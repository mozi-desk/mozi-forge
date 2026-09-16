/** Native completion schema is shared by tools and service-side validation. */
import { text, integer, evidenceParameters } from '@mozi-forge/agent-pain-plugin/contracts'
export const completeParameters = {
  reflect_id: text,
  summary: text,
  decisions: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pain_id: text,
        through_occurrence: integer,
        action: { type: 'string', required: true, enum: ['link_plan', 'expected', 'defer'] },
        plan_ids: { type: 'array', items: { type: 'string' } },
        reason: text,
        evidence: evidenceParameters,
      },
    },
  },
} as const
export interface CompleteInput {
  reflect_id: string
  summary: string
  decisions: Array<{
    pain_id: string
    through_occurrence: number
    action: 'link_plan' | 'expected' | 'defer'
    plan_ids?: string[]
    reason: string
    evidence: Array<{
      sessionId: string
      revision: string
      fromSeq: number
      throughSeq: number
    }>
  }>
}
