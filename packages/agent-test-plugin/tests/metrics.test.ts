import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { deriveMetrics, distribution, hasCompleteUsage } from '../src/metrics.js'

function events(): SessionEvent[] {
  return [
    { seq: 0, time: 1_000, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 1_100, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, time: 1_200, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } },
    { seq: 3, time: 1_300, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 9, outputTokens: 3 } } } },
    { seq: 4, time: 1_400, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 5 } } },
    { seq: 5, time: 1_410, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-a', name: 'bash', arguments: '{}' } },
    { seq: 6, time: 1_460, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-a', toolName: 'bash', content: [{ type: 'text', text: 'bad' }], isError: true }], source: { kind: 'tool', callId: 'call-a' } } } },
    { seq: 7, time: 1_470, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-b', name: 'bash', arguments: '{}' } },
    { seq: 8, time: 1_500, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 9, time: 1_600, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]
}

describe('agent test session-log metrics', () => {
  it('uses final per-step usage and counts failed and incomplete tool calls', () => {
    const metrics = deriveMetrics(events())
    expect(metrics).toMatchObject({
      elapsedMs: 600,
      turns: 1,
      steps: 1,
      llmMs: 300,
      toolMs: 50,
      ttftMs: 100,
      ttftSteps: 1,
      tokens: { uncachedInputTokens: 10, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 0 },
      tools: { calls: 2, failed: 1, incomplete: 1, failureRate: 1 },
    })
    expect(metrics.tools.byName.bash).toEqual({ calls: 2, failed: 1, incomplete: 1 })
  })

  it('reports missing usage instead of treating it as zero', () => {
    expect(hasCompleteUsage(events())).toBe(true)
    expect(hasCompleteUsage([])).toBe(false)
    expect(hasCompleteUsage([...events(), { seq: 10, time: 1700, type: 'step/start', data: { turn: 2, step: 1 } } as SessionEvent])).toBe(false)
    expect(hasCompleteUsage(events().filter(event => event.type !== 'assistant/message'))).toBe(true)
  })

  it('computes repeat mean, P50, and nearest-rank P95', () => {
    expect(distribution([10, 20, 30, 40, 100])).toEqual({ mean: 40, p50: 30, p95: 100 })
  })
})
