/**
 * Purpose: Read stored session logs through the Harness 0.1.5 persistence handle API.
 *
 * Harness 0.1.5 replaced `SessionPersistence.readFrom()` and header-valued `list()` with a per-session
 * storage handle: `open(id, 'read')` observes one stored log without taking write ownership, and
 * `handle.read(offset, length)` returns a contiguous slice of it. The session header and the
 * fork-inherited prefix length travel on that handle instead of on the read result. These helpers keep
 * the older `{ id }` and `{ meta, inheritedEventCount, events }` shapes, so plugins that consume session
 * facts keep reading the same values and depend on one reviewed adapter rather than on the transport
 * change itself.
 *
 * A read handle is always closed, including when the read rejects. Callers therefore never hold a
 * handle open across their own work, and a session that is missing or unreadable rejects instead of
 * yielding an empty log.
 *
 * Example:
 * Input: session `session-1` holds events 0..17, is not a seeded fork, and the caller asks from 9.
 * Process: `open('session-1', 'read')` yields a handle whose `header.id` is `session-1` and whose
 *   `inheritedEventCount` is `0`; `handle.read(9)` returns events 9..17; `close()` releases the handle.
 * Result: `{ meta: <session-1 header>, inheritedEventCount: 0, events: [9..17] }`.
 *
 * Edge-case Example:
 * Input: the same call for a session id no backend stores.
 * Process: `open` rejects before any slice is read, so the `finally` block closes a handle that was
 *   never returned and the rejection propagates unchanged.
 * Result: the caller sees the backend's not-found failure rather than an empty event list.
 */
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

/** The persistence surface these helpers require; re-exported so consumers need no direct dependency on it. */
export type { SessionPersistence }

/** One stored session's identity, as consumed by plugins that only need to address the session. */
export interface StoredSessionSummary {
  readonly id: string
  readonly header: SessionHeader
}

/** One stored session read, in the shape callers used before the handle API. */
export interface StoredSessionRead {
  readonly meta: SessionHeader
  readonly inheritedEventCount: number
  readonly events: readonly SessionEvent[]
}

/**
 * List every stored session visible to this process.
 *
 * Logic:
 * 1. Ask the persistence backend for one snapshot per stored session.
 * 2. Project each snapshot to its string session id plus the header that carries the rest of the
 *    identity, so callers address sessions exactly as they did when `list()` returned headers.
 *
 * @param persistence - the host session persistence service.
 * @returns one summary per stored session, in the backend's own order.
 */
export async function listStoredSessions(persistence: SessionPersistence): Promise<readonly StoredSessionSummary[]> {
  const snapshots = await persistence.list()
  return snapshots.map(snapshot => ({ id: String(snapshot.header.id), header: snapshot.header }))
}

/**
 * Read one stored session's log from `fromSeq` onward.
 *
 * Logic:
 * 1. Open a read handle, which never takes write ownership and so works while the owning process still
 *    holds the session open for writing.
 * 2. Read the slice starting at `fromSeq`; an offset at or past the end yields an empty list.
 * 3. Return the handle's header and inherited-event count beside that slice.
 * 4. Close the handle in `finally`, so a rejected read cannot leak it.
 *
 * @param persistence - the host session persistence service.
 * @param id - the stored session to read.
 * @param fromSeq - first logical event seq to include; defaults to the whole log.
 * @returns the session header, its inherited-event count, and the requested event suffix.
 */
export async function readStoredSession(persistence: SessionPersistence, id: SessionId, fromSeq = 0): Promise<StoredSessionRead> {
  const handle: SessionHandle = await persistence.open(id, 'read')
  try {
    const { events } = await handle.read(fromSeq)
    return { meta: handle.header, inheritedEventCount: Number(handle.inheritedEventCount), events }
  } finally {
    await handle.close()
  }
}
