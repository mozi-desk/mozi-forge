# Configuration and embedding

## Local checkout

Build Forge first. In a separate pnpm application, declare required packages with
`file:../mozi-forge/packages/<package>` dependencies. Add matching `overrides` for
all transitive `@mozi-forge/*` packages in that application's `pnpm-workspace.yaml`.
This directs workspace references in local packages to the same local source.
Keep separate lockfiles. After rebuilding Forge, run `pnpm update '@mozi-forge/*'` in the application
so pnpm refreshes its installed local package copies and lockfile.

## Runtime API

```ts
import { prepareRuntime, hostPatch } from '@mozi-forge/runtime'

await prepareRuntime({
  projectRoot: process.cwd(),
  runtimeHome: '/tmp/example-agent-runtime',
  presetDirectory: '/path/to/application/config/presets',
  pluginExports: { __APP_PLUGIN__: '@example/agent/plugin' },
  packages: ['@example/agent'],
})
```

Pass `hostPatch` before the application's patch using repeated Harness `--patch`
arguments. Later patch rows replace the targeted row's complete configuration.
Pass `DSH_HOME` to the child. The caller owns its process and signal lifecycle.

Shared presets are `trainer`, `tester` and `reviewer`. The caller installs
`@deepseek-ai/dsh`; runtime derives Trainer capabilities from that installation's
shipped `standard` preset, including its adjacent assets. A standard Harness Host
profile supplies the matching providers and registries. Application preset files
replace matching shared files. Place plugin export mappings and additional package
names in `config/runtime.json` to use the same composition in startup and evaluation:

```json
{
  "pluginExports": { "__APP_PLUGIN__": "@example/agent/plugin" },
  "packages": ["@example/agent"],
  "snapshotExclude": ["local-artifacts"]
}
```

Explicit runtime options override file settings; plugin maps merge with explicit
entries last, and package lists combine. Unresolved placeholders fail preparation.
The API replaces generated `.agent-presets` and its own package links in the runtime
home. It does not launch processes.

## Evaluation configuration

Agent Test host accepts `projectRoot`, `suiteDirectory`, `defaultSuite`,
`startupTimeoutMs`, `evaluationPatch`, `pluginExports`, `additionalPackages`, and
`snapshotExclude`. The example's default suite is `coding-live`. Shared host config
reads `FORGE_AGENT_TEST_SUITE_DIRECTORY` and `FORGE_AGENT_TEST_EVALUATION_PATCH`.
Suite YAML chooses the tested preset. Local file/link/workspace dependencies are
copied into snapshots and included in input digests. Registry dependencies resolve
through the installed package store.

No API keys belong in example configuration. Configure providers through Harness
or inject credentials using its documented provider mechanism.
