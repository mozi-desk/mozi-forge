/**
 * Purpose: Execute isolated Agent Test jobs and associate optional training plan IDs.
 * Flow: start saves a process record, the runner snapshots source, and human test
 * answers update results through the shared request service. Example: plan p1 stores
 * its baseline in trainning/p1/evaluations; status reads the same evidence after restart.
 */
import { createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-commands'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { safeId } from '@mozi-forge/human-request-plugin/host'
import { registerRpcChannel } from '@mozi-forge/human-request-plugin/rpc-channel'
import { symlink } from 'node:fs/promises'
import type { HumanRequestService } from '@mozi-forge/human-request-plugin/host'
import { artifactPage, containedPath, protectedPath, type ReadPosition } from './inspection.js'
import { loadSuites } from './definition.js'
import {
  parseAgentTestProcess,
  parseAgentTestProcessRecord,
  upsertAgentTestProcess,
} from './processes.js'
import { AgentTestEngine, atomicJson, completionOutput, computeProjectSourceDigest, reportMarkdown, reviewMarkdown } from './runner.js'
import type {
  AgentTestProcessRecord,
  AgentTestProcessView,
  AgentTestRunResult,
  AgentTestRunView,
  AgentTestSuite,
  HumanReview,
} from './types.js'

export const name = 'mozi-agent-test-host'

export interface Config {
  projectRoot: string
  suiteDirectory?: string
  startupTimeoutMs?: number
  evaluationPatch?: string
  defaultSuite?: string
  pluginExports?: Record<string, string>
  additionalPackages?: string[]
  snapshotExclude?: string[]
}

export const Config: z<Config> = z.object({
  projectRoot: z.string().required(),
  suiteDirectory: z.string(),
  startupTimeoutMs: z.number().step(1).min(1).default(30_000),
  evaluationPatch: z.string(),
  defaultSuite: z.string(),
  pluginExports: z.dict(z.string()),
  additionalPackages: z.array(z.string()),
  snapshotExclude: z.array(z.string()),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTests: AgentTestService
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'agent-test': 'agent-test'
  }
}

interface ActiveRun extends AgentTestRunView {
  sourceRoot?: string
  owner?: Agent
  controller: AbortController
  child: ChildProcess | undefined
  done?: Promise<JobOutcome>
  processWrite: Promise<void>
}

export interface AgentTestStartOptions {
  sourceRoot?: string
  runId?: string
  operationId?: string
  planId?: string
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emptyReview(): HumanReview {
  return { required: false, status: 'not-required', items: [] }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validRunId(runId: string): string {
  if (!/^\d{14}-[0-9a-f]{8}$/u.test(runId)) throw new Error(`invalid agent test run id: ${runId}`)
  return runId
}

function runId(): string {
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/gu, '').slice(0, 14)
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`
}

function tokens(input: string): string[] {
  const result: string[] = []
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/gu
  for (const match of input.matchAll(pattern)) result.push((match[1] ?? match[2] ?? match[3] ?? '').replaceAll(/\\([\\"'])/gu, '$1'))
  return result
}

function option(values: readonly string[], flag: string): string | undefined {
  const index = values.indexOf(flag)
  if (index === -1) return undefined
  const value = values[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function repeatValue(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10) throw new Error('repeat must be an integer from 1 to 10')
  return parsed
}

function timeoutValue(value: string | undefined): number {
  const parsed = value === undefined ? 30_000 : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 600_000) throw new Error('timeout-ms must be an integer from 1 to 600000')
  return parsed
}

function render(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export class AgentTestService extends Service {
  static inject = ['commands', 'jobs']
  static Config = Config
  private readonly active = new Map<string, ActiveRun>()
  private readonly defaultSuite: string | undefined
  private readonly projectRoot: string
  private readonly suiteDirectory: string
  private readonly artifactsRoot: string
  private readonly engine: AgentTestEngine
  private readonly processLists = new Map<string, AgentTestProcessView[]>()
  private readonly processListsReady: Promise<void>
  private readonly reviewQueues = new Map<string, Promise<AgentTestRunView>>()
  private humanRequestService: HumanRequestService | undefined

  constructor(private readonly hostContext: Context, config: Config) {
    super(hostContext, 'agentTests')
    this.defaultSuite = config.defaultSuite
    this.projectRoot = resolve(config.projectRoot)
    this.suiteDirectory = resolve(this.projectRoot, config.suiteDirectory ?? 'tests/agent-evals')
    const dshHome = resolve(process.env.DSH_HOME ?? join(this.projectRoot, '.runtime'))
    this.artifactsRoot = join(dshHome, 'agent-tests')
    this.engine = new AgentTestEngine({
      ...config,
      projectRoot: this.projectRoot,
      startupTimeoutMs: config.startupTimeoutMs ?? 30_000,
      ...(config.evaluationPatch === undefined ? {} : { evaluationPatch: resolve(this.projectRoot, config.evaluationPatch) }),
    })
    this.processListsReady = this.restoreProcessLists()

    hostContext.inject(['humanRequests'], humanContext => {
      this.humanRequestService = humanContext.humanRequests
      humanContext.on('human-request/answered', async request => {
        if (request.type === 'test-review' && request.id.startsWith('test-')) await this.reconcileReview(request.id.slice(5))
      })
      void this.list().then(async views => {
        for (const view of views) await this.reconcileReview(view.runId)
        for (const view of views) if (view.planId !== undefined && view.result !== undefined && !view.result.humanReview.required) await this.notifyCompleted(view)
      }).catch(error => this.hostContext.logger.warn('agent-test notification recovery failed: %s', errorText(error)))
      return () => { if (this.humanRequestService === humanContext.humanRequests) this.humanRequestService = undefined }
    })

    hostContext.inject(['connection', 'webServer'], (connectionContext) => {
      registerRpcChannel(connectionContext, '/mozi-agent-tests', async (endpoint, payload) => {
        const sessionId = typeof payload === 'object' && payload !== null
          ? (payload as { sessionId?: unknown }).sessionId
          : undefined
        if (endpoint !== 'processes' || typeof sessionId !== 'string' || sessionId.length === 0) {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'agent test process request requires endpoint "processes" and a sessionId',
              details: { issues: [] },
            },
          }
        }
        await this.processListsReady
        return { ok: true, value: structuredClone(this.processLists.get(sessionId) ?? []) }
      })
    })

    hostContext.effect(() => hostContext.jobs.attachController('mozi-agent-test-host'))
    hostContext.effect(() => hostContext.jobs.onJobDone((snapshot, owner) => {
      if (snapshot.kind !== 'agent-test' || owner === undefined) return
      const run = [...this.active.values()].find(candidate => candidate.jobId === snapshot.id)
      if (run?.result === undefined || run.result.humanReview.required || run.planId !== undefined) return
      const text = completionOutput(run.result)
      owner.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: name, form: 'notice', summary: boundContextSummary(`Agent test ${run.suite}: ${run.status}`) },
      }))
    }))
    hostContext.effect(() => hostContext.commands.register({
      name: 'agent-test',
      description: 'Run, inspect, cancel, and human-review isolated real-LLM agent tests.',
      input: { hint: 'list | run <suite> [--repeat N] | status <run-id> | wait <run-id> [--timeout-ms N] | cancel <run-id> | review <run-id> <pass|fail> [--note TEXT]' },
      handler: async invocation => {
        try {
          return { kind: 'success' as const, text: await this.command(invocation.rawInput, invocation.agent, invocation.signal) }
        } catch (error: unknown) {
          return { kind: 'error' as const, text: errorText(error) }
        }
      },
    }))
  }

  async suites(): Promise<Array<{ id: string; name: string; cases: number; preset: string; defaultRepeat: number }>> {
    return [...(await loadSuites(this.suiteDirectory)).values()].map(suite => ({
      id: suite.id,
      name: suite.name,
      cases: suite.cases.length,
      preset: suite.preset,
      defaultRepeat: suite.defaults.repeat,
    }))
  }

  async preflight(suiteId: string, sourceRoot = this.projectRoot): Promise<{
    suite: string
    sourcePath: string
    valid: true
    cases: number
    turns: number
    reviewCases: number
    allCasesRequireHumanReview: boolean
    checks: string[]
  }> {
    const suite = (await loadSuites(sourceRoot === this.projectRoot ? this.suiteDirectory : join(sourceRoot, 'tests/agent-evals'))).get(suiteId)
    if (suite === undefined) throw new Error(`unknown agent test suite: ${suiteId}`)
    const presetPath = join(sourceRoot, 'config', 'presets', suite.preset, 'agent.cordis.yml')
    await readFile(presetPath, 'utf8')
    for (const testCase of suite.cases) {
      if (testCase.input !== undefined) {
        if (!testCase.turns.some(turn => turn.prompt.includes('{{input.json}}'))) throw new Error(`${testCase.id}: input is not injected into a prompt`)
        if (!testCase.turns.some(turn => turn.expect?.files?.some(file => file.dataProvenance !== undefined))) {
          throw new Error(`${testCase.id}: structured input requires at least one dataProvenance assertion`)
        }
      }
    }
    return {
      suite: suite.id,
      sourcePath: suite.sourcePath,
      valid: true,
      cases: suite.cases.length,
      turns: suite.cases.reduce((total, testCase) => total + testCase.turns.length, 0),
      reviewCases: suite.cases.filter(testCase => testCase.review?.required === true).length,
      allCasesRequireHumanReview: suite.cases.length > 0 && suite.cases.every(testCase => testCase.review?.required === true),
      checks: ['schema', 'preset', 'templates', 'assertions', 'budgets', 'artifacts', 'review-deduplication', 'input-provenance'],
    }
  }

  async projectSourceDigest(sourceRoot = this.projectRoot): Promise<string> {
    return await computeProjectSourceDigest(sourceRoot)
  }

  async list(): Promise<AgentTestRunView[]> {
    const result = new Map<string, AgentTestRunView>()
    for (const run of this.active.values()) result.set(run.runId, this.publicView(run))
    const runsRoot = join(this.artifactsRoot, 'runs')
    try {
      for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
        if ((!entry.isDirectory() && !entry.isSymbolicLink()) || result.has(entry.name)) continue
        try { result.set(entry.name, await this.readCompleted(entry.name)) } catch { /* incomplete/corrupt runs stay out of list */ }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return [...result.values()].sort((left, right) => right.startedAt - left.startedAt).map(json)
  }

  async start(suiteId = this.defaultSuite, repeat?: number, owner?: Agent, options: AgentTestStartOptions = {}): Promise<AgentTestRunView> {
    if (!suiteId) throw new Error('Specify a suite ID or configure defaultSuite')
    await this.processListsReady
    const suites = await loadSuites(options.sourceRoot === undefined ? this.suiteDirectory : join(options.sourceRoot, 'tests/agent-evals'))
    const suite = suites.get(suiteId)
    if (suite === undefined) throw new Error(`unknown agent test suite: ${suiteId}`)
    const count = repeatValue(repeat === undefined ? undefined : String(repeat), suite.defaults.repeat)
    const id = options.runId === undefined ? runId() : validRunId(options.runId)
    const runRoot = options.planId ? join(dirname(this.artifactsRoot), 'trainning', safeId(options.planId), 'evaluations', id) : join(this.artifactsRoot, 'runs', id)
    await mkdir(join(this.artifactsRoot, 'runs'), { recursive: true })
    await mkdir(dirname(runRoot), { recursive: true })
    await mkdir(runRoot)
    if (options.planId) await symlink(runRoot, join(this.artifactsRoot, 'runs', id), 'dir')
    await atomicJson(join(runRoot, 'start.json'), { runId: id, suite: suite.id, repeat: count, ownerSessionId: owner === undefined ? undefined : String(owner.id), ...options })
    const active: ActiveRun = {
      ...(options.sourceRoot === undefined ? {} : { sourceRoot: options.sourceRoot }),
      runId: id,
      ...(owner === undefined ? {} : { ownerSessionId: String(owner.id) }),
      suite: suite.id,
      repeat: count,
      ...(options.planId === undefined ? {} : { planId: options.planId }),
      status: 'running',
      startedAt: Date.now(),
      runRoot,
      progress: 'queued',
      humanReview: emptyReview(),
      ...(owner === undefined ? {} : { owner }),
      controller: new AbortController(),
      child: undefined,
      processWrite: Promise.resolve(),
    }
    let resolveDone!: (outcome: JobOutcome) => void
    const done = new Promise<JobOutcome>(resolveOutcome => { resolveDone = resolveOutcome })
    active.done = done
    const jobId = this.hostContext.jobs.start({
      kind: 'agent-test',
      label: `${suite.id} x${String(count)}`,
      outputLimitBytes: 32_768,
      ...(owner === undefined ? {} : { owner }),
      run: () => {
        queueMicrotask(() => void this.execute(active, suite, resolveDone))
        return {
          cancel: reason => {
            active.progress = reason === undefined ? 'cancellation requested' : `cancellation requested: ${reason}`
            this.updateProcess(active, { lifecycle: 'stopping', progress: active.progress })
            active.controller.abort(new Error(reason ?? 'agent test cancelled'))
            active.child?.kill('SIGTERM')
          },
          done,
        }
      },
    })
    active.jobId = jobId
    active.process = {
      runId: id,
      jobId,
      suite: suite.id,
      repeat: count,
      ...(options.planId === undefined ? {} : { planId: options.planId }),
      lifecycle: 'queued',
      testStatus: 'running',
      progress: active.progress,
      startedAt: active.startedAt,
      runRoot: active.runRoot,
      stdoutLog: join(active.runRoot, 'dsh.stdout.log'),
      stderrLog: join(active.runRoot, 'dsh.stderr.log'),
      reportPath: join(active.runRoot, 'report.md'),
    }
    this.active.set(id, active)
    this.publishProcess(active)
    return json(this.publicView(active))
  }

  async status(id: string, caller?: Agent): Promise<AgentTestRunView> {
    validRunId(id)
    await this.reconcileReview(id)
    const active = this.active.get(id)
    if (active !== undefined) {
      if (active.status === 'running' && active.jobId !== undefined) this.hostContext.jobs.get(JobId(active.jobId), caller)
      return json(this.publicView(active))
    }
    return json(await this.readCompleted(id))
  }

  private async reconcileReview(id: string): Promise<void> {
    if (!this.humanRequestService) return
    const request = await this.humanRequestService.read(`test-${id}`).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return undefined })
    if (!request?.response) return
    const current = this.active.get(id)
    const view = current ? this.publicView(current) : await this.readCompleted(id)
    if (view.status !== 'waiting-human') return
    const answer = request.response.body.trim()
    if (answer === '通过验收' || answer.startsWith('未通过：')) await this.review(id, answer === '通过验收' ? 'pass' : 'fail', request.sessionId, answer)
  }

  async readArtifact(id: string, path: string, caller: Agent, position: ReadPosition): Promise<unknown> {
    const view = await this.status(id, caller)
    if (view.ownerSessionId !== String(caller.id)) throw new Error('test artifact requires the run owner')
    const absolute = await containedPath(view.runRoot, path)
    const relativePath = relative(await realpath(view.runRoot), absolute)
    if (protectedPath(relativePath)) throw new Error('test artifact path is protected')
    const allowed = ['report.md', 'result.json', 'review.md', 'dsh.stdout.log', 'dsh.stderr.log',
      ...view.humanReview.items.flatMap(item => item.artifacts.map(artifact => relative(view.runRoot, artifact.path))) ]
    if (!allowed.includes(relativePath)) throw new Error('read only the report/result or a registered artifact from this run')
    if (protectedPath(relative(view.runRoot, absolute))) throw new Error('test artifact symlink target is protected')
    return { runId: id, path: absolute, ...artifactPage(await readFile(absolute), position) }
  }

  /** Freeze the registered evidence for the independent Reviewer, including failed attempts. */
  async reviewEvidence(id: string): Promise<unknown> {
    const view = await this.status(id)
    const paths = [...new Set(['report.md', ...view.humanReview.items.flatMap(item => item.artifacts.map(artifact => relative(view.runRoot, artifact.path)))])]
    const artifacts = await Promise.all(paths.map(async path => {
      try {
        const absolute = await containedPath(view.runRoot, path)
        if (protectedPath(relative(await realpath(view.runRoot), absolute))) throw new Error('protected artifact')
        const content = await readFile(absolute)
        const sha256 = createHash('sha256').update(content).digest('hex')
        return content.includes(0) ? { path, sha256, bytes: content.length, unavailable: 'Binary artifact requires human inspection' } : { path, sha256, content: content.toString('utf8') }
      } catch (error) { return { path, unavailable: errorText(error) } }
    }))
    return { run: view, artifacts }
  }

  async wait(id: string, timeoutMs = 30_000, caller?: Agent, signal?: AbortSignal): Promise<AgentTestRunView> {
    const active = this.active.get(validRunId(id))
    if (active === undefined || active.jobId === undefined || active.status !== 'running') return await this.status(id, caller)
    await this.hostContext.jobs.wait(JobId(active.jobId), timeoutValue(String(timeoutMs)), caller, signal)
    return await this.status(id, caller)
  }

  async cancel(id: string, caller?: Agent): Promise<AgentTestRunView> {
    return this.reviewAction(id, () => this.cancelOnce(id, caller))
  }

  private async cancelOnce(id: string, caller?: Agent): Promise<AgentTestRunView> {
    const active = this.active.get(validRunId(id))
    if (active?.jobId !== undefined && active.status === 'running') {
      this.hostContext.jobs.kill(JobId(active.jobId), caller, 'cancelled by agent-test caller')
      return await this.status(id, caller)
    }
    const view = await this.status(id, caller)
    if (view.status !== 'waiting-human' || view.result === undefined) return view
    view.result.status = 'cancelled'
    await atomicJson(join(view.runRoot, 'result.json'), view.result)
    await writeFile(join(view.runRoot, 'report.md'), reportMarkdown(view.result))
    if (active !== undefined) {
      active.result = view.result; active.status = 'cancelled'; active.progress = 'Human validation cancelled'
      this.updateProcess(active, { testStatus: 'cancelled', progress: active.progress })
      await active.processWrite
    }
    const updated = await this.status(id, caller)
    return updated
  }

  private updateProcess(active: ActiveRun, patch: Partial<AgentTestProcessView>): void {
    if (active.process === undefined) return
    active.process = { ...active.process, ...patch }
    this.publishProcess(active)
  }

  private publishProcess(active: ActiveRun): void {
    const process = active.process
    if (process === undefined) return
    const snapshot = structuredClone(process)
    const ownerSessionId = active.owner === undefined ? undefined : String(active.owner.session.id)
    const record: AgentTestProcessRecord = {
      version: 1,
      ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
      process: snapshot,
    }
    active.processWrite = active.processWrite
      .then(async () => {
        await mkdir(active.runRoot, { recursive: true })
        await atomicJson(join(active.runRoot, 'dsh-process.json'), record)
      })
      .catch((error: unknown) => {
        this.hostContext.logger.warn('agent-test: failed to persist process state for %s: %s', active.runId, errorText(error))
      })

    if (ownerSessionId === undefined) return
    const current = this.processLists.get(ownerSessionId) ?? []
    const processes = upsertAgentTestProcess(current, snapshot)
    this.processLists.set(ownerSessionId, processes)
  }

  async review(id: string, verdict: 'pass' | 'fail', reviewedBySessionId: string, note?: string): Promise<AgentTestRunView> {
    return this.reviewAction(id, () => this.reviewOnce(id, verdict, reviewedBySessionId, note))
  }

  private async reviewAction(id: string, action: () => Promise<AgentTestRunView>): Promise<AgentTestRunView> {
    const validId = validRunId(id)
    const previous = this.reviewQueues.get(validId)
    const current = (previous === undefined ? Promise.resolve() : previous.catch(() => undefined))
      .then(action)
    this.reviewQueues.set(validId, current)
    try {
      return await current
    } finally {
      if (this.reviewQueues.get(validId) === current) this.reviewQueues.delete(validId)
    }
  }

  private async reviewOnce(id: string, verdict: 'pass' | 'fail', reviewedBySessionId: string, note?: string): Promise<AgentTestRunView> {
    const active = this.active.get(id)
    if (active !== undefined && active.status === 'running') {
      throw new Error(`agent test run has not finished automatic testing: ${id}`)
    }
    const view = active?.result === undefined ? await this.readCompleted(id) : this.publicView(active)
    const result = view.result
    if (result === undefined || result.status === 'cancelled' || !result.humanReview.required || result.humanReview.status !== 'pending') {
      throw new Error(`agent test run is not waiting for human review: ${id}`)
    }
    result.humanReview = {
      ...result.humanReview,
      status: verdict === 'pass' ? 'passed' : 'failed',
      reviewedAt: Date.now(),
      reviewedBySessionId,
      ...(note === undefined || note.length === 0 ? {} : { note }),
    }
    result.status = result.automaticVerdict === 'passed'
      ? verdict === 'pass' ? 'passed' : 'review-failed'
      : 'failed'
    const runRoot = view.runRoot
    await atomicJson(join(runRoot, 'result.json'), result)
    await writeFile(join(runRoot, 'report.md'), reportMarkdown(result))
    await writeFile(join(runRoot, 'review.md'), reviewMarkdown(result))
    if (active !== undefined) {
      active.result = result
      active.status = result.status
      active.humanReview = result.humanReview
      active.progress = `human review: ${verdict}`
      this.updateProcess(active, { testStatus: result.status, progress: active.progress })
      await active.processWrite
      return json(this.publicView(active))
    }
    return json(await this.readCompleted(id))
  }

  private async execute(active: ActiveRun, suite: AgentTestSuite, settle: (outcome: JobOutcome) => void): Promise<void> {
    try {
      const result = await this.engine.execute({
        ...(active.sourceRoot === undefined ? {} : { sourceRoot: active.sourceRoot }),
        runId: active.runId,
        runRoot: active.runRoot,
        repeat: active.repeat,
        suite,
        ...(active.planId === undefined ? {} : { planId: active.planId }),
        ...(active.jobId === undefined ? {} : { jobId: active.jobId }),
        signal: active.controller.signal,
        onProgress: progress => {
          active.progress = progress
          this.updateProcess(active, { progress })
        },
        onChild: child => { active.child = child },
        onProcess: update => { this.updateProcess(active, update) },
      })
      active.result = result
      active.sourceDigest = result.sourceDigest
      active.status = result.status
      active.automaticVerdict = result.automaticVerdict
      active.finishedAt = result.finishedAt
      active.humanReview = result.humanReview
      this.updateProcess(active, {
        lifecycle: 'exited',
        testStatus: result.status,
        progress: active.progress,
        finishedAt: active.process?.finishedAt ?? result.finishedAt,
      })
      await active.processWrite
      if (result.humanReview.required) {
        try { await this.publishHumanReview(this.publicView(active)) } catch (error: unknown) {
          this.hostContext.logger.warn('agent-test: failed to publish human review for %s: %s', active.runId, errorText(error))
        }
      } else if (active.planId !== undefined) {
        try { await this.notifyCompleted(this.publicView(active), active.owner) }
        catch (error: unknown) { this.hostContext.logger.warn('agent-test completion notification failed: %s', errorText(error)) }
      }
      settle({
        status: result.status === 'cancelled' ? 'killed' : 'completed',
        detail: result.status,
        output: completionOutput(result),
      })
    } catch (error: unknown) {
      active.status = active.controller.signal.aborted ? 'cancelled' : 'failed'
      active.finishedAt = Date.now()
      active.progress = `runner failed: ${errorText(error)}`
      this.updateProcess(active, {
        lifecycle: 'exited',
        testStatus: active.status,
        progress: active.progress,
        finishedAt: active.finishedAt,
      })
      await active.processWrite
      if (active.owner !== undefined && active.planId !== undefined && this.humanRequestService !== undefined) {
        try { await this.humanRequestService.deliverNotice(String(active.owner.id), `agent-test:${active.runId}:failed`, `${active.progress}\nRun: ${active.runId}\nStatus: ${active.status}`, true, active.owner) }
        catch (notificationError: unknown) { this.hostContext.logger.warn('agent-test failure notification failed: %s', errorText(notificationError)) }
      }
      settle({ status: active.status === 'cancelled' ? 'killed' : 'failed', detail: active.progress, output: active.progress })
    } finally {
      active.child = undefined
    }
  }

  private publicView(run: ActiveRun): AgentTestRunView {
    return {
      runId: run.runId,
      ...(run.ownerSessionId === undefined ? {} : { ownerSessionId: run.ownerSessionId }),
      ...(run.jobId === undefined ? {} : { jobId: run.jobId }),
      suite: run.suite,
      repeat: run.repeat,
      ...(run.sourceDigest === undefined ? {} : { sourceDigest: run.sourceDigest }),
      ...(run.planId === undefined ? {} : { planId: run.planId }),
      status: run.status,
      ...(run.automaticVerdict === undefined ? {} : { automaticVerdict: run.automaticVerdict }),
      startedAt: run.startedAt,
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      runRoot: run.runRoot,
      progress: run.progress,
      humanReview: structuredClone(run.humanReview),
      ...(run.process === undefined ? {} : { process: structuredClone(run.process) }),
      ...(run.result === undefined ? {} : { result: structuredClone(run.result) }),
    }
  }

  private async readCompleted(id: string): Promise<AgentTestRunView> {
    const runRoot = join(this.artifactsRoot, 'runs', validRunId(id))
    let result: AgentTestRunResult
    try {
      result = JSON.parse(await readFile(join(runRoot, 'result.json'), 'utf8')) as AgentTestRunResult
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`agent test run not found: ${id}`)
      throw error
    }
    const processRecord = await this.readProcessRecord(runRoot)
    const process = processRecord?.process
    return {
      runId: result.runId,
      ...(processRecord?.ownerSessionId === undefined ? {} : { ownerSessionId: processRecord.ownerSessionId }),
      ...(result.jobId === undefined ? {} : { jobId: result.jobId }),
      suite: result.suite,
      repeat: result.repeat,
      sourceDigest: result.sourceDigest,
      ...(result.planId === undefined ? {} : { planId: result.planId }),
      status: result.status,
      automaticVerdict: result.automaticVerdict,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      runRoot,
      progress: result.status === 'waiting-human' ? 'automatic checks complete; waiting for human review' : `finished: ${result.status}`,
      humanReview: result.humanReview,
      ...(process === undefined ? {} : { process }),
      result,
    }
  }

  private async notifyCompleted(view: AgentTestRunView, owner?: Agent): Promise<void> {
    if (view.result === undefined || view.ownerSessionId === undefined || this.humanRequestService === undefined) return
    await this.humanRequestService.deliverNotice(view.ownerSessionId, `agent-test:${view.runId}:completed`, `${completionOutput(view.result)}\nStatus: ${view.status}; automatic: ${view.automaticVerdict ?? 'unknown'}; human: ${view.humanReview.status}`, true, owner)
  }

  private async publishHumanReview(view: AgentTestRunView): Promise<void> {
    if (this.humanRequestService === undefined) throw new Error('human request service is unavailable')
    if (!view.result?.humanReview.required || !view.ownerSessionId) return
    await this.humanRequestService.submit({ requestId: `test-${view.runId}`, type: 'test-review', title: `验收 ${view.suite}`, body: reviewMarkdown(view.result) + '\n\n请答复“通过验收”或“未通过：原因”。', ...(view.planId ? { planId: view.planId } : {}) }, view.ownerSessionId)
  }

  private async readProcess(runRoot: string): Promise<AgentTestProcessView | undefined> {
    return (await this.readProcessRecord(runRoot))?.process
  }

  private async readProcessRecord(runRoot: string): Promise<AgentTestProcessRecord | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(join(runRoot, 'dsh-process.json'), 'utf8'))
      try {
        return parseAgentTestProcessRecord(value)
      } catch {
        return { version: 1, process: parseAgentTestProcess(value) }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      this.hostContext.logger.warn('agent-test: failed to read process state in %s: %s', runRoot, errorText(error))
      return undefined
    }
  }

  private async restoreProcessLists(): Promise<void> {
    const runsRoot = join(this.artifactsRoot, 'runs')
    let entries: Dirent[]
    try {
      entries = await readdir(runsRoot, { withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.hostContext.logger.warn('agent-test: failed to restore process lists: %s', errorText(error))
      return
    }
    for (const entry of entries) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink())) continue
      const record = await this.readProcessRecord(join(runsRoot, entry.name))
      if (record?.ownerSessionId === undefined) continue
      const current = this.processLists.get(record.ownerSessionId) ?? []
      this.processLists.set(record.ownerSessionId, upsertAgentTestProcess(current, record.process))
    }
  }

  private async command(rawInput: string, agent: Agent, signal: AbortSignal): Promise<string> {
    const values = tokens(rawInput.trim())
    const action = values[0] ?? 'list'
    if (action === 'list') return render({ suites: await this.suites(), runs: await this.list() })
    if (action === 'run') {
      const suite = values[1]
      if (suite === undefined || suite.startsWith('--')) throw new Error('usage: /agent-test run <suite> [--repeat N]')
      const repeatOption = option(values, '--repeat')
      return render(await this.start(suite, repeatOption === undefined ? undefined : repeatValue(repeatOption, 1), agent))
    }
    const id = values[1]
    if (id === undefined) throw new Error(`usage: /agent-test ${action} <run-id>`)
    if (action === 'status') return render(await this.status(id, agent))
    if (action === 'wait') return render(await this.wait(id, timeoutValue(option(values, '--timeout-ms')), agent, signal))
    if (action === 'cancel') return render(await this.cancel(id, agent))
    if (action === 'review') {
      const verdict = values[2]
      if (verdict !== 'pass' && verdict !== 'fail') throw new Error('usage: /agent-test review <run-id> <pass|fail> [--note TEXT]')
      const reviewed = await this.review(id, verdict, String(agent.id), option(values, '--note'))
      if (this.humanRequestService !== undefined) await this.publishHumanReview(reviewed)
      return render(reviewed)
    }
    throw new Error('usage: /agent-test list | run <suite> [--repeat N] | status <run-id> | wait <run-id> [--timeout-ms N] | cancel <run-id> | review <run-id> <pass|fail> [--note TEXT]')
  }
}

export default AgentTestService
