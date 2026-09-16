/** Purpose: Prepare a coding runtime and launch Harness Web. Example: pnpm start -- --no-open. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareRuntime, hostPatch } from '@mozi-forge/runtime'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeHome = resolve(process.env.DSH_HOME ?? join(projectRoot, '.runtime'))
await prepareRuntime({ projectRoot, runtimeHome, presetDirectory: join(projectRoot, 'config/presets') })
const require = createRequire(import.meta.url)
const child = spawn(process.execPath, [join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js'), '--profile', 'web', '--patch', hostPatch, '--patch', join(projectRoot, 'config/web.patch.yml'), ...process.argv.slice(2)], { cwd: projectRoot, env: { ...process.env, DSH_HOME: runtimeHome }, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal))
process.exitCode = await new Promise<number>((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveExit(signal ? 128 : code ?? 1)) })
