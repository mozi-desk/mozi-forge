# trainer-agent

Turn evidence into reviewed improvements.

## Public entry points

Package: `@mozi-forge/trainer-agent`. Exports: `.`, `./host`, `./plugin`, `./types`, `./plan`, `./package.json`.

## Usage and dependencies

Use the shared runtime host patch and presets as described in
[Configuration](../../docs/configuration.md). Runtime dependencies and their exact
constraints are declared in this module's package.json. Host services integrate
through public Harness services; client bundles use the declared DSH client metadata.

## Behavior

Store plans and Markdown proposals; prepare one HEAD worktree per plan. Require reviewed tree identity for integration and preserve destination changes.

See [Architecture](../../docs/architecture.md) and the
[training tutorial](../../docs/training.md) for the full composition.

## Verification

```sh
pnpm --filter @mozi-forge/trainer-agent typecheck
pnpm --filter @mozi-forge/trainer-agent lint
pnpm --filter @mozi-forge/trainer-agent test:unit
```

Root integration tests exercise shared services and the real Web execution path.
