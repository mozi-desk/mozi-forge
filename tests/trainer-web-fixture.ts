/**
 * Purpose: Launch a disposable real Web Harness around a committed synthetic Agent.
 * Flow: copy credential-free project source, commit the fixture, mount Trainer and
 * a tiny target preset, then authenticate through the public startup exchange.
 * Example: baseline target writes OLD; training changes its prompt to write OK.
 * Cleanup joins only the child created here. Startup credentials stay in memory.
 */
import { prepareRuntime } from '@mozi-forge/runtime'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { createWorkcopy } from '@mozi-forge/agent-test-plugin/workcopy'
import { HarnessSessionClient, redactLaunchCredentials } from '@mozi-forge/agent-test-plugin/session-client'
import { git } from './trainer-fixture.js'
import type { HumanRequest } from '@mozi-forge/human-request-plugin/types'
export async function trainerWebFixture(mock = false) {
  const root = await mkdtemp(join(tmpdir(), 'trainer-live-'))
  await createWorkcopy(resolve('.'), root)
  const home = join(root, '.runtime')
  await mkdir(join(root, 'config/presets/fixture-target'), { recursive: true })
  await writeFile(join(root, 'config/presets/fixture-target/prompt.md'), 'Write result.json containing {"answer":"OLD"} using bash, then finish.\n')
  await writeFile(join(root, 'config/presets/fixture-target/plugin.mjs'), `import {readFileSync} from 'node:fs';
export const inject=['systemPrompt'];
export function apply(ctx){ctx.systemPrompt.section({name:'deployment:persona',order:0,complete:true,text:readFileSync(new URL('./prompt.md',import.meta.url),'utf8')})}
`)
  await writeFile(join(root, 'config/presets/fixture-target/agent.cordis.yml'), `- id: fixture-target
  name: ./plugin.mjs
- id: bash
  name: '@deepseek-ai/dsh-tool-bash'
  config: { enableRunInBackground: false }
`)
  await writeFile(join(root, 'tests/agent-evals/fixture-target.yml'), `version: 1
id: fixture-target
name: Synthetic target output
preset: fixture-target
defaults: { timeoutMs: 120000, repeat: 1 }
cases:
  - id: output
    name: Writes the expected answer
    review:
      required: true
      when: always
      title: Assess result
      instructions: Inspect the actual JSON answer against the plan.
      checklist: [Answer is OK]
      artifacts: [{ label: Result, path: result.json }]
    turns:
      - id: write
        prompt: Write the required result file.
        expect:
          files:
            - path: result.json
              json: [{ pointer: /answer, equals: OK }]
`)
  await mkdir(join(root, '.agents/skills/worktree-probe'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), '# Fixture instructions\nFORGE_HEAD_INSTRUCTIONS: Work on the supplied fixture task.\n')
  await writeFile(join(root, '.agents/skills/worktree-probe/SKILL.md'), '---\nname: worktree-probe\ndescription: Inspect the training worktree fixture.\n---\nFORGE_HEAD_SKILL: Use the current execution workspace.\n')
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Trainer Fixture')
  await git(root, 'config', 'user.email', 'trainer@example.invalid')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'Synthetic trainer fixture')
  await prepareRuntime({ projectRoot: root, runtimeHome: home, presetDirectory: join(root, 'config/presets') })
  const targetPreset = join(home, '.agent-presets/fixture-target/agent.cordis.yml')
  await writeFile(targetPreset, (await readFile(targetPreset, 'utf8')).replace('./plugin.mjs', join(root, 'config/presets/fixture-target/plugin.mjs')))
  const patch = join(home, 'trainer.patch.yml')
  const mockPatch = mock ? `- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config: { provider: trainer-fixture, model: trainer-fixture }
- insert:
    - id: fixture-model
      name: ${JSON.stringify(join(root,'tests/fixtures/trainer-loop-llm.mjs'))}
` : ''
  const evalPatch = join(home, 'mock-eval.patch.yml')
  if (mock) await writeFile(evalPatch, mockPatch)
  await writeFile(patch, mockPatch + '- id: review-agent-host\n  disabled: true\n')
  const port = await new Promise<number>((done, fail) => { const server = createServer(); server.on('error', fail); server.listen(0,'127.0.0.1',() => { const address=server.address(); if (!address || typeof address==='string') return fail(new Error('port unavailable')); server.close(() => done(address.port)) }) })
  const child = spawn(process.execPath, [join(root, 'dist/start.js'), '--patch', patch, '--port', String(port), '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED:'1', ...(mock ? { FORGE_AGENT_TEST_EVALUATION_PATCH: evalPatch } : {}) }, stdio:['ignore','pipe','pipe'] })
  let diagnostics = ''
  child.stderr!.on('data', bytes => { diagnostics = (diagnostics + redactLaunchCredentials(String(bytes))).slice(-12000) })
  const lines = createInterface({ input: child.stdout! })
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(done => child.once('exit', () => done()))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited; clearTimeout(timer)
    }
    lines.close()
  }
  try {
    const launch = await new Promise<string>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('Trainer Web startup timeout: '+diagnostics)), 30000)
      child.once('error', error => {clearTimeout(timer); fail(error)})
      child.once('exit', code => {clearTimeout(timer); fail(new Error(`Trainer Web exited ${code}: ${diagnostics}`))})
      lines.on('line', line => {
        diagnostics = (diagnostics + redactLaunchCredentials(line)+'\n').slice(-12000)
        const url = line.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0]
        if (url) {clearTimeout(timer); done(url)}
      })
    })
    const api = new HarnessSessionClient(`http://127.0.0.1:${port}`)
    await api.authenticate(launch)
    async function requests(): Promise<HumanRequest[]> {
      const response = await api.fetch('/mozi-human-requests/list', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ type:'client-request',rpcId:crypto.randomUUID(),method:'list',payload:{status:'pending'} })})
      const value = await response.json() as {result:{ok:boolean;value:HumanRequest[];error?:unknown}}
      if (!value.result.ok) throw new Error(JSON.stringify(value.result.error))
      return value.result.value
    }
    async function answer(id: string, body: string, decision: 'approve' | 'request-changes'): Promise<void> {
      const response=await api.fetch('/mozi-human-requests/respond',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'respond',payload:{id,body,decision}})})
      const value=await response.json() as {result:{ok:boolean;error?:unknown}}
      if (!value.result.ok) throw new Error(JSON.stringify(value.result.error))
    }
    return {root,home,api,requests,answer,stop,diagnostics:()=>diagnostics,async dispose(){await stop();await rm(root,{recursive:true,force:true})}}
  } catch(error) {await stop();throw error}
}
