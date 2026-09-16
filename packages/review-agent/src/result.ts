/**
 * Purpose: Define the native independent-review verdict, finding fields and enums.
 * Model tools and ReviewService share this schema and its inferred types.
 * Example: findings:[null] yields result.findings[0] before a review is saved;
 * a typed request-changes verdict proceeds to evidence and completeness checks.
 * This parser performs no I/O; semantic review gates belong to ReviewService.
 */
import { validateArgs, type InferArgs, type InferValue } from '@deepseek-ai/dsh-tools'

export const reviewFindingSchema = { type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', required: true, enum: ['goal-substitution', 'weakened-evaluation', 'overfitting', 'cherry-picking', 'coverage-loss', 'insufficient-evidence'] },
  evidenceRefs: { type: 'array', required: true, items: { type: 'string' }, description: 'At least one nonempty reference to the frozen review evidence.' },
  impact: { type: 'string', required: true, description: 'Nonempty description of the consequence for the original goal.' },
  remedy: { type: 'string', required: true, description: 'Nonempty actionable correction or requested evidence.' },
} } as const

export const reviewResultParameters = {
  verdict: { type: 'string', required: true, enum: ['pass', 'request-changes', 'insufficient-evidence'] },
  summary: { type: 'string', required: true, description: 'Nonempty conclusion grounded in the complete frozen evidence.' },
  findings: { type: 'array', required: true, items: reviewFindingSchema, description: 'pass requires an empty array; other verdicts require at least one evidenced finding.' },
} as const
export type ReviewFinding = InferValue<typeof reviewFindingSchema>
export type ReviewResult = InferArgs<typeof reviewResultParameters>

/** Validate nested review shape before result persistence or result-listener delivery. */
export function parseReviewResult(value: unknown): ReviewResult {
  const issues = validateArgs({ result: { type: 'object', required: true, additionalProperties: false, properties: reviewResultParameters } }, { result: value })
  if (issues.length) throw new Error(JSON.stringify({ code: 'INVALID_REVIEW_RESULT', issues, repair: 'Supply verdict, summary and typed findings with the declared nested fields.' }))
  return structuredClone(value) as ReviewResult
}
