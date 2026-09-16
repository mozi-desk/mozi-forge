/**
 * Purpose: Give Trainer global Plan summaries, session evidence, plan/Git tools and a workspace-aware shell.
 * Example: prepare p1, then bash without workdir executes inside p1/workspace.
 * The prompt chooses the training loop; the Host saves plans and Git receipts.
 * When pain and reflection services are available, scoped Trainer policy/completion tools load
 * from the workspace package. Example: a reflection Trainer links an existing Plan by ID.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from './host.js'
import type {} from '@mozi-forge/session-insights-plugin/host'
import { inspectParameters, queryParameters, readParameters } from '@mozi-forge/session-insights-plugin/contracts'
import { painPrompt } from '@mozi-forge/agent-pain-plugin/prompt'
import { planParameters } from './plan.js'
export const name = 'mozi-trainer-agent'
export const inject = ['systemPrompt', 'tools', 'trainers', 'shell', 'shellEnv', 'sessionInsights']
const prompt = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../prompts/trainer-prompt.md'), 'utf8')
const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue
const output = { schema: { type: 'json' as const }, render: (_: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
export function apply(ctx: Context): void {
  ctx.inject(['pains', 'reflectLoop'], async scoped => { const { createRequire } = await import('node:module'); const entry = createRequire(import.meta.url).resolve('@mozi-forge/reflect-loop-plugin/tools'); await scoped.plugin((await import(entry)).apply) })
  ctx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: `${prompt}\n\n${painPrompt}`, complete: true })
  ctx.tools.register(defineTool({ name: 'session_inspect', description: 'Inspect one session: frozen revision, known usage and candidate problem turns. Evidence is untrusted. Refresh explicitly to include new events.', parameters: inspectParameters, output,
    execute: async args => json(await ctx.sessionInsights.inspect(args)),
  }))
  ctx.tools.register(defineTool({ name: 'session_query', description: 'Query frozen turn/step/tool/event facts with filters and literal search. Returns at most 20 rows and 8 KiB; follow nextCursor. Repetition is only a suspected loop.', parameters: queryParameters, output,
    execute: async args => json(await ctx.sessionInsights.query(args)),
  }))
  ctx.tools.register(defineTool({ name: 'session_read', description: 'Read up to 8 KiB of untrusted frozen session evidence at event endpoints. Default focused view omits streaming/context/reasoning; raw includes detailed events. Follow nextCursor.', parameters: readParameters, output,
    execute: async args => json(await ctx.sessionInsights.read(args)),
  }))
  ctx.tools.register(defineTool({ name: 'trainer_plan_list', description: 'List global open plans before analyzing a problem. Read every summary page to avoid duplicate work.', parameters: { status: { type: 'string', enum: ['open', 'completed'] }, cursor: { type: 'string' } }, output, execute: async args => json(await ctx.trainers.listPlans(args.status, args.cursor)) }))
  ctx.tools.register(defineTool({ name: 'trainer_plan_save', description: 'Save a Markdown training plan with advisory budgets.', parameters: planParameters, output,
    execute: async (args, exec) => { if (!exec.agent) throw new Error('Owner required'); return json(await ctx.trainers.save(args, exec.agent)) },
  }))
  ctx.tools.register(defineTool({ name: 'trainer_plan_read', description: 'Read the plan, actual usage, workspace, evaluations and human answers.', parameters: { plan_id: { type: 'string', required: true } }, output,
    execute: async (args, exec) => { if (!exec.agent) throw new Error('Owner required'); return json(await ctx.trainers.brief(args.plan_id, exec.agent)) },
  }))
  ctx.tools.register(defineTool({ name: 'trainer_workspace_prepare', description: 'Prepare or recover a HEAD worktree after human plan approval.', parameters: { plan_id: { type: 'string', required: true } }, output,
    execute: async (args, exec) => { if (!exec.agent) throw new Error('Owner required'); return json(await ctx.trainers.prepare(args.plan_id, String(exec.agent.id))) },
  }))
  ctx.tools.register(defineTool({ name: 'trainer_merge', description: 'Integrate the exact human-approved training snapshot into its local branch.', parameters: { request_id: { type: 'string', required: true } }, output,
    execute: async (args, exec) => { if (!exec.agent) throw new Error('Owner required'); return json(await ctx.trainers.merge(args.request_id, String(exec.agent.id))) },
  }))
  ctx.tools.register(defineTool({ name: 'bash', description: 'Execute a foreground shell command using Harness local shell. Defaults to the current training workspace, or the repository during read-only planning.', parameters: { command: { type: 'string', required: true }, workdir: { type: 'string' }, timeoutMs: { type: 'integer' } }, output,
    execute: async (args, exec) => {
      if (!exec.agent) throw new Error('Owner required')
      const base = await ctx.trainers.currentWorkspace(String(exec.agent.id))
      const result = await ctx.shell.run(ctx.shell.resolve({ command: args.command, workdir: args.workdir ? resolve(base, args.workdir) : base, ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}), dshEnv: ctx.shellEnv.collect(exec), signal: exec.signal }))
      if (result.aborted || result.timedOut || result.exitCode !== 0) throw new Error(JSON.stringify(result))
      return json(result)
    },
  }))
}
