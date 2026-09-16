/**
 * Purpose: Drive session-based training through the public model/tool protocol.
 * Example: inspect two historical sessions, review a Plan and two proposals, run
 * before/after evaluations and integrate the reviewed tree in a disposable repository.
 * Synthetic human revisions pause the sequence; only a new approval resumes training.
 * Target sessions obey the snapshot prompt and execute real shell tools.
 */
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
class Adapter extends LlmAdapter {
  constructor(host) { super(); this.host = host }
  step = 0
  resolveModel(provider, id) { return Promise.resolve({provider,id,name:id}) }
  async *stream(options) {
    const flatten = blocks => blocks.flatMap(b => b.type === 'tool-result' ? flatten(b.content) : [b])
    const blocks = flatten(options.messages.flatMap(m=>m.content))
    const texts = blocks.filter(b=>b.type==='text').map(b=>b.text)
    const values = texts.flatMap(t=>{try{return [JSON.parse(t)]}catch{return []}})
    const last = (predicate) => values.findLast(predicate)
    let name, args, text
    if (options.tools?.some(t=>t.name==='trainer_plan_save')) {
      const names = new Set(options.tools.map(tool => tool.name))
      for (const required of ['read','write','edit','glob','grep','bash','job_output','skill','create_goal','get_goal','update_goal','todo_write','ask_user_question','exit_plan_mode','subagent','subagent_fork','workflow','ralph','web_search','web_fetch']) {
        if (!names.has(required)) throw new Error(`Trainer standard capability missing: ${required}`)
      }
    }
    if (texts.some(t => t.includes('FORGE_WORKSPACE_PROBE'))) {
      if (!options.messages.some(m => m.content.some(b => b.type === 'tool-result'))) { name='bash'; args={command:'pwd > delegated-workspace.txt'} }
      else text='Delegated workspace probe complete.'
    } else if (!options.tools?.some(t=>t.name==='trainer_plan_save')) {
      if (!options.messages.some(m => m.content.some(b => b.type === 'tool-result'))) { name='bash'; args={description:'Write synthetic result',command:`printf '%s' '${JSON.stringify({answer:(options.system ?? '').includes('{"answer":"OK"}') ? 'OK':'OLD'})}' > result.json`} }
      else text='Saved result.'
    } else if (last(v => v?.handoff === true && v?.executionSessionId)) {
      text = 'Training continues in the dedicated execution session.'
    } else {
      const planId=last(v=>v?.id?.startsWith('plan-'))?.id ?? this.planId
      if(planId)this.planId=planId
      const runId=last(v=>typeof v?.runId==='string')?.runId
      const requestId=last(v=>v?.type==='training-merge')?.id
      const sourceIds = texts.join('\n').match(/source_sessions=(\[[^\n]+\])/)?.[1]
      const sources = sourceIds ? JSON.parse(sourceIds) : []
      const inherited = texts.join('\n').match(/Plan: (\{[^\n]+\})/)?.[1]
      const inheritedPlan = inherited ? JSON.parse(inherited) : undefined
      if (inheritedPlan?.executionSessionId && !this.host.get('workspaceRegistry')?.list().some(workspace => workspace.sessionIds.includes(inheritedPlan.executionSessionId))) throw new Error('Training execution is missing from the public workspace registry')
      const snapshots = sources.map(id => last(v => v?.sessionId === id && typeof v?.evidencePath === 'string')).filter(Boolean)
      const ref = snapshots.at(-1)
      const sourceSessions = snapshots.map(v => ({sessionId:v.sessionId,revision:v.revision}))
      const evidence = snapshots.length ? snapshots.map(v => `session:${v.sessionId}@${v.revision}#0-${v.through}`).join(', ') : (inheritedPlan?.sourceSessions ?? []).map(v => `session:${v.sessionId}@${v.revision}`).join(', ')
      const firstProposal = `# Proposal 001\nEvidence: ${evidence}. The target writes OLD. Change the target prompt to OK. Compare unchanged fixture-target baseline and after. Risk: fixed output fixture only. Human acceptance: answer is OK.`
      const secondProposal = `# Proposal 002\nEvidence: ${evidence}. Preserve JSON validity with an explicit JSON-output instruction and a second regression case. Baseline and after use the same added suite. Risk: prompt-only wording. Human acceptance: valid JSON and answer OK.`
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
      const commandWrite = (path,content) => `python3 -c ${quote(`from pathlib import Path; Path(${JSON.stringify(path)}).write_text(${JSON.stringify(content)})`)}`
      const steps = []
      for (const id of sources) {
        steps.push(['session_inspect',{session_id:id}])
        steps.push(['session_query',{session_id:id,revision:ref?.revision,sort:'tokens'}])
        steps.push(['session_read',{session_id:id,revision:ref?.revision,from:0,through:ref?.through}])
      }
      steps.push(
        ['trainer_plan_save',{description:'Diagnose source sessions and improve target output.',title:'Improve target from sessions',body:`## Goal\nDiagnose source sessions and improve target output through reviewed proposals.\nEvidence: ${evidence}`,sourceSessions,tokenBudget:200000,iterationBudget:2}],
        ['human_request_submit',{type:'training-plan-review',planId,body:`Review plan and source evidence: ${evidence}`}],
        [null,'Waiting for plan review.'],
        ['trainer_workspace_prepare',{plan_id:planId}],
        ['write',{file_path:'native-probe.txt',content:'native workspace probe'}],
        ['read',{file_path:'native-probe.txt'}],
        ['glob',{pattern:'native-probe.txt'}],
        ['skill',{name:'worktree-probe'}],
        ['subagent',{description:'Verify inherited training workspace',prompt:'FORGE_WORKSPACE_PROBE: record your current working directory.',run_in_background:false}],
        ['trainer_plan_read',{plan_id:planId}],
        ['bash',{command:'pnpm_config_verify_deps_before_run=false pnpm run build:trainer',timeoutMs:300000}],
        ['bash',{command:commandWrite('../proposals/001.md',firstProposal)}],
        ['human_request_submit',{type:'proposal-review',planId,body:firstProposal}],
        [null,'Waiting for proposal review.'],
        ['agent_test_preflight',{plan_id:planId,suite:'fixture-target'}],
        ['agent_test_start',{plan_id:planId,suite:'fixture-target',repeat:1}],
        ['agent_test_wait',{run_id:runId,timeout_ms:60000}],
        ['bash',{command:commandWrite('config/presets/fixture-target/prompt.md','Write result.json containing {"answer":"OK"} using bash, then finish.\n')}],
        ['agent_test_start',{plan_id:planId,suite:'fixture-target',repeat:1}],
        ['agent_test_wait',{run_id:runId,timeout_ms:60000}],
        ['bash',{command:commandWrite('../proposals/002.md',secondProposal)}],
        ['human_request_submit',{type:'proposal-review',planId,body:secondProposal}],
        [null,'Waiting for second proposal review.'],
        ['bash',{command:'python3 -c "from pathlib import Path; p=Path(\'tests/agent-evals/fixture-target.yml\'); Path(\'tests/agent-evals/fixture-json.yml\').write_text(p.read_text().replace(\'id: fixture-target\',\'id: fixture-json\').replace(\'prompt: Write the required result file.\',\'prompt: Produce a machine-readable JSON result without commentary in the file.\'))"'}],
        ['agent_test_preflight',{plan_id:planId,suite:'fixture-json'}],
        ['agent_test_start',{plan_id:planId,suite:'fixture-json',repeat:1}],
        ['agent_test_wait',{run_id:runId,timeout_ms:60000}],
        ['bash',{command:commandWrite('config/presets/fixture-target/prompt.md','Write result.json containing {"answer":"OK"} using bash, then finish. Always emit valid JSON.\n')}],
        ['agent_test_start',{plan_id:planId,suite:'fixture-json',repeat:1}],
        ['agent_test_wait',{run_id:runId,timeout_ms:60000}],
        ['bash',{command:commandWrite('../result.md',`# Training results\nEvidence: ${evidence}. Proposal 001 baseline failed; changed target passed. Proposal 002 baseline and after passed the additional JSON regression. All decisions are fixture human answers.`)}],
        ['human_request_submit',{type:'training-merge',planId,body:'Review target prompt and regression case.',checks:['grep -q OK config/presets/fixture-target/prompt.md']}],
        [null,'Waiting for merge review.'],
        ['trainer_merge',{request_id:requestId}],
      )
      let next
      if (texts.some(t => t.includes('FIXTURE_REVISION_REQUIRED')) && (this.revisionStage ?? 0) < 4) {
        const rejected = last(v => v?.type === 'proposal-review')?.id
        const revisions = [
          ['human_request_read',{id:rejected}],
          ['bash',{command:commandWrite('../proposals/001.md',firstProposal+'\nRevision: preserve the fixed baseline assertion and include both source references.')}],
          ['human_request_submit',{type:'proposal-review',planId,body:firstProposal+'\nRevision: preserve the fixed assertion and both source references.'}],
          [null,'Waiting for revised proposal approval.'],
        ]
        next = revisions[this.revisionStage ?? 0]
        this.revisionStage = (this.revisionStage ?? 0)+1
      } else next = steps[this.step++]
      if (!next) text='Training complete.'
      else if (next[0]) {name=next[0];args=next[1]}
      else text=next[1]
    }
    if(name === 'bash') args = {description:'Execute training fixture command', ...args}
    if(name) {
      const id=ToolCallId(crypto.randomUUID())
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:JSON.stringify(args)}
      yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}}
      yield {type:'usage',usage:{inputTokens:20,outputTokens:10}}
      yield {type:'finish',reason:{kind:'tool-calls'}}
    } else {
      yield {type:'block-start',index:0,blockType:'text'}
      yield {type:'text-delta',index:0,text}
      yield {type:'block-end',index:0,block:{type:'text',text}}
      yield {type:'usage',usage:{inputTokens:20,outputTokens:5}}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
}
export const inject=['llm']
export function apply(ctx){ctx.llm.registerAdapter(['trainer-fixture'],new Adapter(ctx))}
