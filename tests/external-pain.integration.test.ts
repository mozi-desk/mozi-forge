/** The external collection mode retains Agent tools while source events arrive through its public collector. */
import { expect, it } from 'vitest'
import PainService from '@mozi-forge/agent-pain-plugin/host'
import { fixture } from './trainer-fixture.js'
it('external mode retains tools and does not replay persisted local sessions', async () => {
  const f = await fixture()
  try {
    const session = f.handle.agent.session
    session.append('turn/start', { turn: 1 } as never)
    await f.ctx.sessions.flush(session)
    await f.ctx.plugin(PainService, { projectRoot: f.root, collectionMode: 'external' })
    await f.ctx.pains.ready
    expect(await f.ctx.pains.collector.cursor(String(session.id))).toBe(-1)
    const next = await f.createAgent()
    expect(f.ctx.tools.schemas(next.agent).map(t => t.name)).toContain('pain_submit')
    const submitted = await f.callAs(next, 'pain_submit', { title: 'Wrong table', type: 'cognitive', reason: 'Attribution table missing', feedback: 'Need attribution_events', potentialSolutions: ['Clarify skill'] })
    expect((await f.ctx.pains.engine.get(submitted.id)).occurrences).toHaveLength(1)
    expect(await f.ctx.pains.collector.cursor(String(next.agent.session.id))).toBe(-1)
  } finally { await f.dispose() }
}, 30000)
