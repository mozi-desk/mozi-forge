# agent-pain-plugin

Persist human feedback and execution signals.

## Public entry points

Package: `@mozi-forge/agent-pain-plugin`. Exports: `.`, `./host`, `./engine`, `./package.json`, `./types`, `./prompt`, `./contracts`, `./storage`, `./collector`.

## Usage and dependencies

Use the shared runtime host patch and presets as described in
[Configuration](../../docs/configuration.md). Runtime dependencies and their exact
constraints are declared in this module's package.json. Host services integrate
through public Harness services; client bundles use the declared DSH client metadata.

## Behavior

Persist facts with atomic JSON writes. Keep issue interpretation in agent prompts and preserve replayable collection progress.

See [Architecture](../../docs/architecture.md) and the
[training tutorial](../../docs/training.md) for the full composition.

## Verification

```sh
pnpm --filter @mozi-forge/agent-pain-plugin typecheck
pnpm --filter @mozi-forge/agent-pain-plugin lint
pnpm --filter @mozi-forge/agent-pain-plugin test:unit
```

Root integration tests exercise shared services and the real Web execution path.
