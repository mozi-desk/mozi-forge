/** Durable human questions and Markdown answers shared by the Host and browser. */
export type HumanDecision = 'approve' | 'request-changes'
export interface HumanRequest {
  id: string
  type: string
  sessionId: string
  title: string
  body: string
  status: 'pending' | 'answered'
  createdAt: string
  planId?: string
  response?: { body: string; answeredAt: string; decision?: HumanDecision; decidedAt?: string } | null
  deliveredAt?: string
}
export interface HumanRequestSubmitInput {
  body: string
  title?: string
  type?: string
  planId?: string
  requestId?: string
}
export interface HumanRequestListInput {
  status?: 'pending' | 'answered'
  sessionId?: string
  planId?: string
}
