import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

export function boundedText(text: string, bytes: number): string {
  const buffer = Buffer.from(text)
  let end = Math.min(buffer.length, bytes)
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

export function protectedPath(path: string): boolean {
  return path.split(/[\\/]/u).some(part => ['.git', '.runtime', 'node_modules'].includes(part) || part.startsWith('.env'))
}

/** Resolve through symlinks before reading, including missing final files. */
export async function containedPath(root: string, path: string): Promise<string> {
  const base = await realpath(root)
  const requested = resolve(root, path)
  const rel = relative(resolve(root), requested)
  const lexical = rel === '..' || rel.startsWith(`..${sep}`) ? requested : resolve(base, rel)
  const check = (candidate: string): void => {
    const rel = relative(base, candidate)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('path is outside the authorized root')
  }
  check(lexical)
  let ancestor = lexical
  while (true) {
    try {
      const actual = await realpath(ancestor)
      check(actual)
      return resolve(actual, relative(ancestor, lexical))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = resolve(ancestor, '..')
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
}

export interface ReadPosition { offset?: number; limit?: number; startLine?: number; lineCount?: number }

export function textPage(text: string, position: ReadPosition = {}) {
  const buffer = Buffer.from(text)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const limit = Math.min(position.limit ?? 16384, 16384)
  if (!Number.isSafeInteger(limit) || limit < 4) throw new Error('limit must be an integer from 4 to 16384')
  if (position.offset !== undefined && (position.startLine !== undefined || position.lineCount !== undefined)) throw new Error('offset and line positioning are mutually exclusive')
  let offset = position.offset ?? 0
  let stop = buffer.length
  if (position.startLine !== undefined || position.lineCount !== undefined) {
    const start = position.startLine ?? 1
    const count = position.lineCount ?? 80
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1) throw new Error('start_line and line_count must be positive integers')
    const starts = [0]
    for (let i = 0; i < buffer.length; i++) if (buffer[i] === 10) starts.push(i + 1)
    if (start > starts.length) throw new Error(`start_line exceeds total lines: ${starts.length}`)
    offset = starts[start - 1]!
    stop = starts[start - 1 + count] ?? buffer.length
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) throw new Error(`read offset exceeds the file length or is invalid; totalBytes=${buffer.length}`)
  if (offset < buffer.length && (buffer[offset]! & 0xc0) === 0x80) throw new Error('read offset must use a returned UTF-8 nextOffset boundary')
  let end = Math.min(stop, offset + limit)
  while (end > offset && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1
  return { sha256, totalBytes: buffer.length, offset, content: buffer.subarray(offset, end).toString('utf8'), truncated: end < buffer.length, ...(end < buffer.length ? { nextOffset: end } : {}) }
}

/** Cursor is bound to the complete ordered result, so changed queries cannot silently skip rows. */
export function itemPage<T>(items: readonly T[], cursor: string | undefined, metadata: Record<string, unknown> = {}, maxBytes = 8192, maxItems = 50) {
  const digest = createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16)
  let start = 0
  if (cursor !== undefined) {
    const match = /^(\d+):([a-f0-9]{16})$/u.exec(cursor)
    if (match === null || match[2] !== digest) throw new Error('stale or invalid cursor; repeat the query without cursor')
    start = Number(match[1])
    if (!Number.isSafeInteger(start) || start > items.length) throw new Error('invalid cursor offset')
  }
  const page: Array<T | { index: number; omitted: true; reason: string }> = []
  const result = { ...metadata, items: page, total: items.length, truncated: true, nextCursor: `${start}:${digest}` }
  let index = start
  for (; index < items.length && page.length < maxItems; index++) {
    page.push(items[index]!)
    result.nextCursor = `${index + 1}:${digest}`
    if (jsonBytes(result) > maxBytes) {
      page.pop()
      if (page.length > 0) break
      page.push({ index, omitted: true, reason: 'Item exceeds page budget; use the referenced record reader.' })
      if (jsonBytes(result) > maxBytes) throw new Error('page metadata exceeds output budget')
    }
  }
  result.truncated = index < items.length
  result.nextCursor = result.truncated ? `${index}:${digest}` : ''
  if (jsonBytes(result) > maxBytes) throw new Error('page metadata exceeds output budget')
  return result
}

/** Preserve binary artifacts without interpreting bytes as damaged UTF-8. */
export function artifactPage(buffer: Buffer, position: ReadPosition = {}) {
  const text = buffer.toString('utf8')
  if (!buffer.includes(0) && Buffer.from(text).equals(buffer)) return { encoding: 'utf8', ...textPage(text, position) }
  if (position.startLine !== undefined || position.lineCount !== undefined) throw new Error('binary artifacts support byte offsets only')
  const offset = position.offset ?? 0
  const limit = Math.min(position.limit ?? 16384, 16384)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length || !Number.isSafeInteger(limit) || limit < 4) throw new Error('invalid artifact byte page')
  const end = Math.min(buffer.length, offset + Math.floor(limit / 4) * 3)
  return { encoding: 'base64', totalBytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), offset, content: buffer.subarray(offset, end).toString('base64'), truncated: end < buffer.length, ...(end < buffer.length ? { nextOffset: end } : {}) }
}
