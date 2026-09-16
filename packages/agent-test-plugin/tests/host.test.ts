import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Commands from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTestService } from '../src/host.js'
import { emptyMetrics } from '../src/metrics.js'
import type { AgentTestRunResult } from '../src/types.js'

class StubJobs extends Service {
  constructor(ctx: Context) {
    super(ctx, 'jobs')
  }

  attachController(): () => void { return () => undefined }
  onJobDone(): () => void { return () => undefined }
}

afterEach(() => vi.unstubAllEnvs())

describe('/agent-test human command', () => {
  it('records a human-only review verdict, note, time, and source session', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-test-command-project-'))
    const runtimeHome = await mkdtemp(join(tmpdir(), 'agent-test-command-home-'))
    vi.stubEnv('DSH_HOME', runtimeHome)
    const runId = '20260828010101-1234abcd'
    const runRoot = join(runtimeHome, 'agent-tests/runs', runId)
    await mkdir(runRoot, { recursive: true })
    await mkdir(join(projectRoot, 'tests/agent-evals'), { recursive: true })
    await mkdir(join(projectRoot, 'config/presets/coding'), { recursive: true })
    await writeFile(join(projectRoot, 'config/presets/coding/agent.cordis.yml'), '[]\n')
    await writeFile(join(projectRoot, 'tests/agent-evals/preflight.yml'), `version: 1
id: preflight
name: Preflight fixture
preset: coding
cases:
  - id: one
    name: One
    turns: [{ id: prompt, prompt: inspect }]
`)
    const metrics = emptyMetrics()
    const result: AgentTestRunResult = {
      version: 1,
      runId,
      suite: 'fixture',
      repeat: 1,
      sourceDigest: 'fixture-source-digest',
      status: 'waiting-human',
      automaticVerdict: 'passed',
      startedAt: 1,
      finishedAt: 2,
      snapshotRoot: join(runRoot, 'snapshot'),
      dshHome: join(runRoot, 'dsh-home'),
      attempts: [],
      metrics,
      repeats: {
        total: 1,
        passed: 1,
        passRate: 1,
        elapsedMs: { mean: 0, p50: 0, p95: 0 },
        outputTokens: { mean: 0, p50: 0, p95: 0 },
        toolCalls: { mean: 0, p50: 0, p95: 0 },
      },
      humanReview: {
        required: true,
        status: 'pending',
        items: [{
          caseId: 'case-a',
          repeat: 1,
          title: 'Human check',
          instructions: 'Inspect it.',
          checklist: ['looks correct'],
          artifacts: [{ label: 'Report', path: join(runRoot, 'report.md') }, { label: 'Binary', path: join(runRoot, 'binary.bin') }],
        }],
      },
    }
    await writeFile(join(runRoot, 'result.json'), JSON.stringify(result))
    await writeFile(join(runRoot, 'dsh-process.json'), JSON.stringify({ version: 1, ownerSessionId: 'test-owner-session', process: { runId, suite: 'fixture', repeat: 1, lifecycle: 'exited', testStatus: 'waiting-human', progress: 'review', startedAt: 1, finishedAt: 2, runRoot, stdoutLog: join(runRoot, 'dsh.stdout.log'), stderrLog: join(runRoot, 'dsh.stderr.log'), reportPath: join(runRoot, 'report.md') } }))

    const ctx = new Context()
    await ctx.plugin(Commands)
    await ctx.plugin(StubJobs)
    await ctx.plugin(AgentTestService, { projectRoot })
    await expect(ctx.agentTests.preflight('preflight')).resolves.toMatchObject({
      valid: true,
      allCasesRequireHumanReview: false,
      checks: expect.arrayContaining(['schema', 'input-provenance']),
    })
    const appended: Array<{ type: string; data: unknown }> = []
    const ownerAgent = {
      id: SessionId('test-owner-session'),
      session: { append: () => undefined },
    } as unknown as Agent
    const reportText = '中文行\n'.repeat(6000)
    await writeFile(join(runRoot, 'report.md'), reportText)
    const page = await ctx.agentTests.readArtifact(runId, join(runRoot, 'report.md'), ownerAgent, { limit: 13 }) as { content: string; nextOffset: number; totalBytes: number; sha256: string }
    expect(page.content).not.toContain('�')
    expect(page.totalBytes).toBe(Buffer.byteLength(reportText))
    const next = await ctx.agentTests.readArtifact(runId, 'report.md', ownerAgent, { offset: page.nextOffset, limit: 13 }) as { content: string; sha256: string }
    expect(next.sha256).toBe(page.sha256)
    expect(reportText.startsWith(page.content + next.content)).toBe(true)
    const binary = Buffer.from([0, 255, 128, 2, 3])
    await writeFile(join(runRoot, 'binary.bin'), binary)
    const binaryPage = await ctx.agentTests.readArtifact(runId, 'binary.bin', ownerAgent, { limit: 4 }) as { encoding: string; content: string; totalBytes: number; nextOffset: number }
    expect(binaryPage).toMatchObject({ encoding: 'base64', totalBytes: 5, nextOffset: 3 })
    expect(Buffer.from(binaryPage.content, 'base64')).toEqual(binary.subarray(0, 3))
    await expect(ctx.agentTests.readArtifact(runId, 'result.json', { id: SessionId('other-owner') } as Agent, {})).rejects.toThrow(/owner/u)
    await expect(ctx.agentTests.readArtifact(runId, '../result.json', ownerAgent, {})).rejects.toThrow(/outside/u)
    await expect(ctx.agentTests.readArtifact(runId, '.env', ownerAgent, {})).rejects.toThrow(/protected/u)
    await symlink(projectRoot, join(runRoot, 'escape'))
    await expect(ctx.agentTests.readArtifact(runId, 'escape/package.json', ownerAgent, {})).rejects.toThrow(/outside/u)
    await writeFile(join(runRoot, 'unregistered.txt'), 'not a registered artifact')
    await expect(ctx.agentTests.readArtifact(runId, 'unregistered.txt', ownerAgent, {})).rejects.toThrow(/registered artifact/u)
    const reviewerAgent = {
      id: SessionId('human-review-session'),
      session: { append: (type: string, data: unknown) => { appended.push({ type, data }) } },
    } as unknown as Agent

    const ownerStatus = await ctx.commands.execute(
      ownerAgent,
      `/agent-test status ${runId}`,
      [],
      new AbortController().signal,
    )
    expect(ownerStatus?.result.kind).toBe('success')
    const execution = await ctx.commands.execute(
      reviewerAgent,
      `/agent-test review ${runId} pass --note "looks good"`,
      [],
      new AbortController().signal,
    )
    expect(execution?.result.kind).toBe('success')
    const view = JSON.parse(execution?.result.text ?? '{}') as { status?: string; humanReview?: { status?: string } }
    expect(view).toMatchObject({ status: 'passed', humanReview: { status: 'passed' } })
    const stored = JSON.parse(await readFile(join(runRoot, 'result.json'), 'utf8')) as AgentTestRunResult
    expect(stored.humanReview).toMatchObject({
      status: 'passed',
      reviewedBySessionId: 'human-review-session',
      note: 'looks good',
    })
    expect(stored.humanReview.reviewedAt).toEqual(expect.any(Number))
    expect(appended.map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(await readFile(join(runRoot, 'review.md'), 'utf8')).toContain('Note: looks good')
    await expect(ctx.agentTests.review(runId, 'fail', 'other-human-session')).rejects.toThrow(/not waiting for human review/u)

    const concurrentId = '20260828010103-1234abcd'
    const concurrentRoot = join(runtimeHome, 'agent-tests/runs', concurrentId)
    await mkdir(concurrentRoot, { recursive: true })
    await writeFile(join(concurrentRoot, 'result.json'), JSON.stringify({
      ...structuredClone(result),
      runId: concurrentId,
      snapshotRoot: join(concurrentRoot, 'snapshot'),
      dshHome: join(concurrentRoot, 'dsh-home'),
    }))
    const concurrent = await Promise.allSettled([
      ctx.agentTests.review(concurrentId, 'pass', 'human-a', 'first-a'),
      ctx.agentTests.review(concurrentId, 'fail', 'human-b', 'first-b'),
    ])
    expect(concurrent.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(concurrent.filter(item => item.status === 'rejected')).toHaveLength(1)
    const concurrentStored = JSON.parse(await readFile(join(concurrentRoot, 'result.json'), 'utf8')) as AgentTestRunResult
    expect(['human-a', 'human-b']).toContain(concurrentStored.humanReview.reviewedBySessionId)
    expect(concurrentStored.humanReview.status).not.toBe('pending')

    const cancelledId = '20260828010109-1234abcd'
    const cancelledRoot = join(runtimeHome, 'agent-tests/runs', cancelledId)
    await mkdir(cancelledRoot, { recursive: true })
    await writeFile(join(cancelledRoot, 'result.json'), JSON.stringify({ ...structuredClone(result), runId: cancelledId, status: 'waiting-human', humanReview: { ...result.humanReview, status: 'pending' } }))
    expect((await ctx.agentTests.cancel(cancelledId)).status).toBe('cancelled')
    await expect(ctx.agentTests.review(cancelledId, 'pass', 'human')).rejects.toThrow('not waiting')
    expect(JSON.parse(await readFile(join(cancelledRoot, 'result.json'), 'utf8')).status).toBe('cancelled')

    const trialId = '20260828010102-1234abcd'
    const trialRoot = join(runtimeHome, 'agent-tests/runs', trialId)
    await mkdir(trialRoot, { recursive: true })
    const trial: AgentTestRunResult = {
      ...structuredClone(result),
      runId: trialId,
      planId: 'trainer-20260828010101-1234abcd',
      status: 'passed',
      snapshotRoot: join(trialRoot, 'snapshot'),
      dshHome: join(trialRoot, 'dsh-home'),
      humanReview: { ...structuredClone(result.humanReview), status: 'pending' },
    }
    await writeFile(join(trialRoot, 'result.json'), JSON.stringify(trial))
    await expect(ctx.agentTests.review(trialId, 'pass', 'human-review-session')).resolves.toMatchObject({
      status: 'passed',
      humanReview: { status: 'passed', reviewedBySessionId: 'human-review-session' },
    })

    await expect(ctx.agentTests.review('20260828010104-1234abcd', 'pass', 'human-review-session')).rejects.toThrow(/agent test run not found/u)
    await ctx.fiber.dispose()
  })
})
