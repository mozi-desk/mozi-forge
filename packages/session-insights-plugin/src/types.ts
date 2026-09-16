/** Frozen session facts and bounded query contracts shared with Trainer. */
import type { SessionMetrics } from './metrics-types.js'
export * from './metrics-types.js'
export interface Range { from: number; through: number }
export type Signal = 'high-tokens' | 'tool-failure' | 'suspected-error' | 'incomplete-tool' | 'suspected-loop' | 'large-output' | 'long-running'
export interface SessionReference { sessionId: string; revision: string }
export interface InsightRow extends Range {
  kind: 'turn' | 'step' | 'tool' | 'event'
  turn?: number | undefined
  step?: number | undefined
  tool?: string
  inherited: boolean
  complete: boolean
  summary: string
  signals: Signal[]
  tokens: number
  usageComplete: boolean
  elapsedMs: number
  outputBytes: number
  metrics?: SessionMetrics
}
export interface EventPosition extends Range { focused: [number, number]; raw: [number, number] }
export interface SessionIndex extends SessionReference {
  preset: string
  sourceCwd: string | null
  parentSession: string | null
  createdAt: number
  inheritedEventCount: number
  through: number
  metrics: SessionMetrics
  usageComplete: boolean
  rows: InsightRow[]
  positions: EventPosition[]
  omittedEvents: number
  omittedReasoningBlocks: number
}
export interface QueryInput {
  session_id: string; revision: string
  kind?: InsightRow['kind']; from?: number; through?: number
  signal?: Signal; tool?: string; query?: string
  sort?: 'sequence' | 'tokens' | 'elapsed' | 'output'
  cursor?: string
}
export interface ReadInput {
  session_id: string; revision: string; from: number; through: number
  view?: 'focused' | 'raw'; cursor?: string
}
