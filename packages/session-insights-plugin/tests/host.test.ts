/**
 * Purpose: Black-box frozen evidence, bounded pagination and diagnostic classification.
 * Example: append after inspection, refresh, and resume an old cursor after restarting
 * the service: the original evidence is unchanged. Public persistence fixtures count
 * source reads; tests never inspect SessionInsights private fields.
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionInsights } from '../src/host.js'
import { deriveMetrics } from '../src/metrics.js'
import type { InsightRow } from '../src/types.js'
const directories: string[] = [], contexts: Context[] = []
class Persistence extends Service {
  data = new Map<string, { meta: SessionHeader; inheritedEventCount: number; events: SessionEvent[] }>()
  reads: string[] = []
  constructor(ctx: Context) { super(ctx, 'sessionPersistence') }
  /**
   * Harness 0.1.5 exposes a per-session read handle rather than a `readFrom` result, so the stub answers
   * `open(id, 'read')` with the same stored facts behind a handle shape: the header and fork cut travel
   * on the handle, and `read(offset)` returns the event suffix from that logical offset.
   */
  async open(id: string) {
    this.reads.push(id)
    const row = this.data.get(id)
    if (!row) throw new Error('missing')
    const stored = structuredClone(row)
    return {
      header: stored.meta,
      inheritedEventCount: stored.inheritedEventCount,
      async read(offset = 0) { return { events: stored.events.filter(event => Number(event.seq) >= offset) } },
      async close() {},
    }
  }
}
function turn(start: number, number = 1, size = 20): SessionEvent[] {
  const rows = [
    { type: 'turn/start', data: { turn: number } },
    { type: 'user/message', data: { id: `u${number}`, source: { kind: 'user' }, content: [{ type: 'text', text: '中😀文'.repeat(size) }] } },
    { type: 'step/start', data: { turn: number, step: 1 } },
    // Harness 0.1.5 replaced the log-only `assistant/chunk` carrier with `assistant/attempt`, and moved
    // token accounting onto the settlement event below. The row count stays at nine per turn because
    // this fixture's callers index turns by a literal nine-row stride.
    { type: 'assistant/attempt', data: { turn: number, step: 1, stream: [] } },
    // `stream` is required on a settlement in 0.1.5; it stays empty here because these tests assert
    // evidence, pagination and token accounting, not TTFT.
    { type: 'assistant/message', data: { turn: number, step: 1, usage: { inputTokens: 10, outputTokens: 3 }, stream: [], message: { content: [{ type: 'reasoning', text: 'Investigate the failure.' }] } } },
    { type: 'tool/call', data: { callId: `c${number}`, name: 'bash', arguments: '{}' } },
    { type: 'tool/result', data: { message: { source: { callId: `c${number}` }, content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'error: timeout' }] }] } } },
    { type: 'step/end', data: { turn: number, step: 1 } },
    { type: 'turn/end', data: { turn: number } },
  ]
  return rows.map((e, index) => ({ ...e, seq: start + index, time: start + index })) as unknown as SessionEvent[]
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'session-insights-')); directories.push(root); vi.stubEnv('DSH_HOME', root)
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(Persistence)
  const source = ctx.get('sessionPersistence') as unknown as Persistence
  // Harness 0.1.5 writes format 3; a stored header must carry the version this build reads.
  source.data.set('s0', { meta: { version: 3, isSeeded: false, id: SessionId('s0'), createdAt: 1, agentPreset: 'coding' }, inheritedEventCount: 0, events: turn(0) })
  await ctx.plugin(SessionInsights, { projectRoot: root })
  return { ctx, source, root, insights: ctx.sessionInsights }
}
type Summary = { sessionId: string; revision: string; through: number; evidencePath: string; topTurns: InsightRow[]; usageComplete: boolean; metrics: ReturnType<typeof deriveMetrics> }
type Page = { text: string; nextCursor: string | null; totalBytes: number; omittedEvents: number }
type Query = { rows: InsightRow[]; total: number; nextCursor: string | null }
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); vi.unstubAllEnvs() })
it('reads only the selected source, freezes revisions and reuses persisted evidence after recovery', async () => {
  const f = await fixture()
  const original = await f.insights.inspect({ session_id: 's0' }) as Summary
  f.source.data.get('s0')!.events.push(...turn(9, 2))
  expect(await f.insights.inspect({ session_id: 's0' })).toEqual(original)
  const refreshed = await f.insights.inspect({ session_id: 's0', refresh: true }) as Summary
  expect(refreshed.revision).not.toBe(original.revision)
  expect(f.source.reads).toEqual(['s0', 's0'])
  refreshed.topTurns[0]!.summary = 'caller mutation'
  expect((await f.insights.inspect({ session_id: 's0' }) as Summary).topTurns[0]!.summary).not.toBe('caller mutation')
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(Persistence); await ctx.plugin(SessionInsights, { projectRoot: f.root })
  const old = await ctx.sessionInsights.read({ session_id: 's0', revision: original.revision, from: 0, through: 8 }) as Page
  expect(old.text).toContain('c1'); expect(old.text).not.toContain('c2')
  expect((await ctx.sessionInsights.inspect({ session_id: 's0' }) as Summary).revision).toBe(refreshed.revision)
})
it('paginates huge multilingual events without gaps and binds cursor to the request', async () => {
  const f = await fixture(); f.source.data.get('s0')!.events = turn(0, 1, 10000)
  const snapshot = await f.insights.inspect({ session_id: 's0' }) as Summary
  const request = { session_id: 's0', revision: snapshot.revision, from: 0, through: 8 }
  let text = '', cursor: string | undefined, firstCursor = ''
  do {
    const page = await f.insights.read({ ...request, ...(cursor ? { cursor } : {}) }) as Page
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192)
    expect(page.text).not.toContain('�'); text += page.text
    cursor = page.nextCursor ?? undefined; if (!firstCursor && cursor) firstCursor = cursor
  } while (cursor)
  expect(text).toBe(await readFile(snapshot.evidencePath, 'utf8'))
  expect(f.source.reads).toEqual(['s0'])
  await expect(f.insights.read({ ...request, view: 'raw', cursor: firstCursor })).rejects.toThrow('CURSOR')
  const page = await f.insights.read({ ...request, view: 'raw' }) as Page
  expect(page.totalBytes).toBeGreaterThan(Buffer.byteLength(text))
})
it('paginates query results and searches beyond event previews', async () => {
  const f = await fixture(); f.source.data.get('s0')!.events = Array.from({ length: 45 }, (_,i) => turn(i*9,i+1,100)).flat()
  const snapshot = await f.insights.inspect({ session_id: 's0' }) as Summary
  const request = { session_id: 's0', revision: snapshot.revision, signal: 'tool-failure' as const }
  let cursor: string | undefined; const from: number[] = []
  do { const page = await f.insights.query({ ...request, ...(cursor ? { cursor } : {}) }) as Query; expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192); expect(page.rows.length).toBeLessThanOrEqual(20); from.push(...page.rows.map(r => r.from)); cursor = page.nextCursor ?? undefined } while (cursor)
  expect(from).toEqual(Array.from({ length: 45 }, (_,i) => i*9))
  const found = await f.insights.query({ session_id: 's0', revision: snapshot.revision, query: 'c45', kind: 'tool' }) as Query
  expect(found.rows).toHaveLength(1); expect(found.rows[0]!.from).toBe(44*9+5)
})
it('separates inherited execution and missing usage from measured own turns', async () => {
  const f = await fixture(), source = f.source.data.get('s0')!
  source.events = [...turn(0), ...turn(9, 2)]
  const message = source.events.findLast(e => e.type === 'assistant/message')!
  if (message.type === 'assistant/message') delete message.data.usage
  source.inheritedEventCount = 9
  const result = await f.insights.inspect({ session_id: 's0' }) as Summary
  expect(result.metrics.tools.calls).toBe(1); expect(result.metrics.tokens.outputTokens).toBe(0); expect(result.usageComplete).toBe(false)
  const query = await f.insights.query({ session_id: 's0', revision: result.revision }) as Query
  expect(query.rows.map(r => r.inherited)).toEqual([true, false])
})
it('classifies structured failures, text hints, repeated calls and open tails independently', async () => {
  const f = await fixture(), events = turn(0).slice(0, 5)
  for (let i = 0; i < 4; i++) {
    events.push({ type: 'tool/call', seq: 5+i*2, time: 5+i*2, data: { callId: `repeat${i}`, name: 'bash', arguments: '{"command":"poll"}' } } as unknown as SessionEvent)
    if (i < 3) events.push({ type: 'tool/result', seq: 6+i*2, time: 6+i*2, data: { message: { source: { callId: `repeat${i}` }, content: [{ type: 'text', text: i === 0 ? '{"exitCode":2}' : 'error: possible issue' }] } } } as unknown as SessionEvent)
  }
  f.source.data.get('s0')!.events = events
  const snapshot = await f.insights.inspect({ session_id: 's0' }) as Summary
  const query = await f.insights.query({ session_id: 's0', revision: snapshot.revision, kind: 'tool' }) as Query
  expect(query.rows[0]!.signals).toContain('tool-failure'); expect(query.rows[1]!.signals).toContain('suspected-error')
  expect(query.rows.every(r => r.signals.includes('suspected-loop'))).toBe(true)
  expect(query.rows[3]!.signals).toContain('incomplete-tool'); expect(query.rows[3]!.signals).not.toContain('tool-failure')
  expect(snapshot.metrics.tools.failed).toBe(1); expect(snapshot.metrics.tools.incomplete).toBe(1)
  expect(snapshot.metrics.tokens.outputTokens).toBe(3)
})
it('redacts persisted evidence and validates malformed requests before reading', async () => {
  const f = await fixture()
  const event = f.source.data.get('s0')!.events[1]!
  Object.assign(event.data, { password: 'fixture-private-value', text: 'Authorization: Bearer fixture-secret' })
  const snapshot = await f.insights.inspect({ session_id: 's0' }) as Summary
  const text = await readFile(snapshot.evidencePath, 'utf8')
  expect(text).not.toContain('fixture-private-value'); expect(text).not.toContain('fixture-secret')
  await expect(f.insights.inspect({ session_id: 'missing' })).rejects.toThrow('SOURCE_UNAVAILABLE')
  await expect(f.insights.read({ session_id: 's0', revision: snapshot.revision, from: -1, through: 8 })).rejects.toThrow('from')
  await expect(f.insights.read({ session_id: 's0', revision: snapshot.revision, from: 0, through: 99 })).rejects.toThrow('RANGE')
  await expect(f.insights.query({ session_id: 's0', revision: '../../escape' })).rejects.toThrow('REVISION')
})

it('finds alternating call patterns while leaving ordinary successful text outside failures', async () => {
  const f = await fixture(), events = turn(0).slice(0, 5)
  for (let i = 0; i < 6; i++) {
    events.push({ type: 'tool/call', seq: 5+i*2, time: i*40000, data: { callId: `ab${i}`, name: i%2 ? 'poll' : 'inspect', arguments: i%2 ? { b: 2, a: 1 } : { path: 'file' } } } as unknown as SessionEvent)
    events.push({ type: 'tool/result', seq: 6+i*2, time: i*40000+35000, data: { message: { source: { callId: `ab${i}` }, content: [{ type: 'text', text: 'There is no error.\n' + 'x'.repeat(9000) + '\nneedle\nline' }] } } } as unknown as SessionEvent)
  }
  f.source.data.get('s0')!.events = events
  const summary = await f.insights.inspect({ session_id: 's0' }) as Summary
  const query = await f.insights.query({ session_id: 's0', revision: summary.revision, kind: 'tool', tool: 'poll', query: 'needle\nline' }) as Query
  expect(query.rows).toHaveLength(3)
  for (const row of query.rows) {
    expect(row.tool).toBe('poll')
    expect(row.signals).toEqual(expect.arrayContaining(['suspected-loop', 'large-output', 'long-running']))
    expect(row.signals).not.toContain('tool-failure'); expect(row.signals).not.toContain('suspected-error')
  }
})

it('ranks known token pressure from the settlement usage', async () => {
  const f = await fixture(), events = [...turn(0), ...turn(9, 2)]
  // Harness 0.1.5 reports usage once per step, on the settlement event, so there is no second
  // stream-carried usage left for this fixture to duplicate.
  for (const event of events.slice(9)) {
    if (event.type === 'assistant/message') event.data.usage = { inputTokens: 40000, outputTokens: 100, cacheReadTokens: 12 }
  }
  f.source.data.get('s0')!.events = events
  const snapshot = await f.insights.inspect({ session_id: 's0' }) as Summary
  const query = await f.insights.query({ session_id: 's0', revision: snapshot.revision, sort: 'tokens' }) as Query
  expect(query.rows[0]!.from).toBe(9); expect(query.rows[0]!.tokens).toBe(40112)
  expect(query.rows[0]!.signals).toContain('high-tokens')
  expect(snapshot.metrics.tokens).toMatchObject({ uncachedInputTokens: 40010, outputTokens: 103, cacheReadTokens: 12 })
  const steps = await f.insights.query({ session_id: 's0', revision: snapshot.revision, kind: 'step', signal: 'high-tokens' }) as Query
  expect(steps.rows).toHaveLength(1); expect(steps.rows[0]!.step).toBe(1)
})
it('freezes disjoint Sleep increments, skips unchanged evidence and rejects source rewrites', async () => {
  const f = await fixture()
  const first = await f.insights.incremental({ session_id: 's0' })
  expect(first.session?.analysisRange).toEqual({ from: 0, through: 8 })
  expect(first.session?.metrics.knownTokens).toBe(13)
  expect(first.session?.metrics.confirmedToolFailures).toBe(1)
  const unchanged = await f.insights.incremental({ session_id: 's0', previous: first.checkpoint })
  expect(unchanged.session).toBeUndefined()
  f.source.data.get('s0')!.events.push(...turn(9, 2))
  const second = await f.insights.incremental({ session_id: 's0', previous: first.checkpoint })
  expect(second.session?.analysisRange).toEqual({ from: 9, through: 17 })
  expect(second.session?.metrics.knownTokens).toBe(13)
  expect(second.session?.isNew).toBe(false)
  f.source.data.get('s0')!.events[0] = { ...f.source.data.get('s0')!.events[0]!, time: 999 }
  await expect(f.insights.incremental({ session_id: 's0', previous: second.checkpoint })).rejects.toThrow('SESSION_PREFIX_CHANGED')
})
it('attributes delayed failures and final usage to the continuation window without repeating streamed usage', async () => {
  const f = await fixture()
  const first = await f.insights.incremental({ session_id: 's0', through: 5 })
  expect(first.session?.metrics.incompleteToolCalls).toBe(1)
  const next = await f.insights.incremental({ session_id: 's0', previous: first.checkpoint })
  expect(next.session?.turns).toEqual([{ turn: 1, from: 6, through: 8, contextFrom: 0, continuedFromPrevious: true, complete: true }])
  expect(next.session?.metrics.confirmedToolFailures).toBe(1)
  expect(next.session?.metrics.toolCalls).toBe(0)
  expect(next.session?.metrics.knownTokens).toBe(0)
  // Harness 0.1.5 reports a step's usage on its settlement, so a prefix that must already know the
  // usage has to include the settlement at seq 4 rather than stop at the stream position before it.
  const chunk = await f.insights.incremental({ session_id: 's0', through: 4 })
  const final = await f.insights.incremental({ session_id: 's0', previous: chunk.checkpoint })
  expect(final.session?.metrics.knownTokens).toBe(0)
})
it('keeps inherited execution out of Sleep metrics and reports missing usage and negative corrections', async () => {
  const f = await fixture(), source = f.source.data.get('s0')!
  source.inheritedEventCount = 9
  expect((await f.insights.incremental({ session_id: 's0' })).session).toBeUndefined()
  source.events.push(...turn(9, 2))
  const own = await f.insights.incremental({ session_id: 's0' })
  expect(own.session?.analysisRange).toEqual({ from: 9, through: 17 })
  expect(own.session?.metrics.knownTokens).toBe(13)
  const partial = await f.insights.incremental({ session_id: 's0', through: 11 })
  expect(partial.session?.metrics.usageComplete).toBe(false)
  const beforeFinal = await f.insights.incremental({ session_id: 's0', through: 12 })
  const event = source.events[13]!
  if (event.type === 'assistant/message') source.events[13] = { ...event, data: { ...event.data, usage: { inputTokens: 7, outputTokens: 1 } } }
  const corrected = await f.insights.incremental({ session_id: 's0', previous: beforeFinal.checkpoint })
  // The settlement at seq 13 sits outside the covered prefix, and it is the only carrier of this step's
  // usage, so the shrunk value is newly observed rather than a correction of an earlier reading. A
  // negative correction needs one step to report usage twice, which 0.1.5 no longer does.
  expect(corrected.session?.metrics.knownTokens).toBe(8)
  expect(corrected.session?.metrics.tokenCorrections.uncachedInputTokens).toBe(0)
})
it('retains a captured endpoint when persistence has not reached it and validates checkpoint inputs before reads', async () => {
  const f = await fixture()
  await expect(f.insights.incremental({ session_id: 's0', through: 10 })).rejects.toThrow('SESSION_PREFIX_NOT_DURABLE')
  const reads = f.source.reads.length
  await expect(f.insights.incremental({ session_id: 's0', through: 1.5 })).rejects.toThrow('INVALID_SESSION_ENDPOINT')
  await expect(f.insights.incremental({ session_id: 's0', previous: { through: 8, fingerprint: 'bad' } })).rejects.toThrow('INVALID_SESSION_CHECKPOINT')
  expect(f.source.reads).toHaveLength(reads)
  const captured = await f.insights.incremental({ session_id: 's0', through: 5 })
  expect(captured.hasMore).toBe(true)
  expect((await f.insights.incremental({ session_id: 's0', previous: captured.checkpoint })).session?.analysisRange).toEqual({ from: 6, through: 8 })
})
