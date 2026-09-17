/**
 * Purpose: Snapshot Agent source and run each evaluation in a separate Harness process.
 * Example: baseline and modified prompts produce distinct source digests and reports.
 * Snapshot presets resolve Coding, Trainer, evaluation and Sleep tool entries to the
 * copied packages so evaluation sessions use their own runtime scheduling service.
 * Pain collection stays enabled in every evaluation; reflection is enabled alongside
 * its Trainer host. Example: a Coding evaluation records pain without starting a Trainer.
 * Child runtime, sessions and artifacts are isolated; shutdown joins the owned process.
 * Final metrics are refreshed from the child's flushed generation log, located by its canonical
 * `.vN` filename rather than a fixed name.
 */
import { prepareRuntime } from '@mozi-forge/runtime'
import { createWorkcopy, workcopyPath, resolvePackageDirectory } from './workcopy.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { basename, dirname, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { evaluateBudgets, evaluateTurn } from './assertions.js'
import { assertSafeRelativePath } from './definition.js'
import { addMetrics, deriveMetrics, hasCompleteUsage, emptyMetrics, summarizeRepeats } from './metrics.js'
import { HarnessSessionClient, redactLaunchCredentials } from './session-client.js'
import type {
  AgentTestAttemptResult,
  AgentTestCase,
  AgentTestProcessLifecycle,
  AgentTestRunResult,
  AgentTestSuite,
  HumanReview,
  HumanReviewItem,
} from './types.js'

export interface RunnerConfig {
  projectRoot: string
  startupTimeoutMs: number
  evaluationPatch?: string
  pluginExports?: Record<string, string>
  additionalPackages?: string[]
  snapshotExclude?: string[]
}

export interface RunRequest {
  sourceRoot?: string
  runId: string
  runRoot: string
  repeat: number
  suite: AgentTestSuite
  planId?: string
  jobId?: string
  signal: AbortSignal
  onProgress(progress: string): void
  onChild?(child: ChildProcess | undefined): void
  onProcess?(update: AgentTestProcessUpdate): void
}

export interface AgentTestProcessUpdate {
  lifecycle: AgentTestProcessLifecycle
  pid?: number
  port?: number
  readyAt?: number
  finishedAt?: number
  exitCode?: number | null
  signalCode?: NodeJS.Signals | null
}

interface ChildHandle {
  child: ChildProcess
  api: HarnessSessionClient
  sessionsRoot: string
  stop(): Promise<void>
}

interface Snapshot {
  snapshotRoot: string
  dshHome: string
  webPatch: string
  sourceDigest: string
}

async function digestPath(hash: ReturnType<typeof createHash>, root: string, path: string): Promise<void> {
  if (!workcopyPath(relative(root, path))) return
  const info = await lstat(path)
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) await digestPath(hash, root, join(path, entry.name))
    return
  }
  hash.update(relative(root, path).split(sep).join('/'))
  hash.update('\0')
  hash.update(await readFile(path))
  hash.update('\0')
}

export async function computeProjectSourceDigest(projectRoot: string): Promise<string> {
  const hash = createHash('sha256')
  const candidates = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'config/runtime.json',
    'config/presets',
    'config/web.patch.yml',
    'tests',
    'src',
    'scripts',
    'tsconfig.json',
    'tsconfig.build.json',
    'vitest.config.ts',
  ]
  for (const candidate of candidates) {
    const path = join(projectRoot, candidate)
    if (await exists(path)) await digestPath(hash, projectRoot, path)
  }
  const packagesRoot = join(projectRoot, 'packages')
  if (await exists(packagesRoot)) {
    const entries = (await readdir(packagesRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const packageRoot = join(packagesRoot, entry.name)
      const manifestPath = join(packageRoot, 'package.json')
      if (!await exists(manifestPath)) continue
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown }
      if (typeof manifest.name !== 'string') continue
      for (const name of ['package.json', 'src', 'tests', 'scripts', 'tsconfig.json', 'tsconfig.build.json', 'dist', 'prompts', 'assets']) {
        const path = join(packageRoot, name)
        if (await exists(path)) await digestPath(hash, projectRoot, path)
      }
    }
  }
  const visited = new Set<string>()
  // Normalize external local inputs by package identity so original and snapshot
  // trees have equal digests despite their different physical locations.
  async function localInputs(root: string): Promise<void> {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return '{}' }))
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (typeof version !== 'string' || !/^(?:workspace:|file:|link:)/u.test(version) || visited.has(name)) continue
      visited.add(name)
      const dependency = await resolvePackageDirectory(root, name)
      const rel = relative(projectRoot, dependency)
      if (rel.startsWith('..') || rel.split(sep).includes('node_modules') || rel.split(sep).includes('.snapshot-packages')) {
        hash.update(`local-package:${name}\0`)
        await digestPath(hash, dependency, dependency)
      }
      await localInputs(dependency)
    }
  }
  await localInputs(projectRoot)
  return hash.digest('hex')
}

function valueOf<T>(response: { result: { ok: true; value: T } | { ok: false; error: unknown } }): T {
  if (!response.result.ok) throw new Error(`evaluation Web API failed: ${JSON.stringify(response.result.error)}`)
  return response.result.value
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('agent test cancelled')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('failed to allocate an evaluation port'))
        return
      }
      server.close(error => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, path)
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesBelow(join(root, entry.name)) : [join(root, entry.name)]))).flat()
}

async function snapshotProject(config: RunnerConfig, request: RunRequest): Promise<Snapshot> {
  const projectRoot = request.sourceRoot ?? config.projectRoot
  const snapshotRoot = join(request.runRoot, 'snapshot')
  const dshHome = join(request.runRoot, 'dsh-home')
  const composition = JSON.parse(await readFile(join(projectRoot, 'config/runtime.json'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return '{}' })) as { snapshotExclude?: string[] }
  await createWorkcopy(projectRoot, snapshotRoot, config.snapshotExclude ?? composition.snapshotExclude)
  const sourceDigest = await computeProjectSourceDigest(snapshotRoot)
  await prepareRuntime({ projectRoot: snapshotRoot, runtimeHome: dshHome,
    presetDirectory: join(snapshotRoot, 'config/presets'),
    ...(config.pluginExports ? { pluginExports: config.pluginExports } : {}),
    ...(config.additionalPackages ? { packages: config.additionalPackages } : {}),
  })
  // Freeze shared defaults and the project overlay into a single evaluation input.
  const require = createRequire(join(snapshotRoot, 'package.json'))
  const basePatch = require.resolve('@mozi-forge/runtime/host.patch.yml')
  const projectPatch = join(snapshotRoot, 'config/web.patch.yml')
  await writeFile(projectPatch, `${await readFile(basePatch, 'utf8')}\n${await readFile(projectPatch, 'utf8')}`)

  return { snapshotRoot, dshHome, webPatch: join(snapshotRoot, 'config/web.patch.yml'), sourceDigest }
}

function dshBin(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
}

/**
 * Write an evaluation overlay, then launch and authenticate one owned Web child.
 * Trainer and reflection activate together; every preset retains pain collection.
 * The overlay and logs live under runRoot, sessions under snapshot.dshHome.
 */
async function startChild(config: RunnerConfig, request: RunRequest, snapshot: Snapshot): Promise<ChildHandle> {
  const port = await freePort()
  request.onProcess?.({ lifecycle: 'starting', port })
  const sessionsRoot = join(snapshot.dshHome, 'sessions')
  const evaluationPatch = join(request.runRoot, 'evaluation.patch.yml')
  await writeFile(evaluationPatch, `- id: agent-test-host
  name: '@mozi-forge/agent-test-plugin/host'
  disabled: ${request.suite.preset !== 'trainer'}
  config:
    projectRoot: ${JSON.stringify(snapshot.snapshotRoot)}
- id: trainer-host
  name: '@mozi-forge/trainer-agent'
  disabled: ${request.suite.preset !== 'trainer'}
  config:
    projectRoot: ${JSON.stringify(snapshot.snapshotRoot)}
- id: reflect-loop-host
  name: '@mozi-forge/reflect-loop-plugin/host'
  disabled: ${request.suite.preset !== 'trainer'}
  config:
    projectRoot: ${JSON.stringify(snapshot.snapshotRoot)}
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: ${JSON.stringify(sessionsRoot)}
    compression: none
    packChunks: false
`)
  const stdout = createWriteStream(join(request.runRoot, 'dsh.stdout.log'), { flags: 'a' })
  const stderr = createWriteStream(join(request.runRoot, 'dsh.stderr.log'), { flags: 'a' })
  const args = [
    dshBin(), '--profile', 'web', '--patch', snapshot.webPatch,
    ...(config.evaluationPatch === undefined ? [] : ['--patch', config.evaluationPatch]),
    '--patch', evaluationPatch,
    '--port', String(port), '--no-open',
  ]
  const child = spawn(process.execPath, args, {
    cwd: snapshot.snapshotRoot,
    env: { ...process.env, DSH_HOME: snapshot.dshHome, DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  request.onProcess?.({
    lifecycle: 'starting',
    port,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
  })
  await writeFile(join(request.runRoot, 'dsh.pid'), `${String(child.pid ?? '')}\n`)
  request.onChild?.(child)
  const lines = createInterface({ input: child.stdout! })
  const errorLines = createInterface({ input: child.stderr! })
  lines.on('line', line => stdout.write(`${redactLaunchCredentials(line)}\n`))
  errorLines.on('line', line => stderr.write(`${redactLaunchCredentials(line)}\n`))
  const api = new HarnessSessionClient(`http://127.0.0.1:${String(port)}`)
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    request.onProcess?.({
      lifecycle: 'stopping',
      port,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    })
    lines.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 10_000))])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    lines.close()
    errorLines.close()
    await Promise.all([new Promise<void>(resolveEnd => stdout.end(resolveEnd)), new Promise<void>(resolveEnd => stderr.end(resolveEnd))])
    await atomicJson(join(request.runRoot, 'dsh-exit.json'), {
      pid: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    })
    request.onProcess?.({
      lifecycle: 'exited',
      port,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      finishedAt: Date.now(),
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    })
    request.onChild?.(undefined)
  }
  try {
    const launchUrl = await new Promise<string>((resolveReady, reject) => {
      const diagnostics: string[] = []
      const timer = setTimeout(() => reject(new Error(`evaluation DSH startup timed out\n${diagnostics.join('')}`)), config.startupTimeoutMs)
      const fail = (error: unknown): void => {
        clearTimeout(timer)
        reject(error)
      }
      const exitDuringStartup = (code: number | null): void => fail(new Error(`evaluation DSH exited during startup with ${String(code)}\n${diagnostics.join('')}`))
      child.once('error', fail)
      child.once('exit', exitDuringStartup)
      const onLine = (line: string): void => {
        diagnostics.push(`${redactLaunchCredentials(line)}\n`)
        const url = line.match(/https?:\/\/[^\s]+/u)?.[0]
        if (url === undefined || !url.startsWith(`http://127.0.0.1:${String(port)}/`)) return
        clearTimeout(timer)
        child.off('error', fail)
        child.off('exit', exitDuringStartup)
        lines.off('line', onLine)
        resolveReady(url)
      }
      lines.on('line', onLine)
    })
    await api.authenticate(launchUrl, request.signal)
    request.onProcess?.({
      lifecycle: 'running',
      port,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      readyAt: Date.now(),
    })
  } catch (error: unknown) {
    await stop()
    throw error
  }
  return {
    child,
    api,
    sessionsRoot,
    stop,
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(resolveDelay, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }, { once: true })
  })
}

async function waitForTurn(api: HarnessSessionClient, sessionId: SessionId, count: number, timeoutMs: number, signal: AbortSignal): Promise<SessionEvent[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal.aborted) throw abortError(signal)
    const history = valueOf(await api.sessions.history({ sessionId, maxMessages: 10_000 }, signal))
    // Harness 0.1.5 removed the storage decoder that used to narrow journal records into
    // `SessionEvent`, so the controller journal now hands back the deliberately loose
    // `SessionWireEvent` envelope (its `type` stays a string because durable readers own event-name
    // recognition). This runner reads the durable log of the Harness it launched and pinned, so it
    // narrows once here; every downstream reader relies on the discriminated union.
    const events = history.events.map(entry => entry.event) as unknown as SessionEvent[]
    if (events.filter(event => event.type === 'turn/end').length >= count) return events
    await abortableDelay(200, signal)
  }
  throw new Error(`model did not finish turn ${String(count)} within ${String(timeoutMs)}ms`)
}

function turnReason(events: readonly SessionEvent[], turn: number): string {
  const event = events.find(candidate => candidate.type === 'turn/end' && candidate.data.turn === turn)
  return event?.type === 'turn/end' ? event.data.reason.kind : 'missing'
}

async function runAttempt(
  child: ChildHandle,
  request: RunRequest,
  testCase: AgentTestCase,
  repeat: number,
): Promise<AgentTestAttemptResult> {
  const workspace = join(request.runRoot, 'workspaces', testCase.id, `repeat-${String(repeat)}`)
  await mkdir(workspace, { recursive: true })
  const snapshots = new Map<string, unknown>()
  const turns: AgentTestAttemptResult['turns'] = []
  let events: SessionEvent[] = []
  let sessionId: SessionId | undefined
  try {
    const created = valueOf(await child.api.sessions.create({ cwd: workspace, agentPreset: request.suite.preset }, request.signal))
    sessionId = created.sessionId
    for (let index = 0; index < testCase.turns.length; index += 1) {
      const definition = testCase.turns[index]!
      const prompt = definition.prompt.replaceAll('{{input.json}}', JSON.stringify(testCase.input ?? null, null, 2))
      valueOf(await child.api.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        clientTimeZone: 'Asia/Shanghai',
      }, request.signal))
      events = await waitForTurn(child.api, sessionId, index + 1, request.suite.defaults.timeoutMs, request.signal)
      const turn = index + 1
      turns.push({
        id: definition.id,
        prompt,
        turn,
        turnReason: turnReason(events, turn),
        assertions: await evaluateTurn(definition.expect, { workspace, turn, input: testCase.input, events, snapshots }),
      })
    }
    const metrics = deriveMetrics(events)
    const budgetAssertions = evaluateBudgets(testCase.budgets, metrics)
    const passed = turns.every(turn => turn.assertions.every(item => item.passed)) && budgetAssertions.every(item => item.passed)
    return {
      caseId: testCase.id,
      caseName: testCase.name,
      repeat,
      status: passed ? 'passed' : 'failed',
      sessionId,
      workspace,
      turns,
      assertions: budgetAssertions,
      metrics,
      usageComplete: hasCompleteUsage(events),
    }
  } catch (error: unknown) {
    return {
      caseId: testCase.id,
      caseName: testCase.name,
      repeat,
      status: request.signal.aborted ? 'cancelled' : 'error',
      ...(sessionId === undefined ? {} : { sessionId }),
      workspace,
      turns,
      assertions: [],
      metrics: deriveMetrics(events),
      usageComplete: hasCompleteUsage(events),
      error: errorText(error),
    }
  }
}

/**
 * Locate the current flushed log of one session below a sessions root.
 *
 * Harness 0.1.5 addresses every stored log by immutable format generation, naming it
 * `session.vN.jsonl` and keeping the bare `session.jsonl` only for generation zero, so the previous
 * fixed `session.jsonl` match missed every log this build writes. A session that was migrated on read
 * leaves its older generations in place next to the new one, so the highest generation whose stored
 * header names the wanted session wins: that is the generation the child last published. The child's
 * persistence runs with `compression: none`, so canonical names carry no compression suffix.
 *
 * @param root - the child's sessions root.
 * @param sessionId - the session whose log is wanted.
 * @returns the winning log path, or undefined when no generation belongs to that session.
 */
async function findSessionLog(root: string, sessionId: string): Promise<string | undefined> {
  if (!await exists(root)) return undefined
  let best: { path: string, generation: number } | undefined
  for (const path of await filesBelow(root)) {
    const generation = parseSessionFormatLogFilename(basename(path))
    if (generation === undefined) continue
    if (best !== undefined && generation <= best.generation) continue
    const firstLine = (await readFile(path, 'utf8')).split('\n', 1)[0]
    try {
      const header = JSON.parse(firstLine ?? '') as { type?: unknown; id?: unknown }
      if (header.type === 'session' && header.id === sessionId) best = { path, generation }
    } catch {
      // A malformed log is reported by the attempt metrics refresh below.
    }
  }
  return best?.path
}

async function readSessionEvents(path: string): Promise<SessionEvent[]> {
  const lines = (await readFile(path, 'utf8')).split('\n').filter(line => line.length > 0)
  return lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
}

async function refreshFinalMetrics(attempts: AgentTestAttemptResult[], sessionsRoot: string): Promise<void> {
  for (const attempt of attempts) {
    if (attempt.sessionId === undefined) continue
    const path = await findSessionLog(sessionsRoot, attempt.sessionId)
    if (path === undefined) {
      attempt.status = attempt.status === 'cancelled' ? 'cancelled' : 'error'
      attempt.error = `flushed session log not found for ${attempt.sessionId}`
      continue
    }
    attempt.sessionLog = path
    try {
      const events = await readSessionEvents(path)
      attempt.metrics = deriveMetrics(events)
      attempt.usageComplete = hasCompleteUsage(events)
    } catch (error: unknown) {
      attempt.status = attempt.status === 'cancelled' ? 'cancelled' : 'error'
      attempt.error = `failed to read flushed session log: ${errorText(error)}`
    }
  }
}

function artifactPath(path: string, attempt: AgentTestAttemptResult, runRoot: string): string {
  assertSafeRelativePath(path, 'review artifact path')
  if (path === 'session-log') return attempt.sessionLog ?? join(runRoot, 'dsh-home/sessions')
  if (path === 'workspace') return attempt.workspace
  if (path.startsWith('workspace/')) return join(attempt.workspace, path.slice('workspace/'.length))
  return join(runRoot, path)
}

function reviewItems(suite: AgentTestSuite, attempts: readonly AgentTestAttemptResult[], runRoot: string): HumanReviewItem[] {
  return attempts.flatMap((attempt) => {
    const testCase = suite.cases.find(candidate => candidate.id === attempt.caseId)
    const review = testCase?.review
    if (review === undefined || (review.when === 'auto-pass' && attempt.status !== 'passed')) return []
    return [{
      caseId: attempt.caseId,
      repeat: attempt.repeat,
      title: review.title,
      instructions: review.instructions,
      checklist: review.checklist,
      artifacts: review.artifacts.map(artifact => ({ label: artifact.label, path: artifactPath(artifact.path, attempt, runRoot) })),
    }]
  })
}

export function reviewMarkdown(result: AgentTestRunResult): string {
  const lines = [`# Human Review ${result.runId}`, '', `Status: ${result.humanReview.status}`, '']
  for (const item of result.humanReview.items) {
    lines.push(`## ${item.caseId} repeat ${String(item.repeat)}: ${item.title}`, '', item.instructions, '')
    lines.push(...item.checklist.map(check => `- [ ] ${check}`), '', ...item.artifacts.map(artifact => `- ${artifact.label}: ${artifact.path}`), '')
  }
  if (result.humanReview.reviewedAt !== undefined) {
    lines.push(`Reviewed at: ${new Date(result.humanReview.reviewedAt).toISOString()}`)
    if (result.humanReview.reviewedBySessionId !== undefined) lines.push(`Reviewed by session: ${result.humanReview.reviewedBySessionId}`)
    if (result.humanReview.note !== undefined) lines.push(`Note: ${result.humanReview.note}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function reportMarkdown(result: AgentTestRunResult): string {
  const lines = [
    `# Agent Test ${result.runId}`, '',
    `- Suite: ${result.suite}`,
    `- Source digest: ${result.sourceDigest}`,
    `- Status: ${result.status}`,
    `- Automatic verdict: ${result.automaticVerdict}`,
    `- Human verdict: ${result.humanReview.status}`,
    `- Elapsed: ${String(result.metrics.elapsedMs)} ms`,
    `- LLM/tool/TTFT: ${String(result.metrics.llmMs)} / ${String(result.metrics.toolMs)} / ${String(result.metrics.ttftMs)} ms`,
    `- Tokens uncached/cache-read/cache-write/output: ${String(result.metrics.tokens.uncachedInputTokens)} / ${String(result.metrics.tokens.cacheReadTokens)} / ${String(result.metrics.tokens.cacheWriteTokens)} / ${String(result.metrics.tokens.outputTokens)}`,
    `- Tools: ${String(result.metrics.tools.calls)} calls, ${String(result.metrics.tools.failed)} failed, ${String(result.metrics.tools.incomplete)} incomplete, ${(result.metrics.tools.failureRate * 100).toFixed(2)}% failure rate`,
    `- Repeats: ${(result.repeats.passRate * 100).toFixed(2)}% pass; elapsed mean/P50/P95 ${result.repeats.elapsedMs.mean.toFixed(1)}/${String(result.repeats.elapsedMs.p50)}/${String(result.repeats.elapsedMs.p95)} ms`,
    '', '## Attempts', '',
  ]
  for (const attempt of result.attempts) {
    lines.push(`### ${attempt.caseId} repeat ${String(attempt.repeat)} — ${attempt.status}`, '')
    if (attempt.error !== undefined) lines.push(`Error: ${attempt.error}`, '')
    for (const turn of attempt.turns) {
      lines.push(`- Turn ${turn.id}: ${turn.turnReason}`)
      for (const item of turn.assertions) lines.push(`  - [${item.passed ? 'x' : ' '}] ${item.name}: ${item.detail}`)
    }
    for (const item of attempt.assertions) lines.push(`- [${item.passed ? 'x' : ' '}] ${item.name}: ${item.detail}`)
    if (attempt.sessionLog !== undefined) lines.push(`- Session log: ${attempt.sessionLog}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function completionOutput(result: AgentTestRunResult): string {
  return `Agent test ${result.suite}: ${result.status}.\nRun: ${result.runId}\nReport: ${join(dirname(result.snapshotRoot), 'report.md')}\n${result.humanReview.required ? '请在人类需求页面检查产物并答复。' : '根据证据继续训练。'}`
}

export class AgentTestEngine {
  constructor(private readonly config: RunnerConfig) {}

  async execute(request: RunRequest): Promise<AgentTestRunResult> {
    const startedAt = Date.now()
    let snapshot: Snapshot = {
      snapshotRoot: join(request.runRoot, 'snapshot'),
      dshHome: join(request.runRoot, 'dsh-home'),
      webPatch: join(request.runRoot, 'snapshot/config/web.patch.yml'),
      sourceDigest: '',
    }
    const attempts: AgentTestAttemptResult[] = []
    let child: ChildHandle | undefined
    let infrastructureError: string | undefined
    await mkdir(request.runRoot, { recursive: true })
    try {
      request.onProgress('syncing presets, Web overlay, and built @mozi packages')
      snapshot = await snapshotProject(this.config, request)
      if (request.signal.aborted) throw abortError(request.signal)
      request.onProgress('starting isolated DSH')
      child = await startChild(this.config, request, snapshot)
      for (const testCase of request.suite.cases) {
        for (let repeat = 1; repeat <= request.repeat; repeat += 1) {
          if (request.signal.aborted) throw abortError(request.signal)
          request.onProgress(`running ${testCase.id} repeat ${String(repeat)}/${String(request.repeat)}`)
          const attempt = await runAttempt(child, request, testCase, repeat)
          attempts.push(attempt)
          if (attempt.status === 'cancelled') throw abortError(request.signal)
        }
      }
    } catch (error: unknown) {
      infrastructureError = errorText(error)
    } finally {
      request.onProgress('stopping isolated DSH and flushing session logs')
      await child?.stop()
      if (child !== undefined) await refreshFinalMetrics(attempts, child.sessionsRoot)
    }

    const cancelled = request.signal.aborted
    const automaticVerdict = cancelled ? 'cancelled' : infrastructureError === undefined && attempts.length > 0 && attempts.every(attempt => attempt.status === 'passed') ? 'passed' : 'failed'
    const items = cancelled ? [] : reviewItems(request.suite, attempts, request.runRoot)
    const humanReview: HumanReview = {
      required: items.length > 0,
      status: items.length > 0 ? 'pending' : 'not-required',
      items,
      ...(items.length === 0 ? {} : {
        title: items.length === 1 ? items[0]!.title : `${String(items.length)} 项人工审查`,
        instructions: items.map(item => item.instructions).join('\n\n'),
        checklist: items.flatMap(item => item.checklist),
        artifacts: items.flatMap(item => item.artifacts),
        reviewCommand: `/agent-test review ${request.runId} pass --note "验收通过"`,
      }),
    }
    const status = cancelled
      ? 'cancelled'
      : automaticVerdict === 'failed'
        ? 'failed'
        : humanReview.required
          ? 'waiting-human'
          : 'passed'
    const result: AgentTestRunResult = {
      version: 1,
      runId: request.runId,
      ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
      suite: request.suite.id,
      evaluationDigest: createHash('sha256').update(JSON.stringify({ ...request.suite, sourcePath: undefined })).digest('hex'),
      suiteDefinition: structuredClone(request.suite),
      repeat: request.repeat,
      sourceDigest: snapshot.sourceDigest,
      ...(request.planId === undefined ? {} : { planId: request.planId }),
      status,
      automaticVerdict,
      startedAt,
      finishedAt: Date.now(),
      snapshotRoot: snapshot.snapshotRoot,
      dshHome: snapshot.dshHome,
      attempts,
      metrics: attempts.length === 0 ? emptyMetrics() : addMetrics(attempts.map(attempt => attempt.metrics)),
      repeats: summarizeRepeats(attempts),
      humanReview,
      ...(infrastructureError === undefined ? {} : { error: infrastructureError }),
    }
    request.onProgress(status === 'waiting-human' ? 'automatic checks complete; waiting for human review' : `finished: ${status}`)
    await atomicJson(join(request.runRoot, 'result.json'), result)
    await writeFile(join(request.runRoot, 'report.md'), reportMarkdown(result))
    await writeFile(join(request.runRoot, 'review.md'), reviewMarkdown(result))
    return result
  }
}
