/** Isolated source copies and workspace-local dependency links. Example: createWorkcopy(repo, snapshot). */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, symlink } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const excluded = new Set(['.git', '.runtime', '.pnpm-store', 'node_modules', 'coverage', '.cache', '.npmrc', '.DS_Store', '.credentials.yaml', '.credentials.yml', '.netrc', '.ssh', '.aws'])
export function workcopyPath(path: string): boolean {
  return !path.split(/[\\/]/u).some(part => excluded.has(part) || part.startsWith('.env') || /\.(?:pem|key|p12)$/iu.test(part))
}

/** Locate installed package metadata without requiring a package.json export.
 * Example: an ESM-only rendering dependency exposes its entry but hides metadata;
 * Node's module search directories still identify the installed package root. */
export async function resolvePackageDirectory(from: string, name: string): Promise<string> {
  const require = createRequire(join(from, 'package.json'))
  for (const base of require.resolve.paths(name) ?? []) {
    const directory = join(base, name)
    if (await lstat(join(directory, 'package.json')).catch(() => undefined)) return realpath(directory)
  }
  throw new Error(`Cannot resolve installed dependency ${name} from ${from}`)
}

/** Copy the current working tree, including uncommitted source, with local workspace links. */
export async function createWorkcopy(source: string, destination: string, excludedPaths: string[] = []): Promise<void> {
  source = await realpath(source)
  destination = resolve(destination)
  await mkdir(destination, { recursive: true })
  const filter = async (path: string): Promise<boolean> => {
    if (excludedPaths.some(excluded => relative(source, path).split(sep).includes(excluded)) || path === destination || path.startsWith(`${destination}${sep}`) || !workcopyPath(relative(source, path))) return false
    // Copy regular source only; dependency symlinks are recreated separately below.
    return !(await lstat(path)).isSymbolicLink()
  }
  // Evaluation snapshots normally live beneath source/.runtime. Copy entries so Node's
  // whole-directory self-copy check does not reject this excluded destination.
  for (const entry of await readdir(source)) {
    const path = join(source, entry)
    if (await filter(path)) await cp(path, join(destination, entry), { recursive: true, filter })
  }
  await linkWorkcopyDependencies(source, destination)
}

/** Link installed dependencies while resolving workspace packages to destination source.
 * Example: @example/second imported by first resolves to destination/packages/second.
 * External immutable packages share their existing store paths; local builds stay local.
 */
export async function linkWorkcopyDependencies(source: string, destination: string): Promise<void> {
  const workspacePackages = new Map<string, string>()
  const sources = new Map<string, string>()
  /** Discover local dependency declarations recursively, copying external local packages
   * once. Registry dependencies keep their immutable installed store paths. */
  async function discover(root: string, output: string): Promise<void> {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return '{}' }))
    if (manifest.name && sources.has(manifest.name)) return
    if (manifest.name) { sources.set(manifest.name, root); workspacePackages.set(manifest.name, output) }
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (typeof version !== 'string' || !/^(?:workspace:|file:|link:)/u.test(version) || sources.has(name)) continue
      const dependency = await resolvePackageDirectory(root, name)
      const rel = relative(source, dependency)
      const internal = !rel.startsWith('..') && !rel.split(sep).includes('node_modules')
      const target = internal ? join(destination, rel) : join(destination, '.snapshot-packages', ...name.split('/'))
      if (!internal) await cp(dependency, target, { recursive: true, filter: async path => workcopyPath(relative(dependency, path)) && !(await lstat(path)).isSymbolicLink() })
      await discover(dependency, target)
    }
  }
  await discover(source, destination)
  const entries = await readdir(join(source, 'packages'), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return [] })
  for (const entry of entries) if (entry.isDirectory()) await discover(join(source, 'packages', entry.name), join(destination, 'packages', entry.name))
  async function links(from: string, to: string, scope = ''): Promise<void> {
    const entries = await readdir(from, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return [] })
    if (!entries.length) return
    await mkdir(to, { recursive: true })
    for (const entry of entries) {
      const path = join(from, entry.name), output = join(to, entry.name)
      if (entry.name.startsWith('@') && entry.isDirectory()) { await links(path, output, `${entry.name}/`); continue }
      const actual = await realpath(path)
      const rel = relative(source, actual)
      const internal = !rel.startsWith('..') && !rel.split(sep).includes('node_modules')
      if (entry.name === '.bin') { await cp(path, output, { recursive: true }); continue }
      await symlink(workspacePackages.get(`${scope}${entry.name}`) ?? (internal ? join(destination, rel) : actual), output, 'dir')
    }
  }
  await links(join(source, 'node_modules'), join(destination, 'node_modules'))

  for (const [name, root] of sources) {
    if (root === source) continue
    const output = workspacePackages.get(name)!
    await links(join(root, 'node_modules'), join(output, 'node_modules'))
    // pnpm file packages resolve declared dependencies from a parent store directory,
    // so a package-local node_modules inventory alone is insufficient after copying.
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies, ...manifest.devDependencies })) {
      const link = join(output, 'node_modules', ...dependency.split('/'))
      if (await lstat(link).catch(() => undefined)) continue
      let installed: string
      try { installed = await resolvePackageDirectory(root, dependency) }
      catch (error) {
        if (manifest.dependencies?.[dependency]) throw error
        continue
      }
      await mkdir(dirname(link), { recursive: true })
      await symlink(workspacePackages.get(dependency) ?? installed, link, 'dir')
    }
  }

}

/** Authoring files have a separate inventory so build output cannot hide out-of-scope writes. */
export async function sourceInventory(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  async function walk(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(directory, entry.name), rel = relative(root, path)
      if (!workcopyPath(rel) || entry.name === 'dist' || entry.name.endsWith('.tsbuildinfo')) continue
      if (entry.isSymbolicLink()) throw new Error(`SOURCE_SYMLINK: ${rel}`)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files[rel.split(sep).join('/')] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
  }
  await walk(root)
  return files
}
