# reflect-loop-plugin

Group feedback into reviewable reflection work.

## Public entry points

Package: `@mozi-forge/reflect-loop-plugin`. Exports: `.`, `./host`, `./tools`, `./engine`, `./package.json`, `./types`, `./contracts`.

## Usage and dependencies

Use the shared runtime host patch and presets as described in
[Configuration](../../docs/configuration.md). Runtime dependencies and their exact
constraints are declared in this module's package.json. Host services integrate
through public Harness services; client bundles use the declared DSH client metadata.

## Behavior

Deliver bounded work to Trainer and record feedback coverage. Integration receipts resolve the reviewed coverage.

See [Architecture](../../docs/architecture.md) and the
[training tutorial](../../docs/training.md) for the full composition.

## Verification

```sh
pnpm --filter @mozi-forge/reflect-loop-plugin typecheck
pnpm --filter @mozi-forge/reflect-loop-plugin lint
pnpm --filter @mozi-forge/reflect-loop-plugin test:unit
```

Root integration tests exercise shared services and the real Web execution path.
