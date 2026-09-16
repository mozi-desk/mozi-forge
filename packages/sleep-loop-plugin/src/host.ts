/**
 * Purpose: Connect Sleep's durable engine to public Harness session and Agent services.
 * Model routing: read agentDefaultModel.currentSelection() for each create/resume;
 * this background entry point owns its AgentOptions independently of Web sessions.
 * Example: deployment default fixture/model-a becomes the new Trainer request route.
 * Startup reconciles persisted headers and live sessions. Each candidate captures a
 * live endpoint before flush, then Session Insights freezes that prefix. The engine
 * holds only one source body at a time. Public event listeners mark dirty IDs.
 * Example: a scheduled record creates trainer-sleep-loop-... with the trainer preset,
 * persists its identified prompt in the inbox, then wakes it. Recovery reuses that
 * session and checks public messages before attempting delivery again.
 * Disposal stops polling before disposing owned handles; no external service is restarted.
 */
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MessageId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@mozi-forge/session-insights-plugin/host'
import z from '@deepseek-ai/schemastery'
import { SleepEngine } from './engine.js'
import { sleepPrompt } from './prompt.js'
import type { Delivery, SleepRecord } from './types.js'
export const name = 'mozi-sleep-loop-host'
export interface Config { projectRoot: string }
export const Config: z<Config> = z.object({ projectRoot: z.string().required() })
declare module '@deepseek-ai/cordis' { interface Context { sleepLoop: SleepService } }
export class SleepService extends Service {
  static inject = ['sessions', 'sessionPersistence', 'sessionInsights', 'agents', 'agentPresets', 'agentDefaultModel']
  static Config = Config
  readonly ready: Promise<void>
  private readonly engine: SleepEngine
  private readonly handles = new Map<string, AgentHandle>()
  private readonly persisted = new Set<string>()
  private endpoints: Map<string, number> | undefined
  /** Register discovery before recovery so new events during the startup scan stay visible. */
  constructor(private readonly host: Context, config: Config) {
    super(host, 'sleepLoop')
    const root = resolve(config.projectRoot)
    this.engine = new SleepEngine(join(resolve(process.env.DSH_HOME ?? join(root, '.runtime')), 'sleeps'), {
      beginWindow: () => { this.endpoints = new Map(host.sessions.list().map(session => [String(session.id), Number(session.snapshotEvents().at(-1)?.seq ?? -1)])) },
      endWindow: () => { this.endpoints = undefined },
      list: async () => {
        const persistence = host.get('sessionPersistence') as unknown as { list(): Promise<Array<{ id: string }>> }
        const ids = (await persistence.list()).map(row => String(row.id))
        for (const id of ids) this.persisted.add(id)
        return [...new Set([...ids, ...host.sessions.list().map(s => String(s.id))])]
      },
      capture: async (id, previous) => {
        const session = host.sessions.get(SessionId(id))
        const through = this.endpoints?.get(id)
        if (session && !await host.sessions.flush(session)) throw new Error('SLEEP_PERSISTENCE_REQUIRED')
        return host.sessionInsights.incremental({ session_id: id, ...(previous ? { previous } : {}), ...(through !== undefined ? { through } : {}) })
      },
    }, { deliver: (record, path, delivery) => this.deliver(root, record, path, delivery), recover: (record, path, delivery) => this.deliver(root, record, path, delivery) })
    host.on('session/event', session => { try { this.engine.changed(String(session.id)) } catch { host.logger.warn('SLEEP_DISCOVERY_WRITE_FAILED') } })
    host.on('session/created', session => {
      // A resumed dormant source contributes only its persisted seed to an open window.
      if (this.endpoints && !this.endpoints.has(String(session.id))) this.endpoints.set(String(session.id), Number(session.firstLiveSeq)-1)
      this.engine.changed(String(session.id))
    })
    this.ready = this.engine.start()
    void this.ready.catch(() => host.logger.warn('SLEEP_STARTUP_FAILED'))
    host.effect(() => async () => {
      await this.ready.catch(() => undefined)
      await this.engine.close()
      for (const handle of this.handles.values()) await handle.dispose()
      this.handles.clear()
    })
  }
  async schedule(input: unknown) { await this.ready; return this.engine.schedule(input) }
  async status() { await this.ready; return this.engine.status() }
  /**
   * Create/resume one deterministic Trainer identity and persist its prompt before wake.
   * New and resumed Agents receive the live default model selection before their loop starts.
   * The non-waking send is flushed first. Replacing its pending inbox slot with the
   * same identified follow-up wakes the driver without adding a second task. A crash
   * in that small replacement interval recovers from public user/inbox events.
   * A prompt already claimed as user/message is accepted work and is not resent.
   */
  private async deliver(root: string, record: SleepRecord, path: string, delivery: Delivery): Promise<void> {
    const id = SessionId(delivery.sessionId)
    let agent = this.host.agents.get(id)
    if (!agent) {
      if (this.persisted.has(delivery.sessionId)) {
        const persistence = this.host.get('sessionPersistence') as unknown as { readFrom(id: SessionId, offset: SessionLogOffset): Promise<{ events: readonly SessionEvent[] }> }
        const saved = await persistence.readFrom(id, SessionLogOffset(0))
        if (saved.events.some(e => e.type === 'user/message' && String(e.data.id) === delivery.messageId)) return
      }
      const setup = async (ctx: Context): Promise<void> => { await this.host.agentPresets.mount(ctx, 'trainer') }
      // Resolve live deployment defaults at delivery time for both new and resumed Agents.
      const agentOptions = this.host.agentDefaultModel.currentSelection()
      const handle = this.persisted.has(delivery.sessionId)
        ? await this.host.agents.resume({ resumeSessionId: id, setup, agentOptions })
        : await this.host.agents.create({ sessionId: id, meta: { cwd: root, agentPreset: 'trainer' }, setup, agentOptions })
      this.handles.set(delivery.sessionId, handle); agent = handle.agent
    }
    if (agent.session.snapshotEvents().some(e => e.type === 'user/message' && String(e.data.id) === delivery.messageId)) return
    const message = { ...createUserMessage({ source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'Sleep Loop analysis and scheduling' }, content: [{ type: 'text', text: sleepPrompt(record, path) }] }), id: MessageId(delivery.messageId) }
    if (!agent.inbox.nextTurn.some(m => m.id === message.id)) agent.send(message, 'next-turn', false)
    if (!await this.host.sessions.flush(agent.session)) throw new Error('SLEEP_PERSISTENCE_REQUIRED')
    this.persisted.add(delivery.sessionId)
    agent.inbox.remove(message.id)
    agent.followup(message)
  }
}
export default SleepService
