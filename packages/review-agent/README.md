# review-agent

Review frozen evidence with structured findings.

## Public entry points

Package: `@mozi-forge/review-agent`. Exports: `.`, `./host`, `./types`, `./package.json`, `./plugin`.

## Usage and dependencies

Use the shared runtime host patch and presets as described in
[Configuration](../../docs/configuration.md). Runtime dependencies and their exact
constraints are declared in this module's package.json. Host services integrate
through public Harness services; client bundles use the declared DSH client metadata.

## Behavior

Validate structured results before persistence and notification. Bind review to frozen evidence and its owner.

See [Architecture](../../docs/architecture.md) and the
[training tutorial](../../docs/training.md) for the full composition.

## Verification

```sh
pnpm --filter @mozi-forge/review-agent typecheck
pnpm --filter @mozi-forge/review-agent lint
pnpm --filter @mozi-forge/review-agent test:unit
```

Root integration tests exercise shared services and the real Web execution path.
