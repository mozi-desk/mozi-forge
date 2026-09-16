# Third-party notices

Forge uses the dependencies declared in package manifests and pnpm-lock.yaml.
Their licenses apply independently from Forge's Apache-2.0 license.

Browser builds generate `dist/THIRD_PARTY_NOTICES.txt` in the Human Request and
Agent Test packages. These files contain identities and license texts for dependency
code actually included in each bundle, derived from esbuild's input inventory.
They are included in package archives. The build fails if bundled dependency code
has no accompanying license text. Preserve these notices when redistributing.

External runtime dependencies remain separate packages with their own license files.
