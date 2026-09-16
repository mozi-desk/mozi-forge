import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeProjectSourceDigest } from '../src/runner.js'

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('Agent Test source digest', () => {
  it('binds tests to prompts, presets, dependencies, and suite definitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-test-digest-'))
    roots.push(root)
    await mkdir(join(root, 'packages/agent/prompts'), { recursive: true })
    await mkdir(join(root, 'config/presets/agent'), { recursive: true })
    await mkdir(join(root, 'tests/agent-evals'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    await writeFile(join(root, 'packages/agent/package.json'), '{"name":"@mozi/agent"}')
    await writeFile(join(root, 'packages/agent/prompts/prompt.md'), 'before')
    await writeFile(join(root, 'config/presets/agent/agent.cordis.yml'), '[]')
    await writeFile(join(root, 'tests/agent-evals/suite.yml'), 'version: 1')
    const before = await computeProjectSourceDigest(root)
    await writeFile(join(root, 'packages/agent/prompts/prompt.md'), 'after')
    expect(await computeProjectSourceDigest(root)).not.toBe(before)
  })

  it('tracks source and built package surfaces copied into an Agent Test snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-test-digest-'))
    roots.push(root)
    await mkdir(join(root, 'packages/agent/dist'), { recursive: true })
    await mkdir(join(root, 'packages/agent/src'), { recursive: true })
    await writeFile(join(root, 'packages/agent/package.json'), '{"name":"@mozi/agent"}')
    await writeFile(join(root, 'packages/agent/dist/plugin.js'), 'built')
    await writeFile(join(root, 'packages/agent/src/plugin.ts'), 'source before')
    const before = await computeProjectSourceDigest(root)
    await writeFile(join(root, 'packages/agent/src/plugin.ts'), 'source after')
    expect(await computeProjectSourceDigest(root)).not.toBe(before)
    await writeFile(join(root, 'packages/agent/dist/plugin.js'), 'rebuilt')
    expect(await computeProjectSourceDigest(root)).not.toBe(before)
  })
})
