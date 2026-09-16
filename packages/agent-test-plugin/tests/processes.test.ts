import { describe, expect, it } from 'vitest'
import {
  parseAgentTestProcess,
  parseAgentTestProcessRecord,
  upsertAgentTestProcess,
} from '../src/processes.js'
import type { AgentTestProcessView } from '../src/types.js'

function process(runId: string, lifecycle: AgentTestProcessView['lifecycle']): AgentTestProcessView {
  return {
    runId,
    suite: 'fixture',
    repeat: 1,
    lifecycle,
    testStatus: lifecycle === 'exited' ? 'passed' : 'running',
    progress: lifecycle,
    startedAt: 1,
    runRoot: `/runs/${runId}`,
    stdoutLog: `/runs/${runId}/stdout.log`,
    stderrLog: `/runs/${runId}/stderr.log`,
    reportPath: `/runs/${runId}/report.md`,
  }
}

describe('Agent Test process records', () => {
  it('replaces a run without dropping other process history', () => {
    const running = process('run-a', 'running')
    const other = process('run-b', 'exited')
    const exited = { ...running, lifecycle: 'exited' as const, testStatus: 'passed' as const, finishedAt: 2 }
    expect(upsertAgentTestProcess([running, other], exited)).toEqual([other, exited])
  })

  it('validates persisted process records', () => {
    expect(parseAgentTestProcess(process('run-a', 'queued'))).toMatchObject({ runId: 'run-a', lifecycle: 'queued' })
    expect(() => parseAgentTestProcess({ runId: 'run-a', lifecycle: 'unknown' })).toThrow()
    expect(parseAgentTestProcessRecord({
      version: 1,
      ownerSessionId: 'session-owner',
      process: process('run-a', 'queued'),
    })).toMatchObject({ ownerSessionId: 'session-owner', process: { runId: 'run-a' } })
  })
})
