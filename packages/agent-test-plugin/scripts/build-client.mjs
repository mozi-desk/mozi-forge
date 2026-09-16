/** Purpose: Bundle the browser client and preserve dependency license notices.
 * Example: pnpm build emits the DSH loader factory and third-party attribution. */
import { writeBundleNotices } from '../../../scripts/bundle-notices.mjs'
import { build } from 'esbuild'

const result = await build({
  metafile: true,
  entryPoints: ['src/client.tsx'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  sourcemap: true,
  external: ['react', 'react/jsx-runtime'],
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "@mozi-forge/agent-test-plugin", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
})

await writeBundleNotices(result)
