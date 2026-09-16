/** Plan structure accepts flexible Markdown while retaining usable numeric allowances. */
import { expect, it } from 'vitest'
import { parsePlan } from '../src/plan.js'
it('accepts prose without prescribed headings and diagnoses malformed budgets', () => {
  expect(parsePlan({ description: 'Improve the observed Agent behavior.', title: 'Improve', body: 'Measure and optimize.' }).body).toBe('Measure and optimize.')
  expect(() => parsePlan({ description: 'Improve the observed Agent behavior.', title: 'Improve', body: 'Measure', tokenBudget: -1 })).toThrow()
  expect(() => parsePlan({ description: 'Improve the observed Agent behavior.', title: 'Improve', body: null })).toThrow()
})
