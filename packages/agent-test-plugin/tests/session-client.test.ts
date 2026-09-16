import { once } from 'node:events'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { HarnessSessionClient } from '../src/session-client.js'

describe('Harness Session Remote transport', () => {
  it.each(['cancel', 'timeout', 'remote-error'] as const)('closes the history socket after %s', async (outcome) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP address')
    const controller = new AbortController()
    const client = new HarnessSessionClient(`http://127.0.0.1:${String(address.port)}`, outcome === 'timeout' ? 250 : 5_000)
    const closed = new Promise<void>((resolveClosed) => {
      server.once('connection', socket => {
        socket.once('close', () => resolveClosed())
        socket.once('message', data => {
          const request = JSON.parse(String(data)) as { type: string; streamId: string; endpoint: string }
          expect(request.type).toBe('open')
          expect(request.endpoint).toBe('session/follow')
          if (outcome === 'cancel') controller.abort(new Error('cancelled by caller'))
          if (outcome === 'remote-error') socket.send(JSON.stringify({
            type: 'error', streamId: request.streamId,
            error: { code: 'session/missing', message: 'session is missing', details: {} },
          }))
        })
      })
    })
    try {
      await expect(client.sessions.history({ sessionId: SessionId('missing'), maxMessages: 1 }, controller.signal))
        .rejects.toThrow(outcome === 'cancel' ? /cancelled by caller/u : outcome === 'timeout' ? /timeout/iu : /session\/missing/u)
      await closed
    } finally {
      controller.abort()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolveClose, reject) => server.close(error => error === undefined ? resolveClose() : reject(error)))
    }
  })
})
