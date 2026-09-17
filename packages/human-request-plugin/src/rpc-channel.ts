/**
 * Purpose: Serve one plugin-owned Connection RPC channel on the Harness Web server.
 *
 * Harness 0.1.5 removed `webServer` from the Connection service's own dependency list, so
 * `connection.rpc.handle(channel, handler)` now fails for every caller with `cannot get property
 * "webServer" without inject`, and no 0.1.5 package still uses it. Plugins own their physical routes
 * directly instead. This adapter registers the same channel prefix, applies Connection's trust fence
 * through the still public `requestRejection`, decodes the unchanged `client-request` envelope, and
 * answers with the unchanged `server-response` envelope, so a plugin channel keeps both its published
 * URL and its wire contract.
 *
 * Flow:
 * 1. Ask Connection for its rejection status and answer 401/403 before reading any body, so an
 *    untrusted cross-site call never reaches a plugin handler.
 * 2. Accept only `POST` with `application/json`, bounded by {@link MAX_BODY_BYTES}; a larger or
 *    non-JSON body is refused without dispatching.
 * 3. Require the envelope's `method` to name the URL endpoint, then hand `(endpoint, payload)` to the
 *    plugin handler.
 * 4. Answer `{ type: 'server-response', rpcId, result }` on success and HTTP 500 when the handler
 *    throws, matching the envelope the removed `rpc.handle` produced.
 *
 * Example: `POST /mozi-human-requests/list` carrying `{ type: 'client-request', rpcId: 'r1',
 * method: 'list', payload: { status: 'pending' } }` reaches `handler('list', { status: 'pending' })`
 * and answers `{ type: 'server-response', rpcId: 'r1', result: { ok: true, value: [...] } }`.
 *
 * Edge-case Example: the same request with `method: 'respond'` dispatches nothing and answers HTTP 400,
 * because a `method` that disagrees with the endpoint cannot identify one plugin operation.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, ConnectionRpcResult, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

/** Body cap for one channel request: these channels carry small JSON envelopes, never payload blobs. */
const MAX_BODY_BYTES = 1_048_576

/** The injected Context shape a channel owner must have resolved before registering. */
export interface RpcChannelContext extends Context {
  readonly connection: HostConnectionHandle
  readonly webServer: WebServer
}

/** One decoded `client-request` envelope. */
interface ClientRequestEnvelope {
  readonly type: 'client-request'
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

/**
 * Whether a parsed body is a well-formed `client-request` envelope.
 *
 * @param value - the parsed JSON body.
 * @returns true only when the envelope names a request id and method.
 */
function isClientRequest(value: unknown): value is ClientRequestEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ClientRequestEnvelope>
  return candidate.type === 'client-request' && typeof candidate.rpcId === 'string' && typeof candidate.method === 'string'
}

/**
 * Read and parse one bounded JSON request body.
 *
 * Logic: accumulate the stream while enforcing {@link MAX_BODY_BYTES}, then parse the concatenation.
 * A request is refused as soon as it exceeds the cap, so an oversized body is never buffered whole.
 *
 * @param req - the node request whose body to read.
 * @returns either the parsed JSON value or the status and text to answer with.
 */
async function readJsonBody(req: IncomingMessage): Promise<{ ok: true, value: unknown } | { ok: false, status: number, text: string }> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) return { ok: false, status: 413, text: 'request body is too large' }
    chunks.push(buffer)
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  } catch {
    return { ok: false, status: 400, text: 'body is not JSON' }
  }
}

/**
 * Answer one request with a JSON body.
 *
 * @param res - response owning the lifecycle.
 * @param status - HTTP status to send.
 * @param body - value serialized as the response body.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/**
 * Register one authenticated RPC channel prefix owned by this plugin.
 *
 * Logic:
 * 1. Register a prefix route on the Harness Web server; the route table already holds this process's
 *    exact routes, and longest-prefix-wins keeps the channel reachable beside them.
 * 2. On each request, apply Connection's trust fence first, then enforce method and content type.
 * 3. Decode the envelope, require its `method` to equal the URL endpoint, and dispatch.
 *
 * External calls and effects: `ctx.webServer.register` publishes one physical route for the life of
 * the plugin fiber; the disposer it returns is intentionally ignored because the channel lives exactly
 * as long as the owner Context that registered it.
 *
 * @param ctx - the injected Context that resolved both `connection` and `webServer`.
 * @param channel - absolute channel prefix such as `/mozi-human-requests`.
 * @param handler - the plugin operation table, receiving the endpoint and decoded payload.
 */
export function registerRpcChannel(ctx: RpcChannelContext, channel: string, handler: ConnectionRpcHandler): void {
  ctx.webServer.register({
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (!pathname.startsWith(`${channel}/`)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
        res.end('method not allowed')
        return
      }
      if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('content type must be application/json')
        return
      }
      const body = await readJsonBody(req)
      if (!body.ok) {
        res.writeHead(body.status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(body.text)
        return
      }
      if (!isClientRequest(body.value)) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('body is not a client-request envelope')
        return
      }
      const endpoint = pathname.slice(channel.length + 1)
      if (body.value.method !== endpoint) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('envelope method does not match the endpoint')
        return
      }
      const controller = new AbortController()
      req.on('close', () => controller.abort())
      let result: ConnectionRpcResult<unknown>
      try {
        result = await handler(endpoint, body.value.payload, controller.signal)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`handler failure: ${String(error)}`)
        return
      }
      sendJson(res, 200, { type: 'server-response', rpcId: body.value.rpcId, result })
    },
  })
}
