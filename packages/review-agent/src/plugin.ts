/**
 * Purpose: Give the independent Reviewer native evidence-read and verdict tools.
 * Flow: mount the review persona and typed result schema, require an owner Agent,
 * and delegate bounded reads and validated verdict persistence to ReviewService.
 * Successful verdict submission ends the turn. The request hook limits output and
 * rejects excessive context/steps before another model request is sent.
 * Example: review_submit with verdict=request-changes and an evidenced typed finding
 * persists a completed review and wakes registered workflow listeners through Host.
 * Edge-case Example: findings:[null] fails Harness schema validation before dispatch.
 * The plugin owns protocol/request admission; Host owns evidence and review state.
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from './host.js'
import { ANALYSIS_STEPS, requestLimits } from '@mozi-forge/session-insights-plugin/budgets'
import { reviewResultParameters } from './result.js'
export const name = 'mozi-review-agent'
export const inject = ['systemPrompt', 'tools', 'reviews', 'llm']
export function apply(ctx: Context): void {
  const persona = readFileSync(new URL('../prompts/reviewer-prompt.md', import.meta.url), 'utf8')
  ctx.systemPrompt.section({ name: 'deployment:persona', order: 0, complete: true, text: persona })
  const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
  ctx.tools.register(defineTool({ name: 'review_read', description: 'Read a bounded page of frozen review evidence.', parameters: { review_id: { type: 'string', required: true }, section: { type: 'string', required: true }, offset: { type: 'integer' } }, output,
    async execute(args, exec) { if (!exec.agent) throw new Error('Review owner required'); return await ctx.reviews.read(args.review_id, args.section, args.offset ?? 0, exec.agent) as JsonValue } }))
  // Host checks evidence/completeness and commits the verdict before notifying workflow listeners.
  ctx.tools.register(defineTool({ name: 'review_submit', description: 'Submit an independent Goodhart verdict. Non-pass requires evidenced findings.', parameters: { review_id: { type: 'string', required: true }, ...reviewResultParameters }, output,
    async execute(args, exec) { if (!exec.agent) throw new Error('Review owner required'); const run = await ctx.reviews.submit(args.review_id, { verdict: args.verdict, summary: args.summary, findings: args.findings }, exec.agent); exec.concludeTurn(); return { id: run.id, status: run.status, verdict: run.result!.verdict } } }))
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const config = await next()
    const model = await ctx.llm.resolveModelInfo(config.provider, config.model, signal)
    const limits = requestLimits(model.context?.contextWindow, config.maxTokens ?? model.defaultMaxTokens)
    const events = agent.session.snapshotEvents()
    if (events.filter(e => e.type === 'step/start').length > ANALYSIS_STEPS || Buffer.byteLength(JSON.stringify({ system: persona, tools: ctx.tools.schemas(agent), messages: agent.session.deriveMessages() })) > limits.contextBytes) throw new Error('REVIEW_CONTEXT_BUDGET: resume with focused evidence')
    return { ...config, maxTokens: limits.maxRequestOutputTokens }
  })
}
