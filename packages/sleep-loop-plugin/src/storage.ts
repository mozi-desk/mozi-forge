/**
 * Purpose: Own durable Sleep JSON commits and a bounded, disk-backed discovery queue.
 * SQLite transactions serialize process ownership and cursor updates; WAL plus FULL
 * synchronization protects committed discovery facts. JSON files use fsync/rename.
 * Example: a dead owner's PID is replaced inside one transaction; a live owner makes
 * a second Host fail before it can schedule. PID reuse conservatively keeps the lock.
 * Sleep records are the recovery journal if the discovery database must be rebuilt.
 */
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncrementalCheckpoint } from '@mozi-forge/session-insights-plugin/incremental'
/** Sync file contents before rename, then sync the containing directory before reporting success. */
export async function durableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
    await rename(temp, path)
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(temp, { force: true }) }
}
export async function optionalJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export class Discovery {
  private readonly db: DatabaseSync
  private readonly nonce = randomUUID()
  private closed = false
  private sequence: number
  /** Acquire the single-writer identity atomically before exposing queue operations. */
  constructor(root: string) {
    this.db = new DatabaseSync(join(root, 'discovery.sqlite'))
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER, nonce TEXT); CREATE TABLE IF NOT EXISTS cursors (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS dirty (id TEXT PRIMARY KEY, seq INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS dirty_sequence ON dirty(seq);')
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const owner = this.db.prepare('SELECT pid FROM owner WHERE singleton=1').get() as { pid: number } | undefined
        if (owner) {
          let alive = true
          try { process.kill(owner.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
          if (alive) throw new Error('SLEEP_OWNER_ACTIVE')
        }
        this.db.prepare('INSERT OR REPLACE INTO owner VALUES (1, ?, ?)').run(process.pid, this.nonce)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
      this.sequence = Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM dirty').get()!.n)
    } catch (error) { this.db.close(); throw error }
  }
  /** Coalesce repeated events until a candidate is claimed; subsequent events form another candidate. */
  mark(id: string): void { this.db.prepare('INSERT OR IGNORE INTO dirty VALUES (?, ?)').run(id, ++this.sequence) }
  cutoff(): number { return this.sequence }
  batch(cutoff: number): string[] { return (this.db.prepare('SELECT id FROM dirty WHERE seq <= ? ORDER BY seq LIMIT 128').all(cutoff) as { id: string }[]).map(r => r.id) }
  claim(id: string): void { this.db.prepare('DELETE FROM dirty WHERE id=?').run(id) }
  checkpoint(id: string): IncrementalCheckpoint | undefined { const row = this.db.prepare('SELECT value FROM cursors WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as IncrementalCheckpoint : undefined }
  /** Replay a committed record's coverage atomically; a partial replay cannot lose a session cursor. */
  cover(entries: Array<{ sessionId: string; checkpoint: IncrementalCheckpoint }>): void {
    this.db.exec('BEGIN IMMEDIATE')
    try { const put = this.db.prepare('INSERT OR REPLACE INTO cursors VALUES (?, ?)'); for (const row of entries) put.run(row.sessionId, JSON.stringify(row.checkpoint)); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.db.prepare('DELETE FROM owner WHERE singleton=1 AND nonce=?').run(this.nonce) } finally { this.db.close() }
  }
}
