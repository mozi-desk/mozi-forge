/**
 * Purpose: Verify independent review admission, evidence delivery and recovery through
 * public services and temporary persisted records with synthetic Agent dependencies.
 * Example: pass before complete evidence delivery fails; reading every page permits
 * completion. Edge-case Example: null finding rejects without changing the disk record
 * or notifying result listeners, then a corrected evidenced result succeeds.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReviewService } from '../src/host.js'
const roots: string[] = []; const contexts: Context[] = []
class Agents extends Service {
  rows = new Map<string, Agent>()
  constructor(ctx: Context) { super(ctx, 'agents') }
  get(id: string) { return this.rows.get(id) }
  async create(options: { sessionId: string }) { const agent = { id: options.sessionId, followup: () => undefined } as unknown as Agent; this.rows.set(options.sessionId, agent); return { agent, dispose: async () => { this.rows.delete(options.sessionId) } } }
}
class Presets extends Service { constructor(ctx: Context) { super(ctx, 'agentPresets') } async mount() {} }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-host-')); roots.push(root); vi.stubEnv('DSH_HOME', root)
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(Agents); await ctx.plugin(Presets); await ctx.plugin(ReviewService, { projectRoot: root }); return ctx
}
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() })
describe('independent Reviewer public contract', () => {
  it('binds identity, requires evidence reads and makes a pass immutable', async () => {
    const ctx = await fixture(); const input = { key: 'candidate-v1', sections: { objective: 'Serve the user', candidate: { diff: 'prompt change' }, tests: { accepted: true } } }
    const review = await ctx.reviews.start(input); const agent = ctx.agents.get(review.sessionId as Agent['id'])!
    await expect(ctx.reviews.submit(review.id, { verdict: 'pass', summary: 'ok', findings: [] }, { id: 'trainer' } as unknown as Agent)).rejects.toThrow('OWNER')
    await expect(ctx.reviews.submit(review.id, { verdict: 'pass', summary: 'ok', findings: [] }, agent)).rejects.toThrow('EVIDENCE_REQUIRED')
    for (const section of Object.keys(input.sections)) await ctx.reviews.read(review.id, section, 0, agent)
    const result = await ctx.reviews.submit(review.id, { verdict: 'pass', summary: 'Scope is supported', findings: [] }, agent)
    expect(result.status).toBe('completed'); expect((await ctx.reviews.start(input)).id).toBe(review.id)
    await expect(ctx.reviews.start({ ...input, sections: { objective: 'Different scope' } })).rejects.toThrow('IDENTITY_CONFLICT')
    await expect(ctx.reviews.submit(review.id, { verdict: 'pass', summary: 'Different decision', findings: [] }, agent)).rejects.toThrow('ALREADY_SUBMITTED')
  })
  it('resumes paused review in a fresh context bound to the same frozen candidate', async () => {
    const ctx = await fixture()
    const input = { key: 'restart-candidate', sections: { candidate: { diff: 'focused evidence' } } }
    const run = await ctx.reviews.start(input)
    const old = ctx.agents.get(run.sessionId as Agent['id'])!
    ctx.emit('agent/status', { agent: old, status: 'idle' })
    await vi.waitFor(async () => expect((await ctx.reviews.get(run.id)).status).toBe('paused'))
    const resumed = await ctx.reviews.resume(run.id)
    expect(resumed.id).toBe(run.id); expect(resumed.sessionId).not.toBe(run.sessionId)
    expect(resumed.sections).toEqual(input.sections)
    await expect(ctx.reviews.read(run.id, 'candidate', 0, old)).rejects.toThrow('OWNER')
    const current = ctx.agents.get(resumed.sessionId as Agent['id'])!
    await ctx.reviews.read(run.id, 'candidate', 0, current)
    expect((await ctx.reviews.submit(run.id, { verdict: 'pass', summary: 'Supported by the frozen evidence', findings: [] }, current)).status).toBe('completed')
  })
  it('requires actionable findings for weakened evaluations and supports cancellation', async () => {
    const ctx = await fixture(); const run = await ctx.reviews.start({ key: 'candidate-v2', sections: { candidate: { diff: '- difficult case\n+ easy case' } } }); const agent = ctx.agents.get(run.sessionId as Agent['id'])!
    await expect(ctx.reviews.submit(run.id, { verdict: 'request-changes', summary: 'Weak test', findings: [] }, agent)).rejects.toThrow('FINDINGS_REQUIRED')
    const result = await ctx.reviews.submit(run.id, { verdict: 'request-changes', summary: 'Restore difficult case', findings: [{ kind: 'weakened-evaluation', evidenceRefs: ['candidate#diff'], impact: 'Coverage dropped', remedy: 'Restore the original case and rerun baseline and final' }] }, agent)
    expect(result.result?.verdict).toBe('request-changes')
    await ctx.reviews.cancel(run.id); await expect(ctx.reviews.read(run.id, 'candidate', 0, agent)).rejects.toThrow('OWNER')
  })
})


it('requires contiguous evidence pages before passing a large section', async () => {
  const ctx = await fixture()
  const review = await ctx.reviews.start({ key: 'paged-evidence', sections: { candidate: { diff: 'measured behavior '.repeat(1000) } } })
  const owner = ctx.agents.get(review.sessionId as Agent['id'])!
  let page = await ctx.reviews.read(review.id, 'candidate', 0, owner) as { nextOffset?: number }
  await expect(ctx.reviews.submit(review.id, { verdict: 'pass', summary: 'Supported', findings: [] }, owner)).rejects.toThrow('EVIDENCE_REQUIRED')
  while (page.nextOffset !== undefined) page = await ctx.reviews.read(review.id, 'candidate', page.nextOffset, owner) as { nextOffset?: number }
  expect((await ctx.reviews.submit(review.id, { verdict: 'pass', summary: 'The complete evidence supports the candidate.', findings: [] }, owner)).status).toBe('completed')
})

it('rejects malformed nested results before writes or notifications and accepts the correction', async () => {
  const ctx = await fixture()
  const review = await ctx.reviews.start({ key: 'native-shape', sections: { objective: 'Measure the same behavior.' } })
  const owner = ctx.agents.get(review.sessionId as Agent['id'])!
  const path = join(process.env.DSH_HOME!, 'reviews', `${Buffer.from(review.id).toString('base64url')}.json`)
  const before = await readFile(path, 'utf8')
  const notify = vi.fn(); ctx.reviews.onResult(notify)
  const finding = { kind: 'insufficient-evidence', evidenceRefs: ['objective'], impact: 'Unknown result.', remedy: 'Run a baseline.' }
  for (const findings of [[null], [{ ...finding, kind: 'unknown' }], [{ ...finding, evidenceRefs: [null] }], [{ ...finding, remedy: {} }]]) {
    await expect(ctx.reviews.submit(review.id, { verdict: 'insufficient-evidence', summary: 'More evidence needed.', findings } as unknown as Parameters<typeof ctx.reviews.submit>[1], owner)).rejects.toThrow('result.findings[0]')
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(notify).not.toHaveBeenCalled()
  }
  expect((await ctx.reviews.submit(review.id, { verdict: 'insufficient-evidence', summary: 'Collect the baseline.', findings: [{ ...finding, kind: 'insufficient-evidence' }] }, owner)).status).toBe('completed')
  expect(notify).toHaveBeenCalledOnce()
})
