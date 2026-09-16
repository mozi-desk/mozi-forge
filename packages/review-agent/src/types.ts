/** Frozen review inputs, schema-derived verdicts and persisted review lifecycle. */
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ReviewResult } from './result.js'
export type { ReviewResult, ReviewFinding } from './result.js'
export interface ReviewInput { key: string; agentOptions?: AgentOptions; sections: Record<string, unknown> }
export interface ReviewRun extends ReviewInput {
  id: string; sessionId: string; attempt?: number; status: 'running' | 'completed' | 'paused' | 'cancelled'; createdAt: number; readSections?: string[]; readProgress?: Record<string, number>; result?: ReviewResult; error?: string
}
