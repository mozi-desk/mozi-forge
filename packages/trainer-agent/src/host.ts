/**
 * Purpose: Save training plans, prepare HEAD worktrees and integrate human-approved trees.
 * Flow: the Agent chooses its loop; this service records filesystem/Git facts only.
 * A chosen plan id creates the plan on the first save and updates it in place afterwards,
 * preserving createdAt, workspace facts and the merge receipt.
 * Example: plan p1 creates workspace at HEAD, a human reviews its tree, merge writes
 * one commit onto the recorded branch, and p1.merge becomes its completion receipt.
 * Recovery: saved commit identities make repeated integration safe. Dirty destination
 * checkouts and changed review trees fail without resetting user work. Branch movement
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
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { atomicJson, safeId } from '@mozi-forge/human-request-plugin/host'
import type {} from '@mozi-forge/agent-test-plugin/host'
import { linkWorkcopyDependencies } from '@mozi-forge/agent-test-plugin/workcopy'
import type { MergeSnapshot } from '@mozi-forge/human-request-plugin/types'
import { deriveMetrics, hasCompleteUsage } from '@mozi-forge/agent-test-plugin/metrics'
import type {} from '@mozi-forge/session-insights-plugin/host'
import { parsePlan } from './plan.js'
import type { TrainingPlan, PlanInput } from './types.js'
export const name = 'mozi-trainer-host'
export interface Config { projectRoot: string }
export const Config: z<Config> = z.object({ projectRoot: z.string().required() })
declare module '@deepseek-ai/cordis' { interface Context { trainers: TrainerService } }
const run = promisify(execFile)
const excludedParts = new Set(['.runtime', 'node_modules', '.git', '.npmrc', '.credentials.yml', '.credentials.yaml'])
export class TrainerService extends Service {
  static inject = ['humanRequests', 'agentTests', 'sessionInsights']
  static Config = Config
  readonly projectRoot: string
  readonly root: string
  private mergeListeners = new Set<() => Promise<void>>()
  private queues = new Map<string, Promise<unknown>>()
  constructor(private host: Context, config: Config) {
    super(host, 'trainers')
    this.projectRoot = resolve(config.projectRoot)
    this.root = join(resolve(process.env.DSH_HOME ?? join(this.projectRoot, '.runtime')), 'trainning')
  }
  directory(id: string): string { return join(this.root, safeId(id)) }
  workspace(id: string): string { return join(this.directory(id), 'workspace') }
  async read(id: string, owner?: string): Promise<TrainingPlan> {
    const plan = await this.load(id)
    if (!plan) throw new Error(`Unknown training plan: ${id}`)
    if (owner && plan.sessionId !== owner) throw new Error('Plan belongs to another session; choose another id')
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
    if (plan && plan.sessionId !== owner) throw new Error('Plan belongs to another session; choose another id')
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
  /** Prepare once at HEAD; a retry returns the existing worktree without resetting it. */
  async prepare(id: string, owner: string): Promise<{ plan: TrainingPlan; workspace: string; planDirectory: string }> {
    return this.serial(id, async () => {
      const plan = await this.read(id, owner), workspace = this.workspace(id)
      if (!plan.baseCommit) {
        plan.baseCommit = await this.git(this.projectRoot, ['rev-parse', 'HEAD'])
        const branch = await this.git(this.projectRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => undefined)
        if (branch) plan.targetBranch = branch
        await atomicJson(join(this.directory(id), 'plan.json'), plan)
      }
      const registered = await this.worktrees()
      const actual = await realpath(workspace).catch(() => workspace)
      if (!registered.some(w => w.path === actual || w.path === workspace)) await this.git(this.projectRoot, ['worktree', 'add', '--detach', workspace, plan.baseCommit])
      const lock = (root: string) => readFile(join(root, 'pnpm-lock.yaml'), 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return undefined })
      if (!await realpath(join(workspace, 'node_modules')).catch(() => undefined) && await lock(this.projectRoot) === await lock(workspace)) await linkWorkcopyDependencies(this.projectRoot, workspace)
      await mkdir(join(this.directory(id), 'proposals'), { recursive: true })
      await mkdir(join(this.directory(id), 'evaluations'), { recursive: true })
      return { plan, workspace, planDirectory: this.directory(id) }
    })
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
  async currentWorkspace(owner: string): Promise<string> {
    const names = await readdir(this.root).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return [] })
    const plans = await Promise.all(names.map(id => this.read(id).catch(() => undefined)))
    const current = plans.filter((p): p is TrainingPlan => !!p && p.sessionId === owner && !!p.baseCommit && !p.merge).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0]
    return current ? this.workspace(current.id) : this.projectRoot
  }
  /** Return actual usage, with incomplete provider accounting explicitly identified. */
  async brief(id: string, agent: Agent): Promise<unknown> {
    const plan = await this.read(id)
    if (plan.sessionId !== String(agent.id)) return { plan, workspace: null }
    const events = agent.session.snapshotEvents().slice(plan.startSeq)
    const metrics = deriveMetrics(events)
    const tests = (await this.host.agentTests.list()).filter(t => t.planId === id)
    const totals = [metrics.tokens, ...tests.flatMap(t => t.result ? [t.result.metrics.tokens] : [])]
    const totalTokens = totals.reduce((sum, t) => sum + t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens, 0)
    const known = hasCompleteUsage(events)
    return { plan, workspace: plan.baseCommit ? this.workspace(id) : null, usage: { totalTokens, complete: known && tests.every(t => t.result !== undefined && t.result.attempts.length > 0 && t.result.attempts.every(a => a.usageComplete === true)), trainer: metrics.tokens }, requests: (await this.host.humanRequests.list({ planId: id })).map(r => ({ id: r.id, type: r.type, title: r.title, status: r.status, response: r.response })), evaluations: tests.map(t => ({ id: t.runId, status: t.status, path: t.runRoot })) }
  }
  /** Capture the full review tree using a temporary index, preserving the Agent's index. */
  async snapshot(id: string, owner: string, branch?: string, checks: string[] = []): Promise<{ merge: MergeSnapshot; body: string }> {
    const plan = await this.read(id, owner)
    if (!plan.baseCommit) throw new Error('Prepare the workspace first')
    const targetBranch = plan.targetBranch ?? branch
    if (!targetBranch) throw new Error('Ask the human to name the target local branch')
    await this.git(this.projectRoot, ['check-ref-format', '--branch', targetBranch])
    await this.git(this.projectRoot, ['rev-parse', '--verify', `refs/heads/${targetBranch}`])
    const tree = await this.tree(id, plan.baseCommit)
    await this.git(this.projectRoot, ['update-ref', `refs/mozi-training/${id}/${tree}`, tree])
    const diff = await this.git(this.projectRoot, ['diff', '--stat', plan.baseCommit, tree])
    if (!diff) throw new Error('No training changes to merge')
    const full = await this.git(this.projectRoot, ['diff', '--no-ext-diff', '--binary', plan.baseCommit, tree])
    return { merge: { baseCommit: plan.baseCommit, tree, targetBranch, checks }, body: `\n\n## 合入快照\nTree: ${tree}\n目标本地分支: ${targetBranch}\n\n检查命令：\n${checks.join('\n')}\n\n批准本次快照请答复：批准合入本次修改。\n\n## 完整 diff\n\`\`\`diff\n${full}\n\`\`\`\n` }
  }
  /**
   * Integrate only the explicitly approved tree. A temporary worktree checks advanced
   * branches; the destination moves only after successful checks and clean status.
   * Saved commit ids let a retry recognize a completed Git update before the receipt.
   */
  async merge(requestId: string, owner: string): Promise<TrainingPlan> {
    return this.serial('merge', async () => {
      const request = await this.host.humanRequests.read(requestId)
      if (request.sessionId !== owner || request.type !== 'training-merge' || !request.planId || !request.merge) throw new Error('Owned merge request required')
      if (request.response?.body.trim() !== '批准合入本次修改。') throw new Error('Explicit human merge approval required')
      const plan = await this.read(request.planId, owner), snapshot = request.merge
      if (plan.merge) { for (const listener of this.mergeListeners) await listener(); return plan }
      const targetRef = `refs/heads/${snapshot.targetBranch}`
      let target = await this.git(this.projectRoot, ['rev-parse', targetRef])
      const finish = async (commit: string): Promise<TrainingPlan> => {
        plan.merge = { requestId, commit, targetBranch: snapshot.targetBranch, mergedAt: new Date().toISOString() }
        await this.serial(plan.id, async () => { const latest = await this.read(plan.id); if (latest.painRefs) plan.painRefs = latest.painRefs; await atomicJson(join(this.directory(plan.id), 'plan.json'), plan) })
        for (const listener of this.mergeListeners) await listener()
        await this.host.humanRequests.deliverNotice(owner, `training-merged:${plan.id}`, `Training Plan ${plan.title} 已完成，本地提交 ${commit}`, true)
        return plan
      }
      if (snapshot.integratedCommit && await this.git(this.projectRoot, ['merge-base', '--is-ancestor', snapshot.integratedCommit, target]).then(() => true, () => false)) return finish(snapshot.integratedCommit)
      if (await this.tree(plan.id, snapshot.baseCommit) !== snapshot.tree) throw new Error('Training content changed; submit a fresh merge request')
      const destination = (await this.worktrees()).find(w => w.branch === targetRef)
      if (destination && await this.git(destination.path, ['status', '--porcelain'])) throw new Error('Target checkout has local changes; ask the human to handle them')
      if (!snapshot.commit) {
        snapshot.commit = await this.git(this.projectRoot, ['commit-tree', snapshot.tree, '-p', snapshot.baseCommit, '-m', `Trainer: ${plan.title}`])
        await this.host.humanRequests.save(request)
      }
      let integrated = snapshot.commit
      if (target !== snapshot.baseCommit) {
        if (!snapshot.checks.length) throw new Error('Target advanced; submit a merge request with proposal verification commands')
        const integration = join(this.directory(plan.id), `integration-${randomUUID()}`)
        await this.git(this.projectRoot, ['worktree', 'add', '--detach', integration, target])
        await this.git(integration, ['cherry-pick', '--no-commit', snapshot.commit])
        const expectedTree = await this.git(integration, ['write-tree'])
        for (const command of snapshot.checks) await run('bash', ['-c', command], { cwd: integration, timeout: 300000, maxBuffer: 1024 * 1024 })
        await this.git(integration, ['diff', '--exit-code'])
        const tree = await this.git(integration, ['write-tree'])
        if (tree !== expectedTree) throw new Error('Integration checks changed reviewed source; submit a fresh request')
        integrated = await this.git(this.projectRoot, ['commit-tree', tree, '-p', target, '-m', `Trainer: ${plan.title}`])
      }
      snapshot.integratedCommit = integrated
      await this.host.humanRequests.save(request)
      if (await this.git(this.projectRoot, ['rev-parse', targetRef]) !== target) throw new Error('Target moved during verification; retry integration')
      if (destination) {
        if (await this.git(destination.path, ['symbolic-ref', 'HEAD']) !== targetRef || await this.git(destination.path, ['status', '--porcelain'])) throw new Error('Target checkout changed during verification')
        await this.git(destination.path, ['merge', '--ff-only', integrated])
      } else await this.git(this.projectRoot, ['update-ref', targetRef, integrated, target])
      return finish(integrated)
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
  private async worktrees(): Promise<Array<{ path: string; branch: string | undefined }>> {
    const text = await this.git(this.projectRoot, ['worktree', 'list', '--porcelain'])
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
