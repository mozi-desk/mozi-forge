/** Native question fields; Markdown carries the domain content. */
import { validateArgs } from '@deepseek-ai/dsh-tools'
import type { HumanRequestSubmitInput } from './types.js'
export const humanRequestParameters = {
  body: { type: 'string', required: true, description: 'Markdown question, evidence and requested decision.' },
  title: { type: 'string' }, type: { type: 'string' }, planId: { type: 'string' }, requestId: { type: 'string' },
} as const
export function parseHumanRequest(value: unknown): HumanRequestSubmitInput {
  const issues = validateArgs({ request: { type: 'object', required: true, additionalProperties: false, properties: humanRequestParameters } }, { request: value })
  if (issues.length) throw new Error(issues.join('; '))
  const input = value as HumanRequestSubmitInput
  if (!input.body.trim()) throw new Error('body must not be empty')
  return structuredClone(input)
}
