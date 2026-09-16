/** Sleep's versioned disk records and dependency boundary; all timestamps are Unix milliseconds. */
import type { IncrementalCheckpoint, IncrementalSession } from '@mozi-forge/session-insights-plugin/incremental'
export const DAY = 86_400_000
export const RECOMMENDED_MIN = 1_200_000
export interface Scheduler { version: 1; initializedAt: number; lastSleepId: string | null; lastStartedAt: number | null; requestedAt: number | null; nextDueAt: number; hardDeadlineAt: number; generation: number }
export interface RankedSession extends IncrementalSession { priority: { newSession: number; toolFailures: number; tokens: number; total: number; rank: number } }
export interface SleepRecord {
  version: 1; id: string; previousSleepId: string | null; scheduledAt: number; startedAt: number; snapshotCompletedAt: number
  trigger: 'scheduled' | 'deadline' | 'startup-overdue'; latenessMs: number
  window: { previousStartedAt: number | null; currentStartedAt: number }
  summary: { changedSessionCount: number; newSessionCount: number; newTurnCount: number; continuedTurnCount: number; confirmedToolFailures: number; knownTokens: number; usageComplete: boolean }
  schedulingGuidance: { recommendedMinIntervalMs: number; recommendedMaxIntervalMs: number; hardDeadlineAt: number }
  scoring: { version: 1; weights: { newSession: number; toolFailures: number; tokens: number } }
  sessions: RankedSession[]
}
export interface Delivery { version: 1; sessionId: string; messageId: string; status: 'pending' | 'delivered'; attempts: number; nextAttemptAt: number; error?: string }
export interface SleepSource {
  beginWindow?(): void
  endWindow?(): void
  list(): Promise<string[]>
  capture(id: string, previous?: IncrementalCheckpoint): Promise<{ checkpoint: IncrementalCheckpoint; session?: IncrementalSession; hasMore?: boolean }>
}
export interface TrainerDelivery { deliver(record: SleepRecord, path: string, delivery: Delivery): Promise<void>; recover?(record: SleepRecord, path: string, delivery: Delivery): Promise<void> }
export interface Clock { now(): number; monotonic(): number; setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export const systemClock: Clock = { now: () => Date.now(), monotonic: () => performance.now(), setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer }, clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }
