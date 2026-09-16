/** Persisted pain facts; sequence boundaries allow a plan to resolve only reviewed feedback. */
export type PainType = 'user_dissatisfaction' | 'cognitive' | 'tool_failure' | 'token_excess'
export type PainStatus = 'open' | 'reflecting' | 'resolved'
export interface Evidence {
  sessionId: string
  revision: string
  fromSeq: number
  throughSeq: number
}
export interface Source {
  sessionId: string
  agentId: string
  agentPreset: string | null
  turnId: string
  toolCallId?: string
  eventSeq: number
}
export interface Metrics {
  confirmedToolFailures: number
  knownTokens: number
  usageComplete: boolean
  toolName?: string
  failureKind?: string
}
export interface Occurrence {
  seq: number
  id: string
  createdAt: string
  type: PainType
  origin: 'agent' | 'automatic'
  reason: string
  feedback: string
  potentialSolutions: string[]
  source: Source
  metrics?: Metrics
  score: number
  policyRevision: number
}
export interface Review {
  reflectId: string
  throughOccurrence: number
  action: 'link_plan' | 'expected' | 'defer'
  planIds: string[]
  reason: string
  evidence: Evidence[]
  reviewedAt: string
}
export interface Pain {
  version: 1
  id: string
  title: string
  status: PainStatus
  createdAt: string
  updatedAt: string
  groupingKey?: string
  occurrences: Occurrence[]
  analysis: {
    analyzedThrough: number
    activeReflectId: string | null
    reviews: Review[]
  }
  resolutions: Array<{
    throughOccurrence: number
    reason: 'plans_completed' | 'expected'
    planIds: string[]
    reflectId: string
    explanation: string
    resolvedAt: string
  }>
  score: {
    total: number
    unresolved: number
  }
}
export interface Policy {
  version: 1
  revision: number
  enabled: boolean
  weights: Record<PainType, number>
  execution: {
    toolFailuresPerTurn: number
    tokensPerTurn: number
  }
  reflection: {
    triggerScore: number
    retryDelayMs: number
  }
  updatedAt: string
  updatedBy: {
    sessionId: string | null
    agentId: string | null
  }
  reason: string
}
export type PolicySettings = Pick<Policy, 'enabled' | 'weights' | 'execution' | 'reflection'>
export interface Submit {
  pain_id?: string
  title?: string
  type: 'user_dissatisfaction' | 'cognitive'
  reason: string
  feedback: string
  potentialSolutions: string[]
}
export interface View {
  policyRevision: number
  activeReflectId: string | null
  openPainCount: number
  reflectingPainCount: number
  unresolvedScore: number
  triggerableScore: number
  eligiblePainIds: string[]
  nextRetryAt: string | null
}
