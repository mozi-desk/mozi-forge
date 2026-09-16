/**
 * Purpose: Compose real public Harness services around a disposable Git repository.
 * Example: a test calls trainer_plan_save through tools, inspects disk, then disposes
 * its own Agent and subprocess services. No production runtime or browser is touched.
 * The versioned Trainer preset is mounted through the real Loader with Sleep tools.
 * Extra Agents can be created and driven through the same public tool executor so that
 * cross-session ownership rules stay testable without reaching into private state.
 */
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import SleepService from '@mozi-forge/sleep-loop-plugin/host'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import Commands from '@deepseek-ai/dsh-commands'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { HumanRequestService } from '@mozi-forge/human-request-plugin/host'
import { AgentTestService } from '@mozi-forge/agent-test-plugin/host'
import SessionInsights from '@mozi-forge/session-insights-plugin/host'
import { TrainerService } from '@mozi-forge/trainer-agent/host'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
const exec = promisify(execFile)
const resolveRuntime = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
const { default: JsonlPersistence } = await import(resolveRuntime.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
export async function git(root: string, ...args: string[]): Promise<string> { return (await exec('git', args, { cwd: root })).stdout.trim() }
class QuietModel extends LlmAdapter {
  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Saved answer received.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Saved answer received.' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export async function fixture(adapter?: LlmAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'trainer-blackbox-')), home = join(root, '.runtime')
  await git(root, 'init', '-b', 'main'); await git(root, 'config', 'user.name', 'Trainer Test'); await git(root, 'config', 'user.email', 'trainer@example.invalid')
  await writeFile(join(root, '.gitignore'), '.runtime/\nnode_modules/\n')
  await writeFile(join(root, 'agent.txt'), 'baseline\n')
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'fixture baseline')
  const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home
  const ctx = new Context()
  ctx.baseUrl = new URL('../', import.meta.url).href
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime); await ctx.plugin(ShellEnv, { dshHome: home }); await ctx.plugin(LocalBashExecutor, { timeoutMs: 10000 }); await ctx.plugin(LocalJobRegistry, {})
  await ctx.plugin(Commands); await ctx.plugin(HostConnectionService, [])
  await ctx.plugin(JsonlPersistence, { root: join(home, 'sessions') })
  await ctx.plugin(SessionInsights, { projectRoot: root })
  await ctx.plugin(HumanRequestService, { projectRoot: root }); await ctx.plugin(AgentTestService, { projectRoot: root }); await ctx.plugin(TrainerService, { projectRoot: root })
  ctx.llm.registerAdapter(['fixture'], adapter ?? new QuietModel())
  const presetRoot = join(home, 'presets'), trainerPath = join(presetRoot, 'trainer')
  await mkdir(trainerPath, { recursive: true })
  const require = createRequire(import.meta.url)
  let preset = await readFile(require.resolve('@mozi-forge/runtime/presets/trainer/agent.cordis.yml'), 'utf8')
  for (const [marker, entry] of Object.entries({ __FORGE_TRAINER_PLUGIN__: '@mozi-forge/trainer-agent/plugin', __FORGE_AGENT_TEST_TOOL_PLUGIN__: '@mozi-forge/agent-test-plugin/tool', __FORGE_SLEEP_LOOP_TOOLS__: '@mozi-forge/sleep-loop-plugin/tools' })) preset = preset.replaceAll(marker, JSON.stringify(require.resolve(entry)))
  await writeFile(join(trainerPath, 'agent.cordis.yml'), preset)
  await ctx.plugin(AgentPresets, { default: 'trainer', roots: [{ path: presetRoot, trust: 'user' }], includeUserRoot: false, includeShippedRoot: false })
  await ctx.plugin(AgentDefaultModel, { provider: 'fixture', model: 'fixture' })
  await ctx.plugin(SleepService, { projectRoot: root }); await ctx.sleepLoop.ready
  const setup = async (agentCtx: Context) => { await ctx.agentPresets.mount(agentCtx, 'trainer') }
  const created: Array<Awaited<ReturnType<typeof ctx.agents.create>>> = []
  let sequence = 0
  const createAgent = async () => {
    const target = await ctx.agents.create({ sessionId: SessionId(`trainer-${Date.now()}-${created.length}`), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' }, setup })
    created.push(target)
    return target
  }
  const handle = await createAgent()
  const callAs = async (target: Awaited<ReturnType<typeof createAgent>>, name: string, args: Record<string, unknown> = {}) => {
    const result = await ctx.tools.execute({ callId: ToolCallId(`fixture-${++sequence}`), name, arguments: args, agent: target.agent, signal: new AbortController().signal })
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
    if (result.isError) throw new Error(text)
    return JSON.parse(text)
  }
  const call = (name: string, args: Record<string, unknown> = {}) => callAs(handle, name, args)
  return { root, home, ctx, handle, call, callAs, createAgent, async dispose() { for (const target of created.splice(0)) await target.dispose(); await ctx.fiber.dispose(); if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; await rm(root, { recursive: true, force: true }) } }
}
