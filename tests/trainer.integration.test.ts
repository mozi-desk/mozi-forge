/**
 * Purpose: Black-box Trainer tools, human answers and real Git integration.
 * Example: a verified tree becomes one local commit; changed verification trees and dirty checkouts
 * are rejected without losing source. All commits belong to disposable repositories.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { fixture, git } from './trainer-fixture.js'
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose() })
async function setup() { const f = await fixture(); fixtures.push(f); return f }
async function training(f: Awaited<ReturnType<typeof fixture>>) {
  const plan = await f.call('trainer_plan_save', { description: 'Improve the observed Agent behavior.', title: 'Improve agent', body: '## Goal\nImprove the response.' })
  const review = await f.call('human_request_submit', { type: 'plan-review', planId: plan.id, body: plan.body })
  await f.ctx.humanRequests.respond(review.id, '同意，请继续。', 'approve')
  const { workspace } = await f.call('trainer_workspace_prepare', { plan_id: plan.id })
  return { plan, workspace }
}
async function approve(f: Awaited<ReturnType<typeof fixture>>, plan: { id: string; body: string }, agent = f.handle) {
  const request = await f.callAs(agent, 'human_request_submit', { type: 'plan-review', planId: plan.id, body: plan.body })
  await f.ctx.humanRequests.respond(request.id, '', 'approve')
}
it('hands training to one execution session and uses native tools in its HEAD workspace', async () => {
  const f = await setup()
  expect(f.ctx.tools.schemas(f.handle.agent).map(t => t.name).sort()).toEqual(expect.arrayContaining(['trainer_plan_list','sleep_loop_schedule','sleep_loop_status','session_inspect','session_query','session_read','bash','trainer_plan_save','trainer_plan_read','trainer_workspace_prepare','trainer_merge','human_request_submit','human_request_read','agent_test_preflight','agent_test_list','agent_test_start','agent_test_status','agent_test_wait','agent_test_read','agent_test_cancel'].sort()))
  await writeFile(join(f.root, 'agent.txt'), 'local unsaved work')
  const { plan, workspace } = await training(f)
  expect(plan.tokenBudget).toBe(10000000); expect(plan.iterationBudget).toBe(3)
  expect(await readFile(join(workspace, 'agent.txt'), 'utf8')).toBe('baseline\n')
  const result = await f.call('bash', { command: 'pwd' })
  expect(JSON.stringify(result)).toContain(workspace)
  await f.call('bash', { command: "printf improved > agent.txt" })
  await f.call('trainer_workspace_prepare', { plan_id: plan.id })
  expect(await readFile(join(workspace, 'agent.txt'), 'utf8')).toBe('improved')
  expect(await readFile(join(f.root, 'agent.txt'), 'utf8')).toBe('local unsaved work')
  const saved = await f.ctx.trainers.read(plan.id)
  const execution = f.ctx.agents.get(SessionId(saved.executionSessionId!))!
  expect(execution.session.header.cwd).toBe(workspace)
  expect(execution.session.header.parentSession).toBe(f.handle.agent.id)
  expect((await f.call('trainer_workspace_prepare', { plan_id: plan.id })).executionSessionId).toBe(saved.executionSessionId)
  await f.call('write', { file_path: 'native.txt', content: 'native file tools' })
  expect(JSON.stringify(await f.call('read', { file_path: 'native.txt' }))).toContain('native file tools')
  expect(JSON.stringify(await f.call('glob', { pattern: '*.txt' }))).toContain('native.txt')
  await expect(readFile(join(f.root, 'native.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  const job = await f.call('bash', { command: 'pwd', run_in_background: true })
  expect(JSON.stringify(await f.call('job_output', { job_id: job.jobId, wait: true, timeout_ms: 5000 }))).toContain(workspace)
})

it('resumes the same durable execution session after the owning service restarts', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  const executionSessionId = (await f.ctx.trainers.read(plan.id)).executionSessionId!
  const execution = f.ctx.agents.get(SessionId(executionSessionId))!
  await f.call('write', { file_path: 'progress.txt', content: 'keep this progress' })
  await f.ctx.sessions.flush(execution.session)
  await f.restartTrainer()
  const resumed = await f.callAs(f.handle, 'trainer_workspace_prepare', { plan_id: plan.id })
  expect(resumed.executionSessionId).toBe(executionSessionId)
  expect(f.ctx.agents.get(SessionId(executionSessionId))!.session.header.cwd).toBe(workspace)
  expect(await readFile(join(workspace, 'progress.txt'), 'utf8')).toBe('keep this progress')
  expect((await f.ctx.trainers.read(plan.id)).sessionId).toBe(String(f.handle.agent.id))
})

it('keeps concurrent plans in distinct native tool workspaces', async () => {
  const f = await setup(), first = await training(f), other = await f.createAgent()
  const second = await f.callAs(other, 'trainer_plan_save', { title: 'Second workspace', description: 'Isolate concurrent work.', body: 'Change only this plan.' })
  await approve(f, second, other)
  const prepared = await f.callAs(other, 'trainer_workspace_prepare', { plan_id: second.id })
  const agent = f.ctx.agents.get(SessionId(prepared.executionSessionId))!
  await f.call('write', { file_path: 'isolation.txt', content: 'first' })
  await f.callAs({ agent, dispose: async () => {} }, 'write', { file_path: 'isolation.txt', content: 'second' })
  expect(await readFile(join(first.workspace, 'isolation.txt'), 'utf8')).toBe('first')
  expect(await readFile(join(prepared.workspace, 'isolation.txt'), 'utf8')).toBe('second')
  await expect(readFile(join(f.root, 'isolation.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(f.callAs(other, 'trainer_workspace_prepare', { plan_id: first.plan.id })).rejects.toThrow('another session')
})
it('requires one plan decision and integrates autonomously with an idempotent receipt', async () => {
  const f = await setup()
  const plan = await f.call('trainer_plan_save', { title: 'Improve output', description: 'Fix observed output.', body: 'What: improve output. Why: incorrect output. Accept: output is improved.' })
  await expect(f.call('trainer_workspace_prepare', { plan_id: plan.id })).rejects.toThrow('Plan approval')
  const rejected = await f.call('human_request_submit', { type: 'plan-review', planId: plan.id, body: plan.body })
  await f.ctx.humanRequests.respond(rejected.id, '', 'request-changes')
  await expect(f.call('trainer_workspace_prepare', { plan_id: plan.id })).rejects.toThrow('Plan approval')
  await approve(f, plan)
  const { workspace } = await f.call('trainer_workspace_prepare', { plan_id: plan.id })
  await writeFile(join(workspace, 'agent.txt'), 'improved')
  const args = { plan_id: plan.id, checks: ['test "$(cat agent.txt)" = improved'] }
  const merged = await f.call('trainer_merge', args)
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(merged.merge.commit)
  expect(await readFile(join(f.root, 'agent.txt'), 'utf8')).toBe('improved')
  await f.call('trainer_merge', args)
  expect(await git(f.root, 'rev-list', '--count', 'HEAD')).toBe('2')
  expect((await f.ctx.humanRequests.list({ planId: plan.id })).every(r => r.type === 'plan-review')).toBe(true)
  // Public persisted document models interruption between Git update and receipt write.
  delete merged.merge
  await writeFile(join(f.home, 'trainning', plan.id, 'plan.json'), JSON.stringify(merged))
  await f.restartTrainer()
  expect((await f.call('trainer_merge', args)).merge.commit).toBe(await git(f.root, 'rev-parse', 'HEAD'))
  expect(await git(f.root, 'rev-list', '--count', 'HEAD')).toBe('2')
})
it('binds approval to the current scope and preserves a dirty destination', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'improved')
  const args = { plan_id: plan.id, checks: ['true'] }
  const revised = await f.call('trainer_plan_save', { id: plan.id, title: plan.title, description: plan.description, body: 'Different acceptance criteria.' })
  await expect(f.call('trainer_merge', args)).rejects.toThrow('Plan approval')
  await approve(f, revised)
  await writeFile(join(f.root, 'agent.txt'), 'user work')
  await expect(f.call('trainer_merge', args)).rejects.toThrow('local changes')
  expect(await readFile(join(f.root, 'agent.txt'), 'utf8')).toBe('user work')
  expect((await f.ctx.trainers.read(plan.id)).merge).toBeUndefined()
  await writeFile(join(f.root, 'agent.txt'), 'baseline\n')
  await f.call('trainer_merge', args)
  expect(await readFile(join(f.root, 'agent.txt'), 'utf8')).toBe('improved')
})
it('checks an advanced destination in isolation and preserves unrelated commits', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'improved')
  await writeFile(join(f.root, 'other.txt'), 'new main work'); await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'advance')
  await f.call('trainer_merge', { plan_id: plan.id, checks: ['test "$(cat agent.txt)" = improved', 'test "$(cat other.txt)" = "new main work"'] })
  expect(await readFile(join(f.root, 'other.txt'), 'utf8')).toBe('new main work')
  expect(await git(f.root, 'rev-list', '--count', 'HEAD')).toBe('3')
})
it.each([false, true])('failed checks leave the destination unchanged (advanced=%s)', async advanced => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'improved')
  if (advanced) { await writeFile(join(f.root, 'other.txt'), 'new'); await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'advance') }
  const before = await git(f.root, 'rev-parse', 'HEAD')
  await expect(f.call('trainer_merge', { plan_id: plan.id, checks: [] })).rejects.toThrow('Verification commands')
  await expect(f.call('trainer_merge', { plan_id: plan.id, checks: ['exit 7'] })).rejects.toThrow()
  await expect(f.call('trainer_merge', { plan_id: plan.id, checks: ['printf changed > agent.txt'] })).rejects.toThrow()
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(before)
  expect((await f.ctx.trainers.read(plan.id)).merge).toBeUndefined()
  await f.call('trainer_merge', { plan_id: plan.id, checks: ['test "$(cat agent.txt)" = improved'] })
  expect(await readFile(join(f.root, 'agent.txt'), 'utf8')).toBe('improved')
})
it('requires the latest evaluation and artifact assessment to pass, including after recovery', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'improved')
  const runRoot = join(f.home, 'agent-tests/runs/20260921010101-1234abcd')
  await mkdir(runRoot, { recursive: true })
  const result = { version: 1, runId: '20260921010101-1234abcd', planId: plan.id, suite: 'acceptance', repeat: 1, startedAt: 1, finishedAt: 2, status: 'waiting-review', automaticVerdict: 'passed', humanReview: { required: true, status: 'pending', items: [] } }
  await writeFile(join(runRoot, 'result.json'), JSON.stringify(result))
  const args = { plan_id: plan.id, checks: ['test -s agent.txt'] }
  await f.restartTrainer()
  await expect(f.call('trainer_merge', args)).rejects.toThrow('Evaluation acceptance must pass')
  await writeFile(join(runRoot, 'result.json'), JSON.stringify({ ...result, status: 'review-failed', humanReview: { ...result.humanReview, status: 'failed' } }))
  await expect(f.call('trainer_merge', args)).rejects.toThrow('Evaluation acceptance must pass')
  const nextRoot = join(f.home, 'agent-tests/runs/20260921010102-1234abcd')
  await mkdir(nextRoot)
  await writeFile(join(nextRoot, 'result.json'), JSON.stringify({ ...result, runId: '20260921010102-1234abcd', startedAt: 3, finishedAt: 4, status: 'passed', humanReview: { ...result.humanReview, status: 'passed' } }))
  await f.call('trainer_merge', args)
  expect(await readFile(join(f.root, 'agent.txt'), 'utf8')).toBe('improved')
})
it('rejects source changes during verification without moving the target', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'improved')
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  await expect(f.call('trainer_merge', { plan_id: plan.id, checks: [`printf changed > ${quote(join(workspace, 'agent.txt'))}`] })).rejects.toThrow('Training content changed')
  expect(await git(f.root, 'rev-list', '--count', 'HEAD')).toBe('1')
})
it('leaves conflicting changes intact and accepts a named detached destination', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'training change')
  await writeFile(join(f.root, 'agent.txt'), 'main change'); await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'conflict')
  const before = await git(f.root, 'rev-parse', 'HEAD')
  await expect(f.call('trainer_merge', { plan_id: plan.id, checks: ['true'] })).rejects.toThrow()
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(before)
  expect(await readFile(join(f.root, 'agent.txt'), 'utf8')).toBe('main change')
  await git(f.root, 'checkout', '--detach')
  const next = await training(f)
  await writeFile(join(next.workspace, 'agent.txt'), 'detached improvement')
  await expect(f.call('trainer_merge', { plan_id: next.plan.id, checks: ['true'] })).rejects.toThrow('target local branch')
  const result = await f.call('trainer_merge', { plan_id: next.plan.id, target_branch: 'main', checks: ['true'] })
  expect(await git(f.root, 'rev-parse', 'refs/heads/main')).toBe(result.merge.commit)
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(before)
})
it('keeps allowance advisory and records uncertain token coverage', async () => {
  const f = await setup()
  const plan = await f.call('trainer_plan_save', { description: 'Improve the observed Agent behavior.', title: 'Small allowance', body: 'One iteration.', tokenBudget: 1, iterationBudget: 1 })
  const brief = await f.call('trainer_plan_read', { plan_id: plan.id })
  expect(brief.usage.complete).toBe(false)
  await approve(f, plan)
  await f.call('trainer_workspace_prepare', { plan_id: plan.id })
  expect((await f.call('bash', { command: 'exit 4' })).exitCode).toBe(4)
  await expect(f.call('bash', { command: 'printf still-available' })).resolves.toBeTruthy()
})

it('exposes native session schemas and validates frozen plan references through public tools', async () => {
  const f = await setup()
  const session = f.handle.agent.session
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await f.ctx.sessions.flush(session)
  const summary = await f.call('session_inspect', { session_id: String(session.id) })
  const ref = { sessionId: String(session.id), revision: summary.revision }
  const schemas = f.ctx.tools.schemas(f.handle.agent)
  expect(JSON.stringify(schemas.find(s => s.name === 'trainer_plan_save'))).toContain('sourceSessions')
  expect(JSON.stringify(schemas.find(s => s.name === 'session_query'))).toContain('suspected-loop')
  await expect(f.call('session_read', { session_id: String(session.id), revision: summary.revision, from: -1, through: 1 })).rejects.toThrow('from')
  await expect(f.call('session_query', { session_id: String(session.id), revision: summary.revision, cursor: 'invalid' })).rejects.toThrow('CURSOR')
  expect((await f.call('session_read', { session_id: String(session.id), revision: summary.revision, from: 0, through: 1 })).text).toContain('turn/start')
  await expect(f.call('trainer_plan_save', { description: 'Improve the observed Agent behavior.', title: 'Bad evidence', body: 'Review', sourceSessions: [{...ref, revision:'missing'}] })).rejects.toThrow('REVISION')
  await expect(f.call('trainer_plan_save', { description: 'Improve the observed Agent behavior.', title: 'Bad shape', body: 'Review', sourceSessions: JSON.stringify([ref]) })).rejects.toThrow()
  const plan = await f.call('trainer_plan_save', { description: 'Improve the observed Agent behavior.', title: 'Session improvement', body: 'Review these facts', sourceSessions: [ref] })
  expect(plan.sourceSessions).toEqual([ref])
  expect((await f.call('trainer_plan_read', { plan_id: plan.id })).plan.sourceSessions).toEqual([ref])
})

it('creates a plan with an explicit readable id and then updates that same plan', async () => {
  const f = await setup()
  const created = await f.call('trainer_plan_save', { id: 'named-training', description: 'Improve the observed Agent behavior.', title: 'Named plan', body: '## Goal\nFirst revision.' })
  expect(created.id).toBe('named-training')
  expect(Date.parse(created.createdAt)).toBeGreaterThan(0)
  expect(created.updatedAt).toBeUndefined()
  expect(JSON.parse(await readFile(join(f.home, 'trainning', 'named-training', 'plan.json'), 'utf8')).body).toContain('First revision.')
  await approve(f, created)
  const prepared = await f.call('trainer_workspace_prepare', { plan_id: 'named-training' })
  expect(JSON.stringify(await f.call('bash', { command: 'pwd' }))).toContain(prepared.workspace)
  const updated = await f.call('trainer_plan_save', { id: 'named-training', description: 'Improve the observed Agent behavior.', title: 'Named plan v2', body: '## Goal\nSecond revision.' })
  expect(updated.title).toBe('Named plan v2')
  expect(updated.body).toContain('Second revision.')
  expect(updated.createdAt).toBe(created.createdAt)
  expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.createdAt))
  expect(updated.baseCommit).toBe((await f.call('trainer_plan_read', { plan_id: 'named-training' })).plan.baseCommit)
  await approve(f, updated)
  expect((await f.call('trainer_workspace_prepare', { plan_id: 'named-training' })).workspace).toBe(prepared.workspace)
})

it('rejects a plan id owned by another session and preserves the stored plan', async () => {
  const f = await setup()
  await f.call('trainer_plan_save', { id: 'owned-plan', description: 'Improve the observed Agent behavior.', title: 'Owned plan', body: 'Mine.' })
  const other = await f.createAgent()
  await expect(f.callAs(other, 'trainer_plan_save', { id: 'owned-plan', description: 'Improve the observed Agent behavior.', title: 'Hijack', body: 'Not mine.' })).rejects.toThrow('another session')
  const stored = JSON.parse(await readFile(join(f.home, 'trainning', 'owned-plan', 'plan.json'), 'utf8'))
  expect(stored.body).toBe('Mine.')
  expect(stored.sessionId).toBe(String(f.handle.agent.id))
})

it('reports an unknown plan id without leaking a filesystem error', async () => {
  const f = await setup()
  await expect(f.call('trainer_plan_read', { plan_id: 'no-such-plan' })).rejects.toThrow('Unknown training plan')
})

it('still generates a plan id when none is supplied', async () => {
  const f = await setup()
  const plan = await f.call('trainer_plan_save', { description: 'Improve the observed Agent behavior.', title: 'Default identity', body: 'No explicit id.' })
  expect(plan.id.startsWith('plan-')).toBe(true)
  expect(plan.updatedAt).toBeUndefined()
})

it('executes native Sleep scheduling tools through the real Loader without invoking a model', async () => {
  const f = await setup()
  const initial = await f.call('sleep_loop_status')
  const schema = JSON.stringify(f.ctx.tools.schemas(f.handle.agent).find(t => t.name === 'sleep_loop_schedule'))
  expect(schema).toContain('delta_ms'); expect(schema).toContain('integer'); expect(schema).toContain('at')
  await expect(f.call('sleep_loop_schedule', { delta_ms: '28800000' })).rejects.toThrow()
  await expect(f.call('sleep_loop_schedule', { delta_ms: 28800000, at: new Date(initial.hardDeadlineAt).toISOString() })).rejects.toThrow()
  const changed = await f.call('sleep_loop_schedule', { delta_ms: 28800000 })
  expect(changed.hardDeadlineAt).toBe(initial.hardDeadlineAt)
  expect(changed.nextDueAt).toBeLessThan(initial.hardDeadlineAt)
  expect(JSON.stringify(changed)).not.toContain('sessions')
  const disk = JSON.parse(await readFile(join(f.home, 'sleeps/scheduler.json'), 'utf8'))
  expect(disk.nextDueAt).toBe(changed.nextDueAt)
})

// Drive the real Sleep delivery and AgentLoop against QuietModel's in-memory stream.
it('routes a Sleep-created Trainer through the configured default model without a Web controller', async () => {
  const f = await setup()
  await f.ctx.sleepLoop.schedule({ delta_ms: 1 })
  await expect.poll(async () => (await f.ctx.sleepLoop.status()).lastSleepId).not.toBeNull()
  const sleepId = (await f.ctx.sleepLoop.status()).lastSleepId!
  const id = SessionId(`trainer-${sleepId}`)
  await expect.poll(() => f.ctx.agents.get(id)?.session.requestHeader()?.config.model).toBe('fixture')
  const session = f.ctx.agents.get(id)!.session
  expect(session.requestHeader()!.config.provider).toBe('fixture')
  await expect.poll(() => session.snapshotEvents().filter(e => e.type === 'turn/end').length).toBe(1)
  const end = session.snapshotEvents().find(e => e.type === 'turn/end')!
  expect(end.data).toMatchObject({ reason: { kind: 'completed' } })
})

it('paginates global plan summaries and reads the first paragraph of legacy plans', async () => {
  const f = await setup()
  for (let i = 0; i < 23; i++) await f.call('trainer_plan_save', { id: `summary-${i}`, title: `Plan ${i}`, description: `Description ${i}`, body: 'First paragraph\ncontinued.\n\nSecond paragraph.' })
  const legacyPath = join(f.home, 'trainning', 'summary-0', 'plan.json')
  const legacy = JSON.parse(await readFile(legacyPath, 'utf8'))
  delete legacy.description
  await writeFile(legacyPath, JSON.stringify(legacy))
  const read = await f.call('trainer_plan_read', { plan_id: 'summary-0' })
  expect(read.plan.description).toBe('First paragraph\ncontinued.')
  let cursor: string | undefined
  const ids: string[] = []
  do {
    const result = await f.call('trainer_plan_list', cursor ? { cursor } : {})
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192)
    ids.push(...result.items.map((item: {id: string}) => item.id))
    cursor = result.nextCursor ?? undefined
  } while (cursor)
  expect(new Set(ids).size).toBe(23)
})


it('renders saved plan scope before approval even when the Agent submits a paraphrase', async () => {
  const f = await setup()
  const plan = await f.call('trainer_plan_save', { title: 'Apply release rule', description: 'Persist the team rule.', body: 'Block releases below 4096 MiB after rollback reserve. Accept on the four unchanged cases.' })
  const args = { type: 'plan-review', planId: plan.id, requestId: 'canonical-plan-review', title: 'Short summary', body: 'Please approve the release rule.' }
  const submitted = await f.call('human_request_submit', args)
  const displayed = await f.ctx.humanRequests.read(submitted.id)
  expect(displayed.title).toBe(plan.title)
  expect(displayed.body).toBe(plan.body)
  expect(displayed.response).toBeUndefined()
  expect(await f.call('human_request_submit', { ...args, body: 'Same review, paraphrased again.' })).toEqual(submitted)
  await f.ctx.humanRequests.respond(submitted.id, '', 'approve')
  const prepared = await f.call('trainer_workspace_prepare', { plan_id: plan.id })
  expect(prepared.executionSessionId).toBeTruthy()
  expect(await f.ctx.humanRequests.list({ planId: plan.id })).toHaveLength(1)
  await f.restartTrainer()
  expect((await f.call('trainer_workspace_prepare', { plan_id: plan.id })).executionSessionId).toBe(prepared.executionSessionId)
  await f.call('trainer_plan_save', { id: plan.id, title: plan.title, description: plan.description, body: 'Change acceptance to two cases.' })
  await expect(f.call('trainer_workspace_prepare', { plan_id: plan.id })).rejects.toThrow('Plan approval')
  expect((await f.ctx.humanRequests.read(submitted.id)).body).toBe(plan.body)
})

it('rejects missing, unknown and other-owner plan reviews before creating a human request', async () => {
  const f = await setup()
  await expect(f.call('human_request_submit', { type: 'plan-review', body: 'Review it.' })).rejects.toThrow('requires planId')
  await expect(f.call('human_request_submit', { type: 'plan-review', planId: 'unknown-plan', body: 'Review it.' })).rejects.toThrow('Unknown training plan')
  const plan = await f.call('trainer_plan_save', { title: 'Owned scope', description: 'Owned review.', body: 'Only this scope.' })
  const other = await f.createAgent()
  await expect(f.callAs(other, 'human_request_submit', { type: 'plan-review', planId: plan.id, body: 'Approve another plan.' })).rejects.toThrow('another session')
  expect(await f.ctx.humanRequests.list()).toEqual([])
  const question = await f.call('human_request_submit', { type: 'question', title: 'Question', body: 'Which server?' })
  expect((await f.ctx.humanRequests.read(question.id)).body).toBe('Which server?')
})
