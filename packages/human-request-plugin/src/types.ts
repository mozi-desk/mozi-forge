/** Durable human questions and Markdown answers shared by the Host and browser. */
export interface MergeSnapshot {
  baseCommit: string
  tree: string
  targetBranch: string
  checks: string[]
  commit?: string
  integratedCommit?: string
}
export interface HumanRequest {
  id: string
  type: string
  sessionId: string
  title: string
  body: string
  status: 'pending' | 'answered'
  createdAt: string
  planId?: string
  merge?: MergeSnapshot
  response?: { body: string; answeredAt: string } | null
  deliveredAt?: string
}
export interface HumanRequestSubmitInput {
  body: string
  title?: string
  type?: string
  planId?: string
  requestId?: string
  targetBranch?: string
  checks?: string[]
}
export interface HumanRequestListInput {
  status?: 'pending' | 'answered'
  sessionId?: string
  planId?: string
}
