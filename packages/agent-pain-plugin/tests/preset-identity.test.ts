/**
 * Purpose: The recorded pain owner is the preset the session actually ran, not the
 * deep-frozen creation header. A session may change preset while it is blank, and the
 * change is what later turns run under, so the collector must advance its identity from
 * the session log and keep it across a restart.
 * Example: header "canvas" plus a blank-window selection of "standard" -> the pain names
 * "standard" in its source and in the grouped `sources` summary.
 * Tests drive the public Collector over disposable directories and inspect persisted JSON.
 */
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Collector } from '../src/collector.js'
import { PainEngine } from '../src/engine.js'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(preset: string | null) {
  const root = await mkdtemp(join(tmpdir(), 'pain-preset-'))
  roots.push(root)
  const engine = new PainEngine(root)
  await engine.ready
  return { root, engine, source: { sessionId: 'preset-session', agentId: 'preset-agent', agentPreset: preset } }
}
const event = (seq: number, type: string, data: unknown) =>
  ({ type, data, seq, time: 1789000000000 + seq }) as SessionEvent
/** 65020 known tokens crosses the default 64000 per-turn allowance, so one token_excess is emitted. */
const usage = { turn: 1, step: 1, usage: { inputTokens: 65000, outputTokens: 20 } }
const occurrences = async (engine: PainEngine) =>
  (await engine.all()).flatMap((p) => p.occurrences.map((o) => ({ pain: p, occurrence: o })))

it('names the preset selected before the first turn, not the creation header', async () => {
  const f = await fixture('canvas')
  const collector = new Collector(f.root, f.engine, async () => [])
  await collector.ready
  await collector.consume(f.source, [
    event(0, 'agent-preset/selected', { agentPreset: 'standard' }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'step/start', { turn: 1, step: 1 }),
    event(3, 'assistant/message', usage),
  ])
  const found = await occurrences(f.engine)
  expect(found).toHaveLength(1)
  expect(found[0]!.occurrence.type).toBe('token_excess')
  expect(found[0]!.occurrence.source.agentPreset).toBe('standard')
  const listed = await f.engine.list({})
  expect(listed.items[0]!.sources).toEqual(['standard'])
})

it('keeps the creation header when the session never changes preset', async () => {
  const f = await fixture('canvas')
  const collector = new Collector(f.root, f.engine, async () => [])
  await collector.ready
  await collector.consume(f.source, [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'step/start', { turn: 1, step: 1 }),
    event(2, 'assistant/message', usage),
  ])
  const found = await occurrences(f.engine)
  expect(found).toHaveLength(1)
  expect(found[0]!.occurrence.source.agentPreset).toBe('canvas')
})

it('keeps the selected preset when the selection happened before a restart', async () => {
  const f = await fixture('canvas')
  const first = new Collector(f.root, f.engine, async () => [])
  await first.ready
  await first.consume(f.source, [
    event(0, 'agent-preset/selected', { agentPreset: 'standard' }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'step/start', { turn: 1, step: 1 }),
  ])
  const second = new Collector(f.root, f.engine, async () => [])
  await second.ready
  expect(await second.cursor(f.source.sessionId)).toBe(2)
  await second.consume(f.source, [event(3, 'assistant/message', usage)])
  const found = await occurrences(f.engine)
  expect(found).toHaveLength(1)
  expect(found[0]!.occurrence.source.agentPreset).toBe('standard')
  const state = JSON.parse(await readFile(join(f.root, 'collector.json'), 'utf8'))
  expect(state.sessions[0].agentPreset).toBe('standard')
})

it('uses the last selection made while the session was still blank', async () => {
  const f = await fixture('standard')
  const collector = new Collector(f.root, f.engine, async () => [])
  await collector.ready
  await collector.consume(f.source, [
    event(0, 'agent-preset/selected', { agentPreset: 'canvas' }),
    event(1, 'agent-preset/selected', { agentPreset: 'trainer' }),
    event(2, 'turn/start', { turn: 1 }),
    event(3, 'step/start', { turn: 1, step: 1 }),
    event(4, 'assistant/message', usage),
  ])
  const found = await occurrences(f.engine)
  expect(found).toHaveLength(1)
  expect(found[0]!.occurrence.source.agentPreset).toBe('trainer')
})

it('does not change the token_excess threshold, metrics or deduplication', async () => {
  const f = await fixture('standard')
  const collector = new Collector(f.root, f.engine, async () => [])
  await collector.ready
  await collector.consume(f.source, [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'step/start', { turn: 1, step: 1 }),
    event(2, 'assistant/message', usage),
  ])
  const found = await occurrences(f.engine)
  expect(found).toHaveLength(1)
  expect(found[0]!.occurrence.metrics).toMatchObject({
    knownTokens: 65020,
    usageComplete: true,
    confirmedToolFailures: 0,
  })
  expect(found[0]!.occurrence.score).toBe(10)
})

it('reads a collector state written before the preset field existed', async () => {
  const f = await fixture('canvas')
  await writeFile(
    join(f.root, 'collector.json'),
    JSON.stringify({
      version: 1,
      initializedAt: '2026-09-16T11:51:03.980Z',
      sessions: [
        {
          sessionId: f.source.sessionId,
          processedThroughSeq: 2,
          activeTurns: [
            {
              turnId: '1',
              confirmedToolFailures: 0,
              failedCallIds: [],
              calls: [],
              usageByStep: [
                { stepId: '1', uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usageComplete: false },
              ],
              emittedTypes: [],
            },
          ],
        },
      ],
    }),
  )
  const collector = new Collector(f.root, f.engine, async () => [])
  await collector.ready
  expect(await collector.preset(f.source.sessionId)).toBeNull()
  // The Host resolves a legacy entry from the whole log, so the batch carries the effective preset.
  await collector.consume({ ...f.source, agentPreset: 'standard' }, [event(3, 'assistant/message', usage)])
  const found = await occurrences(f.engine)
  expect(found).toHaveLength(1)
  expect(found[0]!.occurrence.source.agentPreset).toBe('standard')
  expect(await collector.preset(f.source.sessionId)).toBe('standard')
})
