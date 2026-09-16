/**
 * Purpose: Black-box Trainer tools, human answers and real Git integration.
 * Example: a reviewed tree becomes one local commit; changed trees and dirty checkouts
 * are rejected without losing source. All commits belong to disposable repositories.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { fixture, git } from './trainer-fixture.js'
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose() })
async function setup() { const f = await fixture(); fixtures.push(f); return f }
async function training(f: Awaited<ReturnType<typeof fixture>>) {
  const plan = await f.call('trainer_plan_save', { description: 'Improve the observed Agent behavior.', title: 'Improve agent', body: '## Goal\nImprove the response.' })
  const review = await f.call('human_request_submit', { type: 'training-plan-review', planId: plan.id, body: plan.body })
  await f.ctx.humanRequests.respond(review.id, '同意，请继续。')
  const { workspace } = await f.call('trainer_workspace_prepare', { plan_id: plan.id })
  return { plan, workspace }
}
async function proposal(f: Awaited<ReturnType<typeof fixture>>, id: string, checks: string[] = []) {
  return f.call('human_request_submit', { type: 'training-merge', planId: id, title: 'Merge changes', body: 'Review the full diff.', checks })
}
it('loads the versioned Trainer preset with the configured Trainer tools and executes shell in the HEAD training workspace', async () => {
  const f = await setup()
  expect(f.ctx.tools.schemas(f.handle.agent).map(t => t.name).sort()).toEqual(['trainer_plan_list','sleep_loop_schedule','sleep_loop_status','session_inspect','session_query','session_read','bash','trainer_plan_save','trainer_plan_read','trainer_workspace_prepare','trainer_merge','human_request_submit','human_request_read','agent_test_preflight','agent_test_list','agent_test_start','agent_test_status','agent_test_wait','agent_test_read','agent_test_cancel'].sort())
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
})
it('requires human approval, integrates once and records completion only after Git succeeds', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'improved\n')
  const request = await proposal(f, plan.id)
  expect((await f.ctx.humanRequests.read(request.id)).body).toContain('+improved')
  await expect(f.call('trainer_merge', { request_id: request.id })).rejects.toThrow('approval')
  expect((await f.ctx.trainers.read(plan.id)).merge).toBeUndefined()
  await f.ctx.humanRequests.respond(request.id, '批准合入本次修改。')
  const merged = await f.call('trainer_merge', { request_id: request.id })
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(merged.merge.commit)
  expect(await readFile(join(f.root, 'agent.txt'), 'utf8')).toBe('improved\n')
  await f.call('trainer_merge', { request_id: request.id })
  expect(await git(f.root, 'rev-list', '--count', 'HEAD')).toBe('2')
})
it('protects rejected requests and changed reviewed content', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'first')
  const rejected = await proposal(f, plan.id)
  await f.ctx.humanRequests.respond(rejected.id, '请调整：保留原有行为。')
  await expect(f.call('trainer_merge', { request_id: rejected.id })).rejects.toThrow('approval')
  const approved = await proposal(f, plan.id)
  await f.ctx.humanRequests.respond(approved.id, '批准合入本次修改。')
  await writeFile(join(workspace, 'agent.txt'), 'second')
  await expect(f.call('trainer_merge', { request_id: approved.id })).rejects.toThrow('changed')
  expect(await git(f.root, 'rev-list', '--count', 'HEAD')).toBe('1')
})
it('preserves dirty destination and integrates after it is clean', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'improved')
  const request = await proposal(f, plan.id)
  await f.ctx.humanRequests.respond(request.id, '批准合入本次修改。')
  await writeFile(join(f.root, 'agent.txt'), 'user work')
  await expect(f.call('trainer_merge', { request_id: request.id })).rejects.toThrow('local changes')
  expect(await readFile(join(f.root, 'agent.txt'), 'utf8')).toBe('user work')
  expect((await f.ctx.trainers.read(plan.id)).merge).toBeUndefined()
})
it('checks an advanced destination in isolation and preserves unrelated commits', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'improved')
  const request = await proposal(f, plan.id, ['test "$(cat agent.txt)" = improved'])
  await f.ctx.humanRequests.respond(request.id, '批准合入本次修改。')
  await writeFile(join(f.root, 'other.txt'), 'new main work'); await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'advance')
  await f.call('trainer_merge', { request_id: request.id })
  expect(await readFile(join(f.root, 'other.txt'), 'utf8')).toBe('new main work')
  expect(await git(f.root, 'rev-list', '--count', 'HEAD')).toBe('3')
})
it('failed integration checks leave the destination unchanged', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'improved')
  const request = await proposal(f, plan.id, ['exit 7'])
  await f.ctx.humanRequests.respond(request.id, '批准合入本次修改。')
  await writeFile(join(f.root, 'other.txt'), 'new'); await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'advance')
  const before = await git(f.root, 'rev-parse', 'HEAD')
  await expect(f.call('trainer_merge', { request_id: request.id })).rejects.toThrow()
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(before)
  expect((await f.ctx.trainers.read(plan.id)).merge).toBeUndefined()
})
it('recovers a Git update whose plan receipt was interrupted', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'improved')
  const request = await proposal(f, plan.id)
  await f.ctx.humanRequests.respond(request.id, '批准合入本次修改。')
  const merged = await f.call('trainer_merge', { request_id: request.id })
  // Public persisted document models interruption between Git update and receipt write.
  delete merged.merge
  await writeFile(join(f.home, 'trainning', plan.id, 'plan.json'), JSON.stringify(merged))
  expect((await f.call('trainer_merge', { request_id: request.id })).merge.commit).toBe(await git(f.root, 'rev-parse', 'HEAD'))
  expect(await git(f.root, 'rev-list', '--count', 'HEAD')).toBe('2')
})
it('leaves conflicting branch changes intact and accepts a named detached destination', async () => {
  const f = await setup(), { plan, workspace } = await training(f)
  await writeFile(join(workspace, 'agent.txt'), 'training change')
  const request = await proposal(f, plan.id, ['true'])
  await f.ctx.humanRequests.respond(request.id, '批准合入本次修改。')
  await writeFile(join(f.root, 'agent.txt'), 'main change'); await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'conflict')
  const before = await git(f.root, 'rev-parse', 'HEAD')
  await expect(f.call('trainer_merge', { request_id: request.id })).rejects.toThrow()
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(before)
  expect(await readFile(join(f.root, 'agent.txt'), 'utf8')).toBe('main change')
  await git(f.root, 'checkout', '--detach')
  const next = await training(f)
  await writeFile(join(next.workspace, 'agent.txt'), 'detached improvement')
  await expect(proposal(f, next.plan.id)).rejects.toThrow('target local branch')
  const detachedRequest = await f.call('human_request_submit', { type: 'training-merge', planId: next.plan.id, targetBranch: 'main', body: 'Review detached changes.' })
  await f.ctx.humanRequests.respond(detachedRequest.id, '批准合入本次修改。')
  const result = await f.call('trainer_merge', { request_id: detachedRequest.id })
  expect(await git(f.root, 'rev-parse', 'refs/heads/main')).toBe(result.merge.commit)
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(before)
})
it('keeps allowance advisory and records uncertain token coverage', async () => {
  const f = await setup()
  const plan = await f.call('trainer_plan_save', { description: 'Improve the observed Agent behavior.', title: 'Small allowance', body: 'One iteration.', tokenBudget: 1, iterationBudget: 1 })
  const brief = await f.call('trainer_plan_read', { plan_id: plan.id })
  expect(brief.usage.complete).toBe(false)
  await f.call('trainer_workspace_prepare', { plan_id: plan.id })
  await expect(f.call('bash', { command: 'exit 4' })).rejects.toThrow('exitCode')
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
  const prepared = await f.call('trainer_workspace_prepare', { plan_id: 'named-training' })
  expect(JSON.stringify(await f.call('bash', { command: 'pwd' }))).toContain(prepared.workspace)
  const updated = await f.call('trainer_plan_save', { id: 'named-training', description: 'Improve the observed Agent behavior.', title: 'Named plan v2', body: '## Goal\nSecond revision.' })
  expect(updated.title).toBe('Named plan v2')
  expect(updated.body).toContain('Second revision.')
  expect(updated.createdAt).toBe(created.createdAt)
  expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.createdAt))
  expect(updated.baseCommit).toBe((await f.call('trainer_plan_read', { plan_id: 'named-training' })).plan.baseCommit)
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
