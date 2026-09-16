/**
 * Purpose: Validate and order durable evaluation-process records.
 * Example: a completed record replaces the same run while preserving other history.
 */
import { z } from 'zod'
import type { AgentTestProcessRecord, AgentTestProcessView } from './types.js'

const lifecycle = z.enum(['queued', 'starting', 'running', 'stopping', 'exited'])
const testStatus = z.enum(['running', 'failed', 'waiting-human', 'passed', 'review-failed', 'cancelled'])

export const agentTestProcessSchema = z.object({
  runId: z.string(),
  jobId: z.string().optional(),
  suite: z.string(),
  repeat: z.number().int().positive(),
  planId: z.string().optional(),
  lifecycle,
  testStatus,
  progress: z.string(),
  pid: z.number().int().positive().optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  startedAt: z.number().int().nonnegative(),
  readyAt: z.number().int().nonnegative().optional(),
  finishedAt: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().nullable().optional(),
  signalCode: z.string().nullable().optional(),
  runRoot: z.string(),
  stdoutLog: z.string(),
  stderrLog: z.string(),
  reportPath: z.string(),
})

export const agentTestProcessListSchema = z.array(agentTestProcessSchema)

export const agentTestProcessRecordSchema = z.object({
  version: z.literal(1),
  ownerSessionId: z.string().optional(),
  process: agentTestProcessSchema,
})

export function parseAgentTestProcess(value: unknown): AgentTestProcessView {
  return agentTestProcessSchema.parse(value) as AgentTestProcessView
}

export function parseAgentTestProcessRecord(value: unknown): AgentTestProcessRecord {
  return agentTestProcessRecordSchema.parse(value) as AgentTestProcessRecord
}

export function upsertAgentTestProcess(
  processes: readonly AgentTestProcessView[],
  process: AgentTestProcessView,
): AgentTestProcessView[] {
  const next = processes.filter(candidate => candidate.runId !== process.runId)
  next.push(structuredClone(process))
  return next.sort((left, right) => left.startedAt - right.startedAt)
}
