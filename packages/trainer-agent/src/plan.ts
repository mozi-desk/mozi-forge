/** Plan tool contract: a Markdown document and two advisory training allowances. */
import { validateArgs } from '@deepseek-ai/dsh-tools'
import type { PlanInput } from './types.js'
export const planParameters = {
  id: { type: 'string' }, title: { type: 'string', required: true }, description: { type: 'string', required: true }, body: { type: 'string', required: true },
  sourceSessions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string', required: true }, revision: { type: 'string', required: true } } } },
  tokenBudget: { type: 'integer', description: 'Advisory total model tokens; default 10000000.' },
  iterationBudget: { type: 'integer', description: 'Advisory iterations; default 3.' },
} as const
export function parsePlan(value: unknown): PlanInput {
  const issues = validateArgs({ plan: { type: 'object', required: true, additionalProperties: false, properties: planParameters } }, { plan: value })
  if (issues.length) throw new Error(issues.join('; '))
  const plan = value as PlanInput
  if (!plan.title.trim() || !plan.description.trim() || !plan.body.trim()) throw new Error('title, description and body are required')
  for (const v of [plan.tokenBudget, plan.iterationBudget]) if (v !== undefined && (!Number.isSafeInteger(v) || v <= 0)) throw new Error('Budgets must be positive integers')
  return structuredClone(plan)
}
