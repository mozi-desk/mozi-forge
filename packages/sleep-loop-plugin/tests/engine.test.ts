/**
 * Purpose: Black-box Sleep scheduling, scale, commit recovery and bounded prompts.
 * Example: initialize two thousand unchanged candidates, mark one changed source,
 * advance the clock, and assert that only it reaches sleep.json and Trainer delivery.
 * Dependencies are public source/driver interfaces; no LLM or private fields are used.
 */
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { SleepEngine, DAY, type Clock, type Delivery, type SleepRecord, type SleepSource } from '../src/engine.js'
import { sleepPrompt } from '../src/prompt.js'
import type { IncrementalSession } from '@mozi-forge/session-insights-plugin/incremental'
class ManualClock implements Clock {
  wall = 1_800_000_000_000; mono = 0
  callbacks = new Map<object, { callback: () => void; ms: number }>()
  now() { return this.wall }
  monotonic() { return this.mono }
  setTimeout(callback: () => void, ms: number) { const key = {}; this.callbacks.set(key, { callback, ms }); return key }
  clearTimeout(key: unknown) { this.callbacks.delete(key as object) }
  advance(ms: number) { this.wall += ms; this.mono += ms }
}
const roots: string[] = [], engines: SleepEngine[] = []
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
function session(sessionId: string, from = 0): IncrementalSession {
  return { sessionId, preset: 'coding', revision: 'a'.repeat(64), isNew: from === 0, previousThroughSeq: from-1, analysisRange: { from, through: from+8 }, turns: [{ turn: 1, from, through: from+8, contextFrom: from, continuedFromPrevious: false, complete: true }], metrics: { newTurns: 1, continuedTurns: 0, toolCalls: 5, confirmedToolFailures: 2, suspectedToolErrors: 0, incompleteToolCalls: 0, tokens: { uncachedInputTokens: 32000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, tokenCorrections: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, knownTokens: 32000, usageComplete: true } }
}
async function fixture(ids = ['s1']) {
  const root = await mkdtemp(join(tmpdir(), 'sleep-engine-')); roots.push(root)
  const clock = new ManualClock(), calls: string[] = [], delivered: Array<{ record: SleepRecord; path: string; delivery: Delivery; prompt: string }> = []
  const changed = new Map(ids.map(id => [id, session(id)]))
  const source: SleepSource = { list: async () => ids, capture: async (id, previous) => { calls.push(id); const row = changed.get(id); if (row && row.analysisRange.through > (previous?.through ?? -1)) return { checkpoint: { through: row.analysisRange.through, fingerprint: id }, session: row }; return { checkpoint: previous ?? { through: -1, fingerprint: id } } } }
  let failDelivery = false
  const driver = { deliver: async (record: SleepRecord, path: string, delivery: Delivery) => { if (failDelivery) throw new Error('MOCK_DELIVERY_FAILED'); delivered.push({ record, path, delivery: { ...delivery }, prompt: sleepPrompt(record, path) }) } }
  const engine = new SleepEngine(root, source, driver, clock); engines.push(engine); await engine.start(); await engine.drain()
  const restart = async () => { await engine.close(); engines.splice(engines.indexOf(engine), 1); const next = new SleepEngine(root, source, driver, clock); engines.push(next); await next.start(); await next.drain(); return next }
  return { root, clock, source, engine, calls, changed, delivered, restart, failDelivery: (value: boolean) => { failDelivery = value } }
}
it('validates native schedule input and preserves the fixed 24-hour deadline across updates and restart', async () => {
  const f = await fixture(), deadline = f.engine.status().hardDeadlineAt
  expect(f.engine.status().remainingMs).toBe(DAY)
  await f.engine.schedule({ delta_ms: 8*3600000 })
  expect(f.engine.status().nextDueAt).toBe(f.clock.wall + 8*3600000)
  f.clock.advance(3600000)
  for (const args of [{}, { at: 'tomorrow' }, { at: '2026-02-30T00:00:00Z' }, { delta_ms: 0 }, { delta_ms: 1, at: new Date(deadline).toISOString() }, { delta_ms: DAY }, { delta_ms: '10' }, { delta_ms: 10, extra: true }]) await expect(f.engine.schedule(args)).rejects.toThrow('SLEEP_INVALID_SCHEDULE')
  await f.engine.schedule({ at: new Date(deadline).toISOString() })
  const next = await f.restart()
  expect(next.status().hardDeadlineAt).toBe(deadline)
  expect(next.status().nextDueAt).toBe(deadline)
  expect(f.delivered).toHaveLength(0)
})
it('catches up once after multi-day downtime and advances the deadline from that sleep start', async () => {
  const f = await fixture()
  f.clock.advance(3*DAY)
  const next = await f.restart()
  expect(f.delivered).toHaveLength(1)
  expect(f.delivered[0]!.record.trigger).toBe('startup-overdue')
  expect(next.status().hardDeadlineAt).toBe(f.clock.wall + DAY)
  expect(f.delivered[0]!.record.sessions[0]!.priority.total).toBe(55)
  expect(f.delivered[0]!.prompt).toContain('20 minutes')
  expect(f.delivered[0]!.prompt).toContain('Before deep analysis')
})
it('filters thousands of unchanged IDs from records and context and reads only later dirty candidates', async () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `quiet-${i}`), f = await fixture(ids)
  f.changed.clear()
  await f.engine.schedule({ delta_ms: 1 }); f.clock.advance(1); await f.engine.poll(); await f.engine.drain()
  expect(f.delivered[0]!.record.sessions).toEqual([])
  expect(f.delivered[0]!.prompt).not.toContain('quiet-')
  f.calls.length = 0; f.changed.set('active', session('active')); f.engine.changed('active')
  await f.engine.schedule({ delta_ms: 1 }); f.clock.advance(1); await f.engine.poll(); await f.engine.drain()
  expect(f.calls).toEqual(['active'])
  const last = f.delivered.at(-1)!
  expect(last.record.sessions.map(s => s.sessionId)).toEqual(['active'])
  expect(last.prompt).not.toContain('quiet-')
  expect(await readFile(last.path, 'utf8')).not.toContain('quiet-')
})
it('keeps source errors dirty, handles arrivals during capture and records empty-window guidance', async () => {
  const f = await fixture(), original = f.source.capture
  let fail = true
  f.source.capture = async (...args) => { if (fail) throw new Error('SESSION_UNAVAILABLE'); return original(...args) }
  f.clock.advance(DAY); await f.engine.poll(); await f.engine.drain()
  expect(f.delivered[0]!.record.sessions).toEqual([])
  expect(f.delivered[0]!.prompt).toContain('empty window')
  expect(f.engine.status().lastError).toBe('SESSION_UNAVAILABLE')
  fail = false
  f.source.capture = async (...args) => { const result = await original(...args); f.changed.set('s1', session('s1', 9)); f.engine.changed('s1'); return result }
  f.clock.advance(DAY); await f.engine.poll(); await f.engine.drain()
  f.source.capture = original
  f.clock.advance(DAY); await f.engine.poll(); await f.engine.drain()
  expect(f.delivered[1]!.record.sessions[0]!.analysisRange.from).toBe(0)
  expect(f.delivered[2]!.record.sessions[0]!.analysisRange.from).toBe(9)
})
it('retries delivery using the same identity while new windows continue', async () => {
  const f = await fixture(); f.failDelivery(true)
  f.clock.advance(DAY); await f.engine.poll(); await f.engine.drain()
  const firstId = f.engine.status().lastSleepId
  expect(f.engine.status().pendingDeliveries).toBe(1)
  f.clock.advance(DAY); await f.engine.poll(); await f.engine.drain()
  expect(f.engine.status().pendingDeliveries).toBe(2)
  f.failDelivery(false); f.clock.advance(60000); await f.engine.poll(); await f.engine.drain()
  expect(f.delivered.map(d => d.record.id)).toContain(firstId)
  expect(f.engine.status().pendingDeliveries).toBe(0)
})
it('replays committed coverage after scheduler corruption without assigning the same range twice', async () => {
  const f = await fixture(); f.clock.advance(DAY); await f.engine.poll(); await f.engine.drain()
  const id = f.engine.status().lastSleepId
  await writeFile(join(f.root, 'scheduler.json'), '{broken')
  const next = await f.restart()
  expect(next.status().lastSleepId).toBe(id)
  expect(next.status().lastError).toBe('SLEEP_SCHEDULER_RECOVERED')
  f.clock.advance(DAY); await next.poll(); await next.drain()
  expect(f.delivered.at(-1)!.record.sessions).toEqual([])
})
it('recovers delivery after a missing receipt and enforces process ownership', async () => {
  const f = await fixture(); f.clock.advance(DAY); await f.engine.poll(); await f.engine.drain()
  const id = f.engine.status().lastSleepId!
  await rm(join(f.root, id, 'delivery.json'))
  const competing = new SleepEngine(f.root, f.source, { deliver: async () => {} }, f.clock)
  await expect(competing.start()).rejects.toThrow('SLEEP_OWNER_ACTIVE')
  const next = await f.restart()
  expect(f.delivered.at(-1)!.record.id).toBe(id)
  expect(next.status().pendingDeliveries).toBe(0)
})
it('uses monotonic elapsed time after clock rollback and discards stale timers', async () => {
  const f = await fixture(); await f.engine.schedule({ delta_ms: 1000 })
  const old = [...f.clock.callbacks.values()][0]!.callback
  await f.engine.schedule({ delta_ms: 2000 })
  f.clock.wall -= DAY; f.clock.mono += 1000; old(); await f.engine.drain()
  expect(f.delivered).toHaveLength(0)
  f.clock.mono += 1000; await f.engine.poll(); await f.engine.drain()
  expect(f.delivered).toHaveLength(1)
  expect([...f.clock.callbacks.values()].every(t => t.ms <= 30000)).toBe(true)
})
it('bounds prompt data by UTF-8 bytes and item count even with huge turn lists', async () => {
  const f = await fixture(Array.from({ length: 100 }, (_,i) => `变化-${i}`))
  for (const row of [...f.changed.values()].slice(0, 1)) row.turns = Array.from({ length: 10000 }, () => ({ ...row.turns[0]! }))
  f.clock.advance(DAY); await f.engine.poll(); await f.engine.drain()
  const prompt = f.delivered[0]!.prompt, data = prompt.split('Frozen workload data (JSON):\n')[1]!
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(16384)
  const parsed = JSON.parse(data)
  expect(parsed.sessions.length).toBeLessThanOrEqual(20)
  expect(parsed.remainingChangedSessions).toBe(100-parsed.sessions.length)
  expect(parsed.sessions[0].turns).toBeUndefined()
})
it('recovers a confirmed-dead process owner from the persistent database', async () => {
  const f = await fixture(); await f.engine.close(); engines.splice(engines.indexOf(f.engine), 1)
  const db = new DatabaseSync(join(f.root, 'discovery/discovery.sqlite'))
  db.prepare('INSERT INTO owner VALUES (1, ?, ?)').run(2147483647, 'dead-owner'); db.close()
  const next = new SleepEngine(f.root, f.source, { deliver: async () => {} }, f.clock); engines.push(next)
  await next.start(); expect(next.status().remainingMs).toBe(DAY)
})
it('retries the same frozen record when scheduler persistence fails after publication', async () => {
  const f = await fixture()
  await rm(join(f.root, 'scheduler.json')); await mkdir(join(f.root, 'scheduler.json'))
  f.clock.advance(DAY); await f.engine.poll(); await f.engine.drain()
  const dirs = (await readdir(f.root)).filter(n => n.startsWith('sleep-loop-'))
  expect(dirs).toHaveLength(1)
  const first = await readFile(join(f.root, dirs[0]!, 'sleep.json'), 'utf8')
  await rm(join(f.root, 'scheduler.json'), { recursive: true }); f.clock.advance(1000)
  await f.engine.poll(); await f.engine.drain()
  expect(f.delivered).toHaveLength(1)
  expect(await readFile(f.delivered[0]!.path, 'utf8')).toBe(first)
})
it('retries unavailable startup discovery while retaining an overdue deadline', async () => {
  const f = await fixture(); await f.engine.close(); engines.splice(engines.indexOf(f.engine), 1)
  let attempts = 0
  const original = f.source.list
  f.source.list = async () => { if (++attempts === 1) throw new Error('LIST_UNAVAILABLE'); return original() }
  f.clock.advance(DAY)
  const next = new SleepEngine(f.root, f.source, { deliver: async () => {} }, f.clock); engines.push(next)
  await next.start()
  expect(next.status().lastSleepId).toBeNull()
  expect(next.status().lastError).toBe('LIST_UNAVAILABLE')
  f.clock.advance(1000); await next.poll(); await next.drain()
  expect(next.status().lastSleepId).not.toBeNull()
  expect(attempts).toBe(2)
})
it('replays coverage after a database cursor transaction fails following sleep.json commit', async () => {
  const f = await fixture()
  const db = new DatabaseSync(join(f.root, 'discovery/discovery.sqlite'))
  db.exec("CREATE TRIGGER fail_cursor BEFORE INSERT ON cursors BEGIN SELECT RAISE(ABORT, 'TEST_FAILURE'); END")
  f.clock.advance(DAY); await f.engine.poll(); await f.engine.drain()
  const ids = (await readdir(f.root)).filter(n => n.startsWith('sleep-loop-'))
  expect(ids).toHaveLength(1)
  db.exec('DROP TRIGGER fail_cursor'); db.close()
  f.clock.advance(1000); await f.engine.poll(); await f.engine.drain()
  expect(f.delivered[0]!.record.id).toBe(ids[0])
  expect(f.delivered[0]!.record.sessions[0]!.analysisRange.from).toBe(0)
})

it('preserves the exact deadline after the owning Node process is killed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sleep-crash-')); roots.push(root)
  const moduleUrl = new URL('../dist/engine.js', import.meta.url).href
  const script = `import { SleepEngine } from ${JSON.stringify(moduleUrl)};
    const e = new SleepEngine(${JSON.stringify(root)}, { list: async () => [], capture: async () => { throw new Error('UNUSED'); } }, { deliver: async () => {} });
    await e.start(); const status = await e.schedule({ delta_ms: 3600000 });
    process.on('message', () => {}); process.send(status);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let diagnostics = ''
  child.stderr!.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-2000) })
  try {
    const state = await new Promise<{ nextDueAt: number; hardDeadlineAt: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Crash fixture startup timeout: ' + diagnostics)), 5000)
      child.once('message', message => { clearTimeout(timer); resolve(message as { nextDueAt: number; hardDeadlineAt: number }) })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Crash fixture exited: ' + diagnostics)) })
    })
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    const next = new SleepEngine(root, { list: async () => [], capture: async () => { throw new Error('UNUSED') } }, { deliver: async () => {} }); engines.push(next)
    await next.start()
    expect(next.status().nextDueAt).toBe(state.nextDueAt)
    expect(next.status().hardDeadlineAt).toBe(state.hardDeadlineAt)
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
  }
}, 10000)
it('treats a missing scheduler in an initialized home as due rather than postponing another day', async () => {
  const f = await fixture()
  await rm(join(f.root, 'scheduler.json'))
  const next = await f.restart()
  expect(f.delivered).toHaveLength(1)
  expect(next.status().lastError).toBe('SLEEP_SCHEDULER_RECOVERED')
})
