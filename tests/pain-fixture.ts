/**
 * Purpose: Mount the production pain Host around a custom Agent in an isolated Harness.
 * Example: a real or mock adapter sees a complete persona and the same global pain tools.
 * Reflection delivery is captured as data; no Trainer LLM runs in these acceptance tests.
 */
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import PainService from '@mozi-forge/agent-pain-plugin/host'
import { ReflectEngine } from '@mozi-forge/reflect-loop-plugin/engine'
import type { ReflectRecord } from '@mozi-forge/reflect-loop-plugin/types'
import { fixture } from './trainer-fixture.js'
export async function painFixture(live = false, adapter?: LlmAdapter) {
  const f = await fixture(adapter)
  try {
    await f.ctx.plugin(PainService, { projectRoot: f.root })
    await f.ctx.pains.ready
    if (live) {
      const resolveRuntime = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
      const plugin = await import(resolveRuntime.resolve('@deepseek-ai/dsh-llm-deepseek'))
      await f.ctx.plugin(plugin, { thinking: 'disabled', reasoningEffort: 'off' })
    }
    const deliveries: ReflectRecord[] = []
    const reflection = new ReflectEngine(
      join(f.home, 'reflects'),
      f.ctx.pains.engine,
      { read: (id) => f.ctx.trainers.read(id), link: (id, ref) => f.ctx.trainers.linkPain(id, ref) },
      {
        deliver: async (record) => {
          deliveries.push(record)
        },
      },
    )
    await reflection.ready
    const custom = await f.ctx.agents.create({
      sessionId: SessionId('pain-custom'),
      meta: { cwd: f.root, agentPreset: 'custom-pain-test' },
      agentOptions: { provider: live ? 'deepseek-official' : 'fixture', model: live ? 'deepseek-v4-flash' : 'fixture' },
      setup: async (ctx) => {
        ctx.systemPrompt.section({
          name: 'deployment:persona',
          order: 0,
          complete: true,
          text: 'You are a concise support assistant. Respond in Chinese and help the user correct mistakes.',
        })
      },
    })
    return {
      ...f,
      custom,
      deliveries,
      reflection,
      async dispose() {
        await custom.dispose()
        await reflection.close()
        await f.dispose()
      },
    }
  } catch (error) {
    await f.dispose()
    throw error
  }
}
