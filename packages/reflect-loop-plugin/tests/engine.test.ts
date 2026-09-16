/**
 * Purpose: Verify scheduling, prompt delivery and crash recovery without running an LLM.
 * Example: durable result survives a linking failure and replay applies it once on restart.
 */
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { PainEngine } from '@mozi-forge/agent-pain-plugin/engine'
import { ReflectEngine } from '../src/engine.js'
import type { ReflectRecord } from '../src/types.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
const input = {
  title: 'Bad answer',
  type: 'user_dissatisfaction' as const,
  reason: 'Wrong',
  feedback: 'The answer is wrong',
  potentialSolutions: [],
}
const source = { sessionId: 's', agentId: 'a', agentPreset: 'custom', turnId: '1', eventSeq: 1 }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reflect-test-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const pains = new PainEngine(join(root, 'pains'))
  await pains.ready
  const delivered: ReflectRecord[] = []
  const linked: unknown[] = []
  const plans = {
    read: async (_id: string) => ({}),
    link: async (id: string, ref: unknown) => {
      linked.push({ id, ref })
    },
  }
  const engine = new ReflectEngine(join(root, 'reflects'), pains, plans, {
    deliver: async (r) => {
      delivered.push(r)
    },
  })
  cleanup.push(() => engine.close())
  await engine.ready
  return { root, pains, engine, delivered, linked, plans }
}
it('starts once, snapshots every open pain and sends the expected bounded prompt', async () => {
  const f = await fixture()
  await f.pains.submit({ ...input, type: 'cognitive' }, source, 'c')
  await f.engine.evaluate('pain_received')
  expect(f.delivered).toHaveLength(0)
  await f.pains.submit(input, source, 'u')
  await Promise.all(Array.from({ length: 5 }, () => f.engine.evaluate('pain_received')))
  expect(f.delivered).toHaveLength(1)
  const r = (await f.engine.status())!
  expect(r.pains).toHaveLength(2)
  expect(r.trainer.initialPrompt).toContain('trainer_plan_list')
  expect(r.trainer.initialPrompt).toContain('EVERY')
  expect(Buffer.byteLength(r.trainer.initialPrompt)).toBeLessThan(16384)
  expect((await f.pains.all()).every((p) => p.status === 'reflecting')).toBe(true)
})
it('completes analysis before training and keeps post-snapshot feedback', async () => {
  const f = await fixture()
  const p = await f.pains.submit(input, source, 'u')
  await f.engine.evaluate('pain_received')
  const r = (await f.engine.status())!
  await f.pains.submit({ ...input, pain_id: p.id }, source, 'u2')
  const args = {
    reflect_id: r.id,
    summary: 'Existing fix',
    decisions: [
      {
        pain_id: p.id,
        through_occurrence: 1,
        action: 'link_plan' as const,
        plan_ids: ['p1'],
        reason: 'Covered by plan',
        evidence: [],
      },
    ],
  }
  await f.engine.complete(args, r.trainer.sessionId)
  await f.engine.complete(args, r.trainer.sessionId)
  expect(f.linked).toHaveLength(1)
  expect(await f.engine.status()).toBeNull()
  expect((await f.pains.get(p.id)).status).toBe('reflecting')
  await f.pains.reconcile(async () => true)
  await f.engine.evaluate('pain_received')
  expect((await f.engine.status())!.id).not.toBe(r.id)
  const nextId = (await f.engine.status())!.id
  await f.engine.complete(args, r.trainer.sessionId)
  expect((await f.engine.status())!.id).toBe(nextId)
})
it('validates ownership, exact coverage and expected evidence before side effects', async () => {
  const f = await fixture()
  const p = await f.pains.submit(input, source, 'u')
  await f.engine.evaluate('pain_received')
  const r = (await f.engine.status())!
  const args = {
    reflect_id: r.id,
    summary: 'Expected',
    decisions: [
      { pain_id: p.id, through_occurrence: 1, action: 'expected' as const, reason: 'Expected', evidence: [] },
    ],
  }
  await expect(f.engine.complete(args, 'other')).rejects.toThrow('Owned')
  await expect(f.engine.complete(args, r.trainer.sessionId)).rejects.toThrow('evidence')
  expect((await f.pains.get(p.id)).resolutions).toEqual([])
  await f.engine.complete(
    {
      ...args,
      decisions: [
        { ...args.decisions[0]!, evidence: [{ sessionId: 's', revision: 'rev', fromSeq: 0, throughSeq: 1 }] },
      ],
    },
    r.trainer.sessionId,
  )
  expect((await f.pains.get(p.id)).status).toBe('resolved')
})
it('replays persisted completion after a crash between result and plan association', async () => {
  const f = await fixture()
  const p = await f.pains.submit(input, source, 'u')
  await f.engine.evaluate('pain_received')
  const r = (await f.engine.status())!
  await f.engine.close()
  r.result = {
    summary: 'Fix',
    decisions: [
      { painId: p.id, throughOccurrence: 1, action: 'link_plan', planIds: ['p'], reason: 'Fix', evidence: [] },
    ],
  }
  await writeFile(join(f.root, 'reflects', r.id, 'reflect.json'), JSON.stringify(r))
  const restored = new ReflectEngine(join(f.root, 'reflects'), new PainEngine(join(f.root, 'pains')), f.plans, {
    deliver: async () => {
      throw new Error('should not redeliver')
    },
  })
  cleanup.push(() => restored.close())
  await restored.ready
  expect(await restored.status()).toBeNull()
  expect(f.linked).toHaveLength(1)
  expect(JSON.parse(await readFile(join(f.root, 'reflects', r.id, 'reflect.json'), 'utf8')).status).toBe('completed')
})
it('resumes the same pending reflection after a restart', async () => {
  const f = await fixture()
  await f.pains.submit(input, source, 'u')
  await f.engine.evaluate('pain_received')
  const first = (await f.engine.status())!
  await f.engine.close()
  const restored = new ReflectEngine(join(f.root, 'reflects'), new PainEngine(join(f.root, 'pains')), f.plans, {
    deliver: async (r) => {
      f.delivered.push(r)
    },
  })
  cleanup.push(() => restored.close())
  await restored.ready
  await restored.evaluate('startup')
  expect((await restored.status())!.trainer.messageId).toBe(first.trainer.messageId)
  expect((await restored.status())!.id).toBe(first.id)
})

it('policy changes trigger existing feedback and disabled policy still records pains', async () => {
  const f = await fixture()
  const p = await f.pains.currentPolicy()
  const settings = { enabled: false, weights: p.weights, execution: p.execution, reflection: p.reflection }
  await f.pains.updatePolicy({ expected_revision: 1, policy: settings, reason: 'Pause' }, source)
  await f.pains.submit(input, source, 'u')
  await f.engine.evaluate('pain_received')
  expect(f.delivered).toHaveLength(0)
  await f.pains.updatePolicy({ expected_revision: 2, policy: { ...settings, enabled: true }, reason: 'Resume' }, source)
  await f.engine.evaluate('policy_updated')
  expect(f.delivered).toHaveLength(1)
})

it('reclaims a persisted snapshot after a crash before marking pains reflecting', async () => {
  const f = await fixture()
  const p = await f.pains.submit(input, source, 'u')
  await f.engine.evaluate('pain_received')
  const first = (await f.engine.status())!
  await f.engine.close()
  const { readdir } = await import('node:fs/promises')
  const eventPath = join(f.root, 'pains', 'events', (await readdir(join(f.root, 'pains', 'events')))[0]!)
  const saved = JSON.parse(await readFile(eventPath, 'utf8'))
  saved.analysis.activeReflectId = null
  saved.status = 'open'
  await writeFile(eventPath, JSON.stringify(saved))
  const recoveredPains = new PainEngine(join(f.root, 'pains'))
  const restored = new ReflectEngine(join(f.root, 'reflects'), recoveredPains, f.plans, { deliver: async () => {} })
  cleanup.push(() => restored.close())
  await restored.ready
  await restored.evaluate('startup')
  expect((await recoveredPains.get(p.id)).analysis.activeReflectId).toBe(first.id)
})
