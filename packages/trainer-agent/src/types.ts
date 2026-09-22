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
  /** Destination branch recorded for each pinned submodule of a superproject root. */
  submoduleTargets?: Record<string, string>
  merge?: { tree: string; commit: string; targetBranch: string; mergedAt: string; submodules?: Array<{ path: string; sha: string }> }
}
export interface PlanInput { sourceSessions?: Array<{ sessionId: string; revision: string }>; id?: string; title: string; description: string; body: string; tokenBudget?: number; iterationBudget?: number }

/** Durable verified candidate; written before moving the destination branch. */
export interface MergeSnapshot {
  baseCommit: string
  tree: string
  targetBranch: string
  checks: string[]
  commit?: string
  integratedCommit?: string
  /** Candidate commit of every pinned submodule, recorded with the superproject tree. */
  submodules?: Array<{ path: string; sha: string }>
}
