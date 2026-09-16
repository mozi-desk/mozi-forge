/**
 * Purpose: Serialize pain and policy writes and reconstruct scores from durable occurrences.
 * Flow: validate -> persist occurrence -> notify scheduler. Reflection reviews and merge
 * receipts cover a sequence prefix; newer occurrences survive completion.
 * Example: review through 2, append 3, merge the linked plan -> occurrence 3 stays open.
 * Recovery replays the same review identity. A failed write leaves in-memory state unchanged.
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { check, submitParameters, policyParameters, listParameters, readParameters } from './contracts.js'
import { atomicJson, readJson, names, page, redact, summaryText } from './storage.js'
import type {
  Pain,
  Policy,
  PolicySettings,
  Submit,
  Source,
  Metrics,
  PainType,
  Review,
  View,
  PainStatus,
} from './types.js'
const now = () => new Date().toISOString()
export const defaults: PolicySettings = {
  enabled: true,
  weights: { user_dissatisfaction: 100, cognitive: 60, tool_failure: 40, token_excess: 10 },
  execution: { toolFailuresPerTurn: 3, tokensPerTurn: 64000 },
  reflection: { triggerScore: 100, retryDelayMs: 60000 },
}
export class PainEngine {
  private records = new Map<string, Pain>()
  private policy!: Policy
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<(kind: 'pain_received' | 'policy_updated') => void>()
  readonly ready: Promise<void>
  constructor(readonly root: string) {
    this.ready = this.load()
  }
  /** Read durable policy and every pain before publishing the reconstructed view. */
  private async load() {
    const saved = await readJson<Policy>(join(this.root, 'policy.json'))
    if (saved && (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 1))
      throw new Error('POLICY_STORAGE_INVALID')
    this.policy = {
      version: 1,
      revision: 1,
      ...defaults,
      updatedAt: now(),
      updatedBy: { sessionId: null, agentId: null },
      reason: 'Initial policy',
      ...saved,
      weights: { ...defaults.weights, ...saved?.weights },
      execution: { ...defaults.execution, ...saved?.execution },
      reflection: { ...defaults.reflection, ...saved?.reflection },
    }
    this.validatePolicy(this.policy)
    if (!saved) await atomicJson(join(this.root, 'policy.json'), this.policy)
    for (const file of await names(join(this.root, 'events'))) {
      if (!/^pain-event-.*\.json$/.test(file)) continue
      const pain = await readJson<Pain>(join(this.root, 'events', file))
      if (
        !pain ||
        pain.version !== 1 ||
        !Array.isArray(pain.occurrences) ||
        !pain.analysis ||
        !Array.isArray(pain.analysis.reviews) ||
        !Array.isArray(pain.resolutions) ||
        this.records.has(pain.id)
      )
        throw new Error('PAIN_STORAGE_INVALID')
      if (
        !/^[a-zA-Z0-9-]+$/.test(pain.id) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(pain.createdAt) ||
        !Number.isFinite(Date.parse(pain.createdAt)) ||
        pain.occurrences.some(
          (o, i) =>
            o.seq !== i + 1 ||
            typeof o.id !== 'string' ||
            !Object.hasOwn(defaults.weights, o.type) ||
            !Number.isSafeInteger(o.score) ||
            o.score <= 0 ||
            !o.source,
        ) ||
        !Number.isSafeInteger(pain.analysis.analyzedThrough)
      )
        throw new Error('PAIN_STORAGE_INVALID')
      this.project(pain)
      this.records.set(pain.id, pain)
    }
  }
  /** Validate live and restored configuration with the same schema and numeric invariants. */
  private validatePolicy(policy: PolicySettings) {
    check(
      { policy: policyParameters.policy },
      {
        policy: {
          enabled: policy.enabled,
          weights: policy.weights,
          execution: policy.execution,
          reflection: policy.reflection,
        },
      },
    )
    for (const value of [
      ...Object.values(policy.weights),
      ...Object.values(policy.execution),
      ...Object.values(policy.reflection),
    ])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error('Policy thresholds and weights must be positive safe integers')
    const w = policy.weights
    if (
      !(w.user_dissatisfaction > w.cognitive && w.cognitive > w.tool_failure && w.tool_failure > w.token_excess) ||
      policy.reflection.retryDelayMs < 1000
    )
      throw new Error('Policy weights must follow user > cognitive > failure > tokens; retryDelayMs >= 1000')
  }
  /** Global queue makes grouping, replay checks and the corresponding file update indivisible. */
  async serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => this.ready).then(fn)
    this.queue = result.catch(() => undefined)
    return result
  }
  onChange(listener: (kind: 'pain_received' | 'policy_updated') => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private notify(kind: 'pain_received' | 'policy_updated') {
    for (const listener of this.listeners) listener(kind)
  }
  private path(p: Pain) {
    return join(this.root, 'events', `pain-event-${p.createdAt.replace(/[:.]/g, '-')}-${p.id}.json`)
  }
  private project(p: Pain) {
    const through = Math.max(0, ...p.resolutions.map((r) => r.throughOccurrence))
    const pending = p.analysis.reviews.some((r) => r.action === 'link_plan' && r.throughOccurrence > through)
    p.status =
      through >= p.occurrences.length ? 'resolved' : p.analysis.activeReflectId || pending ? 'reflecting' : 'open'
    p.score = {
      total: p.occurrences.reduce((n, o) => n + o.score, 0),
      unresolved: p.occurrences.filter((o) => o.seq > through).reduce((n, o) => n + o.score, 0),
    }
  }
  private async put(p: Pain) {
    this.project(p)
    p.updatedAt = now()
    await atomicJson(this.path(p), p)
    this.records.set(p.id, p)
  }
  async all(): Promise<Pain[]> {
    await this.ready
    return structuredClone([...this.records.values()])
  }
  async get(id: string): Promise<Pain> {
    await this.ready
    const p = this.records.get(id)
    if (!p) throw new Error('Unknown pain')
    return structuredClone(p)
  }
  async currentPolicy() {
    await this.ready
    return structuredClone(this.policy)
  }
  triggerable(p: Pain) {
    return p.status === 'open'
      ? p.occurrences
          .filter((o) => o.seq > p.analysis.analyzedThrough)
          .reduce((n, o) => n + this.policy.weights[o.type], 0)
      : 0
  }
  async view(): Promise<View> {
    const rows = await this.all()
    return {
      policyRevision: this.policy.revision,
      activeReflectId: rows.find((p) => p.analysis.activeReflectId)?.analysis.activeReflectId ?? null,
      openPainCount: rows.filter((p) => p.status === 'open').length,
      reflectingPainCount: rows.filter((p) => p.status === 'reflecting').length,
      unresolvedScore: rows.reduce((n, p) => n + p.score.unresolved, 0),
      triggerableScore: rows.reduce((n, p) => n + this.triggerable(p), 0),
      eligiblePainIds: rows.filter((p) => this.triggerable(p) > 0).map((p) => p.id),
      nextRetryAt: null,
    }
  }
  async list(
    raw: {
      query?: string
      statuses?: PainStatus[]
      cursor?: string
    } = {},
  ) {
    check(listParameters, raw)
    const rows = (await this.all()).filter(
      (p) =>
        (raw.statuses ?? ['open', 'reflecting']).includes(p.status) &&
        (!raw.query ||
          `${p.title} ${p.occurrences.map((o) => o.reason).join(' ')}`.toLowerCase().includes(raw.query.toLowerCase())),
    )
    return page(
      rows.map((p) => ({
        id: p.id,
        title: summaryText(p.title),
        status: p.status,
        types: [...new Set(p.occurrences.map((o) => o.type))],
        score: p.score,
        triggerable: this.triggerable(p),
        occurrenceCount: p.occurrences.length,
        sources: [...new Set(p.occurrences.map((o) => o.source.agentPreset ?? o.source.sessionId))]
          .slice(0, 3)
          .map((s) => summaryText(s, 80)),
      })),
      raw.cursor,
      JSON.stringify([raw.query, raw.statuses]),
    )
  }
  async read(raw: { pain_id: string; cursor?: string }) {
    check(readParameters, raw)
    const p = await this.get(raw.pain_id)
    // Separate bounded text fragments retain full feedback even when one occurrence exceeds a page.
    const entries: unknown[] = []
    for (const o of p.occurrences) {
      const encoded = JSON.stringify(o)
      for (let i = 0; i < encoded.length; i += 1000)
        entries.push({ kind: 'occurrence', seq: o.seq, offset: i, jsonFragment: encoded.slice(i, i + 1000) })
    }
    for (const r of p.analysis.reviews) {
      const encoded = JSON.stringify(r)
      for (let i = 0; i < encoded.length; i += 1000)
        entries.push({ kind: 'review', offset: i, jsonFragment: encoded.slice(i, i + 1000) })
    }
    for (const r of p.resolutions) entries.push({ kind: 'resolution', ...r, explanation: summaryText(r.explanation) })
    return {
      id: p.id,
      title: summaryText(p.title),
      status: p.status,
      score: p.score,
      ...page(entries, raw.cursor, p.id),
    }
  }
  async submit(raw: Submit, source: Source, identity: string) {
    check(submitParameters, raw)
    if (!raw.reason.trim() || !raw.feedback.trim() || (!raw.pain_id && !raw.title?.trim()))
      throw new Error('Nonempty reason, feedback and new pain title required')
    if (Buffer.byteLength(JSON.stringify(raw)) > 16000) throw new Error('PAIN_INPUT_TOO_LARGE')
    return this.record(raw, source, identity)
  }
  /** Automatic metrics use stable session/turn/type identities; later observations only refresh metrics. */
  async automatic(type: 'tool_failure' | 'token_excess', source: Source, metrics: Metrics, groupingKey: string) {
    return this.record(
      {
        type,
        title: type === 'tool_failure' ? 'Repeated tool failures' : 'High turn token usage',
        reason: type === 'tool_failure' ? 'Turn failed tool threshold reached' : 'Turn token threshold reached',
        feedback: JSON.stringify(metrics),
        potentialSolutions: [],
      },
      source,
      `automatic:${source.sessionId}:${source.turnId}:${type}`,
      metrics,
      groupingKey,
    )
  }
  private async record(
    raw: Omit<Submit, 'type'> & {
      type: PainType
    },
    source: Source,
    identity: string,
    metrics?: Metrics,
    groupingKey?: string,
  ) {
    return this.serial(async () => {
      const existing = [...this.records.values()].find((p) => p.occurrences.some((o) => o.id === identity))
      if (existing) {
        const p = structuredClone(existing)
        if (metrics) {
          p.occurrences.find((o) => o.id === identity)!.metrics = metrics
          await this.put(p)
        }
        return { id: p.id, status: p.status, score: p.score, occurrenceId: identity }
      }
      let p = raw.pain_id
        ? await this.get(raw.pain_id)
        : structuredClone([...this.records.values()].find((p) => groupingKey && p.groupingKey === groupingKey))
      p ??= {
        version: 1,
        id: randomUUID(),
        title: redact(raw.title!),
        status: 'open',
        createdAt: now(),
        updatedAt: now(),
        ...(groupingKey ? { groupingKey } : {}),
        occurrences: [],
        analysis: { analyzedThrough: 0, activeReflectId: null, reviews: [] },
        resolutions: [],
        score: { total: 0, unresolved: 0 },
      }
      p.occurrences.push({
        seq: p.occurrences.length + 1,
        id: identity,
        createdAt: now(),
        type: raw.type,
        origin: metrics ? 'automatic' : 'agent',
        reason: redact(raw.reason),
        feedback: redact(raw.feedback),
        potentialSolutions: raw.potentialSolutions.map(redact),
        source,
        ...(metrics ? { metrics } : {}),
        score: this.policy.weights[raw.type],
        policyRevision: this.policy.revision,
      })
      await this.put(p)
      this.notify('pain_received')
      return { id: p.id, status: p.status, score: p.score, occurrenceId: identity }
    })
  }
  /** Persist a revision-checked replacement before publishing its recalculated trigger weights. */
  async updatePolicy(
    raw: {
      expected_revision: number
      policy: PolicySettings
      reason: string
    },
    source: Source,
  ) {
    check(policyParameters, raw)
    this.validatePolicy(raw.policy)
    if (!raw.reason.trim()) throw new Error('Policy update reason required')
    return this.serial(async () => {
      if (raw.expected_revision !== this.policy.revision) throw new Error('POLICY_REVISION_CONFLICT')
      const next: Policy = {
        ...this.policy,
        ...raw.policy,
        revision: this.policy.revision + 1,
        updatedAt: now(),
        updatedBy: { sessionId: source.sessionId, agentId: source.agentId },
        reason: redact(raw.reason),
      }
      await atomicJson(join(this.root, 'policy.json'), next)
      this.policy = next
      this.notify('policy_updated')
      return this.currentPolicy()
    })
  }
  /** A persisted reflection claims its frozen pain set; replay retains the same owner. */
  async claim(ids: string[], reflectId: string) {
    return this.serial(async () => {
      for (const id of ids) {
        const p = await this.get(id)
        if (p.analysis.activeReflectId && p.analysis.activeReflectId !== reflectId)
          throw new Error('PAIN_ALREADY_CLAIMED')
        p.analysis.activeReflectId = reflectId
        await this.put(p)
      }
    })
  }
  /** Apply one durable reflection decision; repeats retain the first committed review identity. */
  async review(id: string, review: Review) {
    return this.serial(async () => {
      const p = await this.get(id)
      if (p.analysis.reviews.some((r) => r.reflectId === review.reflectId)) return
      if (review.throughOccurrence > p.occurrences.length) throw new Error('Invalid occurrence boundary')
      p.analysis.reviews.push(review)
      p.analysis.analyzedThrough = Math.max(p.analysis.analyzedThrough, review.throughOccurrence)
      p.analysis.activeReflectId = null
      if (review.action === 'expected')
        p.resolutions.push({
          throughOccurrence: review.throughOccurrence,
          reason: 'expected',
          planIds: [],
          reflectId: review.reflectId,
          explanation: review.reason,
          resolvedAt: now(),
        })
      await this.put(p)
    })
  }
  /** Merge receipts are authoritative; callback failures retry on startup without changing those receipts. */
  async reconcile(isComplete: (id: string) => Promise<boolean>) {
    return this.serial(async () => {
      for (const original of this.records.values()) {
        const p = structuredClone(original)
        let changed = false
        for (const r of p.analysis.reviews) {
          if (r.action !== 'link_plan' || p.resolutions.some((x) => x.reflectId === r.reflectId)) continue
          if ((await Promise.all(r.planIds.map(isComplete))).every(Boolean)) {
            p.resolutions.push({
              throughOccurrence: r.throughOccurrence,
              reason: 'plans_completed',
              planIds: r.planIds,
              reflectId: r.reflectId,
              explanation: 'All linked plans integrated successfully',
              resolvedAt: now(),
            })
            changed = true
          }
        }
        if (changed) await this.put(p)
      }
      this.notify('pain_received')
    })
  }
}
