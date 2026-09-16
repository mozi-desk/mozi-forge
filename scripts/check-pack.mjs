/** Purpose: Build package archives, validate their published exports and install them together.
 * Example: pnpm check:pack verifies a clean consumer can load every declared export.
 * All archives and installed artifacts live in a disposable directory removed on exit.
 */
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(join(tmpdir(), 'forge-pack-'))
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`)
  return result.stdout
}
try {
  const dependencies = {}, specifiers = []
  for (const name of await readdir(join(root, 'packages'))) {
    const directory = join(root, 'packages', name)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    run('pnpm', ['pack', '--pack-destination', temporary], directory)
    const filename = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
    const archive = join(temporary, filename), files = run('tar', ['-tzf', archive]).trim().split('\n')
    if (!files.includes('package/LICENSE')) throw new Error(`Missing license: ${name}`)
    const packed = JSON.parse(run('tar', ['-xOf', archive, 'package/package.json']))
    for (const version of Object.values(packed.dependencies ?? {})) if (/^(workspace:|file:|link:)/u.test(version)) throw new Error(`Local dependency in ${name}`)
    for (const [entry, target] of Object.entries(manifest.exports)) {
      const value = typeof target === 'string' ? target : target.default
      if (value.includes('*')) continue
      if (!files.includes(`package/${value.slice(2)}`)) throw new Error(`Missing export ${name}${entry}: ${value}`)
      if (value.endsWith('.js') && entry !== './client') specifiers.push(manifest.name + (entry === '.' ? '' : entry.slice(1)))
    }
    if (files.some(file => /(?:^|\/)\.env|\.runtime|node_modules/u.test(file))) throw new Error(`Unexpected private artifacts in ${name}`)
    dependencies[manifest.name] = `file:${archive}`
  }
  const consumer = join(temporary, 'consumer'); await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }))
  // Keep provider peer versions identical to the tested workspace.
  const workspace = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')
  await writeFile(join(consumer, 'pnpm-workspace.yaml'), workspace.replace('packages:\n  - packages/*\n\n', '').replace('overrides:\n', 'overrides:\n' + Object.entries(dependencies).map(([name, value]) => `  '${name}': '${value}'\n`).join('')))
  run('pnpm', ['install', '--ignore-scripts'], consumer)
  run(process.execPath, ['--input-type=module', '-e', `for (const name of ${JSON.stringify(specifiers)}) await import(name); console.log('exports loaded')`], consumer)
  console.log(`Validated ${Object.keys(dependencies).length} archives and ${specifiers.length} exports in a clean consumer.`)
} finally { await rm(temporary, { recursive: true, force: true }) }
