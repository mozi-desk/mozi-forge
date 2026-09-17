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
import { type SessionPersistence, listStoredSessions, readStoredSession } from '@mozi-forge/session-insights-plugin/session-reader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { PainEngine } from './engine.js'
import { Collector, presetOf } from './collector.js'
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
/** Identity of the running session: the header advanced by every recorded preset selection. */
export function sourceOf(agent: Agent, callId?: string): Source {
  const events = agent.session.snapshotEvents()
  const turn = events.findLast((e) => e.type === 'turn/start')
  return {
    sessionId: String(agent.session.id),
    agentId: String(agent.id),
    agentPreset: presetOf(
      typeof agent.session.header.agentPreset === 'string' ? agent.session.header.agentPreset : null,
      events,
    ),
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
      for (const row of await listStoredSessions(this.persistence())) {
        const saved = await readStoredSession(this.persistence(), SessionId(row.id))
        const captured = initialEndpoints.get(String(row.id))
        const through = captured ?? (host.sessions.get(SessionId(row.id)) ? -1 : Number(saved.events.at(-1)?.seq ?? -1))
        result.push({ sessionId: String(row.id), through })
      }
      return result
    })
    host.on('agent/created', ({ agent }) => this.install(agent))
    host.on('session/event', (session, event) => {
      // Harness 0.1.5 removed the `assistant/chunk` event and moved token accounting onto
      // `assistant/message.usage`, which this whitelist already covers. Dropping the former
      // chunk-usage clause therefore loses no collection trigger.
      if (
        !['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message'].includes(
          event.type,
        )
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
  private persistence(): SessionPersistence {
    return this.host.get('sessionPersistence') as unknown as SessionPersistence
  }
  /** Read only checkpoint suffixes; persisted metadata supplies grouping and fork exclusion. */
  private async recover() {
    await this.engine.ready
    await this.collector.ready
    for (const row of await listStoredSessions(this.persistence())) {
      const cursor = await this.collector.cursor(String(row.id))
      const saved = await readStoredSession(this.persistence(), SessionId(row.id), cursor + 1)
      const id = String(row.id)
      await this.collector.consume(
        {
          sessionId: id,
          agentId: id,
          // Stored identity wins; otherwise advance the persisted header by this replay.
          agentPreset: (await this.collector.preset(id)) ?? presetOf(saved.meta?.agentPreset ?? null, saved.events),
        },
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
    const id = String(session.id)
    await this.collector.consume(
      {
        sessionId: id,
        agentId: id,
        // Initial value only. A stored value survives restarts; a session whose selection event
        // already sits behind the cursor is resolved from the whole log instead of this batch.
        agentPreset:
          (await this.collector.preset(id)) ??
          presetOf(
            typeof session.header.agentPreset === 'string' ? session.header.agentPreset : null,
            session.snapshotEvents(),
          ),
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
