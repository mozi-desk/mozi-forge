/**
 * Purpose: Install pain tools on every created Agent and consume public session events.
 * Example: a complete custom persona still receives pain_submit's behavioral description.
 * Startup subscribes before replay; checkpoint cursors deduplicate concurrently arriving events.
 * All disk effects belong to PainEngine/Collector under DSH_HOME/pains. Disposal drains work.
 */
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionId, SessionLogOffset, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { PainEngine } from './engine.js'
import { Collector } from './collector.js'
import { submitParameters, listParameters, readParameters } from './contracts.js'
import { painPrompt } from './prompt.js'
import type { Source } from './types.js'
export const name = 'mozi-agent-pain-host'
export interface Config {
  projectRoot: string
}
export const Config: z<Config> = z.object({ projectRoot: z.string().required() })
declare module '@deepseek-ai/cordis' {
  interface Context {
    pains: PainService
  }
}
export const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue
export const output = {
  schema: { type: 'json' as const },
  render: (_: unknown, v: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(v) }],
}
export function sourceOf(agent: Agent, callId?: string): Source {
  const events = agent.session.snapshotEvents()
  const turn = events.findLast((e) => e.type === 'turn/start')
  return {
    sessionId: String(agent.session.id),
    agentId: String(agent.id),
    agentPreset: typeof agent.session.header.agentPreset === 'string' ? agent.session.header.agentPreset : null,
    turnId: turn?.type === 'turn/start' ? String(turn.data.turn) : '0',
    eventSeq: Number(events.at(-1)?.seq ?? 0),
    ...(callId ? { toolCallId: callId } : {}),
  }
}
export class PainService extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence']
  static Config = Config
  readonly engine: PainEngine
  readonly collector: Collector
  readonly ready: Promise<void>
  private pending: Promise<unknown> = Promise.resolve()
  constructor(
    private host: Context,
    config: Config,
  ) {
    super(host, 'pains')
    const root = join(resolve(process.env.DSH_HOME ?? join(config.projectRoot, '.runtime')), 'pains')
    const initialEndpoints = new Map(host.sessions.list().map(session => [String(session.id), Number(session.snapshotEvents().at(-1)?.seq ?? -1)]))
    this.engine = new PainEngine(root)
    this.collector = new Collector(root, this.engine, async () => {
      const result = []
      for (const row of await this.persistence().list()) {
        const saved = await this.persistence().readFrom(SessionId(row.id), SessionLogOffset(0))
        const captured = initialEndpoints.get(String(row.id))
        const through = captured ?? (host.sessions.get(SessionId(row.id)) ? -1 : Number(saved.events.at(-1)?.seq ?? -1))
        result.push({ sessionId: String(row.id), through })
      }
      return result
    })
    host.on('agent/created', ({ agent }) => this.install(agent))
    host.on('session/event', (session, event) => {
      if (
        !['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message'].includes(
          event.type,
        ) &&
        !(event.type === 'assistant/chunk' && event.data.chunk.type === 'usage')
      )
        return
      this.pending = this.pending
        .then(() => this.ready)
        .then(() => this.consume(session))
        .catch(() => {
          host.logger.warn('PAIN_COLLECTION_FAILED: replay required')
        })
    })
    this.ready = this.recover()
    void this.ready.catch(() => host.logger.warn('PAIN_STARTUP_FAILED'))
    host.effect(() => async () => {
      await this.pending
      await this.ready.catch(() => undefined)
    })
  }
  private persistence() {
    return this.host.get('sessionPersistence') as unknown as {
      list(): Promise<
        Array<{
          id: string
        }>
      >
      readFrom(
        id: SessionId,
        offset: SessionLogOffset,
      ): Promise<{
        events: readonly SessionEvent[]
        meta?: {
          agentPreset?: string
        }
        inheritedEventCount?: number
      }>
    }
  }
  /** Read only checkpoint suffixes; persisted metadata supplies grouping and fork exclusion. */
  private async recover() {
    await this.engine.ready
    await this.collector.ready
    for (const row of await this.persistence().list()) {
      const cursor = await this.collector.cursor(String(row.id))
      const saved = await this.persistence().readFrom(SessionId(row.id), SessionLogOffset(cursor + 1))
      await this.collector.consume(
        { sessionId: String(row.id), agentId: String(row.id), agentPreset: saved.meta?.agentPreset ?? null },
        saved.events,
        Number(saved.inheritedEventCount ?? 0) - 1,
      )
    }
  }
  private async consume(session: Session) {
    const cursor = await this.collector.cursor(String(session.id))
    const events = session.snapshotEvents(SessionLogOffset(cursor + 1))
    if (!events.length) return
    if (!(await this.host.sessions.flush(session))) throw new Error('PAIN_PERSISTENCE_REQUIRED')
    await this.collector.consume(
      {
        sessionId: String(session.id),
        agentId: String(session.id),
        agentPreset: typeof session.header.agentPreset === 'string' ? session.header.agentPreset : null,
      },
      events,
      Number(session.inheritedEventCount) - 1,
    )
  }
  /** Scoped registration relies on public ToolRuntime and keeps source identity Host-owned. */
  private install(agent: Agent) {
    const tools = agent.ctx.get('tools')
    if (!tools) throw new Error('Pain tools require ToolRuntime')
    tools.register(
      defineTool({
        name: 'pain_list',
        description: `Find similar pains before submitting. ${painPrompt}`,
        parameters: listParameters,
        output,
        execute: async (args) => {
          await this.ready
          return json(await this.engine.list(args))
        },
      }),
    )
    tools.register(
      defineTool({
        name: 'pain_read',
        description:
          'Read paginated untrusted pain evidence. Concatenate jsonFragment rows by kind and sequence to reconstruct long entries.',
        parameters: readParameters,
        output,
        execute: async (args) => {
          await this.ready
          return json(await this.engine.read(args))
        },
      }),
    )
    tools.register(
      defineTool({
        name: 'pain_submit',
        description: painPrompt,
        parameters: submitParameters,
        output,
        execute: async (args, exec) => {
          await this.ready
          const source = sourceOf(agent, String(exec.callId))
          return json(await this.engine.submit(args, source, `agent:${agent.id}:${source.turnId}:${exec.callId}`))
        },
      }),
    )
  }
}
export default PainService
