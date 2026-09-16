/**
 * Purpose: Coordinate durable deadlines, incremental Sleep commits and retryable delivery.
 * Flow: acquire ownership, replay committed coverage, reconcile persistence, then arm
 * bounded timers. A sleep.json commit precedes cursor and scheduler updates; restart
 * replays that journal before collecting another disjoint range. Delivery has its own
 * queue and never holds scheduling serialization while creating or waking an Agent.
 * Example: crash after sleep.json but before scheduler.json -> recover the same record,
 * cover its endpoints and deliver its deterministic Trainer identity once.
 * Failure: source errors retain candidates; commit errors retain the deadline. Delivery
 * errors retry the original record. Disposal drains owned work and releases the lock.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Discovery, durableJson, optionalJson } from './storage.js'
import { DAY, RECOMMENDED_MIN, systemClock, type Clock, type Delivery, type RankedSession, type Scheduler, type SleepRecord, type SleepSource, type TrainerDelivery } from './types.js'
import type { IncrementalCheckpoint, IncrementalSession } from '@mozi-forge/session-insights-plugin/incremental'
export * from './types.js'
const backoff = (attempt: number): number => [1000, 5000, 30000, 60000][Math.min(Math.max(0, attempt - 1), 3)]!
const code = (error: unknown): string => error instanceof Error && /^[A-Z][A-Z_]+$/u.test(error.message) ? error.message : 'SLEEP_OPERATION_FAILED'
/** Native service validation also protects direct callers before scheduling writes. */
export function scheduleTime(input: unknown, now: number, deadline: number): number {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('SLEEP_INVALID_SCHEDULE: expected an object with at or delta_ms')
  const row = input as Record<string, unknown>
  if (Object.keys(row).some(k => k !== 'at' && k !== 'delta_ms') || (row.at !== undefined) === (row.delta_ms !== undefined)) throw new Error('SLEEP_INVALID_SCHEDULE: provide exactly one of at or delta_ms')
  let at: number
  if (row.at !== undefined) {
    if (typeof row.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(row.at)) throw new Error('SLEEP_INVALID_SCHEDULE: at must be RFC3339 with timezone')
    at = Date.parse(row.at)
    const day = row.at.slice(0, 10), parsedDay = new Date(`${day}T00:00:00Z`)
    if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) throw new Error('SLEEP_INVALID_SCHEDULE: at has an invalid calendar date')
  } else {
    if (!Number.isSafeInteger(row.delta_ms) || Number(row.delta_ms) <= 0) throw new Error('SLEEP_INVALID_SCHEDULE: delta_ms must be a positive safe integer')
    at = now + Number(row.delta_ms)
  }
  if (!Number.isSafeInteger(at) || at <= now || at > deadline) throw new Error(`SLEEP_INVALID_SCHEDULE: target must be after ${now} and at or before hardDeadlineAt=${deadline}`)
  return at
}
function ranked(session: IncrementalSession): RankedSession {
  const round = (n: number) => Math.round(n * 100) / 100
  const priority = { newSession: session.isNew ? 20 : 0, toolFailures: round(50 * Math.min(session.metrics.confirmedToolFailures / 5, 1)), tokens: round(30 * Math.min(session.metrics.knownTokens / 64000, 1)), total: 0, rank: 0 }
  priority.total = round(priority.newSession + priority.toolFailures + priority.tokens)
  return { ...session, priority }
}
/** Reject malformed disk state instead of resetting a deadline from unchecked fields. */
function validScheduler(value: Scheduler | undefined): value is Scheduler {
  if (!value || value.version !== 1) return false
  if (![value.initializedAt, value.nextDueAt, value.hardDeadlineAt, value.generation].every(Number.isSafeInteger) || value.generation <= 0) return false
  if (value.lastStartedAt !== null && !Number.isSafeInteger(value.lastStartedAt)) return false
  if (value.lastSleepId !== null && (typeof value.lastSleepId !== 'string' || !/^sleep-loop-\d+-[a-f0-9-]+$/u.test(value.lastSleepId))) return false
  if ((value.lastSleepId === null) !== (value.lastStartedAt === null)) return false
  if (value.requestedAt !== null && (!Number.isSafeInteger(value.requestedAt) || value.requestedAt !== value.nextDueAt)) return false
  return value.nextDueAt <= value.hardDeadlineAt && value.hardDeadlineAt === (value.lastStartedAt ?? value.initializedAt) + DAY
}

export class SleepEngine {
  private discovery!: Discovery
  private state!: Scheduler
  private queue: Promise<unknown> = Promise.resolve()
  private worker: Promise<void> | undefined
  private timer: unknown
  private closed = false
  private pending = new Map<string, Delivery>()
  private lastError: string | null = null
  private captureAttempts = 0
  private retryAt = 0
  private needsReconcile = true
  private reconcileAt = 0
  private reconcileAttempts = 0
  private anchorWall = 0
  private anchorMono = 0
  private observedNow = 0
  constructor(readonly root: string, private readonly source: SleepSource, private readonly trainer: TrainerDelivery, private readonly clock: Clock = systemClock) {}
  /** Effective wall time cannot move backwards during one process lifetime. */
  private now(): number { this.observedNow = Math.max(this.observedNow, this.clock.now(), this.anchorWall + this.clock.monotonic() - this.anchorMono); return Math.floor(this.observedNow) }
  private async serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.queue.catch(() => undefined).then(fn); this.queue = next; return next }
  /** Recover committed ranges before listing sources; initial activation defaults to one day. */
  async start(): Promise<void> {
    this.anchorWall = this.clock.now(); this.anchorMono = this.clock.monotonic()
    await mkdir(join(this.root, 'discovery'), { recursive: true, mode: 0o700 })
    const previouslyInitialized = existsSync(join(this.root, 'discovery', 'discovery.sqlite'))
    this.discovery = new Discovery(join(this.root, 'discovery'))
    try {
      let stored: Scheduler | undefined, corrupt = false
      try { stored = await optionalJson<Scheduler>(join(this.root, 'scheduler.json')); corrupt = stored === undefined ? previouslyInitialized : !validScheduler(stored) } catch { corrupt = true }
      const now = this.now()
      this.state = validScheduler(stored) ? stored : { version: 1, initializedAt: now, lastSleepId: null, lastStartedAt: null, requestedAt: null, nextDueAt: corrupt ? now : now + DAY, hardDeadlineAt: now + DAY, generation: 1 }
      if (corrupt) this.lastError = 'SLEEP_SCHEDULER_RECOVERED'
      const directories = (await readdir(this.root)).filter(n => /^sleep-loop-\d+-[a-f0-9-]+$/u.test(n)).sort((a,b) => Number(a.split('-')[2])-Number(b.split('-')[2]) || a.localeCompare(b))
      for (const id of directories) {
        const record = await optionalJson<SleepRecord>(join(this.root, id, 'sleep.json'))
        if (!record) continue
        if (record.version !== 1 || record.id !== id || !Array.isArray(record.sessions)) throw new Error('SLEEP_RECORD_INVALID')
        const coverage = await optionalJson<Array<{ sessionId: string; checkpoint: IncrementalCheckpoint }>>(join(this.root, id, 'coverage.json'))
        if (!coverage) throw new Error('SLEEP_COVERAGE_MISSING')
        this.discovery.cover(coverage)
        if (this.state.lastStartedAt === null || record.startedAt > this.state.lastStartedAt || (record.previousSleepId === this.state.lastSleepId && record.id !== this.state.lastSleepId)) this.advance(record)
        const delivery = await optionalJson<Delivery>(join(this.root, id, 'delivery.json')) ?? this.newDelivery(id)
        if (delivery.status !== 'delivered' || this.trainer.recover) this.pending.set(id, delivery)
      }
      await durableJson(join(this.root, 'scheduler.json'), this.state)
      await this.poll(true)
    } catch (error) { this.discovery.close(); throw error }
  }
  /** Startup metadata listing is the public backend's full header list; bodies are read individually later. */
  async reconcile(): Promise<void> { for (const id of await this.source.list()) this.discovery.mark(id) }
  /** Called from public session notifications; dirty IDs remain entirely host-side. */
  changed(id: string): void {
    if (this.closed || !this.discovery) return
    try { this.discovery.mark(id) } catch { this.lastError = 'SLEEP_DISCOVERY_WRITE_FAILED'; this.needsReconcile = true; this.reconcileAt = this.now() + 1000; this.arm() }
  }
  /** Query only scheduling facts; discovery IDs are intentionally absent from the response. */
  status() { return { ...this.state, remainingMs: Math.max(0, this.state.nextDueAt - this.now()), recommendedMinIntervalMs: RECOMMENDED_MIN, recommendedMaxIntervalMs: DAY, pendingDeliveries: this.pending.size, lastError: this.lastError } }
  /** Persist the accepted deadline before replacing the timer; hardDeadlineAt is unchanged. */
  async schedule(input: unknown) {
    return this.serial(async () => {
      if (this.closed) throw new Error('SLEEP_CLOSED')
      const requestedAt = scheduleTime(input, this.now(), this.state.hardDeadlineAt)
      const next = { ...this.state, requestedAt, nextDueAt: requestedAt, generation: this.state.generation + 1 }
      await durableJson(join(this.root, 'scheduler.json'), next)
      this.state = next; this.arm(); return this.status()
    })
  }
  /** Poll is also a public deterministic test/embedding boundary; delivery runs on a separate queue. */
  async poll(startup = false): Promise<void> {
    await this.serial(async () => {
      if (this.closed) return
      if (this.needsReconcile && this.now() >= this.reconcileAt) {
        try { await this.reconcile(); this.needsReconcile = false; this.reconcileAttempts = 0 }
        catch (error) { this.lastError = code(error); this.reconcileAt = this.now() + backoff(++this.reconcileAttempts) }
      }
      if (!this.needsReconcile && (this.unfinished || this.now() >= this.state.nextDueAt) && this.now() >= this.retryAt) {
        try { await this.capture(startup); this.captureAttempts = 0; this.retryAt = 0 }
        catch (error) { this.lastError = code(error); this.retryAt = this.now() + backoff(++this.captureAttempts) }
      }
      this.arm()
    })
    this.pump()
  }
  /** Bound wall-clock waits so suspension and clock changes are noticed promptly. */
  private arm(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    if (this.closed) return
    const generation = this.state.generation
    let deliveryDue = Infinity
    if (!this.worker) for (const d of this.pending.values()) deliveryDue = Math.min(deliveryDue, d.nextAttemptAt || this.now())
    const captureDue = this.needsReconcile ? this.reconcileAt : this.unfinished ? this.retryAt : Math.max(this.state.nextDueAt, this.retryAt)
    const due = Math.min(captureDue, deliveryDue)
    this.timer = this.clock.setTimeout(() => {
      if (generation !== this.state.generation || this.closed) return
      void this.poll().catch(() => { this.lastError = 'SLEEP_POLL_FAILED'; this.arm() })
    }, Math.max(1, Math.min(30000, due - this.now())))
  }
  /** A record advances the fixed deadline only after its immutable JSON has committed. */
  private advance(record: SleepRecord): void { this.state = { ...this.state, lastSleepId: record.id, lastStartedAt: record.startedAt, requestedAt: null, nextDueAt: record.startedAt + DAY, hardDeadlineAt: record.startedAt + DAY, generation: this.state.generation + 1 } }
  /**
   * Claim one bounded batch at a time; events arriving after a claim remain dirty.
   * Coverage is written before sleep.json, which is the commit point. Once committed,
   * retries finish the same journal via recoverCommit, rather than snapshotting again.
   */
  private async capture(startup: boolean): Promise<void> {
    if (this.unfinished) { await this.recoverCommit(this.unfinished); return }
    const startedAt = Math.floor(this.now()), id = `sleep-loop-${startedAt}-${randomUUID()}`
    const sessions: RankedSession[] = [], coverage: Array<{ sessionId: string; checkpoint: IncrementalCheckpoint }> = []
    this.source.beginWindow?.()
    const cutoff = this.discovery.cutoff()
    try {
      for (;;) {
        const batch = this.discovery.batch(cutoff)
        if (!batch.length) break
        for (const sessionId of batch) {
          this.discovery.claim(sessionId)
          try {
            const result = await this.source.capture(sessionId, this.discovery.checkpoint(sessionId))
            if (result.hasMore) this.discovery.mark(sessionId)
            if (result.session) { sessions.push(ranked(result.session)); coverage.push({ sessionId, checkpoint: result.checkpoint }) }
            else this.discovery.cover([{ sessionId, checkpoint: result.checkpoint }])
          } catch (error) {
            this.discovery.mark(sessionId)
            this.lastError = code(error)
            await durableJson(join(this.root, 'discovery', 'last-error.json'), { at: this.now(), code: this.lastError })
          }
        }
      }
      sessions.sort((a,b) => b.priority.total-a.priority.total || b.metrics.confirmedToolFailures-a.metrics.confirmedToolFailures || b.metrics.knownTokens-a.metrics.knownTokens || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
      sessions.forEach((s,i) => { s.priority.rank = i+1 })
      const record: SleepRecord = {
        version: 1, id, previousSleepId: this.state.lastSleepId, scheduledAt: this.state.nextDueAt, startedAt, snapshotCompletedAt: Math.floor(this.now()), trigger: startup ? 'startup-overdue' : this.state.requestedAt === null ? 'deadline' : 'scheduled', latenessMs: Math.max(0, startedAt-this.state.nextDueAt),
        window: { previousStartedAt: this.state.lastStartedAt, currentStartedAt: startedAt },
        summary: { changedSessionCount: sessions.length, newSessionCount: sessions.filter(s => s.isNew).length, newTurnCount: sessions.reduce((n,s) => n+s.metrics.newTurns, 0), continuedTurnCount: sessions.reduce((n,s) => n+s.metrics.continuedTurns, 0), confirmedToolFailures: sessions.reduce((n,s) => n+s.metrics.confirmedToolFailures, 0), knownTokens: sessions.reduce((n,s) => n+s.metrics.knownTokens, 0), usageComplete: sessions.every(s => s.metrics.usageComplete) },
        schedulingGuidance: { recommendedMinIntervalMs: RECOMMENDED_MIN, recommendedMaxIntervalMs: DAY, hardDeadlineAt: startedAt+DAY }, scoring: { version: 1, weights: { newSession: 20, toolFailures: 50, tokens: 30 } }, sessions,
      }
      await durableJson(join(this.root, id, 'coverage.json'), coverage)
      // Keep the identity even if rename committed but its following directory fsync failed.
      this.unfinished = { record, coverage }
      await durableJson(join(this.root, id, 'sleep.json'), record)
      await this.recoverCommit(this.unfinished)
    } catch (error) { for (const row of coverage) this.discovery.mark(row.sessionId); throw error }
    finally { this.source.endWindow?.() }
  }
  private unfinished: { record: SleepRecord; coverage: Array<{ sessionId: string; checkpoint: IncrementalCheckpoint }> } | undefined
  /** Finish the same identity after any partial commit; publication can safely be repeated with identical bytes. */
  private async recoverCommit(commit: NonNullable<SleepEngine['unfinished']>): Promise<void> {
    const { record, coverage } = commit
    await durableJson(join(this.root, record.id, 'sleep.json'), record)
    this.discovery.cover(coverage)
    if (this.state.lastSleepId !== record.id) this.advance(record)
    await durableJson(join(this.root, 'scheduler.json'), this.state)
    const delivery = this.newDelivery(record.id)
    await durableJson(join(this.root, record.id, 'delivery.json'), delivery)
    this.pending.set(record.id, delivery); this.unfinished = undefined
  }
  private newDelivery(id: string): Delivery { return { version: 1, sessionId: `trainer-${id}`, messageId: `sleep-prompt-${id}`, status: 'pending', attempts: 0, nextAttemptAt: 0 } }
  /** Delivery failures keep their immutable input and retry independently of the 24-hour capture clock. */
  private pump(): void {
    if (this.closed || this.worker) return
    this.worker = (async () => {
      for (const [id, delivery] of this.pending) {
        if (this.closed) break
        if (delivery.nextAttemptAt > this.now()) continue
        try {
          const path = join(this.root, id, 'sleep.json'), record = await optionalJson<SleepRecord>(path)
          if (!record) throw new Error('SLEEP_RECORD_MISSING')
          delivery.attempts++
          if (delivery.status === 'delivered' && this.trainer.recover) await this.trainer.recover(record, path, delivery)
          else await this.trainer.deliver(record, path, delivery)
          const completed: Delivery = { ...delivery, status: 'delivered' }
          delete completed.error
          await durableJson(join(this.root, id, 'delivery.json'), completed)
          this.pending.delete(id)
        } catch (error) {
          delivery.error = code(error); this.lastError = delivery.error; delivery.nextAttemptAt = this.now() + backoff(delivery.attempts)
          await durableJson(join(this.root, id, 'delivery.json'), delivery)
        }
      }
    })().catch(() => { this.lastError = 'SLEEP_DELIVERY_WRITE_FAILED' }).finally(() => { this.worker = undefined; this.arm() })
  }
  /** Await attempted deliveries without running a Trainer model; useful to embedding callers and teardown. */
  async drain(): Promise<void> { await this.queue.catch(() => undefined); await this.worker }
  async close(): Promise<void> { this.closed = true; if (this.timer !== undefined) this.clock.clearTimeout(this.timer); await this.drain(); this.discovery?.close() }
}
