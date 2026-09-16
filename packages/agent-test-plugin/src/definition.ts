import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'
import type {
  AgentTestBudgets,
  AgentTestCase,
  AgentTestReviewDefinition,
  AgentTestSuite,
  AgentTestTurn,
  FileExpectation,
  JsonExpectation,
  ToolExpectation,
} from './types.js'

type RecordValue = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

function object(value: unknown, path: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object')
  return value as RecordValue
}

function strict(value: RecordValue, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) fail(path, `unknown field(s): ${unknown.join(', ')}`)
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'expected a non-empty string')
  return value
}

function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(path, `expected an integer from ${String(min)} to ${String(max)}`)
  }
  return value as number
}

function finite(value: unknown, path: string, min = 0, max = Number.MAX_VALUE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(path, `expected a number from ${String(min)} to ${String(max)}`)
  }
  return value
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'expected a non-empty array')
  return value
}

function strings(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => string(item, `${path}[${String(index)}]`))
}

function optionalStrings(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined
  return strings(value, path)
}

export function validateJsonPointer(pointer: string, path = 'pointer'): string {
  if (pointer !== '' && !pointer.startsWith('/')) fail(path, 'JSON Pointer must be empty or start with /')
  for (let index = 0; index < pointer.length; index += 1) {
    if (pointer[index] === '~' && pointer[index + 1] !== '0' && pointer[index + 1] !== '1') {
      fail(path, 'JSON Pointer contains an invalid ~ escape')
    }
  }
  return pointer
}

export function assertSafeRelativePath(path: string, field = 'path'): string {
  if (isAbsolute(path) || path.includes('\0')) fail(field, 'must be a relative path')
  const cleaned = normalize(path)
  if (cleaned === '..' || cleaned.startsWith(`..${sep}`)) fail(field, 'path escapes its workspace')
  if (cleaned === '.' || cleaned.length === 0) fail(field, 'must name a file')
  return cleaned
}

export function resolveWorkspacePath(workspace: string, relative: string): string {
  const safe = assertSafeRelativePath(relative)
  const base = resolve(workspace)
  const target = resolve(base, safe)
  if (target !== base && !target.startsWith(`${base}${sep}`)) fail('path', 'path escapes its workspace')
  return target
}

function parseJsonExpectation(value: unknown, path: string): JsonExpectation {
  const row = object(value, path)
  strict(row, ['pointer', 'equals', 'contains'], path)
  const hasEquals = Object.hasOwn(row, 'equals')
  const hasContains = Object.hasOwn(row, 'contains')
  if (hasEquals === hasContains) fail(path, 'exactly one of equals or contains is required')
  return {
    pointer: validateJsonPointer(string(row.pointer, `${path}.pointer`), `${path}.pointer`),
    ...(hasEquals ? { equals: row.equals } : { contains: row.contains }),
  }
}

function parseFile(value: unknown, path: string): FileExpectation {
  const row = object(value, path)
  strict(row, ['path', 'json', 'saveAs', 'unchangedCollection', 'dataProvenance'], path)
  const file: FileExpectation = { path: assertSafeRelativePath(string(row.path, `${path}.path`), `${path}.path`) }
  if (row.json !== undefined) file.json = array(row.json, `${path}.json`).map((item, index) => parseJsonExpectation(item, `${path}.json[${String(index)}]`))
  if (row.saveAs !== undefined) file.saveAs = string(row.saveAs, `${path}.saveAs`)
  if (row.unchangedCollection !== undefined) {
    const unchanged = object(row.unchangedCollection, `${path}.unchangedCollection`)
    strict(unchanged, ['from', 'pointer', 'key', 'except'], `${path}.unchangedCollection`)
    const except = optionalStrings(unchanged.except, `${path}.unchangedCollection.except`)
    file.unchangedCollection = {
      from: string(unchanged.from, `${path}.unchangedCollection.from`),
      pointer: validateJsonPointer(string(unchanged.pointer, `${path}.unchangedCollection.pointer`), `${path}.unchangedCollection.pointer`),
      key: string(unchanged.key, `${path}.unchangedCollection.key`),
      ...(except === undefined ? {} : { except }),
    }
  }
  if (row.dataProvenance !== undefined) {
    const provenance = object(row.dataProvenance, `${path}.dataProvenance`)
    strict(provenance, ['inputPointer', 'documentPointers', 'excludePointers'], `${path}.dataProvenance`)
    file.dataProvenance = {
      ...(provenance.inputPointer === undefined ? {} : {
        inputPointer: validateJsonPointer(string(provenance.inputPointer, `${path}.dataProvenance.inputPointer`), `${path}.dataProvenance.inputPointer`),
      }),
      documentPointers: strings(provenance.documentPointers, `${path}.dataProvenance.documentPointers`)
        .map((pointer, index) => validateJsonPointer(pointer, `${path}.dataProvenance.documentPointers[${String(index)}]`)),
      excludePointers: provenance.excludePointers === undefined ? [] : strings(provenance.excludePointers, `${path}.dataProvenance.excludePointers`)
        .map((pointer, index) => validateJsonPointer(pointer, `${path}.dataProvenance.excludePointers[${String(index)}]`)),
    }
  }
  if (file.json === undefined && file.saveAs === undefined && file.unchangedCollection === undefined && file.dataProvenance === undefined) {
    fail(path, 'file expectation requires json, saveAs, unchangedCollection, or dataProvenance')
  }
  return file
}

function parseTool(value: unknown, path: string): ToolExpectation {
  const row = object(value, path)
  strict(row, ['name', 'calls', 'failed', 'incomplete', 'arguments'], path)
  const result: ToolExpectation = { name: string(row.name, `${path}.name`) }
  if (row.calls !== undefined) {
    const calls = object(row.calls, `${path}.calls`)
    strict(calls, ['exactly', 'min', 'max'], `${path}.calls`)
    if (Object.keys(calls).length === 0) fail(`${path}.calls`, 'requires exactly, min, or max')
    result.calls = {
      ...(calls.exactly === undefined ? {} : { exactly: integer(calls.exactly, `${path}.calls.exactly`) }),
      ...(calls.min === undefined ? {} : { min: integer(calls.min, `${path}.calls.min`) }),
      ...(calls.max === undefined ? {} : { max: integer(calls.max, `${path}.calls.max`) }),
    }
  }
  if (row.failed !== undefined) result.failed = integer(row.failed, `${path}.failed`)
  if (row.incomplete !== undefined) result.incomplete = integer(row.incomplete, `${path}.incomplete`)
  if (row.arguments !== undefined) {
    const args = object(row.arguments, `${path}.arguments`)
    strict(args, ['contains', 'excludes', 'regex'], `${path}.arguments`)
    const contains = typeof args.contains === 'string' ? args.contains : optionalStrings(args.contains, `${path}.arguments.contains`)
    const regex = typeof args.regex === 'string' ? args.regex : optionalStrings(args.regex, `${path}.arguments.regex`)
    for (const source of regex === undefined ? [] : Array.isArray(regex) ? regex : [regex]) {
      try { new RegExp(source, 'u') } catch { fail(`${path}.arguments.regex`, `invalid regular expression: ${source}`) }
    }
    const excludes = optionalStrings(args.excludes, `${path}.arguments.excludes`)
    result.arguments = {
      ...(contains === undefined ? {} : { contains }),
      ...(excludes === undefined ? {} : { excludes }),
      ...(regex === undefined ? {} : { regex }),
    }
  }
  return result
}

function parseTurn(value: unknown, path: string): AgentTestTurn {
  const row = object(value, path)
  strict(row, ['id', 'prompt', 'expect'], path)
  const turn: AgentTestTurn = { id: string(row.id, `${path}.id`), prompt: string(row.prompt, `${path}.prompt`) }
  if (row.expect !== undefined) {
    const expect = object(row.expect, `${path}.expect`)
    strict(expect, ['turn', 'tools', 'files'], `${path}.expect`)
    turn.expect = {}
    if (expect.turn !== undefined) {
      const expectedTurn = object(expect.turn, `${path}.expect.turn`)
      strict(expectedTurn, ['reason'], `${path}.expect.turn`)
      turn.expect.turn = { reason: string(expectedTurn.reason, `${path}.expect.turn.reason`) }
    }
    if (expect.tools !== undefined) turn.expect.tools = array(expect.tools, `${path}.expect.tools`).map((item, index) => parseTool(item, `${path}.expect.tools[${String(index)}]`))
    if (expect.files !== undefined) turn.expect.files = array(expect.files, `${path}.expect.files`).map((item, index) => parseFile(item, `${path}.expect.files[${String(index)}]`))
  }
  return turn
}

function parseBudgets(value: unknown, path: string): AgentTestBudgets {
  const row = object(value, path)
  const fields: Array<keyof AgentTestBudgets> = [
    'maxElapsedMs', 'maxLlmMs', 'maxToolMs', 'maxTtftMs', 'maxUncachedInputTokens',
    'maxCacheReadTokens', 'maxCacheWriteTokens', 'maxOutputTokens', 'maxToolCalls', 'maxToolFailureRate',
  ]
  strict(row, fields, path)
  const result: AgentTestBudgets = {}
  for (const field of fields) {
    if (row[field] === undefined) continue
    result[field] = field === 'maxToolFailureRate'
      ? finite(row[field], `${path}.${field}`, 0, 1)
      : integer(row[field], `${path}.${field}`)
  }
  return result
}

function parseReview(value: unknown, path: string): AgentTestReviewDefinition {
  const row = object(value, path)
  strict(row, ['required', 'when', 'title', 'instructions', 'checklist', 'artifacts'], path)
  if (row.required !== true) fail(`${path}.required`, 'must be true when review is present')
  const when = row.when === undefined ? 'auto-pass' : string(row.when, `${path}.when`)
  if (when !== 'auto-pass' && when !== 'always') fail(`${path}.when`, 'must be auto-pass or always')
  const artifacts = array(row.artifacts, `${path}.artifacts`).map((value, index) => {
    const artifactPath = `${path}.artifacts[${String(index)}]`
    const artifact = object(value, artifactPath)
    strict(artifact, ['label', 'path'], artifactPath)
    const declaredPath = string(artifact.path, `${artifactPath}.path`)
    assertSafeRelativePath(declaredPath, `${artifactPath}.path`)
    return { label: string(artifact.label, `${artifactPath}.label`), path: declaredPath }
  })
  const checklist = strings(row.checklist, `${path}.checklist`)
  if (new Set(checklist).size !== checklist.length) fail(`${path}.checklist`, 'duplicate review checklist item')
  const artifactKeys = artifacts.map(artifact => `${artifact.label}\0${artifact.path}`)
  if (new Set(artifactKeys).size !== artifactKeys.length) fail(`${path}.artifacts`, 'duplicate review artifact')
  return {
    required: true,
    when,
    title: string(row.title, `${path}.title`),
    instructions: string(row.instructions, `${path}.instructions`),
    checklist,
    artifacts,
  }
}

function uniqueIds(values: readonly { id: string }[], path: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value.id)) fail(path, `duplicate id: ${value.id}`)
    seen.add(value.id)
  }
}

function validateSnapshots(testCase: AgentTestCase, path: string): void {
  const snapshots = new Set<string>()
  for (let turnIndex = 0; turnIndex < testCase.turns.length; turnIndex += 1) {
    const files = testCase.turns[turnIndex]?.expect?.files ?? []
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex]!
      const field = `${path}.turns[${String(turnIndex)}].expect.files[${String(fileIndex)}]`
      if (file.unchangedCollection !== undefined && !snapshots.has(file.unchangedCollection.from)) {
        fail(`${field}.unchangedCollection.from`, `unknown or forward snapshot reference: ${file.unchangedCollection.from}`)
      }
      if (file.saveAs !== undefined) {
        if (snapshots.has(file.saveAs)) fail(`${field}.saveAs`, `duplicate snapshot name: ${file.saveAs}`)
        snapshots.add(file.saveAs)
      }
    }
  }
}

function parseCase(value: unknown, path: string): AgentTestCase {
  const row = object(value, path)
  strict(row, ['id', 'name', 'input', 'turns', 'budgets', 'review'], path)
  const testCase: AgentTestCase = {
    id: string(row.id, `${path}.id`),
    name: string(row.name, `${path}.name`),
    ...(row.input === undefined ? {} : { input: row.input }),
    turns: array(row.turns, `${path}.turns`).map((item, index) => parseTurn(item, `${path}.turns[${String(index)}]`)),
    ...(row.budgets === undefined ? {} : { budgets: parseBudgets(row.budgets, `${path}.budgets`) }),
    ...(row.review === undefined ? {} : { review: parseReview(row.review, `${path}.review`) }),
  }
  uniqueIds(testCase.turns, `${path}.turns`)
  if (testCase.input !== undefined && !testCase.turns.some(turn => turn.prompt.includes('{{input.json}}'))) {
    fail(`${path}.turns`, 'a case with input must inject it through {{input.json}}')
  }
  validateSnapshots(testCase, path)
  return testCase
}

export function parseSuite(source: string, sourcePath = '<yaml>'): AgentTestSuite {
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true })
  if (document.errors.length > 0) fail(sourcePath, document.errors.map(error => error.message).join('; '))
  const row = object(document.toJS(), sourcePath)
  strict(row, ['version', 'id', 'name', 'preset', 'defaults', 'cases'], sourcePath)
  if (row.version !== 1) fail(`${sourcePath}.version`, 'must be 1')
  const defaults = row.defaults === undefined ? {} : object(row.defaults, `${sourcePath}.defaults`)
  strict(defaults, ['timeoutMs', 'repeat'], `${sourcePath}.defaults`)
  const suite: AgentTestSuite = {
    version: 1,
    id: string(row.id, `${sourcePath}.id`),
    name: string(row.name, `${sourcePath}.name`),
    preset: string(row.preset, `${sourcePath}.preset`),
    defaults: {
      timeoutMs: defaults.timeoutMs === undefined ? 180_000 : integer(defaults.timeoutMs, `${sourcePath}.defaults.timeoutMs`, 1),
      repeat: defaults.repeat === undefined ? 1 : integer(defaults.repeat, `${sourcePath}.defaults.repeat`, 1, 10),
    },
    cases: array(row.cases, `${sourcePath}.cases`).map((item, index) => parseCase(item, `${sourcePath}.cases[${String(index)}]`)),
    sourcePath,
  }
  uniqueIds(suite.cases, `${sourcePath}.cases`)
  return suite
}

export async function loadSuites(directory: string): Promise<Map<string, AgentTestSuite>> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  const suites = new Map<string, AgentTestSuite>()
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const suite = parseSuite(await readFile(path, 'utf8'), path)
    const prior = suites.get(suite.id)
    if (prior !== undefined) fail(path, `duplicate suite id ${suite.id}; already defined in ${prior.sourcePath}`)
    suites.set(suite.id, suite)
  }
  return suites
}
