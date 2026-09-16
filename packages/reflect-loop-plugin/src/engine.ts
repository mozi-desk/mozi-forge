/**
 * Purpose: Own one durable reflection and replay its multi-file completion transaction.
 * Flow: snapshot -> claim pains -> identified Trainer delivery -> result -> links/reviews.
 * Example: crash after linking plan A replays the same result and finishes remaining pains.
 * Delivery failures retain the same Session/message identity and retry after policy delay.
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PainEngine } from '@mozi-forge/agent-pain-plugin/engine'
import { atomicJson, readJson, names, redact } from '@mozi-forge/agent-pain-plugin/storage'
import { check } from '@mozi-forge/agent-pain-plugin/contracts'
import { completeParameters, type CompleteInput } from './contracts.js'
import { reflectPrompt } from './prompt.js'
import type { ReflectRecord, Plans, Delivery } from './types.js'
export class ReflectEngine {
  private active: ReflectRecord | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stop: (() => void) | undefined
  private closed = false
  readonly ready: Promise<void>
  constructor(
    readonly root: string,
    readonly pains: PainEngine,
    private plans: Plans,
    private delivery: Delivery,
  ) {
    this.stop = pains.onChange((kind) => {
      void this.evaluate(kind).catch(() => this.retry())
    })
    this.ready = this.start()
  }
  private path(r: ReflectRecord) {
    return join(this.root, r.id, 'reflect.json')
  }
  private async save(r: ReflectRecord) {
    await atomicJson(this.path(r), r)
    this.active = r.status === 'completed' ? null : structuredClone(r)
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.ready).then(fn)
    this.queue = next.catch(() => undefined)
    return next
  }
  private async start() {
    await this.pains.ready
    for (const directory of await names(this.root)) {
      if (!directory.startsWith('reflect-loop-')) continue
      const r = await readJson<ReflectRecord>(join(this.root, directory, 'reflect.json'))
      if (!r || r.version !== 1 || !['pending', 'running', 'completed'].includes(r.status) || !Array.isArray(r.pains))
        throw new Error('REFLECT_STORAGE_INVALID')
      if (r.status !== 'completed') {
        if (this.active) throw new Error('MULTIPLE_ACTIVE_REFLECTIONS')
        this.active = r
      }
    }
    await this.pains.reconcile(async (id) => !!(await this.plans.read(id)).merge)
    if (this.active?.result) await this.applyResult(this.active)
    // Defer evaluation until ready resolves; service construction never waits on its own queue.
    queueMicrotask(() => {
      void this.evaluate('startup').catch(() => this.retry())
    })
  }
  async status() {
    await this.ready
    return this.active ? structuredClone(this.active) : null
  }
  private retry() {
    if (this.closed || this.timer) return
    void this.pains.currentPolicy().then((policy) => {
      if (this.closed || this.timer) return
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.evaluate('startup').catch(() => this.retry())
      }, policy.reflection.retryDelayMs)
      this.timer.unref()
    })
  }
  /** Snapshot all open pains under one scheduler queue; occurrences arriving later are outside its prefix. */
  async evaluate(kind: ReflectRecord['trigger']['kind']) {
    return this.serial(async () => {
      if (this.closed) return
      const policy = await this.pains.currentPolicy()
      let r = this.active ? structuredClone(this.active) : null
      if (!r) {
        const view = await this.pains.view()
        if (!policy.enabled || view.triggerableScore < policy.reflection.triggerScore) return
        const pains = (await this.pains.all()).filter((p) => p.status === 'open')
        const time = new Date().toISOString()
        const id = `reflect-loop-${time.replace(/[:.]/g, '-')}-${randomUUID()}`
        r = {
          version: 1,
          id,
          status: 'pending',
          createdAt: time,
          startedAt: null,
          completedAt: null,
          trigger: {
            kind,
            policyRevision: policy.revision,
            score: view.triggerableScore,
            threshold: policy.reflection.triggerScore,
          },
          pains: pains.map((p) => ({
            painId: p.id,
            title: p.title,
            throughOccurrence: p.occurrences.length,
            unresolvedScore: p.score.unresolved,
            triggerableScore: this.pains.triggerable(p),
          })),
          trainer: {
            sessionId: `trainer-${id}`,
            messageId: `message-${id}`,
            promptVersion: 1,
            initialPrompt: '',
            deliveryStatus: 'pending',
            attempts: 0,
            nextAttemptAt: null,
            lastError: null,
          },
          result: null,
        }
        r.trainer.initialPrompt = reflectPrompt(r, this.path(r))
        if (Buffer.byteLength(r.trainer.initialPrompt) > 16384) throw new Error('REFLECT_PROMPT_TOO_LARGE')
        await this.save(r)
      }
      if (r.result) {
        await this.applyResult(r)
        return
      }
      if (r.trainer.deliveryStatus === 'delivered' && kind !== 'startup') return
      await this.pains.claim(
        r.pains.map((p) => p.painId),
        r.id,
      )
      if (r.trainer.nextAttemptAt && Date.parse(r.trainer.nextAttemptAt) > Date.now()) {
        this.retry()
        return
      }
      r.trainer.attempts++
      await this.save(r)
      try {
        await this.delivery.deliver(structuredClone(r), this.path(r))
        r.status = 'running'
        r.startedAt ??= new Date().toISOString()
        r.trainer.deliveryStatus = 'delivered'
        r.trainer.lastError = null
        r.trainer.nextAttemptAt = null
        await this.save(r)
      } catch {
        r.trainer.lastError = 'TRAINER_DELIVERY_FAILED'
        r.trainer.nextAttemptAt = new Date(Date.now() + policy.reflection.retryDelayMs).toISOString()
        await this.save(r)
        this.retry()
      }
    })
  }
  /** Validate the entire decision batch before recording its replayable commit intent. */
  async complete(raw: CompleteInput, owner: string) {
    check(completeParameters, raw)
    return this.serial(async () => {
      let r = this.active ? structuredClone(this.active) : null
      if (!r || r.id !== raw.reflect_id) {
        r = (await readJson<ReflectRecord>(join(this.root, this.safeId(raw.reflect_id), 'reflect.json'))) ?? null
      }
      if (!r || r.id !== raw.reflect_id || r.trainer.sessionId !== owner) throw new Error('Owned reflection required')
      const decisions = raw.decisions.map((d) => ({
        painId: d.pain_id,
        throughOccurrence: d.through_occurrence,
        action: d.action,
        planIds: [...new Set(d.plan_ids ?? [])],
        reason: redact(d.reason),
        evidence: d.evidence,
      }))
      const result = { summary: redact(raw.summary), decisions }
      if (r.result) {
        if (JSON.stringify(r.result) !== JSON.stringify(result)) throw new Error('REFLECTION_RESULT_CONFLICT')
        if (r.status !== 'completed') await this.applyResult(r)
        return r
      }
      if (
        !raw.summary.trim() ||
        decisions.length !== r.pains.length ||
        new Set(decisions.map((d) => d.painId)).size !== r.pains.length
      )
        throw new Error('One decision per snapshot pain required')
      for (const d of decisions) {
        const snapshot = r.pains.find((p) => p.painId === d.painId)
        if (!snapshot || d.throughOccurrence !== snapshot.throughOccurrence || !d.reason.trim())
          throw new Error('Exact snapshot boundary and reason required')
        if (d.action === 'link_plan') {
          if (!d.planIds.length) throw new Error('Plan IDs required')
          for (const id of d.planIds) if ((await this.plans.read(id)).merge) throw new Error('Open plan required')
        } else if (d.planIds.length) throw new Error('Plan IDs only apply to link_plan')
        if (d.action === 'expected' && !d.evidence.length) throw new Error('Expected behavior requires evidence')
        for (const e of d.evidence)
          if (
            !e.sessionId.trim() ||
            !e.revision.trim() ||
            !Number.isSafeInteger(e.fromSeq) ||
            !Number.isSafeInteger(e.throughSeq) ||
            e.fromSeq < 0 ||
            e.throughSeq < e.fromSeq
          )
            throw new Error('Invalid evidence range')
      }
      r.result = result
      await this.save(r)
      await this.applyResult(r)
      queueMicrotask(() => {
        void this.evaluate('pain_received').catch(() => this.retry())
      })
      return r
    })
  }
  private safeId(id: string) {
    if (!/^reflect-loop-[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid reflection ID')
    return id
  }
  /** Apply durable intent before marking completion; every linked reference and review is idempotent. */
  private async applyResult(r: ReflectRecord) {
    for (const d of r.result!.decisions) {
      for (const id of d.planIds)
        await this.plans.link(id, { painId: d.painId, throughOccurrence: d.throughOccurrence, reflectId: r.id })
      await this.pains.review(d.painId, { ...d, reflectId: r.id, reviewedAt: r.createdAt })
    }
    r.status = 'completed'
    r.completedAt = new Date().toISOString()
    await this.save(r)
    await this.pains.reconcile(async (id) => !!(await this.plans.read(id)).merge)
  }
  async close() {
    this.closed = true
    this.stop?.()
    if (this.timer) clearTimeout(this.timer)
    await this.ready.catch(() => undefined)
    await this.queue
  }
}
