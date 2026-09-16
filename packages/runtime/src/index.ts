/**
 * Purpose: Materialize reusable presets and resolve plugin exports for a host project.
 * Example: prepareRuntime({ projectRoot, runtimeHome }) installs Trainer and tester
 * presets; a caller's presetDirectory overwrites matching defaults before resolution.
 * Only generated presets and package links beneath runtimeHome are replaced. Failures
 * propagate before process launch; rerunning repairs a partially prepared runtime.
 */
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const presetDirectory = fileURLToPath(new URL('../config/presets/', import.meta.url))
export const hostPatch = fileURLToPath(new URL('../config/host.patch.yml', import.meta.url))
export const packages = ['session-insights-plugin', 'human-request-plugin', 'agent-test-plugin', 'trainer-agent', 'review-agent', 'sleep-loop-plugin', 'agent-pain-plugin', 'reflect-loop-plugin'].map(name => `@mozi-forge/${name}`)
export const pluginExports: Record<string, string> = {
  __FORGE_REVIEW_PLUGIN__: '@mozi-forge/review-agent/plugin',
  __FORGE_TRAINER_PLUGIN__: '@mozi-forge/trainer-agent/plugin',
  __FORGE_AGENT_TEST_TOOL_PLUGIN__: '@mozi-forge/agent-test-plugin/tool',
  __FORGE_SLEEP_LOOP_TOOLS__: '@mozi-forge/sleep-loop-plugin/tools',
}
export interface RuntimeOptions {
  projectRoot: string
  runtimeHome: string
  presetDirectory?: string
  pluginExports?: Record<string, string>
  packages?: string[]
}
/** Copy defaults, overlay caller presets, then resolve entries from the caller's dependencies.
 * Package names in ordinary YAML rows remain package names; runtime links make them
 * resolvable by the Loader. Missing optional preset directories are accepted.
 */
export async function prepareRuntime(options: RuntimeOptions): Promise<void> {
  const configured = JSON.parse(await readFile(join(options.projectRoot, 'config/runtime.json'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return '{}' })) as Pick<RuntimeOptions, 'pluginExports' | 'packages'>
  options = { ...configured, ...options, pluginExports: { ...configured.pluginExports, ...options.pluginExports }, packages: [...configured.packages ?? [], ...options.packages ?? []] }
  const home = resolve(options.runtimeHome), target = join(home, '.agent-presets')
  const require = createRequire(join(resolve(options.projectRoot), 'package.json'))
  await rm(target, { recursive: true, force: true })
  await cp(presetDirectory, target, { recursive: true })
  if (options.presetDirectory) await cp(options.presetDirectory, target, { recursive: true }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  const replacements = { ...pluginExports, ...options.pluginExports }
  async function rewrite(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { await rewrite(path); continue }
      if (!/\.ya?ml$/u.test(path)) continue
      let content = await readFile(path, 'utf8')
      for (const [marker, specifier] of Object.entries(replacements)) if (content.includes(marker)) content = content.replaceAll(marker, JSON.stringify(require.resolve(specifier)))
      if (/__[A-Z][A-Z0-9_]*__/u.test(content)) throw new Error(`Unresolved plugin export in ${path}`)
      await writeFile(path, content)
    }
  }
  await rewrite(target)
  for (const name of new Set([...packages, ...options.packages ?? []])) {
    const source = dirname(require.resolve(`${name}/package.json`)), link = join(home, 'node_modules', ...name.split('/'))
    await mkdir(dirname(link), { recursive: true }); await rm(link, { recursive: true, force: true })
    await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
}
