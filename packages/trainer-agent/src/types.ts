/** A training plan owns its workspace and records a successful local integration. */
export interface TrainingPlan {
  id: string
  sessionId: string
  /** Dedicated execution session whose immutable cwd is this plan's worktree. */
  executionSessionId?: string
  sourceSessions?: Array<{ sessionId: string; revision: string }>
  title: string
  description: string
  painRefs?: Array<{ painId: string; throughOccurrence: number; reflectId: string }>
  body: string
  tokenBudget: number
  iterationBudget: number
  createdAt: string
  /** Set only when a save updates an existing plan; createdAt stays the identity time. */
  updatedAt?: string
  startSeq: number
  baseCommit?: string
  targetBranch?: string
  merge?: { requestId: string; commit: string; targetBranch: string; mergedAt: string }
}
export interface PlanInput { sourceSessions?: Array<{ sessionId: string; revision: string }>; id?: string; title: string; description: string; body: string; tokenBudget?: number; iterationBudget?: number }
