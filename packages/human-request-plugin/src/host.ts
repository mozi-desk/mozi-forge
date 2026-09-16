/**
 * Purpose: Persist one JSON file per human request and deliver answers to its session.
 * Flow: tools submit/read Markdown; the browser responds through RPC; answers are
 * saved before delivery. Session event markers make replay after interruption safe.
 * Example: proposal-review q1 is answered, then its owner resumes with that answer.
 * Recovery: an offline owner receives the saved answer when its Agent is restored.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'
import { humanRequestParameters, parseHumanRequest } from './input.js'
import type { HumanRequest, HumanRequestListInput, HumanRequestSubmitInput, MergeSnapshot } from './types.js'
export const name = 'mozi-human-request-host'
export interface Config { projectRoot: string }
export const Config: z<Config> = z.object({ projectRoot: z.string().required() })
declare module '@deepseek-ai/cordis' { interface Context { humanRequests: HumanRequestService } interface Events { 'human-request/answered'(request: HumanRequest): Promise<void> } }
export function safeId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}$/u.test(id)) throw new Error('Invalid record id')
  return id
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
  await rename(temporary, path)
}
const output = { schema: { type: 'json' as const }, render: (_: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue

export class HumanRequestService extends Service {
  static inject = ['connection', 'agents']
  static Config = Config
  private root: string
  private queues = new Map<string, Promise<unknown>>()
  constructor(private host: Context, config: Config) {
    super(host, 'humanRequests')
    this.root = join(resolve(process.env.DSH_HOME ?? join(config.projectRoot, '.runtime')), 'human-requests')
    host.inject(['connection', 'webServer'], connectionContext => connectionContext.connection.rpc.handle('/mozi-human-requests', async (endpoint, payload) => {
      try {
        const input = payload as { id: string; body: string } & HumanRequestListInput
        if (endpoint === 'list') return { ok: true, value: await this.list(input) }
        if (endpoint === 'read') return { ok: true, value: await this.read(input.id) }
        if (endpoint === 'respond') return { ok: true, value: await this.respond(input.id, input.body) }
        throw new Error('Unknown human request operation')
      } catch (error) { return { ok: false, error: { code: 'internal' as const, message: String(error), details: {} } } }
    }))
    host.on('agent/created', ({ agent }) => {
      const tools = agent.ctx?.get('tools')
      tools?.register(defineTool({ name: 'human_request_submit', description: 'Ask a human using Markdown. Use training-merge to request approval of a saved Git snapshot.', parameters: humanRequestParameters, output,
        execute: async args => { const request = await this.submit(args, agent); return json({ id: request.id, type: request.type, status: request.status, planId: request.planId }) },
      }))
      tools?.register(defineTool({ name: 'human_request_read', description: 'Read an owned request or list requests for this session and optional plan.', parameters: { id: { type: 'string' }, plan_id: { type: 'string' } }, output,
        execute: async args => {
          if (!args.id) return json((await this.list({ sessionId: String(agent.id), ...(args.plan_id ? { planId: args.plan_id } : {}) })).map(r => ({ id: r.id, type: r.type, title: r.title, status: r.status, response: r.response })))
          const request = await this.read(args.id)
          if (request.sessionId !== String(agent.id)) throw new Error('Request belongs to another session')
          return json(request)
        },
      }))
      void this.recover(agent).catch(error => host.logger.warn('human answer recovery: %s', String(error)))
    })
  }
  /** Validate and save a question. Merge requests capture the exact reviewable Git tree. */
  async submit(raw: HumanRequestSubmitInput, owner: Agent | string): Promise<HumanRequest> {
    const input = parseHumanRequest(raw)
    const sessionId = typeof owner === 'string' ? owner : String(owner.id)
    const id = safeId(input.requestId ?? randomUUID())
    return this.serial(id, async () => {
      const existing = await this.read(id).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return undefined })
      if (existing) {
        if (existing.sessionId !== sessionId || existing.type !== (input.type ?? 'question') || existing.planId !== input.planId || (input.title !== undefined && existing.title !== input.title) || (input.checks !== undefined && JSON.stringify(existing.merge?.checks) !== JSON.stringify(input.checks)) || (existing.type === 'training-merge' ? existing.body.split('\n\n## 合入快照')[0] !== input.body : existing.body !== input.body)) throw new Error('Request id conflict')
        return existing
      }
      const request: HumanRequest = { id, sessionId, type: input.type ?? 'question', title: input.title ?? input.body.slice(0, 80), body: input.body, status: 'pending', createdAt: new Date().toISOString(), ...(input.planId ? { planId: safeId(input.planId) } : {}) }
      if (request.type === 'training-merge') {
        if (!request.planId) throw new Error('training-merge requires planId')
        const trainer = this.host.get('trainers') as unknown as { snapshot(id: string, owner: string, branch?: string, checks?: string[]): Promise<{ merge: MergeSnapshot; body: string }> } | undefined
        if (!trainer) throw new Error('Trainer service unavailable')
        const snapshot = await trainer.snapshot(request.planId, sessionId, input.targetBranch, input.checks)
        request.merge = snapshot.merge
        request.body += snapshot.body
      }
      await this.save(request)
      return request
    })
  }
  async read(id: string): Promise<HumanRequest> { return JSON.parse(await readFile(join(this.root, safeId(id) + '.json'), 'utf8')) as HumanRequest }
  async list(input: HumanRequestListInput = {}): Promise<HumanRequest[]> {
    const names = await readdir(this.root).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return [] })
    const records = (await Promise.all(names.filter(n => n.endsWith('.json')).map(n => this.read(n.slice(0, -5))))).filter(r => typeof r.id === 'string' && typeof r.createdAt === 'string' && (r.status === 'pending' || r.status === 'answered'))
    return records.filter(r => (!input.status || r.status === input.status) && (!input.sessionId || r.sessionId === input.sessionId) && (!input.planId || r.planId === input.planId)).sort((a,b) => b.createdAt.localeCompare(a.createdAt))
  }
  /** Browser-only answer entry. Identical retries are safe; different second answers fail. */
  async respond(id: string, body: string): Promise<HumanRequest> {
    if (typeof body !== 'string' || !body.trim()) throw new Error('Answer is required')
    return this.serial(id, async () => {
      const request = await this.read(id)
      if (request.response && request.response.body !== body) throw new Error('Request already answered')
      request.status = 'answered'
      request.response ??= { body, answeredAt: new Date().toISOString() }
      await this.save(request)
      await this.host.parallel('human-request/answered', request)
      await this.deliverAnswer(request)
      return request
    })
  }
  /** Host-owned metadata shares the request file; tools cannot set answers or snapshots. */
  async save(request: HumanRequest): Promise<void> { await atomicJson(join(this.root, safeId(request.id) + '.json'), request) }
  private async deliverAnswer(request: HumanRequest, agent?: Agent): Promise<void> {
    if (!request.response || request.deliveredAt) return
    if (await this.deliverNotice(request.sessionId, `human-answer:${request.id}`, request.response.body, true, agent)) {
      request.deliveredAt = new Date().toISOString()
      await this.save(request)
    }
  }
  /** Use durable session markers for notification deduplication without another record store. */
  async deliverNotice(sessionId: string, eventId: string, summary: string, autoContinue: boolean, supplied?: Agent): Promise<boolean> {
    const agent = supplied ?? this.host.agents.get(SessionId(sessionId))
    if (!agent) return false
    const marker = `Event: ${eventId}`
    const seen = agent.session.snapshotEvents().some(event => (event.type === 'user/message' || event.type === 'agent/inbox/spliced') && JSON.stringify(event.data).includes(marker))
    if (!seen) {
      const message = createUserMessage({ content: [{ type: 'text', text: `${summary}\n${marker}` }], source: { kind: 'plugin', plugin: name, form: 'notice', summary: boundContextSummary(summary) } })
      if (autoContinue && (agent.status === 'idle' || eventId.startsWith('human-answer:'))) agent.followup(message)
      else agent.inject(message)
    }
    const sessions = this.host.get('sessions')
    const live = sessions?.get(SessionId(sessionId))
    if (live) await sessions!.flush(live)
    return true
  }
  private async recover(agent: Agent): Promise<void> {
    for (const request of await this.list({ sessionId: String(agent.id), status: 'answered' })) await this.serial(request.id, () => this.deliverAnswer(request, agent))
  }
  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(action)
    this.queues.set(id, next)
    try { return await next } finally { if (this.queues.get(id) === next) this.queues.delete(id) }
  }
}
export default HumanRequestService
