import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { computeProjectSourceDigest } from '../src/runner.js'
import { createWorkcopy, sourceInventory } from '../src/workcopy.js'
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
