/**
 * Purpose: Assign disjoint event prefixes to Sleep and derive incremental facts.
 * Example: a call at seq 4 and its failed result at seq 12 belong to successive
 * windows; the second window counts the failure and references the continued turn.
 * Prefix fingerprints reject truncation and rewrites. Usage is deduplicated by the
 * existing metrics implementation before subtraction; negative corrections are
 * recorded explicitly and excluded from priority. Inherited execution is context.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { digest } from './store.js'
import { deriveMetrics } from './metrics.js'
import { usageComplete } from './analysis.js'
import { toolResultState } from './event-analysis.js'
import type { TokenTotals } from './metrics-types.js'
export interface IncrementalCheckpoint { through: number; fingerprint: string }
export interface IncrementalTurn { turn: number; from: number; through: number; contextFrom: number; continuedFromPrevious: boolean; complete: boolean }
export interface IncrementalSession {
  sessionId: string; preset: string; revision: string; isNew: boolean; previousThroughSeq: number
  analysisRange: { from: number; through: number }; turns: IncrementalTurn[]
  metrics: { newTurns: number; continuedTurns: number; toolCalls: number; confirmedToolFailures: number; suspectedToolErrors: number; incompleteToolCalls: number; tokens: TokenTotals; tokenCorrections: TokenTotals; knownTokens: number; usageComplete: boolean }
}
/** Validate the complete covered prefix before deriving any new assignment or metrics. */
export function incrementalFacts(events: readonly SessionEvent[], inherited: number, previous?: IncrementalCheckpoint): { checkpoint: IncrementalCheckpoint; session?: Omit<IncrementalSession, 'sessionId' | 'preset' | 'revision'> } {
  if (events.some((e, i) => !Number.isSafeInteger(Number(e.seq)) || Number(e.seq) < 0 || (i > 0 && Number(e.seq) <= Number(events[i-1]!.seq)))) throw new Error('INVALID_SESSION_SEQUENCE')
  const through = Number(events.at(-1)?.seq ?? -1)
  const before = events.filter(e => Number(e.seq) <= (previous?.through ?? -1))
  if (previous && (through < previous.through || digest([inherited, before]) !== previous.fingerprint)) throw new Error('SESSION_PREFIX_CHANGED')
  const checkpoint = { through, fingerprint: digest([inherited, events]) }
  const own = events.filter(e => Number(e.seq) >= inherited)
  const added = own.filter(e => Number(e.seq) > (previous?.through ?? -1))
  if (!added.length) return { checkpoint }
  const from = Number(added[0]!.seq)
  const oldTokens = deriveMetrics(before.filter(e => Number(e.seq) >= inherited)).tokens
  const totalTokens = deriveMetrics(own).tokens
  const tokens = { ...totalTokens }, tokenCorrections = { ...totalTokens }
  for (const key of Object.keys(tokens) as Array<keyof TokenTotals>) {
    const delta = totalTokens[key] - oldTokens[key]
    tokens[key] = Math.max(0, delta); tokenCorrections[key] = Math.min(0, delta)
  }
  const turns: IncrementalTurn[] = []
  let current: IncrementalTurn | undefined
  let currentAdded = false
  const calls = new Map<string, { seq: number; result: boolean }>()
  let failed = 0, suspected = 0
  for (const event of own) {
    const seq = Number(event.seq)
    if (event.type === 'turn/start') {
      currentAdded = false
      current = { turn: event.data.turn, from: Math.max(seq, from), through: seq, contextFrom: seq, continuedFromPrevious: seq < from, complete: false }
    }
    if (current) {
      current.through = seq
      if (seq >= from && !currentAdded) { turns.push(current); currentAdded = true }
      if (event.type === 'turn/end') { current.complete = true; current = undefined }
    }
    if (event.type === 'tool/call') calls.set(event.data.callId, { seq, result: false })
    if (event.type === 'tool/result') {
      const call = calls.get(event.data.message.source.callId)
      if (call && !call.result) {
        call.result = true
        if (seq >= from) { const state = toolResultState(event as unknown as Record<string, unknown>); if (state.failed) failed++; if (state.suspectedError) suspected++ }
      }
    }
  }
  const newCalls = [...calls.values()].filter(c => c.seq >= from)
  // Harness 0.1.5 removed `assistant/chunk`; `assistant/message` is the settlement that carries both the
  // step's usage and its embedded stream, so it alone marks a step as touched.
  const touchedSteps = new Set(added.filter(e => e.type === 'step/start' || e.type === 'assistant/message').map(e => { const d = e.data as { turn: number; step: number }; return `${d.turn}:${d.step}` }))
  const stepEvents = own.filter(e => { const d = e.data as { turn?: number; step?: number }; return touchedSteps.has(`${d.turn}:${d.step}`) })
  return { checkpoint, session: {
    isNew: previous === undefined || previous.through < inherited,
    previousThroughSeq: previous?.through ?? -1, analysisRange: { from, through }, turns,
    metrics: { newTurns: turns.filter(t => !t.continuedFromPrevious).length, continuedTurns: turns.filter(t => t.continuedFromPrevious).length, toolCalls: newCalls.length, confirmedToolFailures: failed, suspectedToolErrors: suspected, incompleteToolCalls: newCalls.filter(c => !c.result).length, tokens, tokenCorrections, knownTokens: Object.values(tokens).reduce((a,b) => a+b, 0), usageComplete: touchedSteps.size === 0 || usageComplete(stepEvents) },
  } }
}
