# sleep-loop-plugin

Schedule incremental session analysis.

## Public entry points

Package: `@mozi-forge/sleep-loop-plugin`. Exports: `.`, `./host`, `./tools`, `./engine`, `./package.json`.

## Usage and dependencies

Use the shared runtime host patch and presets as described in
[Configuration](../../docs/configuration.md). Runtime dependencies and their exact
constraints are declared in this module's package.json. Host services integrate
through public Harness services; client bundles use the declared DSH client metadata.

## Behavior

Use DSH_HOME, bounded changed-session summaries and a fixed 24-hour deadline. Persist delivery identity before waking the target; retries reuse it.

See [Architecture](../../docs/architecture.md) and the
[training tutorial](../../docs/training.md) for the full composition.

## Verification

```sh
pnpm --filter @mozi-forge/sleep-loop-plugin typecheck
pnpm --filter @mozi-forge/sleep-loop-plugin lint
pnpm --filter @mozi-forge/sleep-loop-plugin test:unit
```

Root integration tests exercise shared services and the real Web execution path.
