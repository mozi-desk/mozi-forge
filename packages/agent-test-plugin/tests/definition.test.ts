import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertSafeRelativePath, loadSuites, parseSuite } from '../src/definition.js'

const base = `
version: 1
id: sample
name: Sample suite
preset: coding
cases:
  - id: case-a
    name: Case A
    turns:
      - id: create
        prompt: create
        expect:
          files:
            - path: result.json
              json:
                - pointer: /items
                  contains: { id: one }
              saveAs: before
      - id: patch
        prompt: patch
        expect:
          files:
            - path: result.json
              unchangedCollection:
                from: before
                pointer: /items
                key: id
`

describe('agent eval YAML definition', () => {
  it('applies deterministic defaults and validates snapshot references', () => {
    const suite = parseSuite(base)
    expect(suite.defaults).toEqual({ timeoutMs: 180_000, repeat: 1 })
    expect(suite.cases[0]?.turns.map(turn => turn.id)).toEqual(['create', 'patch'])
  })

  it.each([
    ['unknown fields', base.replace('name: Sample suite', 'name: Sample suite\nunknown: true'), /unknown field/u],
    ['duplicate ids', base.replace('id: patch', 'id: create'), /duplicate id/u],
    ['invalid pointers', base.replace('pointer: /items', 'pointer: items'), /JSON Pointer/u],
    ['missing snapshots', base.replace('from: before', 'from: absent'), /snapshot reference/u],
    ['forward snapshots', base.replace('saveAs: before', '').replace('from: before', 'from: later').replace('              unchangedCollection:', '              saveAs: later\n              unchangedCollection:'), /snapshot reference/u],
    ['escaping files', base.replace('path: result.json', 'path: ../result.json'), /escapes/u],
  ])('rejects %s before execution', (_name, source, expected) => {
    expect(() => parseSuite(source)).toThrow(expected)
  })

  it('rejects duplicate suite ids across YAML files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-eval-definition-'))
    await writeFile(join(directory, 'a.yml'), base)
    await writeFile(join(directory, 'b.yaml'), base)
    await expect(loadSuites(directory)).rejects.toThrow(/duplicate suite id/u)
  })

  it('rejects absolute and parent-relative paths', () => {
    expect(() => assertSafeRelativePath('/tmp/result.json')).toThrow(/relative path/u)
    expect(() => assertSafeRelativePath('../result.json')).toThrow(/escapes/u)
  })

  it('loads the checked-in coding-live suite', async () => {
    const suites = await loadSuites(fileURLToPath(new URL('../../../tests/agent-evals', import.meta.url)))
    expect(suites.get('coding-live')).toMatchObject({ preset: 'coding', cases: [{ id: 'incremental-patch' }] })
  })

  it('requires structured input injection and accepts explicit data provenance exclusions', () => {
    const source = base
      .replace('name: Case A', 'name: Case A\n    input: { values: [10, 20], labels: [a, b] }')
      .replace('prompt: create', 'prompt: |\n          create from {{input.json}}')
      .replace('              saveAs: before', `              saveAs: before
              dataProvenance:
                documentPointers: [/items]
                excludePointers: [/items/0/span, /items/0/axis]`)
    expect(parseSuite(source).cases[0]?.input).toEqual({ values: [10, 20], labels: ['a', 'b'] })
    expect(() => parseSuite(source.replace('{{input.json}}', 'inline values'))).toThrow(/must inject/u)
  })

  it('rejects duplicate human review checklist content before a model run', () => {
    const source = `${base}
    review:
      required: true
      title: Inspect
      instructions: Check output
      checklist: [same item, same item]
      artifacts: [{ label: Result, path: result.json }]
`
    expect(() => parseSuite(source)).toThrow(/duplicate review checklist/u)
  })
})
