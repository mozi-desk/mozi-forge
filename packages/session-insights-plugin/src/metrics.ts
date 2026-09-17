/**
 * Purpose: Compute session timings, usage and tool outcomes from public events.
 * Example: Harness 0.1.5 settles `assistant/message` once per turn/step and embeds the attempt's timed
 * stream in it, so the first-token time for TTFT comes from `assistantStreamFirstTokenTime` over that
 * stream and the settlement's `usage` is counted once even when the same step also produced earlier
 * `assistant/attempt` records; a text-only error hint stays outside confirmed failures. Missing calls
 * count as incomplete separately from failed; aggregate failureRate includes both outcomes.
 */
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm'
import { toolResultState } from './event-analysis.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionMetrics, Distribution, TokenTotals } from './metrics-types.js'

export interface Usage {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
}

function nonnegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Token accounting for one settled step. Harness 0.1.5 reports usage only on the settlement event. */
export function usageOf(event: SessionEvent): Usage | undefined {
  if (event.type === 'assistant/message') return event.data.usage
  return undefined
}

function resultFailed(event: Extract<SessionEvent, { type: 'tool/result' }>): boolean {
  const state = toolResultState(event as unknown as Record<string, unknown>)
  return state.failed
}

export function emptyMetrics(): SessionMetrics {
  return {
    elapsedMs: 0,
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    tokens: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    tools: { calls: 0, failed: 0, incomplete: 0, failureRate: 0, byName: {} },
  }
}

export function deriveMetrics(events: readonly SessionEvent[]): SessionMetrics {
  const metrics = emptyMetrics()
  const first = events.find(event => event.type === 'turn/start')
  const last = events.findLast(event => event.type === 'turn/end')
  if (first !== undefined && last !== undefined) metrics.elapsedMs = Math.max(0, last.time - first.time)

  const turns = new Set<number>()
  const steps = new Map<string, { start: number; firstToken?: number; message?: number }>()
  const usages = new Map<string, Usage>()
  const calls = new Map<string, { name: string; start: number; result?: number; failed?: boolean }>()

  for (const event of events) {
    if (event.type === 'step/start') {
      steps.set(`${String(event.data.turn)}:${String(event.data.step)}`, { start: event.time })
    } else if (event.type === 'assistant/message') {
      const key = `${String(event.data.turn)}:${String(event.data.step)}`
      const step = steps.get(key)
      if (step !== undefined) {
        step.message = event.time
        // Harness 0.1.5 removed the per-chunk session events that used to supply the first-token time,
        // and embeds the attempt's timed stream in the settlement event instead. The reader reconstructs
        // the same first delta time, keeping TTFT measurable rather than silently dropping it.
        if (step.firstToken === undefined) {
          const firstToken = assistantStreamFirstTokenTime(event.data.stream)
          if (firstToken !== undefined) step.firstToken = firstToken
        }
      }
      const usage = usageOf(event)
      if (usage !== undefined) usages.set(key, usage)
    } else if (event.type === 'step/end') {
      turns.add(event.data.turn)
      metrics.steps += 1
    } else if (event.type === 'tool/call') {
      calls.set(event.data.callId, { name: event.data.name, start: event.time })
    } else if (event.type === 'tool/result') {
      const call = calls.get(event.data.message.source.callId)
      if (call !== undefined) {
        call.result = event.time
        call.failed = resultFailed(event)
      }
    }
  }

  metrics.turns = turns.size
  for (const step of steps.values()) {
    if (step.message !== undefined) metrics.llmMs += Math.max(0, step.message - step.start)
    if (step.firstToken !== undefined) {
      metrics.ttftMs += Math.max(0, step.firstToken - step.start)
      metrics.ttftSteps += 1
    }
  }
  for (const usage of usages.values()) {
    metrics.tokens.uncachedInputTokens += nonnegative(usage.inputTokens)
    metrics.tokens.outputTokens += nonnegative(usage.outputTokens)
    metrics.tokens.cacheReadTokens += nonnegative(usage.cacheReadTokens)
    metrics.tokens.cacheWriteTokens += nonnegative(usage.cacheWriteTokens)
  }

  for (const call of calls.values()) {
    metrics.tools.calls += 1
    const bucket = metrics.tools.byName[call.name] ?? { calls: 0, failed: 0, incomplete: 0 }
    bucket.calls += 1
    if (call.result === undefined) {
      metrics.tools.incomplete += 1
      bucket.incomplete += 1
    } else {
      metrics.toolMs += Math.max(0, call.result - call.start)
      if (call.failed === true) {
        metrics.tools.failed += 1
        bucket.failed += 1
      }
    }
    metrics.tools.byName[call.name] = bucket
  }
  metrics.tools.failureRate = metrics.tools.calls === 0
    ? 0
    : (metrics.tools.failed + metrics.tools.incomplete) / metrics.tools.calls
  return metrics
}

export function addMetrics(all: readonly SessionMetrics[]): SessionMetrics {
  const total = emptyMetrics()
  for (const metrics of all) {
    total.elapsedMs += metrics.elapsedMs
    total.turns += metrics.turns
    total.steps += metrics.steps
    total.llmMs += metrics.llmMs
    total.toolMs += metrics.toolMs
    total.ttftMs += metrics.ttftMs
    total.ttftSteps += metrics.ttftSteps
    for (const key of Object.keys(total.tokens) as Array<keyof TokenTotals>) total.tokens[key] += metrics.tokens[key]
    total.tools.calls += metrics.tools.calls
    total.tools.failed += metrics.tools.failed
    total.tools.incomplete += metrics.tools.incomplete
    for (const [name, bucket] of Object.entries(metrics.tools.byName)) {
      const target = total.tools.byName[name] ?? { calls: 0, failed: 0, incomplete: 0 }
      target.calls += bucket.calls
      target.failed += bucket.failed
      target.incomplete += bucket.incomplete
      total.tools.byName[name] = target
    }
  }
  total.tools.failureRate = total.tools.calls === 0
    ? 0
    : (total.tools.failed + total.tools.incomplete) / total.tools.calls
  return total
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1)
  return sorted[index] ?? 0
}

export function distribution(values: readonly number[]): Distribution {
  return {
    mean: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  }
}

