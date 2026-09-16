export interface TokenTotals {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ToolBucket {
  calls: number
  failed: number
  incomplete: number
}

export interface ToolMetrics extends ToolBucket {
  failureRate: number
  byName: Record<string, ToolBucket>
}

export interface SessionMetrics {
  elapsedMs: number
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  tokens: TokenTotals
  tools: ToolMetrics
}

export interface Distribution {
  mean: number
  p50: number
  p95: number
}

