/**
 * Purpose: Validate model-visible schemas, complete personas and actual tool writes.
 * Example: a custom Agent submits dissatisfaction, resulting in one durable reflection.
 */
import { expect, it } from 'vitest'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { painFixture } from './pain-fixture.js'
it('exposes pain guidance and native tools to a complete custom persona', async () => {
  const f = await painFixture()
  try {
    const schemas = f.ctx.tools.schemas(f.custom.agent)
    expect(schemas.map((s) => s.name)).toEqual(expect.arrayContaining(['pain_list', 'pain_read', 'pain_submit']))
    expect(schemas.map((s) => s.name)).not.toContain('pain_policy_update')
    const assembled = await f.ctx.systemPrompt.assemble(assembleContextFor(f.custom.agent))
    expect(JSON.stringify(assembled)).toContain('user expresses dissatisfaction')
    expect(JSON.stringify(assembled)).toContain('concise support assistant')
    const call = (name: string, args: unknown) =>
      f.ctx.tools.execute({
        callId: ToolCallId('pain-test-submit'),
        name,
        arguments: args,
        agent: f.custom.agent,
        signal: new AbortController().signal,
      })
    const bad = await call('pain_submit', { type: 'tool_failure' })
    expect(bad.isError).toBe(true)
    expect(await f.ctx.pains.engine.all()).toEqual([])
    const args = {
      title: 'Wrong response',
      type: 'user_dissatisfaction',
      reason: 'Wrong unit',
      feedback: 'I asked for milliseconds',
      potentialSolutions: ['Check requested unit'],
    }
    expect((await call('pain_submit', args)).isError).not.toBe(true)
    expect((await call('pain_submit', args)).isError).not.toBe(true)
    await f.reflection.evaluate('pain_received')
    const pains = await f.ctx.pains.engine.all()
    expect(pains).toHaveLength(1)
    expect(pains[0]!.occurrences).toHaveLength(1)
    expect(pains[0]!.occurrences[0]!.source.sessionId).toBe('pain-custom')
    expect(f.deliveries).toHaveLength(1)
  } finally {
    await f.dispose()
  }
}, 30000)
it('mounts Trainer-only policy and completion tools and delivers through the real Harness host', async () => {
  const { fixture } = await import('./trainer-fixture.js')
  const { default: PainService } = await import('@mozi-forge/agent-pain-plugin/host')
  const { default: ReflectService } = await import('@mozi-forge/reflect-loop-plugin/host')
  const f = await fixture()
  try {
    await f.ctx.plugin(PainService, { projectRoot: f.root })
    await f.ctx.pains.ready
    await f.ctx.plugin(ReflectService, { projectRoot: f.root })
    await f.ctx.reflectLoop.ready
    const trainer = await f.createAgent()
    await expect.poll(() => f.ctx.tools.schemas(trainer.agent).map((t) => t.name)).toContain('reflect_complete')
    const names = f.ctx.tools.schemas(trainer.agent).map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['pain_policy_read', 'pain_policy_update', 'trainer_plan_list', 'pain_submit']),
    )
    const policy = await f.callAs(trainer, 'pain_policy_read')
    expect(policy.policy.revision).toBe(1)
    const plan = await f.callAs(trainer, 'trainer_plan_save', {
      title: 'Existing fix',
      description: 'Correct unit omissions',
      body: 'Inspect units',
    })
    const listed = await f.call('trainer_plan_list')
    expect(listed.items.some((p: { id: string }) => p.id === plan.id)).toBe(true)
    expect((await f.call('trainer_plan_read', { plan_id: plan.id })).plan.description).toBe('Correct unit omissions')
    const pain = await f.callAs(trainer, 'pain_submit', {
      title: 'Missing units',
      type: 'user_dissatisfaction',
      reason: 'Missing units',
      feedback: 'User is unhappy',
      potentialSolutions: ['Check units'],
    })
    await f.ctx.reflectLoop.engine.evaluate('pain_received')
    const reflection = (await f.ctx.reflectLoop.engine.status())!
    const delivered = f.ctx.agents.get(reflection.trainer.sessionId as never)!
    expect(delivered).toBeDefined()
    await delivered.whenIdle()
    expect(
      delivered.session
        .snapshotEvents()
        .some((e) => e.type === 'user/message' && JSON.stringify(e.data).includes('trainer_plan_list')),
    ).toBe(true)
    const result = await f.ctx.tools.execute({
      callId: ToolCallId('complete-reflection'),
      name: 'reflect_complete',
      arguments: {
        reflect_id: reflection.id,
        summary: 'Covered by existing Plan',
        decisions: [
          {
            pain_id: pain.id,
            through_occurrence: 1,
            action: 'link_plan',
            plan_ids: [plan.id],
            reason: 'Same missing units',
            evidence: [],
          },
        ],
      },
      agent: delivered,
      signal: new AbortController().signal,
    })
    expect(result.isError).not.toBe(true)
    const saved = await f.ctx.trainers.read(plan.id)
    expect(saved.sessionId).toBe(String(trainer.agent.id))
    expect(saved.painRefs?.[0]?.painId).toBe(pain.id)
    const review = await f.callAs(trainer, 'human_request_submit', { type: 'plan-review', planId: plan.id, body: plan.body })
    await f.ctx.humanRequests.respond(review.id, '同意，请继续。', 'approve')
    const prepared = await f.callAs(trainer, 'trainer_workspace_prepare', { plan_id: plan.id })
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(join(prepared.workspace, 'agent.txt'), 'validated units\n')
    await f.callAs(trainer, 'trainer_merge', { plan_id: plan.id, checks: ['test -s agent.txt'] })
    expect((await f.ctx.pains.engine.get(pain.id)).status).toBe('resolved')

  } finally {
    await f.dispose()
  }
}, 30000)
