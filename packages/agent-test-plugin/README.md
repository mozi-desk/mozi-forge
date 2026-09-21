# agent-test-plugin

Run isolated evaluations and present evidence.

## Public entry points

Package: `@mozi-forge/agent-test-plugin`. Exports: `.`, `./host`, `./tool`, `./client`, `./metrics`, `./types`, `./package.json`, `./inspection`, `./workcopy`, `./runner`, `./definition`, `./session-client`.

## Usage and dependencies

Use the shared runtime host patch and presets as described in
[Configuration](../../docs/configuration.md). Runtime dependencies and their exact
constraints are declared in this module's package.json. Host services integrate
through public Harness services; client bundles use the declared DSH client metadata.

## Behavior

Snapshot source and local dependencies, launch a separate Harness process, and persist reports. Support cancellation, recovery and artifact assessment. Plan-associated runs enter `waiting-review` and the owning Trainer records `pass` or `fail` with evidence through `agent_test_review`. Standalone runs use human review. Standalone human-request decisions map `approve` to a passed review and `request-changes` to a failed review; the response body is the reviewer note.

See [Architecture](../../docs/architecture.md) and the
[training tutorial](../../docs/training.md) for the full composition.

## Verification

```sh
pnpm --filter @mozi-forge/agent-test-plugin typecheck
pnpm --filter @mozi-forge/agent-test-plugin lint
pnpm --filter @mozi-forge/agent-test-plugin test:unit
```

Root integration tests exercise shared services and the real Web execution path.
