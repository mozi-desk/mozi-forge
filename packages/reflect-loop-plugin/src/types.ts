/** Reflection snapshots and results are durable recovery instructions, not model-owned state. */
import type { Evidence } from '@mozi-forge/agent-pain-plugin/types'
export interface Decision {
  painId: string
  throughOccurrence: number
  action: 'link_plan' | 'expected' | 'defer'
  planIds: string[]
  reason: string
  evidence: Evidence[]
}
export interface ReflectRecord {
  version: 1
  id: string
  status: 'pending' | 'running' | 'completed'
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  trigger: {
    kind: 'pain_received' | 'policy_updated' | 'startup'
    policyRevision: number
    score: number
    threshold: number
  }
  pains: Array<{
    painId: string
    title: string
    throughOccurrence: number
    unresolvedScore: number
    triggerableScore: number
  }>
  trainer: {
    sessionId: string
    messageId: string
    promptVersion: 1
    initialPrompt: string
    deliveryStatus: 'pending' | 'delivered'
    attempts: number
    nextAttemptAt: string | null
    lastError: string | null
  }
  result: null | {
    summary: string
    decisions: Decision[]
  }
}
export interface Plans {
  read(id: string): Promise<{
    merge?: unknown
  }>
  link(
    id: string,
    ref: {
      painId: string
      throughOccurrence: number
      reflectId: string
    },
  ): Promise<void>
}
export interface Delivery {
  deliver(record: ReflectRecord, path: string): Promise<void>
}
