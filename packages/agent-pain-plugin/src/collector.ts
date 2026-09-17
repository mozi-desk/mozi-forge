/**
 * Purpose: Consume own-session events and checkpoint turn counters after pain writes.
 * Example: a crash after the third failed call writes pain but not collector.json;
 * replay repeats its stable session/turn/type identity and contributes no extra score.
 * Usage is replaced by step identity, not added twice. Completed turns release counters.
 * The same pass advances the session's effective Agent preset: the creation header names
 * only what a session started with, so every `agent-preset/selected` event recorded while
 * the session was blank must move the identity a later pain is filed under.
 */
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { usageOf } from '@mozi-forge/session-insights-plugin/metrics'
import { toolResultState } from '@mozi-forge/session-insights-plugin/event-analysis'
import { atomicJson, readJson } from './storage.js'
import type { PainEngine } from './engine.js'
import type { Source } from './types.js'
/**
 * The preset selection an event carries, or null for every other event.
 * The payload is read structurally because only this plugin's Host composition knows the
 * Agent-preset plugin, and the collector must work from a plain persisted session log.
 */
const selectedPreset = (event: SessionEvent): string | null => {
  const candidate = event as { type?: string; data?: { agentPreset?: unknown } }
  return candidate.type === 'agent-preset/selected' && typeof candidate.data?.agentPreset === 'string'
    ? candidate.data.agentPreset
    : null
}
/** Creation header advanced by every recorded selection, which is what a later turn ran under. */
export const presetOf = (initial: string | null, events: readonly SessionEvent[]): string | null =>
  events.reduce<string | null>((preset, event) => selectedPreset(event) ?? preset, initial)
interface Turn {
  turnId: string
  confirmedToolFailures: number
  failedCallIds: string[]
  calls: Array<{
    id: string
    name: string
  }>
  usageByStep: Array<{
    stepId: string
    uncachedInputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    usageComplete: boolean
  }>
  emittedTypes: Array<'tool_failure' | 'token_excess'>
}
export interface CollectorState {
  version: 1
  initializedAt: string
  sessions: Array<{
    sessionId: string
    processedThroughSeq: number
    activeTurns: Turn[]
    /** Effective preset; absent in states written before this field existed. */
    agentPreset: string | null
  }>
}
export class Collector {
  private state!: CollectorState
  private queue: Promise<unknown> = Promise.resolve()
  readonly ready: Promise<void>
  constructor(
    readonly root: string,
    private pains: PainEngine,
    private initial: () => Promise<
      Array<{
        sessionId: string
        through: number
      }>
    >,
  ) {
    this.ready = this.load()
  }
  private async load() {
    this.state = (await readJson<CollectorState>(join(this.root, 'collector.json')))!
    if (this.state) {
      if (this.state.version !== 1 || !Array.isArray(this.state.sessions)) throw new Error('COLLECTOR_STORAGE_INVALID')
      return
    }
    this.state = {
      version: 1,
      initializedAt: new Date().toISOString(),
      sessions: (await this.initial()).map((s) => ({
        sessionId: s.sessionId,
        processedThroughSeq: s.through,
        activeTurns: [],
        agentPreset: null,
      })),
    }
    await atomicJson(join(this.root, 'collector.json'), this.state)
  }
  /** Public cursor lets the Host bound replay without reading collector internals. */
  async cursor(id: string) {
    await this.ready
    return this.state.sessions.find((s) => s.sessionId === id)?.processedThroughSeq ?? -1
  }
  /**
   * Effective preset already recorded for a session, or null when none is stored yet.
   * A Host otherwise has no way to know whether a selection event sits behind the cursor.
   */
  async preset(id: string) {
    await this.ready
    return this.state.sessions.find((s) => s.sessionId === id)?.agentPreset ?? null
  }
  /** Commit a batch only after every threshold occurrence is durable; failure retains the old cursor. */
  async consume(source: Omit<Source, 'turnId' | 'eventSeq'>, events: readonly SessionEvent[], inheritedThrough = -1) {
    const task = this.queue
      .then(() => this.ready)
      .then(async () => {
        const next = structuredClone(this.state)
        let s = next.sessions.find((s) => s.sessionId === source.sessionId)
        if (!s) {
          s = {
            sessionId: source.sessionId,
            processedThroughSeq: inheritedThrough,
            activeTurns: [],
            agentPreset: source.agentPreset,
          }
          next.sessions.push(s)
        }
        const policy = await this.pains.currentPolicy()
        let preset = s.agentPreset ?? source.agentPreset
        for (const event of events) {
          if (Number(event.seq) <= Math.max(s.processedThroughSeq, inheritedThrough)) continue
          preset = selectedPreset(event) ?? preset
          const data = event.data as {
            turn?: number
            step?: number
          }
          const turnId = data.turn === undefined ? null : String(data.turn)
          if (turnId !== null) {
            let turn = s.activeTurns.find((t) => t.turnId === turnId)
            if (!turn) {
              turn = {
                turnId,
                confirmedToolFailures: 0,
                failedCallIds: [],
                calls: [],
                usageByStep: [],
                emittedTypes: [],
              }
              s.activeTurns.push(turn)
            }
            if (event.type === 'tool/call') turn.calls.push({ id: String(event.data.callId), name: event.data.name })
            let toolName: string | undefined
            let failureKind: string | undefined
            if (event.type === 'tool/result' && toolResultState(event as unknown as Record<string, unknown>).failed) {
              const callId = String(event.data.message.source.callId)
              if (!turn.failedCallIds.includes(callId)) {
                turn.failedCallIds.push(callId)
                turn.confirmedToolFailures++
              }
              toolName = turn.calls.find((c) => c.id === callId)?.name ?? 'unknown'
              failureKind = event.data.error?.code ?? 'failed_result'
            }
            const usage = usageOf(event)
            if (event.type === 'step/start' && !turn.usageByStep.some((u) => u.stepId === String(data.step)))
              turn.usageByStep.push({
                stepId: String(data.step),
                uncachedInputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                usageComplete: false,
              })
            if (usage) {
              const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0)
              const row = {
                stepId: String(data.step),
                uncachedInputTokens: n(usage.inputTokens),
                outputTokens: n(usage.outputTokens),
                cacheReadTokens: n(usage.cacheReadTokens),
                cacheWriteTokens: n(usage.cacheWriteTokens),
                usageComplete: typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number',
              }
              turn.usageByStep = turn.usageByStep.filter((u) => u.stepId !== row.stepId)
              turn.usageByStep.push(row)
            }
            const metrics = {
              confirmedToolFailures: turn.confirmedToolFailures,
              knownTokens: turn.usageByStep.reduce(
                (n, u) => n + u.uncachedInputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens,
                0,
              ),
              usageComplete: turn.usageByStep.length > 0 && turn.usageByStep.every((u) => u.usageComplete),
              ...(toolName ? { toolName, failureKind: failureKind! } : {}),
            }
            for (const type of ['tool_failure', 'token_excess'] as const) {
              if (
                turn.emittedTypes.includes(type) ||
                (type === 'tool_failure'
                  ? metrics.confirmedToolFailures >= policy.execution.toolFailuresPerTurn
                  : metrics.knownTokens >= policy.execution.tokensPerTurn)
              ) {
                const key = JSON.stringify([
                  preset ?? source.sessionId,
                  type,
                  ...(type === 'tool_failure' ? [toolName ?? 'unknown', failureKind ?? 'failed_result'] : []),
                ])
                await this.pains.automatic(type, { ...source, agentPreset: preset, turnId, eventSeq: Number(event.seq) }, metrics, key)
                if (!turn.emittedTypes.includes(type)) turn.emittedTypes.push(type)
              }
            }
            if (event.type === 'turn/end') s.activeTurns = s.activeTurns.filter((t) => t !== turn)
          }
          s.processedThroughSeq = Number(event.seq)
        }
        s.agentPreset = preset
        await atomicJson(join(this.root, 'collector.json'), next)
        this.state = next
      })
    this.queue = task.catch(() => undefined)
    return task
  }
}
