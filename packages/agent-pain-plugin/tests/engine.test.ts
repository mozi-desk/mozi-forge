/**
 * Purpose: Black-box pain persistence, scoring, recurrence and policy acceptance.
 * Example: merge feedback 1 while feedback 2 arrived -> disk keeps feedback 2 open.
 * Tests construct public engines over disposable directories and inspect JSON, never internals.
 */
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PainEngine } from '../src/engine.js'
import { Collector } from '../src/collector.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pain-test-'))
  roots.push(root)
  const engine = new PainEngine(root)
  await engine.ready
  return { root, engine }
}
const source = { sessionId: 's1', agentId: 'a1', agentPreset: 'custom', turnId: '1', eventSeq: 1 }
const input = {
  title: 'Incorrect result',
  type: 'user_dissatisfaction' as const,
  reason: 'User requested valid output',
  feedback: 'This is still incorrect',
  potentialSolutions: ['Validate output'],
}
it('serializes concurrent accumulation, deduplicates replay and reconstructs scores', async () => {
  const { root, engine } = await fixture()
  const first = await engine.submit(input, source, 'one')
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      engine.submit({ ...input, pain_id: first.id }, { ...source, sessionId: `s${i}` }, `next${i}`),
    ),
  )
  await engine.submit(input, source, 'one')
  expect((await engine.get(first.id)).occurrences).toHaveLength(9)
  expect((await engine.view()).triggerableScore).toBe(900)
  const recovered = new PainEngine(root)
  expect((await recovered.get(first.id)).score.total).toBe(900)
  expect((await readdir(join(root, 'events'))).filter((f) => f.endsWith('.json'))).toHaveLength(1)
})
it('resolves only covered feedback and reopens a recurring resolved pain', async () => {
  const { engine } = await fixture()
  const first = await engine.submit(input, source, 'one')
  await engine.claim([first.id], 'r1')
  await engine.review(first.id, {
    reflectId: 'r1',
    throughOccurrence: 1,
    action: 'link_plan',
    planIds: ['p1', 'p2'],
    reason: 'Fix',
    evidence: [],
    reviewedAt: new Date().toISOString(),
  })
  await engine.submit({ ...input, pain_id: first.id }, source, 'two')
  expect((await engine.get(first.id)).status).toBe('reflecting')
  await engine.reconcile(async (id) => id === 'p1')
  expect((await engine.get(first.id)).status).toBe('reflecting')
  await engine.reconcile(async () => true)
  expect((await engine.get(first.id)).status).toBe('open')
  expect((await engine.view()).triggerableScore).toBe(100)
  await engine.review(first.id, {
    reflectId: 'r2',
    throughOccurrence: 2,
    action: 'expected',
    planIds: [],
    reason: 'Documented behavior',
    evidence: [],
    reviewedAt: new Date().toISOString(),
  })
  expect((await engine.get(first.id)).status).toBe('resolved')
  await engine.submit({ ...input, pain_id: first.id }, source, 'three')
  expect((await engine.get(first.id)).status).toBe('open')
})
it('defers identical evidence, validates native input and applies revisioned policy', async () => {
  const { engine } = await fixture()
  const first = await engine.submit({ ...input, type: 'cognitive' }, source, 'one')
  await engine.review(first.id, {
    reflectId: 'r1',
    throughOccurrence: 1,
    action: 'defer',
    planIds: [],
    reason: 'Missing evidence',
    evidence: [],
    reviewedAt: new Date().toISOString(),
  })
  expect((await engine.view()).triggerableScore).toBe(0)
  await engine.submit({ ...input, pain_id: first.id, type: 'cognitive' }, source, 'two')
  const p = await engine.currentPolicy()
  const settings = {
    enabled: p.enabled,
    weights: { ...p.weights, cognitive: 80 },
    execution: p.execution,
    reflection: p.reflection,
  }
  await engine.updatePolicy({ expected_revision: 1, policy: settings, reason: 'More sensitive' }, source)
  expect((await engine.view()).triggerableScore).toBe(80)
  expect((await engine.get(first.id)).score.total).toBe(120)
  await expect(
    engine.updatePolicy({ expected_revision: 1, policy: settings, reason: 'stale' }, source),
  ).rejects.toThrow('CONFLICT')
  await expect(engine.submit({ ...input, type: 'tool_failure' } as never, source, 'bad')).rejects.toThrow()
  await expect(
    engine.updatePolicy(
      {
        expected_revision: 2,
        policy: { ...settings, weights: { ...settings.weights, token_excess: 200 } },
        reason: 'bad',
      },
      source,
    ),
  ).rejects.toThrow()
})
it('paginates full feedback without losing long UTF-8 text', async () => {
  const { engine } = await fixture()
  const p = await engine.submit({ ...input, feedback: '问题'.repeat(1800) }, source, 'one')
  let cursor: string | undefined
  let text = ''
  do {
    const result = await engine.read({ pain_id: p.id, ...(cursor ? { cursor } : {}) })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8192)
    for (const row of result.items as Array<{
      kind: string
      jsonFragment?: string
    }>)
      if (row.kind === 'occurrence') text += row.jsonFragment
    cursor = result.nextCursor ?? undefined
  } while (cursor)
  expect(JSON.parse(text).feedback).toBe('问题'.repeat(1800))
})
it('collects deduplicated per-turn failures and usage and replays after restart', async () => {
  const { root, engine } = await fixture()
  const collector = new Collector(root, engine, async () => [])
  await collector.ready
  let seq = 0
  const event = (type: string, data: unknown) => ({ type, data, seq: seq++, time: Date.now() }) as SessionEvent
  const events = [
    event('turn/start', { turn: 1 }),
    event('step/start', { turn: 1, step: 1 }),
    event('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 65000, outputTokens: 20 } },
    }),
    event('assistant/message', { turn: 1, step: 1, usage: { inputTokens: 65000, outputTokens: 20 } }),
  ]
  for (let i = 0; i < 4; i++) {
    events.push(event('tool/call', { turn: 1, step: 1, callId: `c${i}`, name: 'bash', arguments: '{}' }))
    events.push(
      event('tool/result', {
        turn: 1,
        step: 1,
        error: { name: 'Error', code: 'EXIT_NONZERO' },
        message: { source: { callId: `c${i}` }, content: [] },
      }),
    )
  }
  await collector.consume(source, events)
  expect((await engine.all()).map((p) => p.occurrences.length)).toEqual([1, 1])
  expect(
    (await engine.all()).find((p) => p.occurrences[0]!.type === 'token_excess')!.occurrences[0]!.metrics!.knownTokens,
  ).toBe(65020)
  const restored = new Collector(root, engine, async () => [])
  await restored.consume(source, events)
  expect((await engine.view()).unresolvedScore).toBe(50)
  await restored.consume(source, [event('turn/end', { turn: 1, reason: { kind: 'stop' } })])
  const state = JSON.parse(await readFile(join(root, 'collector.json'), 'utf8'))
  expect(state.sessions[0].activeTurns).toEqual([])
})
it('ignores inherited events and suspected text failures', async () => {
  const { root, engine } = await fixture()
  const collector = new Collector(root, engine, async () => [])
  const events = Array.from({ length: 4 }, (_, i) => ({
    seq: i,
    time: 1,
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: { source: { callId: `c${i}` }, content: [{ type: 'text', text: 'error: maybe' }] },
    },
  })) as unknown as SessionEvent[]
  await collector.consume(source, events, 1)
  expect(await engine.all()).toEqual([])
})

it('replays pain saved before its collector checkpoint without counting it twice', async () => {
  const { root, engine } = await fixture()
  const collector = new Collector(root, engine, async () => [])
  await collector.ready
  const before = await readFile(join(root, 'collector.json'), 'utf8')
  const events = [
    {
      type: 'assistant/message',
      seq: 0,
      time: 1,
      data: { turn: 1, step: 1, usage: { inputTokens: 64000, outputTokens: 3 } },
    },
  ] as unknown as SessionEvent[]
  await collector.consume(source, events)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, 'collector.json'), before)
  const replay = new Collector(root, new PainEngine(root), async () => [])
  await replay.consume(source, events)
  expect((await new PainEngine(root).all())[0]!.occurrences).toHaveLength(1)
})

it('merges saved policy defaults and refuses malformed durable pain state', async () => {
  const { root, engine } = await fixture()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, 'policy.json'), JSON.stringify({ version: 1, revision: 1, weights: { cognitive: 70 } }))
  const restarted = new PainEngine(root)
  expect((await restarted.currentPolicy()).weights.cognitive).toBe(70)
  expect((await restarted.currentPolicy()).execution.tokensPerTurn).toBe(64000)
  await engine.submit(input, source, 'one')
  const file = (await readdir(join(root, 'events')))[0]!
  await writeFile(join(root, 'events', file), '{malformed')
  await expect(new PainEngine(root).ready).rejects.toThrow()
})
