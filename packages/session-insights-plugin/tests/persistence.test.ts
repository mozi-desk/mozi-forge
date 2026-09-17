/**
 * Purpose: Verify evidence against the installed Harness JSONL persistence plugin.
 * Example: write a fork with a completed inherited turn and an open own turn in
 * both supported encodings; querying preserves the open tail and original log bytes.
 * Only public persistence handle APIs and public disk artifacts are used.
 */
import { createRequire } from 'node:module'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import SessionInsights from '../src/host.js'
import type { InsightRow } from '../src/types.js'
const runtime = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
const { default: JsonlPersistence } = await import(runtime.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
/** Locate one stored session's current generation log below a sessions root. */
async function findSessionLog(root: string, id: string): Promise<string> {
  const sessions = join(root, 'sessions')
  for (const entry of await readdir(sessions, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u.test(entry.name)) continue
    const path = join(entry.parentPath, entry.name)
    // The session directory is named after the session id, and a `zstd` log is not UTF-8 readable, so
    // the path itself identifies the stored session.
    if (path.includes(id)) return path
  }
  throw new Error(`stored session log not found for ${id}`)
}

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
    // Harness 0.1.5 only accepts a seeded Session whose inherited prefix ends with the end-seed marker;
    // without it the reader refuses the log as a corrupt released-format fork.
    session.append('session/end-seed', { inherited: true })
    session.append('turn/start', { turn: 2 })
    const meta = { id, version: SESSION_FORMAT_VERSION, isSeeded: true, cwd: root, createdAt: 1, agentPreset: 'coding' }
    const persistence = ctx.get('sessionPersistence') as InstanceType<typeof JsonlPersistence>
    // Harness 0.1.5 hands back a write handle from `create`, carries the fork cut in its options, and
    // dropped `locate()`: the stored log is found by scanning the sessions root for its generation file.
    const handle = await persistence.create(meta, { inheritedEventCount: SessionLogOffset(3) })
    try {
      await handle.append(session.snapshotEvents())
      await handle.flush()
    } finally { await handle.close() }
    const path = await findSessionLog(root, id)
    const before = await readFile(path)
    const summary = await ctx.sessionInsights.inspect({ session_id: id }) as { revision: string; through: number; inheritedEventCount: number }
    expect(summary.inheritedEventCount).toBe(2); expect(summary.through).toBe(3)
    const query = await ctx.sessionInsights.query({ session_id: id, revision: summary.revision }) as { rows: InsightRow[] }
    expect(query.rows.map(r => [r.inherited, r.complete])).toEqual([[true, true], [false, false]])
    expect(await readFile(path)).toEqual(before)
    expect(path.endsWith(compression === 'zstd' ? '.jsonl.zstd' : '.jsonl')).toBe(true)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() }
})
