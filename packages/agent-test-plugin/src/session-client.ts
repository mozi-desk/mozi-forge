import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type {
  SessionCreateRequest, SessionCreateValue, SessionFollowFrame,
  SessionPage, SessionPromptRequest, SessionPromptValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { decodeStorageRecord } from '@deepseek-ai/dsh-session/chunk-rows'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

type Snapshot = Extract<SessionFollowFrame, { type: 'snapshot' }>
type Reply<T> = { result: { ok: true; value: T } }

/** Startup URLs are credentials and must not enter diagnostic artifacts. */
export function redactLaunchCredentials(text: string): string {
  return text.replace(/([?&]token=)[^&\s]+/gu, '$1[redacted]')
}

/** Node transport for the Session Controller's public Remote endpoints. */
export class HarnessSessionClient {
  private cookie: string | undefined
  constructor(private readonly origin: string, private readonly timeoutMs = 30_000) {}

  /** Exchange the child process's startup URL; retain its cookie only in memory. */
  async authenticate(launchUrl: string, signal?: AbortSignal): Promise<void> {
    const url = new URL(launchUrl)
    if (url.origin !== this.origin || url.pathname !== '/' || !url.searchParams.has('token')) {
      throw new Error('Expected the child Harness authenticated startup URL')
    }
    const response = await fetch(url, { redirect: 'manual', signal: this.deadline(signal) })
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    if (response.status !== 303 || cookie.length === 0) throw new Error('Harness startup authentication failed')
    this.cookie = cookie
  }

  /** Authenticated HTTP on this child's origin, including plugin RPC channels. */
  fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin) throw new Error('Harness requests must stay on the child origin')
    const headers = new Headers(init?.headers)
    if (this.cookie !== undefined) headers.set('cookie', this.cookie)
    return fetch(url, { ...init, headers, signal: this.deadline(init?.signal ?? undefined) })
  }

  readonly sessions = {
    create: (request: SessionCreateRequest, signal?: AbortSignal): Promise<Reply<SessionCreateValue>> =>
      this.call('session/create', request, signal),
    prompt: (request: Omit<SessionPromptRequest, 'requestId'>, signal?: AbortSignal): Promise<Reply<SessionPromptValue>> =>
      this.call('session/prompt', { ...request, requestId: randomUUID() }, signal),
    history: async (request: { sessionId: SessionId; maxMessages: number }, signal?: AbortSignal): Promise<Reply<{ events: { event: SessionEvent }[] }>> => {
      const deadline = this.deadline(signal)
      const snapshot = await this.snapshot(request, deadline)
      let records = [...snapshot.records]
      let hasMore = snapshot.hasMore
      while (hasMore) {
        const beforeSeq = records[0]?.event.seq
        if (beforeSeq === undefined) throw new Error('Session history page is empty but hasMore is true')
        const page = await this.call<SessionPage>('session/page', {
          address: { kind: 'session', sessionId: request.sessionId },
          throughSeq: snapshot.cursor,
          beforeSeq,
          maxMessages: request.maxMessages,
        }, deadline)
        if ((page.result.value.records[0]?.event.seq ?? beforeSeq) >= beforeSeq) throw new Error('Session history pagination made no progress')
        records = [...page.result.value.records, ...records]
        hasMore = page.result.value.hasMore
      }
      const events = records.flatMap(({ event }) => decodeStorageRecord(
        event.type.startsWith('chunkrow/')
          ? { type: event.type.slice('chunkrow/'.length), seq0: event.seq, time0: event.time, data: event.data }
          : event,
      )).map(event => ({ event }))
      return { result: { ok: true, value: { events } } }
    },
  }

  private deadline(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  }

  private async call<T>(endpoint: string, request: unknown, signal?: AbortSignal): Promise<Reply<T>> {
    const rpcId = randomUUID()
    const response = await this.fetch(`/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: { request } } }),
      signal: this.deadline(signal),
    })
    if (!response.ok) throw new Error(`${endpoint}: HTTP ${String(response.status)}`)
    const envelope = await response.json() as {
      type: string; rpcId: string;
      result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
    }
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error(`${endpoint}: invalid RPC response`)
    if (!envelope.result.ok) throw new Error(`${endpoint}: ${envelope.result.error.code}: ${envelope.result.error.message}`)
    return { result: envelope.result }
  }

  private snapshot(request: { sessionId: SessionId; maxMessages: number }, signal: AbortSignal): Promise<Snapshot> {
    signal.throwIfAborted()
    const url = new URL('/api/remote.mux', this.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, { headers: this.cookie === undefined ? {} : { cookie: this.cookie } })
    const streamId = randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, value?: Snapshot): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', aborted)
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }))
        socket.close()
        if (error !== undefined) reject(error)
        else resolve(value!)
      }
      const aborted = (): void => { finish(signal.reason instanceof Error ? signal.reason : new Error('Session history cancelled')) }
      signal.addEventListener('abort', aborted, { once: true })
      socket.addEventListener('open', () => {
        if (settled) { socket.close(); return }
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: {
          address: { kind: 'session', sessionId: request.sessionId }, maxMessages: request.maxMessages,
        } } } }))
      })
      socket.addEventListener('message', (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as { type: string; streamId: string; value?: Snapshot; error?: { code: string; message: string } }
          if (frame.streamId !== streamId) throw new Error('Session history stream identity mismatch')
          if (frame.type === 'error') throw new Error(`session/follow: ${frame.error?.code}: ${frame.error?.message}`)
          if (frame.type !== 'item' || frame.value?.type !== 'snapshot' || !Array.isArray(frame.value.records)) throw new Error('Session history stream did not open with a snapshot')
          finish(undefined, frame.value)
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
      })
      socket.addEventListener('error', () => finish(new Error('Session history WebSocket failed')))
      socket.addEventListener('close', () => finish(new Error('Session history WebSocket closed before snapshot')))
      if (signal.aborted) aborted()
    })
  }
}
