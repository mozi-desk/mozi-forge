import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex') }
export function redact(text: string): string {
  return text.split('\n').map(line => /(?:bearer\s+\S+|authorization\s*[:=]|(?:api[_ -]?key|access[_ -]?token|secret|password)\s*["']?\s*[:=]|[?&]token=)/iu.test(line) ? '[redacted sensitive line]' : line).join('\n')
}
export function bounded(value: unknown, bytes = 4096): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  if (raw === undefined || Buffer.byteLength(raw) > bytes) throw new Error(`CONTENT_TOO_LARGE: limit ${bytes} bytes; save smaller records and references`)
  // Redact string fields before encoding structured results so the JSON remains valid.
  const safe = typeof value === 'string' ? redact(value) : JSON.stringify(value, (_key, field: unknown) => typeof field === 'string' ? redact(field) : field)
  if (Buffer.byteLength(safe) > bytes) throw new Error(`CONTENT_TOO_LARGE: limit ${bytes} bytes after redaction`)
  return safe
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}
export class Records<T> {
  constructor(readonly root: string) {}
  path(id: string): string { return join(this.root, `${Buffer.from(id).toString('base64url')}.json`) }
  async get(id: string): Promise<T> { return JSON.parse(await readFile(this.path(id), 'utf8')) as T }
  async maybe(id: string): Promise<T | undefined> {
    try { return await this.get(id) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async put(id: string, value: T): Promise<void> { await atomicJson(this.path(id), value) }
  async list(): Promise<T[]> {
    let files: string[]
    try { files = await readdir(this.root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    return Promise.all(files.filter(x => x.endsWith('.json')).sort().map(async file => JSON.parse(await readFile(join(this.root, file), 'utf8')) as T))
  }
}
export class Serial {
  private readonly queues = new Map<string, Promise<unknown>>()
  async drain(): Promise<void> { await Promise.allSettled(this.queues.values()) }
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const current = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
    this.queues.set(key, current)
    try { return await current } finally { if (this.queues.get(key) === current) this.queues.delete(key) }
  }
}
