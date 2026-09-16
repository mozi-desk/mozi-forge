import { describe, expect, it } from 'vitest'
import {
  agentTestProcessDisplayStatus,
  agentTestProcessIsActive,
  orderedAgentTestProcesses,
} from '../src/client.js'
import type { AgentTestProcessView } from '../src/types.js'

function process(runId: string, lifecycle: AgentTestProcessView['lifecycle'], startedAt: number): AgentTestProcessView {
  return {
    runId,
    jobId: `agent-test-${runId}`,
    suite: 'fixture',
    repeat: 1,
    lifecycle,
    testStatus: lifecycle === 'exited' ? 'passed' : 'running',
    progress: lifecycle,
    startedAt,
    ...(lifecycle === 'exited' ? { finishedAt: startedAt + 10 } : {}),
    runRoot: `/runs/${runId}`,
    stdoutLog: `/runs/${runId}/stdout.log`,
    stderrLog: `/runs/${runId}/stderr.log`,
    reportPath: `/runs/${runId}/report.md`,
  }
}

describe('agent-test browser process panel', () => {
  it('orders live processes before newest terminal history and marks orphaned live records stale', () => {
    const oldFinished = process('old', 'exited', 10)
    const live = process('live', 'running', 20)
    const newFinished = process('new', 'exited', 30)
    expect(orderedAgentTestProcesses([oldFinished, newFinished, live]).map(item => item.runId)).toEqual([
      'live', 'new', 'old',
    ])
    expect(agentTestProcessDisplayStatus(live, false, new Set())).toBe('running')
    expect(agentTestProcessDisplayStatus(live, true, new Set())).toBe('stale / aborted')
    expect(agentTestProcessIsActive(live, true, new Set())).toBe(false)
    expect(agentTestProcessDisplayStatus(live, true, new Set([live.jobId!]))).toBe('running')
    expect(agentTestProcessIsActive(live, true, new Set([live.jobId!]))).toBe(true)
    expect(agentTestProcessDisplayStatus(newFinished, true, new Set())).toBe('passed')
  })
})
