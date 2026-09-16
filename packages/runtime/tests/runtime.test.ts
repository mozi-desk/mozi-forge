/** Purpose: Validate preset overlay and installed package resolution through the public runtime API.
 * Example: a project overrides tester while Trainer retains resolved Forge defaults.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { prepareRuntime } from '../src/index.js'
it('overlays caller presets, resolves exports and repairs generated copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-runtime-'))
  const projectRoot = resolve(import.meta.dirname, '../../..')
  try {
    const presets = join(root, 'input'), home = join(root, 'home')
    await mkdir(join(presets, 'tester'), { recursive: true })
    await writeFile(join(presets, 'tester/agent.cordis.yml'), '- id: custom\n  name: __CUSTOM__\n')
    const options = { projectRoot, runtimeHome: home, presetDirectory: presets, pluginExports: { __CUSTOM__: '@mozi-forge/agent-test-plugin/tool' } }
    await prepareRuntime(options)
    expect(await readFile(join(home, '.agent-presets/tester/agent.cordis.yml'), 'utf8')).toMatch(/id: custom[\s\S]+dist\/tool.js/u)
    expect(await readFile(join(home, '.agent-presets/trainer/agent.cordis.yml'), 'utf8')).not.toContain('__FORGE_')
    const standard = await readFile(join(home, '.agent-presets/trainer/standard/agent.cordis.yml'), 'utf8')
    expect(standard).toContain('id: tool-subagent')
    expect(standard).toContain('id: tool-fs')
    expect(standard).not.toMatch(/^- id: persona$/mu)
    expect(standard).not.toMatch(/name: ['"]@deepseek-ai\//u)
    await writeFile(join(home, '.agent-presets/obsolete.yml'), 'obsolete')
    await prepareRuntime(options)
    await expect(readFile(join(home, '.agent-presets/obsolete.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
