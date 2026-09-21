import type { SessionMetrics as AgentTestMetrics, Distribution } from '@mozi-forge/session-insights-plugin/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface CallCountExpectation {
  exactly?: number
  min?: number
  max?: number
}

export interface ArgumentExpectation {
  contains?: string | string[]
  excludes?: string[]
  regex?: string | string[]
}

export interface ToolExpectation {
  name: string
  calls?: CallCountExpectation
  failed?: number
  incomplete?: number
  arguments?: ArgumentExpectation
}

export interface JsonExpectation {
  pointer: string
  equals?: unknown
  contains?: unknown
}

export interface UnchangedCollectionExpectation {
  from: string
  pointer: string
  key: string
  except?: string[]
}

export interface FileExpectation {
  path: string
  json?: JsonExpectation[]
  saveAs?: string
  unchangedCollection?: UnchangedCollectionExpectation
  dataProvenance?: {
    inputPointer?: string
    documentPointers: string[]
    excludePointers: string[]
  }
}

export interface TurnExpectation {
  turn?: { reason: string }
  tools?: ToolExpectation[]
  files?: FileExpectation[]
}

export interface AgentTestTurn {
  id: string
  prompt: string
  expect?: TurnExpectation
}

export interface AgentTestBudgets {
  maxElapsedMs?: number
  maxLlmMs?: number
  maxToolMs?: number
  maxTtftMs?: number
  maxUncachedInputTokens?: number
  maxCacheReadTokens?: number
  maxCacheWriteTokens?: number
  maxOutputTokens?: number
  maxToolCalls?: number
  maxToolFailureRate?: number
}

export interface ReviewArtifactDefinition {
  label: string
  path: string
}

export interface AgentTestReviewDefinition {
  required: true
  when: 'auto-pass' | 'always'
  title: string
  instructions: string
  checklist: string[]
  artifacts: ReviewArtifactDefinition[]
}

export interface AgentTestCase {
  id: string
  name: string
  input?: unknown
  turns: AgentTestTurn[]
  budgets?: AgentTestBudgets
  review?: AgentTestReviewDefinition
}

export interface AgentTestSuite {
  version: 1
  id: string
  name: string
  preset: string
  defaults: { timeoutMs: number; repeat: number }
  cases: AgentTestCase[]
  sourcePath: string
}

export type { TokenTotals, ToolBucket, ToolMetrics, SessionMetrics as AgentTestMetrics, Distribution } from '@mozi-forge/session-insights-plugin/types'

export interface RepeatSummary {
  total: number
  passed: number
  passRate: number
  elapsedMs: Distribution
  outputTokens: Distribution
  toolCalls: Distribution
}

export interface AgentTestAssertion {
  name: string
  passed: boolean
  detail: string
}

export interface AgentTestTurnResult {
  id: string
  prompt: string
  turn: number
  turnReason: string
  assertions: AgentTestAssertion[]
}

export interface AgentTestAttemptResult {
  caseId: string
  caseName: string
  repeat: number
  status: 'passed' | 'failed' | 'error' | 'cancelled'
  sessionId?: string
  sessionLog?: string
  workspace: string
  turns: AgentTestTurnResult[]
  assertions: AgentTestAssertion[]
  metrics: AgentTestMetrics
  error?: string
  usageComplete?: boolean
}

export interface ReviewArtifact {
  label: string
  path: string
}

export interface HumanReviewItem {
  caseId: string
  repeat: number
  title: string
  instructions: string
  checklist: string[]
  artifacts: ReviewArtifact[]
}

export interface HumanReview {
  required: boolean
  status: 'not-required' | 'pending' | 'passed' | 'failed'
  items: HumanReviewItem[]
  title?: string
  instructions?: string
  checklist?: string[]
  artifacts?: ReviewArtifact[]
  reviewCommand?: string
  reviewedAt?: number
  reviewedBySessionId?: string
  note?: string
}

export type AgentTestRunStatus = 'running' | 'failed' | 'waiting-human' | 'waiting-review' | 'passed' | 'review-failed' | 'cancelled'
export type AgentTestProcessLifecycle = 'queued' | 'starting' | 'running' | 'stopping' | 'exited'

export interface AgentTestProcessView {
  runId: string
  jobId?: string
  suite: string
  repeat: number
  planId?: string
  lifecycle: AgentTestProcessLifecycle
  testStatus: AgentTestRunStatus
  progress: string
  pid?: number
  port?: number
  startedAt: number
  readyAt?: number
  finishedAt?: number
  exitCode?: number | null
  signalCode?: NodeJS.Signals | null
  runRoot: string
  stdoutLog: string
  stderrLog: string
  reportPath: string
}

export interface AgentTestProcessRecord {
  version: 1
  ownerSessionId?: string
  process: AgentTestProcessView
}

export interface AgentTestRunResult {
  evaluationDigest?: string
  suiteDefinition?: AgentTestSuite
  version: 1
  runId: string
  jobId?: string
  suite: string
  repeat: number
  sourceDigest: string
  planId?: string
  status: Exclude<AgentTestRunStatus, 'running'>
  automaticVerdict: 'passed' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt: number
  snapshotRoot: string
  dshHome: string
  attempts: AgentTestAttemptResult[]
  metrics: AgentTestMetrics
  repeats: RepeatSummary
  humanReview: HumanReview
  error?: string
}

export interface AgentTestRunView {
  runId: string
  ownerSessionId?: string
  jobId?: string
  suite: string
  repeat: number
  sourceDigest?: string
  planId?: string
  status: AgentTestRunStatus
  automaticVerdict?: 'passed' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt?: number
  runRoot: string
  progress: string
  humanReview: HumanReview
  process?: AgentTestProcessView
  result?: AgentTestRunResult
}

export interface TurnAssertionContext {
  workspace: string
  turn: number
  input?: unknown
  events: readonly SessionEvent[]
  snapshots: Map<string, unknown>
}
