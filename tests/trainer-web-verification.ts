/**
 * Purpose: Exercise session-driven training through public Web APIs with a real or scripted model.
 * The synthetic target starts wrong, establishes a failed baseline, gets optimized,
 * passes the same eval and merges into a disposable Git branch after fixture approval.
 * Example: two source sessions produce one Plan and reviewed proposals; a scripted
 * revision request must be answered before the baseline starts.
 * Human answers are explicitly test fixtures. Logs/receipts are retained as evidence;
 * credentials are handled only by the provider and startup exchange in memory.
 */
import { mkdir, readFile, readdir, writeFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect } from 'vitest'
import { trainerWebFixture } from './trainer-web-fixture.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
/**
 * Durable session events from one history page.
 *
 * Harness 0.1.5 removed the storage decoder that used to narrow journal records into `SessionEvent`, so
 * the session controller now types each record as the deliberately loose `SessionWireEvent` envelope:
 * `type` stays a plain string and `data` stays JSON, because durable readers own recognition of
 * merge-extensible event names. This verification script reads its own child's durable log, so it
 * narrows once here and every reader below works against the discriminated union.
 */
function sessionEvents(page: { result: { value: { events: readonly { event: SessionWireEvent }[] } } }): SessionEvent[] {
  return page.result.value.events.map(row => row.event) as unknown as SessionEvent[]
}

export async function verifyTraining(mock = false): Promise<void> {
  const evidence = resolve('.runtime/trainer-validation', new Date().toISOString().replaceAll(/[:.]/g,'-'))
  await mkdir(evidence,{recursive:true})
  const f=await trainerWebFixture(mock)
  const decisions: Array<{id:string;type:string;body:string}>=[]
  try {
    const sourceIds = []
    for (let i = 0; i < 2; i++) {
      const sourceWorkspace = join(f.home, `source-${i}`)
      await mkdir(sourceWorkspace, { recursive: true })
      const source = (await f.api.sessions.create({cwd:sourceWorkspace,agentPreset:'fixture-target'})).result.value.sessionId
      sourceIds.push(source)
      await f.api.sessions.prompt({sessionId:source,mode:'queue',content:[{type:'text',text:'Write the required result file.'}]})
      const deadline = Date.now() + 120000
      let ended = false
      while (Date.now() < deadline) {
        const events = sessionEvents(await f.api.sessions.history({sessionId:source,maxMessages:100}))
        if (events.some(event => event.type === 'turn/end')) { ended = true; break }
        await new Promise(done => setTimeout(done, 200))
      }
      expect(ended).toBe(true)
    }
    const created=await f.api.sessions.create({cwd:f.root,agentPreset:'trainer'})
    const sessionId=created.result.value.sessionId
    await f.api.sessions.prompt({sessionId,mode:'queue',content:[{type:'text',text:`source_sessions=${JSON.stringify(sourceIds)}\n这是临时 Git 仓库中的真实 Trainer 黑盒验收。先查询并分析这些 sessions，绑定 sourceSessions。每份 proposal 都需要人审通过再训练。请优化 fixture-target，使固定评测 fixture-target 的 result.json.answer 从 OLD 变为 OK。目标修改位于 config/presets/fixture-target/prompt.md，可以新增回归测试样例，保持固定评测断言。按完整训练流程：Plan 人审、HEAD worktree、proposal、修改前 agent eval baseline、修改后相同 agent eval、result.md、合入人审和 trainer_merge。额度 200000 tokens、2 次迭代。初始 baseline 失败是预期证据。worktree 从 HEAD 创建后需要 使用已链接的依赖运行 pnpm_config_verify_deps_before_run=false pnpm run build:trainer 准备依赖及构建。合入检查命令可用 grep -q OK config/presets/fixture-target/prompt.md。所有人工答复由明确标识的测试 fixture 通过公开 RPC 提供。请完成全部流程。`} ]})
    await writeFile(join(evidence,'fixture.json'),JSON.stringify({root:f.root,sessionId}))
    const deadline=Date.now()+(mock ? 3 : 12)*60*1000
    let completed: unknown
    const trainingSessions = new Set([String(sessionId)])
    while(Date.now()<deadline){
      for (const id of await readdir(join(f.home, 'trainning')).catch(() => [])) {
        const plan = JSON.parse(await readFile(join(f.home, 'trainning', id, 'plan.json'), 'utf8'))
        if (plan.executionSessionId) trainingSessions.add(plan.executionSessionId)
      }
      const histories = await Promise.all([...trainingSessions].map(id => f.api.sessions.history({ sessionId: SessionId(id), maxMessages: 100 })))
      const history = { result: { value: { events: histories.flatMap(h => h.result.value.events) } } }
      const failure = sessionEvents(history).find(event => (event.type === 'turn/end' && event.data.reason.kind === 'error') || (mock && event.type === 'tool/result' && (event.data.error !== undefined || JSON.stringify(event.data.message).includes('"isError":true'))))
      if (failure) {
        await writeFile(join(evidence, 'failure.json'), JSON.stringify(failure, null, 2))
        throw new Error(JSON.stringify(failure.data))
      }
      for(const request of await f.requests()){
        if(!trainingSessions.has(request.sessionId))continue
        const revise = mock && request.type === 'proposal-review' && !decisions.some(d => d.type === 'proposal-review')
        if (revise) {
          const planDirs = await readdir(join(f.home,'trainning'))
          for (const id of planDirs) expect(await readdir(join(f.home,'trainning',id,'evaluations'))).toEqual([])
          expect(await readFile(join(f.root,'config/presets/fixture-target/prompt.md'),'utf8')).toContain('OLD')
        }
        const body=revise?'FIXTURE_REVISION_REQUIRED 请补充固定断言与两个来源的证据，重新送审。':request.type==='training-merge'?'批准合入本次修改。':request.type==='test-review'?'通过验收':'同意，请继续。这是自动化测试 fixture 的人工答复。'
        decisions.push({id:request.id,type:request.type,body});await f.answer(request.id,body)
      }
      const ids=await readdir(join(f.home,'trainning')).catch(()=>[])
      for(const id of ids){const plan=JSON.parse(await readFile(join(f.home,'trainning',id,'plan.json'),'utf8'));if(plan.merge)completed=plan}
      if(completed)break
      await new Promise(done=>setTimeout(done,1000))
    }
    const ids=await readdir(join(f.home,'trainning')).catch(()=>[])
    const results=[]
    const proposals: string[] = []
    for(const id of ids){
      for (const name of await readdir(join(f.home,'trainning',id,'proposals')).catch(()=>[])) proposals.push(await readFile(join(f.home,'trainning',id,'proposals',name),'utf8'))
      for(const testId of await readdir(join(f.home,'trainning',id,'evaluations')).catch(()=>[])){
        const result=await readFile(join(f.home,'trainning',id,'evaluations',testId,'result.json'),'utf8').then(JSON.parse).catch(()=>null)
        if(result)results.push({id:result.runId,verdict:result.automaticVerdict,sourceDigest:result.sourceDigest,metrics:result.metrics})
      }
    }
    await writeFile(join(evidence,'evidence.json'),JSON.stringify({fixture:f.root,completed,decisions,results},null,2))
    expect(completed).toBeTruthy()
    const executionId = (completed as { executionSessionId: string }).executionSessionId
    expect(executionId).toBeTruthy()
    const executionHistory = sessionEvents(await f.api.sessions.history({ sessionId: SessionId(executionId), maxMessages: 100 }))
    if (mock) {
      const executionText = JSON.stringify(executionHistory)
      expect(executionText).toContain('FORGE_HEAD_INSTRUCTIONS')
      expect(executionText).toContain('FORGE_HEAD_SKILL')
      const planId = (completed as {id:string}).id
      const workspace = join(f.home, 'trainning', planId, 'workspace')
      expect(await readFile(join(workspace, 'native-probe.txt'), 'utf8')).toBe('native workspace probe')
      expect(await realpath((await readFile(join(workspace, 'delegated-workspace.txt'), 'utf8')).trim())).toBe(await realpath(workspace))
    }
    expect((completed as {sourceSessions: Array<{sessionId:string}>}).sourceSessions.map(ref=>ref.sessionId).sort()).toEqual([...sourceIds].sort())
    expect(decisions.filter(d=>d.type==='proposal-review').length).toBeGreaterThanOrEqual(mock ? 2 : 1)
    expect(proposals.length).toBeGreaterThanOrEqual(mock ? 2 : 1)
    if (mock) { expect(decisions.filter(d=>d.type==='proposal-review')).toHaveLength(3); expect(proposals.join('\n')).toContain('Revision:') }
    const history = sessionEvents(await f.api.sessions.history({ sessionId, maxMessages: 100 }))
    const calls = history.filter(e=>e.type==='tool/call').map(e=>e.data.name)
    expect(calls.indexOf('session_inspect')).toBeLessThan(calls.indexOf('trainer_plan_save'))
    expect(calls).toContain('session_query'); expect(calls).toContain('session_read')
    const sessionCalls = new Set(history.filter(e => e.type === 'tool/call').filter(e => ['session_inspect','session_query','session_read'].includes(e.data.name)).map(e => e.data.callId))
    const responseBytes = history.filter(e => e.type === 'tool/result').filter(e => sessionCalls.has(e.data.message.source.callId)).flatMap(e => e.data.message.content).filter(b => b.type === 'tool-result').flatMap(b => b.content).filter(b => b.type === 'text').map(b => Buffer.byteLength(b.text))
    expect(responseBytes.length).toBeGreaterThan(0)
    expect(Math.max(...responseBytes)).toBeLessThanOrEqual(8192)
    await writeFile(join(evidence,'evidence.json'),JSON.stringify({fixture:f.root,completed,decisions,results,sessionTools:calls.filter(name=>name.startsWith('session_')),maxSessionResponseBytes:Math.max(...responseBytes)},null,2))
    expect(results.some(r=>r.verdict==='failed')).toBe(true)
    expect(results.some(r=>r.verdict==='passed')).toBe(true)
    expect(new Set(results.map(r=>r.sourceDigest)).size).toBeGreaterThan(1)
    expect(await readFile(join(f.root,'config/presets/fixture-target/prompt.md'),'utf8')).toContain('OK')
  } finally {
    await f.stop()
    await writeFile(join(evidence,'diagnostics.txt'),f.diagnostics())
    await writeFile(join(evidence,'fixture.txt'),f.root)
  }
}
