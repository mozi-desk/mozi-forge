/**
 * Purpose: Prove that isolated workcopies build and resolve dependencies on their own.
 * Flow: a disposable live tree with workspace packages and one external `file:` dependency is
 * copied twice; each copy must resolve and run its own source.
 * Example: `createWorkcopy(live, candidate)` then `createWorkcopy(candidate, snapshot)` — the
 * second copy resolves `@mozi/first` from its own `packages/` and `@scope/ext` from its own
 * `.snapshot-packages/` instead of an empty directory.
 * Edge case: the external package resolves through the first copy's snapshot, which used to be
 * misclassified as an in-repo path, leaving the second copy with an empty package directory.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { computeProjectSourceDigest } from '../src/runner.js'
import { createWorkcopy, linkWorkcopyDependencies, sourceInventory } from '../src/workcopy.js'
const roots: string[] = []
const execute = promisify(execFile)
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it('builds current source and resolves workspace dependencies inside each isolated copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-source-')); roots.push(root)
  const live = join(root, 'live'), candidate = join(live, '.runtime/candidate'), snapshot = join(candidate, '.runtime/tests/snapshot')
  for (const name of ['first', 'second']) {
    const pkg = join(live, 'packages', name)
    await mkdir(join(pkg, 'src'), { recursive: true }); await mkdir(join(pkg, 'dist'))
    await mkdir(join(pkg, 'node_modules/@mozi'), { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: `@mozi/${name}`, type: 'module', exports: './dist/index.js' }))
  }
  await mkdir(join(live, 'node_modules/@mozi'), { recursive: true })
  await symlink(join(live, 'packages/first'), join(live, 'node_modules/@mozi/first'))
  await symlink(join(live, 'packages/second'), join(live, 'packages/first/node_modules/@mozi/second'))
  await writeFile(join(live, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(live, 'packages/first/src/index.js'), 'import { value } from "@mozi/second"; export const answer = value + 1;')
  await writeFile(join(live, 'packages/second/src/index.js'), 'export const value = 4;')
  for (const name of ['first', 'second']) await writeFile(join(live, 'packages', name, 'dist/index.js'), 'export const value = 0; export const answer = 0;')
  const before = await sourceInventory(live)
  await createWorkcopy(live, candidate)
  const initialDigest = await computeProjectSourceDigest(candidate)
  await writeFile(join(candidate, 'packages/second/src/index.js'), 'export const value = 8;')
  expect(await computeProjectSourceDigest(candidate)).not.toBe(initialDigest)
  const build = 'const fs = require("node:fs"); for (const name of ["first", "second"]) fs.copyFileSync(`packages/${name}/src/index.js`, `packages/${name}/dist/index.js`);'
  await execute(process.execPath, ['-e', build], { cwd: candidate })
  const run = async (cwd: string) => (await execute(process.execPath, ['--input-type=module', '-e', 'import { answer } from "@mozi/first"; console.log(answer)'], { cwd })).stdout.trim()
  expect(await run(candidate)).toBe('9')
  expect(await run(live)).toBe('0')
  await createWorkcopy(candidate, snapshot)
  expect(await run(snapshot)).toBe('9')
  expect(await computeProjectSourceDigest(snapshot)).toBe(await computeProjectSourceDigest(candidate))
  expect(await sourceInventory(live)).toEqual(before)
  expect(await readFile(join(live, 'packages/second/src/index.js'), 'utf8')).toContain('value = 4')
})

it('re-copies an external file dependency that resolves through an earlier snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-nested-')); roots.push(root)
  const external = join(root, 'external/pkg'), live = join(root, 'live')
  const workcopy = join(live, '.runtime/workcopy'), checkout = join(live, '.runtime/checkout')
  await mkdir(join(external, 'dist'), { recursive: true })
  await writeFile(join(external, 'package.json'), JSON.stringify({ name: '@scope/ext', type: 'module', exports: './dist/index.js' }))
  await writeFile(join(external, 'dist/index.js'), 'export const value = 7;')
  await mkdir(join(live, 'node_modules/@scope'), { recursive: true })
  await symlink(external, join(live, 'node_modules/@scope/ext'))
  const manifest = JSON.stringify({ type: 'module', dependencies: { '@scope/ext': 'file:../external/pkg' } })
  await writeFile(join(live, 'package.json'), manifest)
  const run = async (cwd: string) => (await execute(process.execPath, ['--input-type=module', '-e', 'import { value } from "@scope/ext"; console.log(value)'], { cwd })).stdout.trim()
  await createWorkcopy(live, workcopy)
  expect(await run(workcopy)).toBe('7')
  // A merge-verification checkout holds only committed source, so it has no .snapshot-packages yet.
  await mkdir(checkout, { recursive: true })
  await writeFile(join(checkout, 'package.json'), manifest)
  await linkWorkcopyDependencies(workcopy, checkout)
  expect(await readFile(join(checkout, '.snapshot-packages/@scope/ext/package.json'), 'utf8')).toContain('@scope/ext')
  expect(await run(checkout)).toBe('7')
})
