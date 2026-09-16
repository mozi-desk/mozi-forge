/** Shared long-running analysis limits. Context bytes are a conservative token upper bound. */
export const ANALYSIS_OUTPUT_TOKENS = 5_000_000
export const ANALYSIS_STEPS = 5_000
export const ANALYSIS_CONTEXT_BYTES = 8 * 1024 * 1024
export function requestLimits(contextWindow = 128_000, configuredMaxTokens?: number) {
  const window = Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : 128_000
  const outputTokens = Math.max(1, Math.floor(window / 4))
  return {
    contextWindow: window,
    contextBytes: Math.min(ANALYSIS_CONTEXT_BYTES, Math.floor(window * 3 / 4)),
    maxRequestOutputTokens: Math.min(configuredMaxTokens ?? outputTokens, outputTokens),
  }
}
