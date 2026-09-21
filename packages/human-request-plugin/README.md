# human-request-plugin

Persist human requests and deliver replies.

## Public entry points

Package: `@mozi-forge/human-request-plugin`. Exports: `.`, `./host`, `./client`, `./types`, `./package.json`.

## Usage and dependencies

Use the shared runtime host patch and presets as described in
[Configuration](../../docs/configuration.md). Runtime dependencies and their exact
constraints are declared in this module's package.json. Host services integrate
through public Harness services; client bundles use the declared DSH client metadata.

## Behavior

Requests contain Markdown and an open type string. Public respond RPC persists replies before notification; retries reuse request identity.

The request center follows the Harness global language preference. English and
Chinese dictionaries cover the tab, filters, form labels, empty state, and editable
quick replies. Harness resolves language-pack fallbacks to English and refreshes
localized slots when the language changes. Request Markdown and saved replies
retain their original content. Additional language packs can register dictionaries
under the `mozi-human-requests` namespace.

See [Architecture](../../docs/architecture.md) and the
[training tutorial](../../docs/training.md) for the full composition.

## Verification

```sh
pnpm --filter @mozi-forge/human-request-plugin typecheck
pnpm --filter @mozi-forge/human-request-plugin lint
pnpm --filter @mozi-forge/human-request-plugin test:unit
```

Root integration tests exercise shared services and the real Web execution path.
