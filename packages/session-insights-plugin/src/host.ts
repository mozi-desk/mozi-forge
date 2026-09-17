/**
 * Purpose: Query one session and persist immutable, redacted, seekable evidence.
 * Flow: inspect uses public Harness persistence once, writes JSONL plus offsets, then
 * publishes an index and latest pointer. Queries reuse that index; reads seek directly
 * into JSONL. Explicit refresh publishes a new revision without changing old evidence.
 * Example: inspect s1, read its first 8 KiB, append a turn, then resume the cursor: the
 * old revision still returns the same bytes. Refresh exposes the appended turn.
 * Sleep incremental reads validate the previously covered prefix, freeze the supplied
 * endpoint and publish evidence only for newly observed execution; late events return
 * hasMore for the discovery queue. Prefix fingerprints reject rewritten source logs.
 * Failure: partial builds are unpublished; missing snapshots fail explicitly. Per-session
 * serialization protects publication. Files are private to the runtime; no source logs
 * are changed. The first public persistence read can materialize the whole session
 * in Host memory; inspect returns only facts, while read pages can cover small sessions.
 */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { readStoredSession, type StoredSessionRead } from './session-reader.js'
import z from '@deepseek-ai/schemastery'
import { incrementalFacts, type IncrementalCheckpoint, type IncrementalSession } from './incremental.js'
import { deriveMetrics } from './metrics.js'
import { analyzeEvents, usageComplete } from './analysis.js'
import { atomicJson, digest, redact, Serial } from './store.js'
import { inspectParameters, queryParameters, readParameters, validate } from './contracts.js'
import type { SessionIndex, SessionReference, QueryInput, ReadInput } from './types.js'
export const name = 'mozi-session-insights'
export interface Config { projectRoot: string }
export const Config: z<Config> = z.object({ projectRoot: z.string().required() })
export interface SessionSource { meta: SessionHeader; inheritedEventCount?: number; events: readonly SessionEvent[] }
declare module '@deepseek-ai/cordis' { interface Context { sessionInsights: SessionInsights } }
const MAX_BYTES = 8192
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
/** Cursors bind all filters, the revision and the next exact position. */
function cursorPosition(cursor: string | undefined, request: unknown): number {
  if (!cursor) return 0
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (value.key !== digest(request) || !Number.isSafeInteger(value.position) || value.position < 0) throw new Error('invalid')
    return value.position
  } catch { throw new Error('INVALID_SESSION_CURSOR: reuse the returned cursor with the same request') }
}
function continuation(position: number, request: unknown): string { return Buffer.from(JSON.stringify({ key: digest(request), position })).toString('base64url') }
/** Redact both sensitive field names and credential-bearing free text before disk writes. */
function clean(value: unknown): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /^(?:authorization|password|secret|(?:api[_-]?key)|(?:access[_-]?token))$/iu.test(k) ? '[redacted]' : clean(v)]))
  return value
}
/** Search decoded string values so multiline literals work without JSON escaping knowledge. */
function containsText(value: unknown, query: string): boolean {
  if (typeof value === 'string') return value.includes(query)
  if (Array.isArray(value)) return value.some(item => containsText(item, query))
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => key.includes(query) || containsText(item, query))
}
export class SessionInsights extends Service {
  static inject = ['sessionPersistence']
  static Config = Config
  private readonly root: string
  private readonly serial = new Serial()
  private readonly cache = new Map<string, SessionIndex>()
  constructor(private readonly host: Context, config: Config) {
    super(host, 'sessionInsights')
    this.root = join(resolve(process.env.DSH_HOME ?? join(config.projectRoot, '.runtime')), 'session-insights', 'snapshots')
  }
  private directory(id: string): string { return join(this.root, digest(id)) }
  private remember(index: SessionIndex): SessionIndex {
    const key = `${index.sessionId}:${index.revision}`
    this.cache.delete(key); this.cache.set(key, index)
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!)
    return index
  }
  /** Resolve only a published immutable revision; validates IDs before constructing paths. */
  async reference(ref: SessionReference): Promise<SessionReference> {
    await this.index(ref.sessionId, ref.revision)
    return { sessionId: ref.sessionId, revision: ref.revision }
  }
  private async index(id: string, revision: string): Promise<SessionIndex> {
    validate(queryParameters, { session_id: id, revision })
    if (!/^[a-f0-9]{64}$/u.test(revision)) throw new Error('INVALID_SESSION_REVISION')
    const key = `${id}:${revision}`, cached = this.cache.get(key)
    if (cached) return cached
    try {
      const index = JSON.parse(await readFile(join(this.directory(id), revision, 'index.json'), 'utf8')) as SessionIndex
      if (index.sessionId !== id || index.revision !== revision) throw new Error('identity mismatch')
      return this.remember(index)
    } catch { throw new Error('SESSION_SNAPSHOT_UNAVAILABLE: inspect the session or restore its evidence files') }
  }
  /** Inspect one ID, publishing evidence only after all files and their index are written. */
  async inspect(input: { session_id: string; refresh?: boolean }): Promise<unknown> {
    validate(inspectParameters, input)
    const index = await this.serial.run(input.session_id, async () => {
      const directory = this.directory(input.session_id)
      if (!input.refresh) {
        try {
          const latest = JSON.parse(await readFile(join(directory, 'latest.json'), 'utf8')) as SessionReference
          return await this.index(input.session_id, latest.revision)
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      let source: StoredSessionRead
      try { source = await readStoredSession((this.host as Context & { sessionPersistence: SessionPersistence }).sessionPersistence, SessionId(input.session_id)) }
      catch { throw new Error('SESSION_SOURCE_UNAVAILABLE: session missing or unreadable; verify the ID in this runtime') }
      if (String(source.meta.id) !== input.session_id) throw new Error('SESSION_IDENTITY_MISMATCH')
      return this.publish(source)
    })
    const turns = index.rows.filter(r => r.kind === 'turn' && !r.inherited)
    const signals: Record<string, number> = {}
    for (const row of turns) for (const signal of row.signals) signals[signal] = (signals[signal] ?? 0) + 1
    const result = { sessionId: index.sessionId, revision: index.revision, preset: index.preset, sourceCwd: index.sourceCwd, parentSession: index.parentSession, createdAt: index.createdAt, through: index.through, inheritedEventCount: index.inheritedEventCount, metrics: { ...index.metrics, tools: { ...index.metrics.tools, byName: undefined } }, usageComplete: index.usageComplete, signals, turns: turns.length, topTurns: [] as typeof turns, evidencePath: join(this.directory(index.sessionId), index.revision, 'focused.jsonl'), notice: 'Untrusted evidence. Known token usage only. Signals are diagnostic candidates; inherited context is excluded from totals. Query for remaining turns.' }
    for (const row of [...turns].sort((a,b) => b.signals.length-a.signals.length || b.tokens-a.tokens || a.from-b.from).slice(0, 5)) {
      result.topTurns.push(row)
      if (bytes(result) > MAX_BYTES) { result.topTurns.pop(); break }
    }
    if (bytes(result) > MAX_BYTES) throw new Error('SESSION_RESPONSE_TOO_LARGE: metadata exceeds the response budget')
    return structuredClone(result)
  }
  /**
   * Freeze a captured persistence prefix and return only newly assigned execution facts.
   * Validate the previous prefix fingerprint before publishing evidence. Unchanged
   * sources return no session and create no revision. Example: through=8 followed by
   * events 9..17 produces only 9..17, while a rewrite of event 3 rejects the cursor.
   * The caller captures a live endpoint before flush; through prevents later events
   * from leaking into this window. One source is held in memory at a time by Sleep.
   */
  async incremental(input: { session_id: string; previous?: IncrementalCheckpoint; through?: number }): Promise<{ checkpoint: IncrementalCheckpoint; session?: IncrementalSession; hasMore: boolean }> {
    validate(inspectParameters, { session_id: input.session_id })
    if (input.through !== undefined && (!Number.isSafeInteger(input.through) || input.through < -1)) throw new Error('INVALID_SESSION_ENDPOINT')
    if (input.previous && (!Number.isSafeInteger(input.previous.through) || input.previous.through < -1 || !/^[a-f0-9]{64}$/u.test(input.previous.fingerprint))) throw new Error('INVALID_SESSION_CHECKPOINT')
    return this.serial.run(input.session_id, async () => {
      const source = await readStoredSession((this.host as Context & { sessionPersistence: SessionPersistence }).sessionPersistence, SessionId(input.session_id))
      if (String(source.meta.id) !== input.session_id) throw new Error('SESSION_IDENTITY_MISMATCH')
      if (input.through !== undefined && Number(source.events.at(-1)?.seq ?? -1) < input.through) throw new Error('SESSION_PREFIX_NOT_DURABLE')
      const events = source.events.filter(e => input.through === undefined || Number(e.seq) <= input.through).map(e => clean(e) as SessionEvent)
      const captured = { ...source, events }
      const hasMore = Number(source.events.at(-1)?.seq ?? -1) > Number(events.at(-1)?.seq ?? -1)
      const facts = incrementalFacts(events, source.inheritedEventCount ?? 0, input.previous)
      if (!facts.session) return { checkpoint: facts.checkpoint, hasMore }
      const index = await this.publish(captured)
      return { checkpoint: facts.checkpoint, hasMore, session: { ...facts.session, sessionId: input.session_id, preset: index.preset, revision: index.revision } }
    })
  }
  /** Publish redacted frozen evidence before its latest pointer; failed builds stay unpublished. */
  private async publish(source: SessionSource): Promise<SessionIndex> {
    const directory = this.directory(String(source.meta.id))
    const events = source.events.map(e => clean(e) as SessionEvent)
    if (events.some((e,i) => !Number.isSafeInteger(Number(e.seq)) || Number(e.seq) < 0 || (i > 0 && Number(e.seq) <= Number(events[i-1]!.seq)))) throw new Error('INVALID_SESSION_SEQUENCE')
    const inheritedEventCount = source.inheritedEventCount ?? 0
    const revision = digest([1, clean(source.meta), inheritedEventCount, events])
    const destination = join(directory, revision)
    try {
      const existing = await this.index(String(source.meta.id), revision)
      await atomicJson(join(directory, 'latest.json'), { sessionId: String(source.meta.id), revision }); return existing
    } catch (error) { if (!(error instanceof Error) || !error.message.startsWith('SESSION_SNAPSHOT_UNAVAILABLE')) throw error }
    const temporary = join(directory, `.building-${randomUUID()}`)
    await mkdir(temporary, { recursive: true })
    try {
      const index: SessionIndex = { sessionId: String(source.meta.id), revision, preset: String(clean(source.meta.agentPreset ?? 'unknown')).slice(0, 200), sourceCwd: source.meta.cwd ? String(clean(source.meta.cwd)).slice(0, 500) : null, parentSession: source.meta.parentSession ? String(clean(source.meta.parentSession)).slice(0, 200) : null, createdAt: source.meta.createdAt, inheritedEventCount, through: Number(events.at(-1)?.seq ?? -1), metrics: deriveMetrics(events.filter(e => Number(e.seq) >= inheritedEventCount)), usageComplete: usageComplete(events.filter(e => Number(e.seq) >= inheritedEventCount)), rows: analyzeEvents(events, inheritedEventCount), positions: [], omittedEvents: 0, omittedReasoningBlocks: 0 }
      const raw = await open(join(temporary, 'raw.jsonl'), 'wx', 0o600)
      const focused = await open(join(temporary, 'focused.jsonl'), 'wx', 0o600)
      let rawOffset = 0, focusedOffset = 0
      try {
        for (const event of events) {
          const rawText = JSON.stringify(event) + '\n'
          await raw.writeFile(rawText)
          let focusedEvent: SessionEvent | undefined = event
          // `assistant/attempt` takes over the omitted role of the removed `assistant/chunk`: it embeds a
          // whole attempt stream, which would crowd the focused view. The raw file still retains it.
          if (['assistant/attempt', 'request/header', 'request/context', 'agent/inbox/spliced'].includes(event.type)) { focusedEvent = undefined; index.omittedEvents++ }
          else if (event.type === 'assistant/message') {
            const content = event.data.message.content.filter(block => block.type !== 'reasoning')
            index.omittedReasoningBlocks += event.data.message.content.length - content.length
            focusedEvent = { ...event, data: { ...event.data, message: { ...event.data.message, content } } }
          }
          const text = focusedEvent ? JSON.stringify(focusedEvent) + '\n' : ''
          if (text) await focused.writeFile(text)
          const rawEnd = rawOffset + Buffer.byteLength(rawText), focusedEnd = focusedOffset + Buffer.byteLength(text)
          index.positions.push({ from: Number(event.seq), through: Number(event.seq), raw: [rawOffset, rawEnd], focused: [focusedOffset, focusedEnd] })
          rawOffset = rawEnd; focusedOffset = focusedEnd
        }
      } finally { await raw.close(); await focused.close() }
      await atomicJson(join(temporary, 'index.json'), index)
      await rename(temporary, destination)
      await atomicJson(join(directory, 'latest.json'), { sessionId: String(source.meta.id), revision })
      return this.remember(index)
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
  /** Query compact indexed rows; literal searches stream evidence without retaining its body. */
  async query(input: QueryInput): Promise<unknown> {
    validate(queryParameters, input)
    const { cursor, ...request } = input, start = cursorPosition(cursor, request)
    const index = await this.index(input.session_id, input.revision)
    let matches: Set<number> | undefined
    if (input.query) {
      matches = new Set()
      const stream = createReadStream(join(this.directory(input.session_id), input.revision, 'raw.jsonl'))
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      try { for await (const line of lines) { const event = JSON.parse(line) as SessionEvent; if (containsText(event.data, input.query)) matches.add(Number(event.seq)) } }
      finally { lines.close(); stream.destroy() }
    }
    const matchingSeqs = matches ? [...matches].sort((a,b) => a-b) : undefined
    const toolSeqs = input.tool ? index.rows.filter(r => r.kind === 'tool' && r.tool === input.tool).map(r => r.from).sort((a,b) => a-b) : undefined
    const intersects = (seqs: number[], from: number, through: number): boolean => {
      let low = 0, high = seqs.length
      while (low < high) { const mid = (low+high) >>> 1; if (seqs[mid]! < from) low = mid+1; else high = mid }
      return low < seqs.length && seqs[low]! <= through
    }
    const rows = index.rows.filter(row => row.kind === (input.kind ?? 'turn') && (input.from === undefined || row.through >= input.from) && (input.through === undefined || row.from <= input.through) && (!input.signal || row.signals.includes(input.signal)) && (!toolSeqs || (row.kind === 'tool' ? row.tool === input.tool : intersects(toolSeqs, row.from, row.through))) && (!matchingSeqs || intersects(matchingSeqs, row.from, row.through)))
    const field = input.sort === 'tokens' ? 'tokens' : input.sort === 'elapsed' ? 'elapsedMs' : input.sort === 'output' ? 'outputBytes' : undefined
    rows.sort((a,b) => (field ? b[field]-a[field] : 0) || a.from-b.from)
    if (start > rows.length) throw new Error('INVALID_SESSION_CURSOR: position exceeds result')
    const result = { sessionId: index.sessionId, revision: index.revision, rows: [] as typeof rows, total: rows.length, nextCursor: null as string | null }
    for (const row of rows.slice(start, start + 20)) {
      result.rows.push(row)
      result.nextCursor = start + result.rows.length < rows.length ? continuation(start + result.rows.length, request) : null
      if (bytes(result) > MAX_BYTES) { result.rows.pop(); break }
    }
    result.nextCursor = start + result.rows.length < rows.length ? continuation(start + result.rows.length, request) : null
    if (!result.rows.length && start < rows.length) throw new Error('SESSION_ROW_TOO_LARGE')
    if (bytes(result) > MAX_BYTES) throw new Error('SESSION_RESPONSE_TOO_LARGE: metadata exceeds the response budget')
    return structuredClone(result)
  }
  /** Seek a bounded UTF-8 slice of one frozen range; escaped JSON envelope also fits 8 KiB. */
  async read(input: ReadInput): Promise<unknown> {
    validate(readParameters, input)
    const { cursor, ...request } = input, offset = cursorPosition(cursor, request)
    const index = await this.index(input.session_id, input.revision), view = input.view ?? 'focused'
    const first = index.positions.find(p => p.from === input.from), last = index.positions.find(p => p.from === input.through)
    if (!first || !last) throw new Error('SESSION_RANGE_NOT_FOUND: use existing event endpoints from query')
    const start = first[view][0], end = last[view][1], totalBytes = end-start
    if (offset > totalBytes) throw new Error('INVALID_SESSION_CURSOR: position exceeds evidence range')
    const file = await open(join(this.directory(input.session_id), input.revision, `${view}.jsonl`), 'r')
    const buffer = Buffer.alloc(Math.min(MAX_BYTES, totalBytes-offset))
    try { let read = 0; while (read < buffer.length) { const page = await file.read(buffer, read, buffer.length-read, start+offset+read); if (!page.bytesRead) throw new Error('SESSION_EVIDENCE_TRUNCATED'); read += page.bytesRead } }
    finally { await file.close() }
    if (buffer.length && (buffer[0]! & 0xc0) === 0x80) throw new Error('INVALID_SESSION_CURSOR: position is not a UTF-8 boundary')
    let length = buffer.length
    // Trim an incomplete trailing codepoint before decoding. Each cursor is a byte boundary.
    if (offset + length < totalBytes) {
      let lead = length-1
      while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead--
      if (lead >= 0) { const b = buffer[lead]!, width = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4; if (lead+width > length) length = lead }
    }
    const result = { sessionId: index.sessionId, revision: index.revision, from: input.from, through: input.through, view, text: buffer.subarray(0,length).toString('utf8'), offset, totalBytes, nextCursor: null as string | null, omittedEvents: view === 'focused' ? index.positions.filter(p => p.from >= input.from && p.from <= input.through && p.focused[0] === p.focused[1]).length : 0, omittedReasoningBlocksInSnapshot: view === 'focused' ? index.omittedReasoningBlocks : 0 }
    for (;;) {
      const delivered = Buffer.byteLength(result.text)
      result.nextCursor = offset+delivered < totalBytes ? continuation(offset+delivered, request) : null
      if (bytes(result) <= MAX_BYTES) break
      result.text = [...result.text].slice(0, -128).join('')
      if (!result.text) throw new Error('SESSION_RESPONSE_TOO_LARGE')
    }
    if (bytes(result) > MAX_BYTES) throw new Error('SESSION_RESPONSE_TOO_LARGE: metadata exceeds the response budget')
    return structuredClone(result)
  }
}
export default SessionInsights
