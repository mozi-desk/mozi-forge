import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { evaluateTurn } from '../src/assertions.js'

function events(command: string): SessionEvent[] {
  return [
    { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'one', name: 'bash', arguments: JSON.stringify({ command }) } },
    { seq: 2, time: 3, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'one' }, content: [{ type: 'tool-result', toolCallId: 'one', toolName: 'bash', isError: false, content: [] }] } } },
    { seq: 3, time: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]
}

describe('agent eval black-box assertions', () => {
  it('checks turn, tool arguments, JSON containment, and keyed unchanged snapshots', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-eval-assertions-'))
    const snapshots = new Map<string, unknown>([['before', { components: [{ id: 'keep', value: 1 }, { id: 'change', value: 1 }] }]])
    await writeFile(join(workspace, 'coding.json'), JSON.stringify({ components: [{ id: 'keep', value: 1 }, { id: 'change', value: 2 }] }))
    const result = await evaluateTurn({
      turn: { reason: 'completed' },
      tools: [{
        name: 'bash', calls: { exactly: 1 }, failed: 0, incomplete: 0,
        arguments: { contains: ' patch ', excludes: [' show'], regex: 'codingctl.+patch' },
      }],
      files: [{
        path: 'coding.json',
        json: [{ pointer: '/components', contains: { id: 'change', value: 2 } }],
        unchangedCollection: { from: 'before', pointer: '/components', key: 'id', except: ['change'] },
      }],
    }, { workspace, turn: 1, events: events('node codingctl patch input.json'), snapshots })
    expect(result.every(item => item.passed)).toBe(true)
  })

  it('counts incomplete calls independently from failed results', async () => {
    const incomplete = events('run').filter(event => event.type !== 'tool/result')
    const result = await evaluateTurn({ tools: [{ name: 'bash', calls: { exactly: 1 }, failed: 0, incomplete: 1 }] }, {
      workspace: process.cwd(), turn: 1, events: incomplete, snapshots: new Map(),
    })
    expect(result.every(item => item.passed)).toBe(true)
  })

  it('rejects business data not present in structured input while excluding layout pointers', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-eval-provenance-'))
    await writeFile(join(workspace, 'coding.json'), JSON.stringify({ series: [{ label: '温度', value: 21, span: 6 }, { label: '湿度', value: 101, axis: 'right' }] }))
    const result = await evaluateTurn({ files: [{
      path: 'coding.json',
      dataProvenance: { documentPointers: ['/series'], excludePointers: ['/series/0/span', '/series/1/axis'] },
    }] }, {
      workspace,
      turn: 1,
      input: { series: [{ label: '温度', value: 21 }, { label: '湿度', value: 58 }] },
      events: [],
      snapshots: new Map(),
    })
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining('business data comes from case input'), passed: false, detail: expect.stringContaining('101') })]))
  })
})
