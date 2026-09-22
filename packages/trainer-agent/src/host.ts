/**
 * Purpose: Save training plans, prepare HEAD worktrees and integrate verified trees under approved plans.
 * Flow: the Agent chooses its loop; this service records filesystem/Git facts only.
 * A chosen plan id creates the plan on the first save and updates it in place afterwards,
 * preserving createdAt, workspace facts and the merge receipt.
 * Example: plan p1 creates workspace at HEAD, a human approves its objective, merge writes
 * one commit onto the recorded branch, and p1.merge becomes its completion receipt.
 * Recovery: saved commit identities make repeated integration safe. Dirty destination
 * checkouts and changed verification trees fail without resetting user work. Branch movement
 * is tested in a separate integration worktree before a compare-and-swap update.
 * Global Plan summaries support shared diagnosis; pain associations retain Plan ownership.
 * A merge receipt is saved before completion listeners reconcile the covered feedback.
 */
import { page, summaryText } from '@mozi-forge/agent-pain-plugin/storage'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { atomicJson, safeId } from '@mozi-forge/human-request-plugin/host'
import type {} from '@mozi-forge/agent-test-plugin/host'
import { linkWorkcopyDependencies } from '@mozi-forge/agent-test-plugin/workcopy'
import { deriveMetrics, hasCompleteUsage } from '@mozi-forge/agent-test-plugin/metrics'
import type {} from '@mozi-forge/session-insights-plugin/host'
import { parsePlan } from './plan.js'
import type { TrainingPlan, PlanInput, MergeSnapshot } from './types.js'
export const name = 'mozi-trainer-host'
export interface Config { projectRoot: string }
export const Config: z<Config> = z.object({ projectRoot: z.string().required() })
declare module '@deepseek-ai/cordis' { interface Context { trainers: TrainerService } }
const run = promisify(execFile)
const excludedParts = new Set(['.runtime', 'node_modules', '.git', '.npmrc', '.credentials.yml', '.credentials.yaml'])
export class TrainerService extends Service {
  static inject = ['humanRequests', 'agentTests', 'sessionInsights', 'agents', 'agentPresets', 'agentDefaultModel', 'sessions', 'sessionPersistence']
  static Config = Config
  readonly projectRoot: string
  readonly root: string
  private handles = new Map<string, AgentHandle>()
  private mergeListeners = new Set<() => Promise<void>>()
  private queues = new Map<string, Promise<unknown>>()
  constructor(private host: Context, config: Config) {
    super(host, 'trainers')
    host.effect(() => async () => { for (const handle of this.handles.values()) await handle.dispose(); this.handles.clear() })
    this.projectRoot = resolve(config.projectRoot)
    this.root = join(resolve(process.env.DSH_HOME ?? join(this.projectRoot, '.runtime')), 'trainning')
    host.on('human-request/prepare', async (input, owner) => {
      if (input.type !== 'plan-review') return
      if (!input.planId) throw new Error('plan-review requires planId from trainer_plan_save')
      const plan = await this.read(input.planId, owner)
      input.title = plan.title
      input.body = plan.body
    })
  }
  directory(id: string): string { return join(this.root, safeId(id)) }
  workspace(id: string): string { return join(this.directory(id), 'workspace') }
  async read(id: string, owner?: string): Promise<TrainingPlan> {
    const plan = await this.load(id)
    if (!plan) throw new Error(`Unknown training plan: ${id}`)
    if (owner && plan.sessionId !== owner && plan.executionSessionId !== owner) throw new Error('Plan belongs to another session; choose another id')
    plan.description ??= plan.body.split(/\r?\n\s*\r?\n/).find(paragraph => paragraph.trim())?.trim() ?? plan.title
    return plan
  }
  /** Stored plan, or undefined before the first save creates the directory and plan.json. */
  private async load(id: string): Promise<TrainingPlan | undefined> {
    return readFile(join(this.directory(id), 'plan.json'), 'utf8')
      .then(text => JSON.parse(text) as TrainingPlan)
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
  }
  /** save() lookup: an absent plan is simply a new plan, while an existing one still belongs to its session. */
  private async existing(id: string, owner: string): Promise<TrainingPlan | undefined> {
    const plan = await this.load(id)
    if (plan && plan.sessionId !== owner && plan.executionSessionId !== owner) throw new Error('Plan belongs to another session; choose another id')
    return plan
  }
  /** Validate frozen session references before saving user-authored fields to plan.json. Environment and completion facts remain Host-owned. */
  async save(raw: PlanInput, owner: Agent): Promise<TrainingPlan> {
    const input = parsePlan(raw), id = input.id ?? `plan-${randomUUID()}`
    return this.serial(id, async () => {
      for (const ref of input.sourceSessions ?? []) await this.host.sessionInsights.reference(ref)
      const previous = input.id ? await this.existing(id, String(owner.id)) : undefined
      const plan: TrainingPlan = { id, sessionId: String(owner.id), createdAt: new Date().toISOString(), startSeq: Math.max(0, owner.session.snapshotEvents().findLastIndex(event => event.type === 'turn/start')), tokenBudget: 10000000, iterationBudget: 3, ...previous, ...input }
      if (previous) plan.updatedAt = new Date().toISOString()
      await atomicJson(join(this.directory(id), 'plan.json'), plan)
      return plan
    })
  }
  /**
   * Paths pinned by the root's `.gitmodules`, empty for a single-repository project.
   *
   * Logic: read the declarative file rather than `git submodule status`, because a freshly
   * created worktree has no submodule checkout yet. Only the path is needed here; the pinned
   * commit comes from the plan's own tree through `pinned`.
   */
  private async submodulePaths(): Promise<string[]> {
    const text = await readFile(join(this.projectRoot, '.gitmodules'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return '' })
    return text.split('\n').flatMap(line => { const match = /^\s*path\s*=\s*(.+?)\s*$/u.exec(line); return match ? [match[1]!] : [] })
  }
  /** Commits pinned for the submodules of one tree, read from that tree's gitlinks. */
  private async pinned(base: string): Promise<Array<{ path: string; sha: string }>> {
    const result: Array<{ path: string; sha: string }> = []
    for (const path of await this.submodulePaths()) result.push({ path, sha: await this.git(this.projectRoot, ['rev-parse', `${base}:${path}`]) })
    return result
  }
  /**
   * Mount pinned submodules as worktrees of their real checkouts under `workspace`.
   *
   * Logic: `git worktree add --detach` leaves submodules empty, and `git submodule update`
   * would clone a second object store inside the worktree that the real repository cannot see.
   * Mounting a worktree of the sibling checkout keeps one object store per repository, makes
   * sibling `file:` dependencies resolvable, and lets a plan branch exist where integration
   * expects it. With `branch` the mount carries that plan branch (created at the pinned commit
   * when absent); without it the mount stays detached, which verification uses.
   *
   * Idempotency: an already registered mount is left untouched, so retrying prepare or merge
   * never resets work in progress.
   */
  private async mount(workspace: string, pinned: Array<{ path: string; sha: string }>, branch?: string): Promise<void> {
    for (const { path, sha } of pinned) {
      const root = join(this.projectRoot, path), target = join(workspace, path)
      if ((await this.worktrees(root)).some(worktree => worktree.path === target)) continue
      if (!branch) { await this.git(root, ['worktree', 'add', '--detach', target, sha]); continue }
      const exists = await this.git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)
      await this.git(root, ['worktree', 'add', ...(exists ? [target, branch] : ['-b', branch, target, sha])])
    }
  }
  /** Remove mounts created under `workspace` so no stale worktree survives the caller's cleanup. */
  private async unmount(workspace: string, pinned: Array<{ path: string }>): Promise<void> {
    for (const { path } of pinned) {
      const root = join(this.projectRoot, path)
      await this.git(root, ['worktree', 'remove', '--force', join(workspace, path)]).catch(() => undefined)
      await this.git(root, ['worktree', 'prune']).catch(() => undefined)
    }
  }
  /**
   * Install dependencies in each repository root that declares a lock file.
   *
   * A superproject workspace is self-contained, so a real install is the only preparation that
   * resolves the `file:../<sibling>` dependencies a worktree of this shape relies on. Roots
   * without a lock file (the superproject root itself) are skipped. Failures propagate: a
   * silent partial install would surface much later as a confusing missing-module error.
   */
  private async install(workspace: string, pinned: Array<{ path: string }>): Promise<void> {
    const roots = pinned.length ? pinned.map(({ path }) => join(workspace, path)) : [workspace]
    for (const root of roots) {
      if (!await readFile(join(root, 'pnpm-lock.yaml'), 'utf8').catch(() => undefined)) continue
      if (await realpath(join(root, 'node_modules')).catch(() => undefined)) continue
      await run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: root, timeout: 600000, maxBuffer: 16 * 1024 * 1024 })
    }
  }
  /** Prepare once at HEAD; a retry returns the existing worktree without resetting it. */
  async prepare(id: string, owner: string): Promise<{ plan: TrainingPlan; workspace: string; planDirectory: string; executionSessionId: string; handoff: boolean }> {
    return this.serial(id, async () => {
      const plan = await this.read(id, owner), workspace = this.workspace(id)
      await this.requireApproval(plan)
      if (!plan.baseCommit) {
        plan.baseCommit = await this.git(this.projectRoot, ['rev-parse', 'HEAD'])
        const branch = await this.git(this.projectRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => undefined)
        if (branch) plan.targetBranch = branch
        await atomicJson(join(this.directory(id), 'plan.json'), plan)
      }
      const registered = await this.worktrees()
      const actual = await realpath(workspace).catch(() => workspace)
      if (!registered.some(w => w.path === actual || w.path === workspace)) await this.git(this.projectRoot, ['worktree', 'add', '--detach', workspace, plan.baseCommit])
      const pinned = await this.pinned(plan.baseCommit)
      if (pinned.length) {
        if (!plan.submoduleTargets) {
          plan.submoduleTargets = {}
          for (const { path } of pinned) plan.submoduleTargets[path] = await this.git(join(this.projectRoot, path), ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
          await atomicJson(join(this.directory(id), 'plan.json'), plan)
        }
        await this.mount(workspace, pinned, `trainer/${id}`)
        await this.install(workspace, pinned)
      } else {
        const lock = (root: string) => readFile(join(root, 'pnpm-lock.yaml'), 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return undefined })
        if (!await realpath(join(workspace, 'node_modules')).catch(() => undefined) && await lock(this.projectRoot) === await lock(workspace)) await linkWorkcopyDependencies(this.projectRoot, workspace)
      }
      await mkdir(join(this.directory(id), 'proposals'), { recursive: true })
      await mkdir(join(this.directory(id), 'evaluations'), { recursive: true })
      if (!plan.executionSessionId) {
        plan.executionSessionId = `trainer-execution-${randomUUID()}`
        await atomicJson(join(this.directory(id), 'plan.json'), plan)
      }
      await this.startExecution(plan)
      return { plan, workspace, planDirectory: this.directory(id), executionSessionId: plan.executionSessionId, handoff: owner !== plan.executionSessionId }
    })
  }
  /**
   * A plan keeps one durable execution identity. Persist its inbox before waking
   * the loop; retrying prepare resumes the same session and never resets its cwd.
   * The analysis session remains the plan owner; both identities can inspect and
   * operate it, while each human request retains its original session ownership.
   */
  private async startExecution(plan: TrainingPlan): Promise<void> {
    if (plan.merge || !plan.executionSessionId) return
    const workspaceRecord = await this.host.get('workspaceRegistry')?.create(this.workspace(plan.id), `Training: ${plan.title}`)
    const id = SessionId(plan.executionSessionId)
    let agent = this.host.agents.get(id)
    let resumed = false
    if (!agent) {
      // Harness 0.1.5 wraps each stored session's identity in `header`, so the id moves one level down.
      const exists = (await this.host.sessionPersistence.list()).some(row => row.header.id === id)
      resumed = exists
      const setup = async (ctx: Context) => { await this.host.agentPresets.mount(ctx, 'trainer') }
      const agentOptions = this.host.agentDefaultModel.currentSelection()
      const handle = exists
        ? await this.host.agents.resume({ resumeSessionId: id, agentOptions, setup })
        : await this.host.agents.create({ sessionId: id, meta: { cwd: this.workspace(plan.id), parentSession: SessionId(plan.sessionId), agentPreset: 'trainer' }, agentOptions, setup })
      this.handles.set(String(id), handle)
      agent = handle.agent
    }
    if (agent.session.header.cwd !== this.workspace(plan.id)) throw new Error('Training execution workspace mismatch')
    await workspaceRecord?.attachSession(id)
    let messageId = MessageId(`training-execution-${plan.id}`)
    const events = agent.session.snapshotEvents()
    const consumed = events.some(event => event.type === 'user/message' && event.data.id === messageId)
    const reviews = await this.host.humanRequests.list({ planId: plan.id })
    if (consumed) {
      if (!resumed || reviews.some(request => request.status === 'pending')) return
      messageId = MessageId(`training-resume-${plan.id}-${events.findLast(event => event.type === 'turn/end')?.seq ?? 0}`)
      if (events.some(event => event.type === 'user/message' && event.data.id === messageId)) return
    }
    const message = { ...createUserMessage({ source: { kind: 'plugin', plugin: name, form: 'notice', summary: `Execute training plan ${plan.id}` }, content: [{ type: 'text', text: `Execute the prepared Training Plan ${plan.id}. This is its dedicated execution session. Your workspace is ${this.workspace(plan.id)}. ${consumed ? 'Recover unfinished work from the saved proposals, evaluations and human answers.' : 'Continue from training loop step 4.'} Read trainer_plan_read first. Reuse this plan and its proposals. Human plan review and preparation are recorded below. Implement, evaluate artifacts and integrate autonomously within the approved scope. Use native tools in this workspace and delegate implementation here.\nPlan: ${JSON.stringify(plan)}\nHuman requests: ${JSON.stringify(reviews)}\nsource_sessions=${JSON.stringify((plan.sourceSessions ?? []).map(ref => ref.sessionId))}` }] }), id: messageId }
    if (!agent.inbox.nextTurn.some(pending => pending.id === messageId)) agent.send(message, 'next-turn', false)
    if (!await this.host.sessions.flush(agent.session)) throw new Error('TRAINER_PERSISTENCE_REQUIRED')
    agent.inbox.remove(messageId)
    agent.followup(message)
  }
  /** Public global summaries let every Trainer discover existing work before analysis. */
  async listPlans(status: 'open' | 'completed' = 'open', cursor?: string) {
    if (!['open', 'completed'].includes(status)) throw new Error('Invalid plan status')
    const names = await readdir(this.root).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e })
    const plans = await Promise.all(names.sort().map(id => this.read(id)))
    return page(plans.filter(p => status === 'open' ? !p.merge : !!p.merge).map(p => ({ id: p.id, title: summaryText(p.title), description: summaryText(p.description, 500), sessionId: p.sessionId, sourceSessions: (p.sourceSessions ?? []).slice(0, 3), sourceSessionCount: p.sourceSessions?.length ?? 0, painRefs: (p.painRefs ?? []).slice(0, 3), painCount: p.painRefs?.length ?? 0 })), cursor, status)
  }
  /** Append a Host-owned pain association without transferring the Plan's owner. */
  async linkPain(id: string, ref: { painId: string; throughOccurrence: number; reflectId: string }): Promise<void> {
    await this.serial(id, async () => { const plan = await this.read(id); plan.painRefs ??= []; if (plan.painRefs.some(r => r.painId === ref.painId && r.reflectId === ref.reflectId)) return; plan.painRefs.push(ref); await atomicJson(join(this.directory(id), 'plan.json'), plan) })
  }
  onMerged(listener: () => Promise<void>): () => void { this.mergeListeners.add(listener); return () => { this.mergeListeners.delete(listener) } }
  /** Return actual usage, with incomplete provider accounting explicitly identified. */
  async brief(id: string, agent: Agent): Promise<unknown> {
    const plan = await this.read(id)
    if (plan.sessionId !== String(agent.id) && plan.executionSessionId !== String(agent.id)) return { plan, workspace: null }
    const delegated = new Set<string>(plan.executionSessionId ? [plan.executionSessionId] : [])
    const headers = [...(await this.host.sessionPersistence.list()).map(row => row.header), ...this.host.sessions.list().map(session => session.header)]
    let count: number
    do {
      count = delegated.size
      for (const header of headers) if (header.parentSession && delegated.has(String(header.parentSession))) delegated.add(String(header.id))
    } while (delegated.size !== count)
    const sessionIds = [plan.sessionId, ...delegated]
    const histories = await Promise.all(sessionIds.map(async (id) => {
      const from = Math.max(id === plan.sessionId ? plan.startSeq : 0, 0)
      const live = this.host.sessions.get(SessionId(id))
      // Harness 0.1.5 replaced the direct `readFrom` call with a per-session storage handle. A `read`
      // handle observes the log without taking write ownership (so it still works while the owning
      // process holds `write`), and its `inheritedEventCount` carries the fork cut that used to arrive
      // on the read result.
      if (live) return live.snapshotEvents().slice(Math.max(from, Number(live.inheritedEventCount)))
      const handle = await this.host.sessionPersistence.open(SessionId(id), 'read')
      try {
        const { events } = await handle.read(0)
        return events.slice(Math.max(from, Number(handle.inheritedEventCount)))
      } finally {
        await handle.close()
      }
    }))
    const metrics = deriveMetrics(histories[0] ?? [])
    for (const history of histories.slice(1)) {
      const extra = deriveMetrics(history).tokens
      for (const key of Object.keys(extra) as Array<keyof typeof extra>) metrics.tokens[key] += extra[key]
    }
    const tests = (await this.host.agentTests.list()).filter(t => t.planId === id)
    const totals = [metrics.tokens, ...tests.flatMap(t => t.result ? [t.result.metrics.tokens] : [])]
    const totalTokens = totals.reduce((sum, t) => sum + t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens, 0)
    const known = histories.every(hasCompleteUsage)
    return { plan, workspace: plan.baseCommit ? this.workspace(id) : null, usage: { totalTokens, complete: known && tests.every(t => t.result !== undefined && t.result.attempts.length > 0 && t.result.attempts.every(a => a.usageComplete === true)), trainer: metrics.tokens }, requests: (await this.host.humanRequests.list({ planId: id })).map(r => ({ id: r.id, type: r.type, title: r.title, status: r.status, response: r.response })), evaluations: tests.map(t => ({ id: t.runId, status: t.status, path: t.runRoot })) }
  }
  /**
   * The approved Markdown is exactly the user-facing scope and acceptance criteria.
   *
   * Logic:
   * 1. Read this Plan's human requests and keep those owned by its analysis or execution
   *    session; another session's answer never authorizes this Plan.
   * 2. Accept a request only when the human recorded the structured `approve` decision, so a
   *    free-text answer alone is never promoted into an approval.
   * 3. For the current `plan-review` type, require the persisted request body to equal the saved
   *    Plan body, because editing the Plan must invalidate its approval.
   * 4. For the pre-upgrade `training-plan-review` type, accept the Trainer-written review text and
   *    instead require that the Plan was not saved again after the answer; that timestamp is the
   *    analogue of body equality for a record whose body cannot match the saved Plan body.
   *
   * External calls and effects:
   * - `humanRequests.list` reads persisted request files for this Plan id only and writes
   *   nothing, so a recheck during integration observes the same durable decisions.
   *
   * Failure: any reason to doubt the approval throws `Plan approval required`, keeping
   * `trainer_workspace_prepare` and `trainer_merge` closed instead of starting unapproved work.
   */
  private async requireApproval(plan: TrainingPlan): Promise<void> {
    const requests = (await this.host.humanRequests.list({ planId: plan.id })).filter(request =>
      request.sessionId === plan.sessionId || request.sessionId === plan.executionSessionId)
    const approved = requests.some(request => {
      if (request.response?.decision !== 'approve') return false
      if (request.type === 'plan-review') return request.body === plan.body
      // Records written before plan reviews carried the saved Plan body keep the legacy type and
      // the Trainer-written review text; saving that Plan again changes its scope and reopens review.
      if (request.type === 'training-plan-review') return !plan.updatedAt || plan.updatedAt <= request.response.answeredAt
      return false
    })
    if (!approved) throw new Error('Plan approval required')
  }
  /** A failed baseline can be superseded by a successful candidate in the same suite. */
  private async requireEvaluations(id: string): Promise<void> {
    const suites = new Set<string>()
    for (const evaluation of await this.host.agentTests.list()) {
      if (evaluation.planId !== id || suites.has(evaluation.suite)) continue
      suites.add(evaluation.suite)
      if (evaluation.status !== 'passed' || (evaluation.humanReview.required && evaluation.humanReview.status !== 'passed')) {
        throw new Error(`Evaluation ${evaluation.suite} must pass before integration`)
      }
    }
  }
  /**
   * Fast-forward every pinned submodule to the verified candidate before the superproject moves.
   *
   * Logic: each mount is a worktree of the real submodule repository, so a plan branch already
   * exists there and integration is an ordinary fast-forward of the recorded destination branch.
   * Submodules move first so a partially integrated plan stays visible: the superproject pointer
   * only moves once every submodule did, and the receipt is written last.
   *
   * Failure: an unrecorded destination branch, a diverged destination or a dirty destination
   * checkout throws and leaves the remaining repositories untouched.
   */
  private async integrateSubmodules(plan: TrainingPlan, pinned: Array<{ path: string; sha: string }>): Promise<void> {
    for (const { path, sha } of pinned) {
      const root = join(this.projectRoot, path), branch = plan.submoduleTargets?.[path]
      if (!branch) throw new Error(`Specify the target local branch for submodule ${path}`)
      const ref = `refs/heads/${branch}`
      const current: string | undefined = await this.git(root, ['rev-parse', '--verify', '--quiet', ref]).catch(() => undefined)
      if (current === sha) continue
      if (current && await this.git(root, ['merge-base', '--is-ancestor', current, sha]).then(() => true, () => false)) {
        const destination = (await this.worktrees(root)).find(worktree => worktree.branch === ref)
        if (destination && await this.git(destination.path, ['status', '--porcelain'])) throw new Error(`Submodule ${path} checkout has local changes; integration deferred`)
        if (destination) await this.git(destination.path, ['merge', '--ff-only', sha])
        else await this.git(root, ['update-ref', ref, sha, current])
        continue
      }
      if (current) throw new Error(`Submodule ${path} cannot fast-forward to ${sha}`)
      await this.git(root, ['update-ref', ref, sha])
    }
  }
  /**
   * Freeze a candidate and run its checks in an isolated integration worktree.
   * Persist the candidate before moving Git; a retry recovers an interrupted receipt.
   * Destination changes are preserved and a changed verification tree cannot land.
   */
  async merge(id: string, owner: string, checks: string[], branch?: string): Promise<TrainingPlan> {
    return this.serial('merge', async () => {
      const plan = await this.read(id, owner)
      if (plan.merge) { for (const listener of this.mergeListeners) await listener(); return plan }
      await this.requireApproval(plan)
      if (!plan.baseCommit) throw new Error('Prepare the workspace first')
      const targetBranch = plan.targetBranch ?? branch
      if (!targetBranch) throw new Error('Specify the target local branch')
      await this.git(this.projectRoot, ['check-ref-format', '--branch', targetBranch])
      const targetRef = `refs/heads/${targetBranch}`
      const target = await this.git(this.projectRoot, ['rev-parse', '--verify', targetRef])
      const snapshotPath = join(this.directory(id), 'integration.json')
      let snapshot: MergeSnapshot | undefined = await readFile(snapshotPath, 'utf8').then(text => JSON.parse(text) as MergeSnapshot).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
      const finish = async (commit: string, tree: string): Promise<TrainingPlan> => {
        plan.merge = { tree, commit, targetBranch, mergedAt: new Date().toISOString(), ...(snapshot?.submodules?.length ? { submodules: snapshot.submodules } : {}) }
        await this.serial(plan.id, async () => { const latest = await this.read(plan.id); if (latest.painRefs) plan.painRefs = latest.painRefs; await atomicJson(join(this.directory(plan.id), 'plan.json'), plan) })
        for (const listener of this.mergeListeners) await listener()
        await this.host.humanRequests.deliverNotice(owner, `training-completed:${plan.id}`, `Plan ${plan.title} completed, local commit ${commit}`, true)
        if (owner !== plan.sessionId) await this.host.humanRequests.deliverNotice(plan.sessionId, `training-completed:${plan.id}`, `Plan ${plan.title} completed in execution session ${owner}, local commit ${commit}.`, true)
        return plan
      }
      if (snapshot?.targetBranch === targetBranch && snapshot.integratedCommit && await this.git(this.projectRoot, ['merge-base', '--is-ancestor', snapshot.integratedCommit, target]).then(() => true, () => false)) return finish(snapshot.integratedCommit, snapshot.tree)
      await this.requireEvaluations(id)
      if (!checks.length || checks.some(command => !command.trim())) throw new Error('Verification commands required')
      const tree = await this.tree(id, plan.baseCommit)
      // A gitlink records only the submodule's commit, so uncommitted submodule work would be
      // dropped from the candidate without a trace. Compare each mount with the frozen tree and
      // refuse dirty content, so the caller commits inside the submodule first.
      for (const { path, sha } of await this.pinned(tree)) {
        const mount = join(this.workspace(id), path)
        if (await this.git(mount, ['rev-parse', 'HEAD']) !== sha || await this.git(mount, ['status', '--porcelain'])) throw new Error(`Submodule ${path} has uncommitted changes; commit inside it before integration`)
      }
      if (!await this.git(this.projectRoot, ['diff', '--stat', plan.baseCommit, tree])) throw new Error('No training changes to merge')
      const destination = (await this.worktrees()).find(w => w.branch === targetRef)
      if (destination && await this.git(destination.path, ['status', '--porcelain'])) throw new Error('Target checkout has local changes; integration deferred')
      snapshot = { baseCommit: plan.baseCommit, tree, targetBranch, checks, submodules: await this.pinned(tree) }
      snapshot.commit = await this.git(this.projectRoot, ['commit-tree', tree, '-p', plan.baseCommit, '-m', `Trainer: ${plan.title}`])
      await atomicJson(snapshotPath, snapshot)
      const integration = join(this.directory(plan.id), `integration-${randomUUID()}`)
      await this.git(this.projectRoot, ['worktree', 'add', '--detach', integration, target])
      try {
        await this.git(integration, ['cherry-pick', '--no-commit', snapshot.commit])
        const expectedTree = await this.git(integration, ['write-tree'])
        if (snapshot.submodules?.length) {
          await this.mount(integration, snapshot.submodules)
          await this.install(integration, snapshot.submodules)
        } else await linkWorkcopyDependencies(this.workspace(id), integration)
        for (const command of checks) await run('bash', ['-c', command], { cwd: integration, timeout: 300000, maxBuffer: 1024 * 1024 })
        await this.git(integration, ['diff', '--exit-code'])
        if (await this.git(integration, ['write-tree']) !== expectedTree) throw new Error('Integration checks changed verified source')
        if (await this.tree(id, plan.baseCommit) !== tree) throw new Error('Training content changed during verification; retry integration')
        const current = await this.read(id, owner)
        if (current.body !== plan.body) throw new Error('Plan scope changed during verification; retry integration')
        await this.requireApproval(current)
        await this.requireEvaluations(id)
        if (await this.git(this.projectRoot, ['rev-parse', targetRef]) !== target) throw new Error('Target moved during verification; retry integration')
        // Check the superproject checkout before moving any submodule, because advancing a
        // submodule makes that checkout look dirty until its own pointer commit lands.
        if (destination && (await this.git(destination.path, ['symbolic-ref', 'HEAD']) !== targetRef || await this.git(destination.path, ['status', '--porcelain']))) throw new Error('Target checkout changed during verification')
        await this.integrateSubmodules(plan, snapshot.submodules ?? [])
        const integrated = await this.git(this.projectRoot, ['commit-tree', expectedTree, '-p', target, '-m', `Trainer: ${plan.title}`])
        snapshot.integratedCommit = integrated
        await atomicJson(snapshotPath, snapshot)
        if (destination) await this.git(destination.path, ['merge', '--ff-only', integrated])
        else await this.git(this.projectRoot, ['update-ref', targetRef, integrated, target])
        return finish(integrated, tree)
      } finally {
        if (snapshot.submodules?.length) await this.unmount(integration, snapshot.submodules)
        await this.git(this.projectRoot, ['worktree', 'remove', '--force', integration])
      }
    })
  }
  private async tree(id: string, base: string): Promise<string> {
    const index = join(this.directory(id), `index-${randomUUID()}`)
    const env = { ...process.env, GIT_INDEX_FILE: index }
    try {
      await this.git(this.workspace(id), ['read-tree', base], env)
      const files = (await this.git(this.workspace(id), ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(path => path && !path.split('/').some(part => excludedParts.has(part) || part.startsWith('.env') || /\.(pem|key)$/u.test(part)))
      for (let offset = 0; offset < files.length; offset += 100) await this.git(this.workspace(id), ['--literal-pathspecs', 'add', '-A', '--', ...files.slice(offset, offset + 100)], env)
      return await this.git(this.workspace(id), ['write-tree'], env)
    } finally { await rm(index, { force: true }) }
  }
  private async worktrees(root = this.projectRoot): Promise<Array<{ path: string; branch: string | undefined }>> {
    const text = await this.git(root, ['worktree', 'list', '--porcelain'])
    return text.split('\n\n').map(block => ({ path: block.split('\n').find(l => l.startsWith('worktree '))?.slice(9) ?? '', branch: block.split('\n').find(l => l.startsWith('branch '))?.slice(7) }))
  }
  private async git(cwd: string, args: string[], env = process.env): Promise<string> {
    const result = await run('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 })
    return result.stdout.trimEnd()
  }
  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(action)
    this.queues.set(id, next)
    try { return await next } finally { if (this.queues.get(id) === next) this.queues.delete(id) }
  }
}
export default TrainerService
