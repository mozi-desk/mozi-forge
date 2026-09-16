/** Trainer-only tools expose policy changes and reflection completion through native schemas.
 * Example: a revision-1 policy update produces revision 2 and evaluates existing pain.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { json, output, sourceOf } from '@mozi-forge/agent-pain-plugin/host'
import { policyParameters } from '@mozi-forge/agent-pain-plugin/contracts'
import type {} from './host.js'
import type {} from '@mozi-forge/session-insights-plugin/host'
import { completeParameters } from './contracts.js'
export const name = 'mozi-reflect-loop-tools'
export const inject = ['tools', 'pains', 'reflectLoop', 'sessionInsights']
export function apply(ctx: Context) {
  ctx.tools.register(
    defineTool({
      name: 'pain_policy_read',
      description: 'Read the current pain policy and rebuilt trigger view.',
      parameters: {},
      output,
      execute: async () => {
        await ctx.reflectLoop.ready
        const active = await ctx.reflectLoop.engine.status()
        return json({
          policy: await ctx.pains.engine.currentPolicy(),
          view: {
            ...(await ctx.pains.engine.view()),
            activeReflectId: active?.id ?? null,
            nextRetryAt: active?.trainer.nextAttemptAt ?? null,
          },
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'pain_policy_update',
      description:
        'Replace pain policy settings with expected_revision and an explanation. Preserve user > cognitive > failure > token weights.',
      parameters: policyParameters,
      output,
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('Owner required')
        return json(await ctx.pains.engine.updatePolicy(args, sourceOf(exec.agent)))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'reflect_complete',
      description:
        'Complete an owned reflection with one decision per snapshot pain: link open plans, expected behavior with evidence, or defer. Covered occurrence boundaries are required.',
      parameters: completeParameters,
      output,
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('Owner required')
        for (const d of args.decisions)
          for (const e of d.evidence)
            await ctx.sessionInsights.read({
              session_id: e.sessionId,
              revision: e.revision,
              from: e.fromSeq,
              through: e.throughSeq,
            })
        return json(await ctx.reflectLoop.engine.complete(args, String(exec.agent.id)))
      },
    }),
  )
}
