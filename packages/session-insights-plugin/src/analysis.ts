/**
 * Purpose: Derive bounded turn, step and call facts from one persisted session snapshot.
 * Flow: group events by execution boundaries, reuse usage accounting, and mark repeated
 * call patterns as candidates for human/Trainer interpretation. Inherited events remain
 * readable but do not contribute to the session's own execution totals.
 * Example: three identical bash calls yield suspected-loop on their rows; a still-open
 * call yields incomplete-tool, not tool-failure. A textual error is only suspected-error.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveMetrics } from './metrics.js'
import { toolResultState } from './event-analysis.js'
import { digest } from './store.js'
import type { InsightRow, Signal } from './types.js'
/** Report whether each observed LLM step has usage; zero-step histories remain unknown. */
export function usageComplete(events: readonly SessionEvent[]): boolean {
  const steps = new Set<string>(), measured = new Set<string>()
  for (const e of events) {
    if (e.type === 'step/start' || e.type === 'assistant/message') steps.add(`${e.data.turn}:${e.data.step}`)
    if (e.type === 'assistant/message' && e.data.usage !== undefined) measured.add(`${e.data.turn}:${e.data.step}`)
  }
  return steps.size > 0 && [...steps].every(key => measured.has(key))
}
/** Summaries contain bounded text; exact evidence remains in the indexed JSONL files. */
function preview(event: SessionEvent): string {
  // `assistant/attempt` replaces the removed `assistant/chunk` as the bulky log-only carrier: both hold a
  // whole attempt stream, so either one would crowd out the summary if it were serialized.
  if (['assistant/attempt', 'request/header', 'request/context', 'agent/inbox/spliced'].includes(event.type)) return event.type
  if (event.type === 'assistant/message') return JSON.stringify({ ...event.data, message: { ...event.data.message, content: event.data.message.content.filter(b => b.type !== 'reasoning') } }).slice(0, 350)
  return JSON.stringify(event.data).slice(0, 350)
}
function summary(events: readonly SessionEvent[]): string {
  return events.filter(e => ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(e.type)).map(e => preview(e).slice(0, 300)).join(' ').slice(0, 400)
}
/** Sort object keys while preserving argument value types and array order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k, canonical(v)]))
  return value
}
/** Build facts once; call/result pairs are scoped to their turn and inheritance region. */
export function analyzeEvents(events: readonly SessionEvent[], inheritedCount: number): InsightRow[] {
  const rows: InsightRow[] = []
  let current: SessionEvent[] = []
  const groups: SessionEvent[][] = []
  for (const e of events) {
    // `session/end-seed` closes a seeded Session's inherited prefix. It carries no execution facts, and it
    // sits exactly on the inherited/own boundary, so grouping it would emit a factless turn row of its own.
    if (e.type === 'session/end-seed') continue
    if (current.length && (e.type === 'turn/start' || (Number(e.seq) >= inheritedCount) !== (Number(current[0]!.seq) >= inheritedCount))) { groups.push(current); current = [] }
    current.push(e)
    if (e.type === 'turn/end') { groups.push(current); current = [] }
  }
  if (current.length) groups.push(current)
  // Aggregate only the supplied execution range; incomplete ranges retain their observed endpoint.
  function make(kind: InsightRow['kind'], group: readonly SessionEvent[]): InsightRow {
    const first = group[0]!, last = group.at(-1)!, metrics = deriveMetrics(group)
    const tokens = Object.values(metrics.tokens).reduce((a,b) => a+b, 0)
    const signals: Signal[] = []
    if (tokens >= 32000) signals.push('high-tokens')
    const elapsedMs = Math.max(0, last.time - first.time)
    if (elapsedMs >= 30000) signals.push('long-running')
    const row: InsightRow = { kind, from: Number(first.seq), through: Number(last.seq), inherited: Number(first.seq) < inheritedCount, complete: group.some(e => e.type === (kind === 'turn' ? 'turn/end' : 'step/end')), summary: summary(group), signals, tokens, usageComplete: usageComplete(group), elapsedMs, outputBytes: 0 }
    if (kind === 'turn' || kind === 'step') row.metrics = { ...metrics, tools: { ...metrics.tools, byName: {} } }
    return row
  }
  for (const group of groups) {
    const start = group.find(e => e.type === 'turn/start')
    const turn = start?.type === 'turn/start' ? start.data.turn : undefined
    const turnRow = make('turn', group); turnRow.turn = turn
    const steps = new Map<number, SessionEvent[]>(), calls: Array<{ row: InsightRow; signature: string }> = []
    const results = new Map<string, Extract<SessionEvent, { type: 'tool/result' }>>()
    for (const e of group) if (e.type === 'tool/result') results.set(e.data.message.source.callId, e)
    let step: number | undefined
    for (const e of group) {
      if (e.type === 'step/start') step = e.data.step
      if (step !== undefined) { const bucket = steps.get(step) ?? []; bucket.push(e); steps.set(step, bucket) }
      const eventRow = make('event', [e]); eventRow.summary = `${e.type} ${preview(e)}`; eventRow.turn = turn; eventRow.step = step; eventRow.complete = true
      rows.push(eventRow)
      if (e.type === 'tool/call') {
        const result = results.get(e.data.callId), row = make('tool', result ? [e, result] : [e])
        row.tool = e.data.name; row.turn = turn; row.step = step; row.complete = !!result
        if (result) {
          const state = toolResultState(result as unknown as Record<string, unknown>)
          if (state.failed) row.signals.push('tool-failure')
          else if (state.suspectedError) row.signals.push('suspected-error')
          row.outputBytes = Buffer.byteLength(JSON.stringify(result.data))
          if (row.outputBytes > 8192) row.signals.push('large-output')
        } else row.signals.push('incomplete-tool')
        let argumentsValue: unknown = e.data.arguments
        if (typeof argumentsValue === 'string') { try { argumentsValue = JSON.parse(argumentsValue) } catch { /* Keep malformed argument text as evidence. */ } }
        calls.push({ row, signature: digest([e.data.name, canonical(argumentsValue)]) })
        rows.push(row)
      }
      if (e.type === 'step/end') step = undefined
    }
    // Fixed short patterns avoid an unbounded similarity search or semantic verdict.
    for (let width = 1; width <= 4; width++) for (let i = 0; i + width * 3 <= calls.length; i++) {
      if (calls.slice(i, i + width * 3).every((c,j) => c.signature === calls[i + j % width]!.signature)) {
        for (const c of calls.slice(i, i + width * 3)) if (!c.row.signals.includes('suspected-loop')) c.row.signals.push('suspected-loop')
      }
    }
    for (const [number, bucket] of steps) {
      const row = make('step', bucket); row.turn = turn; row.step = number
      row.signals = [...new Set([...row.signals, ...calls.filter(c => c.row.step === number).flatMap(c => c.row.signals)])]
      row.outputBytes = calls.filter(c => c.row.step === number).reduce((n,c) => n+c.row.outputBytes, 0)
      rows.push(row)
    }
    turnRow.signals = [...new Set([...turnRow.signals, ...calls.flatMap(c => c.row.signals)])]
    turnRow.outputBytes = calls.reduce((n,c) => n+c.row.outputBytes, 0)
    rows.push(turnRow)
  }
  return rows.sort((a,b) => a.from-b.from || a.kind.localeCompare(b.kind))
}
