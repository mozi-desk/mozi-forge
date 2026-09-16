# runtime

Compose reusable presets and host settings.

## Public entry points

Package: `@mozi-forge/runtime`. Exports: `.`, `./package.json`, `./presets/*`, `./host.patch.yml`.

## Usage and dependencies

Use the shared runtime host patch and presets as described in
[Configuration](../../docs/configuration.md). Runtime dependencies and their exact
constraints are declared in this module's package.json. Host services integrate
through public Harness services; client bundles use the declared DSH client metadata.

## Behavior

Copies defaults, overlays caller presets and resolves package exports. The caller owns process startup.

See [Architecture](../../docs/architecture.md) and the
[training tutorial](../../docs/training.md) for the full composition.

## Verification

```sh
pnpm --filter @mozi-forge/runtime typecheck
pnpm --filter @mozi-forge/runtime lint
pnpm --filter @mozi-forge/runtime test:unit
```

Root integration tests exercise shared services and the real Web execution path.

## Trainer composition

The caller installs `@deepseek-ai/dsh` alongside Forge. Preparation reads that
installation's shipped `standard` preset, copies its assets beneath the generated
Trainer preset, and resolves its plugins from the same installation. Trainer
provides the persona while standard tools and their guidance remain assembled.
Caller preset files overlay this generated composition last. Use a Harness Host
profile such as `web` or `headless` to supply the standard providers and registries.
