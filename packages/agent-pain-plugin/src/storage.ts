/**
 * Purpose: Bound public JSON pages and read ordinary durable records.
 * Example: 30 summaries return at most 20 and an offset bound to the query and revision.
 * Oversized single rows fail explicitly; callers project bounded summaries before paging.
 */
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
export { atomicJson, redact } from '@mozi-forge/session-insights-plugin/store'
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}
export async function names(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}
export function page<T>(
  rows: T[],
  cursor?: string,
  binding = '',
): {
  items: T[]
  nextCursor: string | null
} {
  const revision = createHash('sha256')
    .update(binding + JSON.stringify(rows))
    .digest('hex')
  let offset = 0
  if (cursor) {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (
      parsed.revision !== revision ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0 ||
      parsed.offset > rows.length
    )
      throw new Error('STALE_CURSOR: restart pagination')
    offset = parsed.offset
  }
  const items: T[] = []
  while (offset < rows.length && items.length < 20) {
    const row = rows[offset]!
    if (Buffer.byteLength(JSON.stringify({ items: [...items, row] })) > 7400) {
      if (!items.length) throw new Error('ROW_TOO_LARGE')
      break
    }
    items.push(row)
    offset++
  }
  return {
    items,
    nextCursor: offset < rows.length ? Buffer.from(JSON.stringify({ revision, offset })).toString('base64url') : null,
  }
}
export const summaryText = (value: string, length = 240) =>
  value.length > length ? `${value.slice(0, length)} [truncated]` : value
