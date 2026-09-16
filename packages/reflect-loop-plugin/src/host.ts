/**
 * Purpose: Deliver identified reflection tasks using public Harness Agent/session APIs.
 * Example: restart resumes trainer-reflect-loop-X; its initial inbox message is reused.
 * A running handle is left alone; idle failed analysis receives one persisted continuation.
 * Human requests pause continuation. Completion facts drive pain resolution after merges.
 */
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MessageId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@mozi-forge/agent-pain-plugin/host'
import type {} from '@mozi-forge/trainer-agent/host'
import type {} from '@mozi-forge/human-request-plugin/host'
import z from '@deepseek-ai/schemastery'
import { ReflectEngine } from './engine.js'
import type { ReflectRecord } from './types.js'
export const name = 'mozi-reflect-loop-host'
export interface Config {
  projectRoot: string
}
export const Config: z<Config> = z.object({ projectRoot: z.string().required() })
declare module '@deepseek-ai/cordis' {
  interface Context {
    reflectLoop: ReflectService
  }
}
export class ReflectService extends Service {
  static inject = [
    'pains',
    'trainers',
    'agents',
    'sessions',
    'sessionPersistence',
    'agentPresets',
    'agentDefaultModel',
    'humanRequests',
  ]
  static Config = Config
  readonly engine: ReflectEngine
  readonly ready: Promise<void>
  private handles = new Map<string, AgentHandle>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  constructor(
    private host: Context,
    config: Config,
  ) {
    super(host, 'reflectLoop')
    const root = resolve(config.projectRoot)
    this.engine = new ReflectEngine(
      join(resolve(process.env.DSH_HOME ?? join(root, '.runtime')), 'reflects'),
      host.pains.engine,
      { read: (id) => host.trainers.read(id), link: (id, ref) => host.trainers.linkPain(id, ref) },
      { deliver: (r) => this.deliver(root, r) },
    )
    this.ready = this.engine.ready
    void this.ready.catch(() => host.logger.warn('REFLECT_STARTUP_FAILED'))
    const remove = host.trainers.onMerged(() =>
      host.pains.engine.reconcile(async (id) => !!(await host.trainers.read(id)).merge),
    )
    this.poll()
    host.effect(() => async () => {
      this.closed = true
      remove()
      if (this.timer) clearTimeout(this.timer)
      await this.engine.close()
      for (const handle of this.handles.values()) await handle.dispose()
    })
  }
  /** Poll only to recover idle or failed analysis, respecting the live policy retry delay. */
  private poll() {
    void this.host.pains.engine.currentPolicy().then((policy) => {
      if (this.closed) return
      this.timer = setTimeout(() => {
        void this.engine
          .evaluate('startup')
          .catch(() => this.host.logger.warn('REFLECT_RETRY_FAILED'))
          .finally(() => this.poll())
      }, policy.reflection.retryDelayMs)
      this.timer.unref()
    })
  }
  /** Persist identified inbox input before waking; public turn events and requests govern continuation. */
  private async deliver(root: string, r: ReflectRecord) {
    const id = SessionId(r.trainer.sessionId)
    let agent = this.host.agents.get(id)
    if (agent) {
      const events = agent.session.snapshotEvents()
      const last = events.findLast((e) => e.type === 'turn/start' || e.type === 'turn/end')
      if (last?.type === 'turn/start') return
      const requests = await this.host.humanRequests.list({ sessionId: r.trainer.sessionId })
      if (requests.some((q) => q.status === 'pending')) return
    }
    const persistence = this.host.get('sessionPersistence') as unknown as {
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
      }>
    }
    const exists = (await persistence.list()).some((s) => String(s.id) === String(id))
    if (!agent) {
      const setup = async (ctx: Context) => {
        await this.host.agentPresets.mount(ctx, 'trainer')
      }
      const agentOptions = this.host.agentDefaultModel.currentSelection()
      const handle = exists
        ? await this.host.agents.resume({ resumeSessionId: id, setup, agentOptions })
        : await this.host.agents.create({
            sessionId: id,
            meta: { cwd: root, agentPreset: 'trainer' },
            setup,
            agentOptions,
          })
      this.handles.set(String(id), handle)
      agent = handle.agent
    }
    if ((await this.host.humanRequests.list({ sessionId: r.trainer.sessionId })).some((q) => q.status === 'pending'))
      return
    const events = agent.session.snapshotEvents()
    const consumed = events.some((e) => e.type === 'user/message' && String(e.data.id) === r.trainer.messageId)
    const lastEnd = events.findLast((e) => e.type === 'turn/end')
    const messageId = consumed ? `${r.trainer.messageId}-continue-${lastEnd?.seq ?? 0}` : r.trainer.messageId
    if (events.some((e) => e.type === 'user/message' && String(e.data.id) === messageId)) return
    const message = {
      ...createUserMessage({
        source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'Reflect on accumulated Agent pain' },
        content: [
          {
            type: 'text',
            text: consumed
              ? `Continue reflection ${r.id}. Read its saved snapshot and existing plans; finish analysis with reflect_complete. Preserve existing work and human review requirements.`
              : r.trainer.initialPrompt,
          },
        ],
      }),
      id: MessageId(messageId),
    }
    if (!agent.inbox.nextTurn.some((m) => m.id === message.id)) agent.send(message, 'next-turn', false)
    if (!(await this.host.sessions.flush(agent.session))) throw new Error('REFLECT_PERSISTENCE_REQUIRED')
    agent.inbox.remove(message.id)
    agent.followup(message)
  }
}
export default ReflectService
