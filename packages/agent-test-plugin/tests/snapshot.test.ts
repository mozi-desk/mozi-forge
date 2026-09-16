/** Purpose: Exercise local file dependencies through the public snapshot and digest APIs.
 * Example: a local plugin changes after snapshot creation; the frozen snapshot retains
 * its original source while a subsequent snapshot has a different digest.
 */
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createWorkcopy } from '../src/workcopy.js'
import { computeProjectSourceDigest } from '../src/runner.js'
it('freezes external local packages and resolves transitive links within the snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-snapshot-'))
  try {
    const app = join(root, 'app'), plugin = join(root, 'plugin'), snapshot = join(root, 'snapshot')
    await mkdir(join(app, 'node_modules'), { recursive: true }); await mkdir(join(plugin, 'src'), { recursive: true })
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'sample-app', dependencies: { 'sample-plugin': 'file:../plugin' } }))
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'sample-plugin', version: '1.0.0' }))
    await writeFile(join(plugin, 'src/index.js'), 'export const value = 1\n')
    await symlink(plugin, join(app, 'node_modules/sample-plugin'), 'dir')
    await createWorkcopy(app, snapshot)
    const frozen = await realpath(join(snapshot, 'node_modules/sample-plugin'))
    expect(frozen.startsWith(await realpath(snapshot))).toBe(true)
    const before = await computeProjectSourceDigest(snapshot)
    expect(before).toBe(await computeProjectSourceDigest(app))
    await writeFile(join(plugin, 'src/index.js'), 'export const value = 2\n')
    expect(await readFile(join(frozen, 'src/index.js'), 'utf8')).toContain('value = 1')
    expect(await computeProjectSourceDigest(snapshot)).toBe(before)
    await createWorkcopy(app, join(root, 'next'))
    expect(await computeProjectSourceDigest(join(root, 'next'))).not.toBe(before)
  } finally { await rm(root, { recursive: true, force: true }) }
})
