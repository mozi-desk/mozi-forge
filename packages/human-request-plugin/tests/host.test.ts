/** Public request tools persist open-ended Markdown types and protect human answers. */
import { afterEach, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from '../../../tests/trainer-fixture.js'
let f: Awaited<ReturnType<typeof fixture>> | undefined
afterEach(async () => { await f?.dispose(); f = undefined })
it('persists one JSON record, reads answers and rejects conflicting repeated responses', async () => {
  f = await fixture()
  const question = await f.call('human_request_submit', { requestId: 'question-one', type: 'custom-quality-check', body: '# Inspect\n**Is this useful?**' })
  const disk = JSON.parse(await readFile(join(f.home, 'human-requests/question-one.json'), 'utf8'))
  expect(disk).toMatchObject({ id: 'question-one', type: 'custom-quality-check', status: 'pending' })
  await f.ctx.humanRequests.respond(question.id, 'Useful, continue.')
  await f.ctx.humanRequests.respond(question.id, 'Useful, continue.')
  await expect(f.ctx.humanRequests.respond(question.id, 'Changed opinion.')).rejects.toThrow('already answered')
  expect(await f.call('human_request_read', { id: question.id })).toMatchObject({ status: 'answered', response: { body: 'Useful, continue.' } })
  expect(f.ctx.tools.schemas(f.handle.agent).map(t => t.name)).not.toContain('human_request_respond')
})
it('rejects path traversal and mismatched idempotent content', async () => {
  f = await fixture()
  await expect(f.call('human_request_submit', { requestId: '../escape', body: 'hello' })).rejects.toThrow('Invalid record id')
  await f.call('human_request_submit', { requestId: 'one', body: 'first' })
  await expect(f.call('human_request_submit', { requestId: 'one', body: 'other' })).rejects.toThrow('conflict')
})
it('recovers interrupted answer delivery without duplicating the session notice', async () => {
  f = await fixture()
  const question = await f.call('human_request_submit', { requestId: 'recover-one', body: 'Review?' })
  await f.ctx.humanRequests.respond(question.id, 'Accepted')
  await f.handle.agent.whenIdle()
  const record = await f.ctx.humanRequests.read(question.id)
  delete record.deliveredAt
  await f.ctx.humanRequests.save(record)
  await f.ctx.humanRequests.respond(question.id, 'Accepted')
  await f.handle.agent.whenIdle()
  const messages = f.handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes('Event: human-answer:recover-one'))
  expect(messages).toHaveLength(1)
})

it('persists a language-independent decision and protects it on retries', async () => {
  f = await fixture()
  const question = await f.call('human_request_submit', { requestId: 'decision-one', body: 'Review this proposal.' })
  await expect(f.ctx.humanRequests.respond(question.id, '', 'invalid' as 'approve')).rejects.toThrow('Invalid human decision')
  await f.ctx.humanRequests.respond(question.id, '', 'approve')
  await f.ctx.humanRequests.respond(question.id, '', 'approve')
  const stored = JSON.parse(await readFile(join(f.home, 'human-requests/decision-one.json'), 'utf8'))
  expect(stored.response).toMatchObject({ body: '', decision: 'approve', decidedAt: expect.any(String) })
  await expect(f.ctx.humanRequests.respond(question.id, '', 'request-changes')).rejects.toThrow('already answered')
  await expect(f.ctx.humanRequests.respond(question.id, 'Different note', 'approve')).rejects.toThrow('already answered')
})

it('adds an explicit decision to an older reply while retaining its original text', async () => {
  f = await fixture()
  const question = await f.call('human_request_submit', { requestId: 'older-reply', body: 'Review this proposal.' })
  await f.ctx.humanRequests.respond(question.id, '自由填写的说明')
  const before = await f.ctx.humanRequests.read(question.id)
  await f.ctx.humanRequests.respond(question.id, '自由填写的说明', 'approve')
  const after = await f.ctx.humanRequests.read(question.id)
  expect(after.response).toMatchObject({ ...before.response, decision: 'approve', decidedAt: expect.any(String) })
  await f.ctx.humanRequests.respond(question.id, '自由填写的说明', 'approve')
  await f.handle.agent.whenIdle()
  const notices = f.handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes('Event: human-answer:older-reply:approve'))
  expect(notices).toHaveLength(1)
})
