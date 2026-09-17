/** Evaluation measurements and accounting coverage. Example: hasCompleteUsage(sessionEvents). */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { distribution } from '@mozi-forge/session-insights-plugin/metrics'
import type { AgentTestAttemptResult, RepeatSummary } from './types.js'
export { emptyMetrics, deriveMetrics, addMetrics, percentile, distribution } from '@mozi-forge/session-insights-plugin/metrics'

export function summarizeRepeats(attempts: readonly AgentTestAttemptResult[]): RepeatSummary {
  const passed = attempts.filter(attempt => attempt.status === 'passed').length
  return {
    total: attempts.length,
    passed,
    passRate: attempts.length === 0 ? 0 : passed / attempts.length,
    elapsedMs: distribution(attempts.map(attempt => attempt.metrics.elapsedMs)),
    outputTokens: distribution(attempts.map(attempt => attempt.metrics.tokens.outputTokens)),
    toolCalls: distribution(attempts.map(attempt => attempt.metrics.tools.calls)),
  }
}

/** Report accounting coverage separately from numerical totals, including failed steps. */
export function hasCompleteUsage(events: readonly SessionEvent[]): boolean {
  const steps = new Set<string>(), measured = new Set<string>()
  for (const event of events) {
    if (event.type === 'step/start') steps.add(`${event.data.turn}:${event.data.step}`)
    if (event.type === 'assistant/message' && event.data.usage !== undefined) measured.add(`${event.data.turn}:${event.data.step}`)
  }
  return steps.size > 0 && [...steps].every(step => measured.has(step))
}
