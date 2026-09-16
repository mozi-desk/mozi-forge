/**
 * Purpose: Verify evidence against the installed Harness JSONL persistence plugin.
 * Example: write a fork with a completed inherited turn and an open own turn in
 * both supported encodings; querying preserves the open tail and original log bytes.
 * Only public create/append/readFrom APIs and public disk artifacts are used.
 */
import { createRequire } from 'node:module'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import SessionInsights from '../src/host.js'
import type { InsightRow } from '../src/types.js'
const runtime = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
const { default: JsonlPersistence } = await import(runtime.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
it.each(['none', 'zstd'])('queries real %s persistence and keeps incomplete fork evidence unchanged', async compression => {
  const root = await mkdtemp(join(tmpdir(), 'insights-persistence-'))
  vi.stubEnv('DSH_HOME', root)
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression })
    await ctx.plugin(SessionInsights, { projectRoot: root })
    const id = SessionId('source-fork')
    const session = Session.create(SessionId('source-parent'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const meta = { id, version: SESSION_FORMAT_VERSION, isSeeded: true, cwd: root, createdAt: 1, agentPreset: 'coding' }
    const persistence = ctx.get('sessionPersistence') as InstanceType<typeof JsonlPersistence>
    await persistence.create(meta, SessionLogOffset(2))
    await persistence.append(id, session.snapshotEvents())
    const location = persistence.locate(meta)
    const before = await readFile(location.path)
    const summary = await ctx.sessionInsights.inspect({ session_id: id }) as { revision: string; through: number; inheritedEventCount: number }
    expect(summary.through).toBe(2); expect(summary.inheritedEventCount).toBe(2)
    const query = await ctx.sessionInsights.query({ session_id: id, revision: summary.revision }) as { rows: InsightRow[] }
    expect(query.rows.map(r => [r.inherited, r.complete])).toEqual([[true, true], [false, false]])
    expect(await readFile(location.path)).toEqual(before)
    expect(location.path.endsWith(compression === 'zstd' ? '.jsonl.zstd' : '.jsonl')).toBe(true)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() }
})
