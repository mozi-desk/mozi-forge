/**
 * Purpose: Expose scheduling and status only in the Trainer preset.
 * Example: delta_ms=28800000 requests eight hours from receipt, constrained by the
 * existing hard deadline. Schema checks and service validation precede disk effects.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from './host.js'
export const name = 'mozi-sleep-loop-tools'
export const inject = ['tools', 'sleepLoop']
const output = { schema: { type: 'json' as const }, render: (_: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({ name: 'sleep_loop_schedule', description: 'Set the next sleep using exactly one of at or delta_ms. Recommended interval: 20 minutes to 24 hours. Shorten for many new sessions/turns or high analysis burden, extend for low activity. The fixed hardDeadlineAt cannot be postponed.', parameters: { at: { type: 'string', description: 'RFC3339 timestamp with timezone, e.g. 2026-09-15T08:00:00+08:00. Mutually exclusive with delta_ms.' }, delta_ms: { type: 'integer', description: 'Positive milliseconds from receipt, e.g. 28800000 for eight hours. Mutually exclusive with at.' } }, output,
    execute: async (args, exec) => { if (!exec.agent) throw new Error('Trainer owner required'); return json(await ctx.sleepLoop.schedule(args)) },
  }))
  ctx.tools.register(defineTool({ name: 'sleep_loop_status', description: 'Read nextDueAt, hardDeadlineAt, remaining time, recommended interval, last sleep and delivery status. Assess workload and schedule before deep analysis.', parameters: {}, output,
    execute: async (_args, exec) => { if (!exec.agent) throw new Error('Trainer owner required'); return json(await ctx.sleepLoop.status()) },
  }))
}
