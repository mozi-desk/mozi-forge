/**
 * Purpose: Exercise the real Host plugin with public mock Harness dependencies.
 * Example: startup finds an overdue schedule, freezes a source through real Session
 * Insights, persists the prompt, then calls the mock Trainer's followup. Restart
 * resumes that same identity from the mock persistence journal. No model is mounted.
 * Mock fields are fixture state; the tested service is observed only through tools,
 * status, public callbacks and files.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionInsights from '@mozi-forge/session-insights-plugin/host'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import SleepService from '../src/host.js'
import { durableJson } from '../src/storage.js'
import { DAY } from '../src/types.js'
interface Saved { meta: SessionHeader; events: SessionEvent[] }
interface MockSession { id: string; snapshotEvents(): SessionEvent[] }
const roots: string[] = [], contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() })
async function hostFixture(home?: string, failFlush = false, appendDuringFlush = false) {
  const root = home ?? await mkdtemp(join(tmpdir(), 'sleep-host-'))
  if (!home) roots.push(root)
  vi.stubEnv('DSH_HOME', root)
  const persistedPath = join(root, 'fixture-sessions.json')
  let saved: Record<string, Saved>
  try { saved = JSON.parse(await readFile(persistedPath, 'utf8')) as Record<string, Saved> } catch {
    saved = { source: { meta: { id: SessionId('source'), version: 1, isSeeded: false, createdAt: Date.now()-100, agentPreset: 'coding' }, events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }, { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }] as SessionEvent[] } }
  }
  const live = new Map<string, Saved>(), trace: string[] = [], prompts: UserMessage[] = [], presets: string[] = [], creates: string[] = [], resumes: string[] = []
  if (appendDuringFlush) live.set('source', structuredClone(saved.source!))
  const ctx = new Context(); contexts.push(ctx)
  class Persistence extends Service {
    constructor(ctx: Context) { super(ctx, 'sessionPersistence') }
    async list() { return Object.values(saved).map(s => s.meta) }
    async readFrom(id: string) { if (!saved[id]) throw new Error('MISSING_SOURCE'); return structuredClone(saved[id]!) }
  }
  class Sessions extends Service {
    constructor(ctx: Context) { super(ctx, 'sessions') }
    list() { return [...live.keys()].map(id => this.get(id)!) }
    get(id: string) { return live.has(id) ? { id, snapshotEvents: () => live.get(id)!.events } : undefined }
    async flush(session: MockSession) {
      trace.push('flush')
      if (failFlush) throw new Error('MOCK_FLUSH_FAILED')
      if (appendDuringFlush && session.id === 'source') {
        live.get('source')!.events.push({ type: 'turn/start', seq: 2, time: Date.now(), data: { turn: 2 } } as SessionEvent)
        appendDuringFlush = false
      }
      saved[session.id] = structuredClone(live.get(session.id)!)
      await writeFile(persistedPath, JSON.stringify(saved))
      return true
    }
  }
  class Presets extends Service {
    constructor(ctx: Context) { super(ctx, 'agentPresets') }
    async mount(_ctx: Context, preset: string) { presets.push(preset) }
  }
  const agents = new Map<string, unknown>()
  class Agents extends Service {
    constructor(ctx: Context) { super(ctx, 'agents') }
    get(id: string) { return agents.get(id) }
    async create(opts: { agentOptions: AgentOptions; sessionId: string; meta: SessionHeader; setup(ctx: Context): Promise<void> }) { expect(opts.agentOptions).toEqual({ provider: 'sleep-fixture', model: 'configured-model' }); creates.push(opts.sessionId); return this.make(opts.sessionId, { meta: { ...opts.meta, id: SessionId(opts.sessionId), version: 1, isSeeded: false, createdAt: Date.now() }, events: [] }, opts.setup) }
    async resume(opts: { agentOptions: AgentOptions; resumeSessionId: string; setup(ctx: Context): Promise<void> }) { expect(opts.agentOptions).toEqual({ provider: 'sleep-fixture', model: 'configured-model' }); resumes.push(opts.resumeSessionId); return this.make(opts.resumeSessionId, structuredClone(saved[opts.resumeSessionId]!), opts.setup) }
    async make(id: string, state: Saved, setup: (ctx: Context) => Promise<void>) {
      await setup(ctx)
      live.set(id, state)
      const queued: UserMessage[] = []
      for (const event of state.events) if (event.type === 'agent/inbox/spliced') queued.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
      const append = (inserted: UserMessage[], start: number, removedCount = 0) => {
        state.events.push({ type: 'agent/inbox/spliced', seq: state.events.length, time: Date.now(), data: { target: 'next-turn', start, removedCount, inserted } } as SessionEvent)
        queued.splice(start, removedCount, ...inserted)
      }
      const agent = {
        id, session: { id, snapshotEvents: () => state.events },
        inbox: { nextTurn: queued, remove(messageId: string) { const index = queued.findIndex(m => m.id === messageId); if (index >= 0) append([], index, 1) } },
        send(message: UserMessage, _target: string, wake: boolean) { expect(wake).toBe(false); trace.push('send'); append([message], queued.length) },
        followup(message: UserMessage) { trace.push('wake'); expect(saved[id]!.events.some(e => e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => m.id === message.id))).toBe(true); append([message], queued.length); prompts.push(message) },
      }
      agents.set(id, agent)
      return { agent, dispose: async () => { agents.delete(id) } }
    }
  }
  await ctx.plugin(Persistence); await ctx.plugin(Sessions); await ctx.plugin(Presets); await ctx.plugin(Agents)
  await ctx.plugin(AgentDefaultModel, { provider: 'sleep-fixture', model: 'configured-model' })
  await ctx.plugin(SessionInsights, { projectRoot: root })
  if (!home) {
    const now = Date.now()
    await durableJson(join(root, 'sleeps/scheduler.json'), { version: 1, initializedAt: now-DAY, lastSleepId: null, lastStartedAt: null, requestedAt: null, nextDueAt: now-1, hardDeadlineAt: now, generation: 1 })
  }
  await ctx.plugin(SleepService, { projectRoot: root }); await ctx.sleepLoop.ready
  const claimInitial = async () => {
    const id = creates[0]!, state = saved[id]!, message = prompts[0]!
    state.events.push({ type: 'agent/inbox/spliced', seq: state.events.length, time: Date.now(), data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } } as SessionEvent)
    state.events.push({ type: 'user/message', seq: state.events.length, time: Date.now(), data: message } as SessionEvent)
    await writeFile(persistedPath, JSON.stringify(saved))
  }
  return { root, ctx, trace, prompts, creates, resumes, presets, claimInitial, setFailFlush(value: boolean) { failFlush = value } }
}
it('launches the existing Trainer preset with frozen changed-session facts only after durable inbox acceptance', async () => {
  const f = await hostFixture()
  await expect.poll(() => f.prompts.length).toBe(1)
  expect(f.presets).toEqual(['trainer'])
  expect(f.trace).toEqual(['send', 'flush', 'wake'])
  const text = f.prompts[0]!.content.filter(b => b.type === 'text').map(b => b.text).join('')
  expect(text).toContain('source'); expect(text).toContain('sleep_loop_schedule'); expect(text).toContain('20 minutes')
  const status = await f.ctx.sleepLoop.status()
  const record = JSON.parse(await readFile(join(f.root, 'sleeps', status.lastSleepId!, 'sleep.json'), 'utf8'))
  expect(record.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(['source'])
  expect(record.sessions[0].analysisRange).toEqual({ from: 0, through: 1 })
  expect(f.creates[0]).toBe(`trainer-${record.id}`)
})
it('does not wake when flush fails, then retries the existing agent identity', async () => {
  const f = await hostFixture(undefined, true)
  await expect.poll(async () => (await f.ctx.sleepLoop.status()).lastError).toBe('MOCK_FLUSH_FAILED')
  expect(f.prompts).toHaveLength(0)
  f.setFailFlush(false)
  await expect.poll(() => f.prompts.length, { timeout: 4000 }).toBe(1)
  expect(f.creates).toHaveLength(1)
  expect(f.trace.at(-2)).toBe('flush'); expect(f.trace.at(-1)).toBe('wake')
})
it('recovers a missing delivery receipt by resuming the durable identity and original message', async () => {
  const f = await hostFixture()
  await expect.poll(async () => (await f.ctx.sleepLoop.status()).pendingDeliveries).toBe(0)
  const messageId = f.prompts[0]!.id, sessionId = f.creates[0]
  await f.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(f.ctx), 1)
  const folders = (await readdir(join(f.root, 'sleeps'))).filter(n => n.startsWith('sleep-loop-'))
  await rm(join(f.root, 'sleeps', folders[0]!, 'delivery.json'))
  const restored = await hostFixture(f.root)
  await expect.poll(() => restored.prompts.length).toBe(1)
  expect(restored.creates).toHaveLength(0)
  expect(restored.resumes).toEqual([sessionId])
  expect(restored.prompts[0]!.id).toBe(messageId)
})

it('freezes live endpoints before flush and retains later arrivals for the next window', async () => {
  const f = await hostFixture(undefined, false, true)
  await expect.poll(async () => (await f.ctx.sleepLoop.status()).pendingDeliveries).toBe(0)
  const firstId = (await f.ctx.sleepLoop.status()).lastSleepId!
  const first = JSON.parse(await readFile(join(f.root, 'sleeps', firstId, 'sleep.json'), 'utf8'))
  expect(first.sessions[0].analysisRange).toEqual({ from: 0, through: 1 })
  await f.ctx.sleepLoop.schedule({ delta_ms: 1 })
  await expect.poll(async () => (await f.ctx.sleepLoop.status()).lastSleepId).not.toBe(firstId)
  const secondId = (await f.ctx.sleepLoop.status()).lastSleepId!
  const second = JSON.parse(await readFile(join(f.root, 'sleeps', secondId, 'sleep.json'), 'utf8'))
  expect(second.sessions.find((s: { sessionId: string }) => s.sessionId === 'source').analysisRange).toEqual({ from: 2, through: 2 })
})
it('recovers an accepted but unclaimed inbox even when the delivery receipt was already committed', async () => {
  const f = await hostFixture()
  await expect.poll(async () => (await f.ctx.sleepLoop.status()).pendingDeliveries).toBe(0)
  const messageId = f.prompts[0]!.id
  await f.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(f.ctx), 1)
  const restored = await hostFixture(f.root)
  await expect.poll(() => restored.prompts.length).toBe(1)
  expect(restored.creates).toHaveLength(0)
  expect(restored.prompts[0]!.id).toBe(messageId)
})

it('does not recreate or re-prompt a Trainer whose initial message was durably claimed', async () => {
  const f = await hostFixture()
  await expect.poll(async () => (await f.ctx.sleepLoop.status()).pendingDeliveries).toBe(0)
  await f.claimInitial()
  await f.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(f.ctx), 1)
  const restored = await hostFixture(f.root)
  await expect.poll(async () => (await restored.ctx.sleepLoop.status()).pendingDeliveries).toBe(0)
  expect(restored.creates).toHaveLength(0)
  expect(restored.resumes).toHaveLength(0)
  expect(restored.prompts).toHaveLength(0)
})
