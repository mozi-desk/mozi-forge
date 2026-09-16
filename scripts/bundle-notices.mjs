/** Purpose: Preserve licenses for dependency code included by esbuild.
 * Example: a bundled Markdown renderer contributes its package identity and license
 * text to dist/THIRD_PARTY_NOTICES.txt; only public package metadata is emitted.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
export async function writeBundleNotices(result) {
  const packages = new Map()
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes('node_modules/')) continue
    let directory = dirname(resolve(input))
    while (directory !== dirname(directory)) {
      const manifest = await readFile(join(directory, 'package.json'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })
      if (manifest) {
        const metadata = JSON.parse(manifest)
        if (metadata.name && !packages.has(metadata.name)) {
          const files = (await readdir(directory)).filter(name => /^(license|licence|notice|copying)(?:\..*)?$/iu.test(name))
          const texts = await Promise.all(files.map(async name => `${name}\n${await readFile(join(directory, name), 'utf8')}`))
          if (!texts.length) throw new Error(`Bundled dependency has no license text: ${metadata.name}`)
          packages.set(metadata.name, `${metadata.name}@${metadata.version}\nLicense: ${metadata.license ?? 'see license text'}\n\n${texts.join('\n\n')}`)
        }
        if (metadata.name) break
      }
      directory = dirname(directory)
    }
  }
  await writeFile('dist/THIRD_PARTY_NOTICES.txt', [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text).join('\n\n---\n\n') + '\n')
}
