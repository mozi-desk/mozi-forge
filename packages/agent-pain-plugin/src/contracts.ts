/** Native tool contracts are also validated at service entry before any persistence. */
import { validateArgs } from '@deepseek-ai/dsh-tools'
export const text = { type: 'string', required: true } as const
export const integer = { type: 'integer', required: true } as const
export const submitParameters = {
  pain_id: { type: 'string' },
  title: { type: 'string' },
  type: { type: 'string', enum: ['user_dissatisfaction', 'cognitive'], required: true },
  reason: text,
  feedback: text,
  potentialSolutions: { type: 'array', required: true, items: { type: 'string' } },
} as const
export const listParameters = {
  query: { type: 'string' },
  statuses: { type: 'array', items: { type: 'string', enum: ['open', 'reflecting', 'resolved'] } },
  cursor: { type: 'string' },
} as const
export const readParameters = { pain_id: text, cursor: { type: 'string' } } as const
export const policyProperties = {
  enabled: { type: 'boolean', required: true },
  weights: {
    type: 'object',
    required: true,
    additionalProperties: false,
    properties: { user_dissatisfaction: integer, cognitive: integer, tool_failure: integer, token_excess: integer },
  },
  execution: {
    type: 'object',
    required: true,
    additionalProperties: false,
    properties: { toolFailuresPerTurn: integer, tokensPerTurn: integer },
  },
  reflection: {
    type: 'object',
    required: true,
    additionalProperties: false,
    properties: { triggerScore: integer, retryDelayMs: integer },
  },
} as const
export const policyParameters = {
  expected_revision: integer,
  policy: { type: 'object', required: true, additionalProperties: false, properties: policyProperties },
  reason: text,
} as const
export const evidenceParameters = {
  type: 'array',
  required: true,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: { sessionId: text, revision: text, fromSeq: integer, throughSeq: integer },
  },
} as const
export function check(properties: Parameters<typeof validateArgs>[0], value: unknown): void {
  const issues = validateArgs(
    { input: { type: 'object', required: true, additionalProperties: false, properties } },
    { input: value },
  )
  if (issues.length) throw new Error(issues.join('; '))
}
