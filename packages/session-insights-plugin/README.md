# session-insights-plugin

Capture revisioned session evidence and bounded analysis.

## Public entry points

Package: `@mozi-forge/session-insights-plugin`. Exports: `.`, `./host`, `./types`, `./package.json`, `./metrics`, `./store`, `./inspection`, `./contracts`, `./event-analysis`, `./budgets`, `./incremental`.

## Usage and dependencies

Use the shared runtime host patch and presets as described in
[Configuration](../../docs/configuration.md). Runtime dependencies and their exact
constraints are declared in this module's package.json. Host services integrate
through public Harness services; client bundles use the declared DSH client metadata.

## Behavior

Publish immutable revisions after their files and indexes exist. Query/read responses respect byte and row limits; derived evidence is redacted.

See [Architecture](../../docs/architecture.md) and the
[training tutorial](../../docs/training.md) for the full composition.

## Verification

```sh
pnpm --filter @mozi-forge/session-insights-plugin typecheck
pnpm --filter @mozi-forge/session-insights-plugin lint
pnpm --filter @mozi-forge/session-insights-plugin test:unit
```

Root integration tests exercise shared services and the real Web execution path.
