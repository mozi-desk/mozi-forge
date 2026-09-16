import { describe, expect, it } from 'vitest'
import { ANALYSIS_OUTPUT_TOKENS, ANALYSIS_STEPS, requestLimits } from '../src/budgets.js'
describe('model-aware analysis budget policy', () => {
  it('allows five million cumulative tokens while respecting each model window', () => {
    expect(ANALYSIS_OUTPUT_TOKENS).toBe(5_000_000)
    expect(ANALYSIS_STEPS).toBe(5_000)
    expect(requestLimits(1_000_000, 256_000)).toEqual({ contextWindow: 1_000_000, contextBytes: 750_000, maxRequestOutputTokens: 250_000 })
    expect(requestLimits(80_000, 32_000)).toEqual({ contextWindow: 80_000, contextBytes: 60_000, maxRequestOutputTokens: 20_000 })
    expect(requestLimits(1_000_000, 8192).maxRequestOutputTokens).toBe(8192)
    expect(requestLimits()).toEqual({ contextWindow: 128_000, contextBytes: 96_000, maxRequestOutputTokens: 32_000 })
  })
})
