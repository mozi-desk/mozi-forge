import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveWorkspacePath } from './definition.js'
import type {
  AgentTestAssertion,
  AgentTestBudgets,
  AgentTestMetrics,
  FileExpectation,
  ToolExpectation,
  TurnAssertionContext,
  TurnExpectation,
} from './types.js'

function assertion(name: string, passed: boolean, detail: unknown): AgentTestAssertion {
  return { name, passed, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }
}

export function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value
  let current = value
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current)) {
      if (!/^0$|^[1-9]\d*$/u.test(token)) return undefined
      current = current[Number(token)]
    } else if (typeof current === 'object' && current !== null && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token]
    } else {
      return undefined
    }
  }
  return current
}

function deepContains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    if (!Array.isArray(expected)) return actual.some(item => deepContains(item, expected))
    return expected.every(expectedItem => actual.some(actualItem => deepContains(actualItem, expectedItem)))
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false
    return Object.entries(expected as Record<string, unknown>)
      .every(([key, value]) => Object.hasOwn(actual, key) && deepContains((actual as Record<string, unknown>)[key], value))
  }
  return isDeepStrictEqual(actual, expected)
}

interface ToolFact {
  name: string
  arguments: string
  failed: boolean
  incomplete: boolean
}

function resultFailed(event: Extract<SessionEvent, { type: 'tool/result' }>): boolean {
  return event.data.error !== undefined
    || event.data.message.content.some(block => block.type === 'tool-result' && block.isError)
}

function toolFacts(events: readonly SessionEvent[], turn: number): ToolFact[] {
  const calls = new Map<string, ToolFact>()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.turn === turn) {
      calls.set(event.data.callId, {
        name: event.data.name,
        arguments: event.data.arguments,
        failed: false,
        incomplete: true,
      })
    } else if (event.type === 'tool/result' && event.data.turn === turn) {
      const fact = calls.get(event.data.message.source.callId)
      if (fact !== undefined) {
        fact.incomplete = false
        fact.failed = resultFailed(event)
      }
    }
  }
  return [...calls.values()]
}

function toolAssertions(expectation: ToolExpectation, events: readonly SessionEvent[], turn: number): AgentTestAssertion[] {
  const facts = toolFacts(events, turn).filter(fact => fact.name === expectation.name)
  const failed = facts.filter(fact => fact.failed).length
  const incomplete = facts.filter(fact => fact.incomplete).length
  const result: AgentTestAssertion[] = []
  if (expectation.calls?.exactly !== undefined) result.push(assertion(`tool ${expectation.name} calls exactly ${String(expectation.calls.exactly)}`, facts.length === expectation.calls.exactly, `actual=${String(facts.length)}`))
  if (expectation.calls?.min !== undefined) result.push(assertion(`tool ${expectation.name} calls >= ${String(expectation.calls.min)}`, facts.length >= expectation.calls.min, `actual=${String(facts.length)}`))
  if (expectation.calls?.max !== undefined) result.push(assertion(`tool ${expectation.name} calls <= ${String(expectation.calls.max)}`, facts.length <= expectation.calls.max, `actual=${String(facts.length)}`))
  if (expectation.failed !== undefined) result.push(assertion(`tool ${expectation.name} failed = ${String(expectation.failed)}`, failed === expectation.failed, `actual=${String(failed)}`))
  if (expectation.incomplete !== undefined) result.push(assertion(`tool ${expectation.name} incomplete = ${String(expectation.incomplete)}`, incomplete === expectation.incomplete, `actual=${String(incomplete)}`))
  const values = facts.map(fact => fact.arguments)
  const contains = expectation.arguments?.contains
  for (const needle of contains === undefined ? [] : Array.isArray(contains) ? contains : [contains]) {
    result.push(assertion(`tool ${expectation.name} arguments contain ${JSON.stringify(needle)}`, values.some(value => value.includes(needle)), values))
  }
  for (const needle of expectation.arguments?.excludes ?? []) {
    result.push(assertion(`tool ${expectation.name} arguments exclude ${JSON.stringify(needle)}`, values.every(value => !value.includes(needle)), values))
  }
  const regex = expectation.arguments?.regex
  for (const source of regex === undefined ? [] : Array.isArray(regex) ? regex : [regex]) {
    const pattern = new RegExp(source, 'u')
    result.push(assertion(`tool ${expectation.name} arguments match /${source}/u`, values.some(value => pattern.test(value)), values))
  }
  return result
}

function keyedCollection(value: unknown, key: string, except: readonly string[]): Map<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  const result = new Map<string, unknown>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined
    const id = (item as Record<string, unknown>)[key]
    if (typeof id !== 'string' || result.has(id)) return undefined
    if (!except.includes(id)) result.set(id, item)
  }
  return result
}

function unchangedAssertion(file: FileExpectation, document: unknown, snapshots: Map<string, unknown>): AgentTestAssertion | undefined {
  const expectation = file.unchangedCollection
  if (expectation === undefined) return undefined
  const previous = snapshots.get(expectation.from)
  const except = expectation.except ?? []
  const before = keyedCollection(jsonPointer(previous, expectation.pointer), expectation.key, except)
  const after = keyedCollection(jsonPointer(document, expectation.pointer), expectation.key, except)
  const passed = before !== undefined && after !== undefined
    && before.size === after.size
    && [...before].every(([key, value]) => after.has(key) && isDeepStrictEqual(after.get(key), value))
  return assertion(`file ${file.path} collection ${expectation.pointer} unchanged from ${expectation.from}`, passed, {
    before: before === undefined ? 'invalid keyed collection' : Object.fromEntries(before),
    after: after === undefined ? 'invalid keyed collection' : Object.fromEntries(after),
    except,
  })
}

interface ScalarFact { pointer: string; value: string | number | boolean | null }

function scalarFacts(value: unknown, base = ''): ScalarFact[] {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [{ pointer: base, value }]
  if (Array.isArray(value)) return value.flatMap((item, index) => scalarFacts(item, `${base}/${String(index)}`))
  if (typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => scalarFacts(item, `${base}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`))
}

function provenanceAssertion(file: FileExpectation, document: unknown, input: unknown): AgentTestAssertion | undefined {
  const expectation = file.dataProvenance
  if (expectation === undefined) return undefined
  const inputRoot = jsonPointer(input, expectation.inputPointer ?? '')
  const allowed = scalarFacts(inputRoot).map(fact => fact.value)
  const sourceFacts = expectation.documentPointers.flatMap(pointer => scalarFacts(jsonPointer(document, pointer), pointer))
  const included = sourceFacts.filter(fact => !expectation.excludePointers.some(pointer => fact.pointer === pointer || fact.pointer.startsWith(`${pointer}/`)))
  const unexpected = included.filter(fact => !allowed.some(value => isDeepStrictEqual(value, fact.value)))
  return assertion(`file ${file.path} business data comes from case input`, unexpected.length === 0, {
    checked: included.length,
    excludedPointers: expectation.excludePointers,
    unexpected: unexpected.slice(0, 20),
  })
}

export async function evaluateTurn(expectation: TurnExpectation | undefined, context: TurnAssertionContext): Promise<AgentTestAssertion[]> {
  if (expectation === undefined) return []
  const result: AgentTestAssertion[] = []
  if (expectation.turn !== undefined) {
    const event = context.events.find(candidate => candidate.type === 'turn/end' && candidate.data.turn === context.turn)
    const reason = event?.type === 'turn/end' ? event.data.reason.kind : 'missing'
    result.push(assertion(`turn reason = ${expectation.turn.reason}`, reason === expectation.turn.reason, `actual=${reason}`))
  }
  for (const tool of expectation.tools ?? []) result.push(...toolAssertions(tool, context.events, context.turn))
  for (const file of expectation.files ?? []) {
    const path = resolveWorkspacePath(context.workspace, file.path)
    let document: unknown
    try {
      document = JSON.parse(await readFile(path, 'utf8'))
      result.push(assertion(`file ${file.path} exists and is valid JSON`, true, path))
    } catch (error: unknown) {
      result.push(assertion(`file ${file.path} exists and is valid JSON`, false, error instanceof Error ? error.message : String(error)))
      continue
    }
    for (const expected of file.json ?? []) {
      const actual = jsonPointer(document, expected.pointer)
      if (Object.hasOwn(expected, 'equals')) {
        result.push(assertion(`file ${file.path} ${expected.pointer} equals expected value`, isDeepStrictEqual(actual, expected.equals), { actual, expected: expected.equals }))
      } else {
        result.push(assertion(`file ${file.path} ${expected.pointer} contains expected value`, deepContains(actual, expected.contains), { actual, expected: expected.contains }))
      }
    }
    const unchanged = unchangedAssertion(file, document, context.snapshots)
    if (unchanged !== undefined) result.push(unchanged)
    const provenance = provenanceAssertion(file, document, context.input)
    if (provenance !== undefined) result.push(provenance)
    if (file.saveAs !== undefined) context.snapshots.set(file.saveAs, structuredClone(document))
  }
  return result
}

const budgetFields: Array<[keyof AgentTestBudgets, (metrics: AgentTestMetrics) => number]> = [
  ['maxElapsedMs', metrics => metrics.elapsedMs],
  ['maxLlmMs', metrics => metrics.llmMs],
  ['maxToolMs', metrics => metrics.toolMs],
  ['maxTtftMs', metrics => metrics.ttftMs],
  ['maxUncachedInputTokens', metrics => metrics.tokens.uncachedInputTokens],
  ['maxCacheReadTokens', metrics => metrics.tokens.cacheReadTokens],
  ['maxCacheWriteTokens', metrics => metrics.tokens.cacheWriteTokens],
  ['maxOutputTokens', metrics => metrics.tokens.outputTokens],
  ['maxToolCalls', metrics => metrics.tools.calls],
  ['maxToolFailureRate', metrics => metrics.tools.failureRate],
]

export function evaluateBudgets(budgets: AgentTestBudgets | undefined, metrics: AgentTestMetrics): AgentTestAssertion[] {
  if (budgets === undefined) return []
  return budgetFields.flatMap(([field, read]) => {
    const limit = budgets[field]
    if (limit === undefined) return []
    const actual = read(metrics)
    return [assertion(`budget ${field} <= ${String(limit)}`, actual <= limit, `actual=${String(actual)}`)]
  })
}
