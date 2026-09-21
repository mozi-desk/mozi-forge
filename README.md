# Mozi Forge

A foundation for self-evolving AI agents, built on DeepSeek Harness.

Forge combines session evidence, feedback collection, reflection, training plans,
human plan approval, isolated evaluation, and autonomous verified integration. Agents propose improvements;
host services execute operations and preserve reviewable evidence.

## Quick start

Requirements: Node.js 24 or newer, Git, and pnpm 11.7.0. Install the pinned pnpm
version using Corepack or your package manager.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start -- --no-open
```

Open the local URL printed by Harness. Configure your model provider through
Harness's settings interface. The example selects `deepseek-official/deepseek-v4-flash`.
The coding agent uses a local shell: use a dedicated development directory with
only the files you intend the agent to access.

## Capabilities

| Module | Responsibility |
| --- | --- |
| [Runtime](packages/runtime/README.md) | Shared presets, host configuration, plugin resolution |
| [Session Insights](packages/session-insights-plugin/README.md) | Bounded, revisioned session evidence |
| [Agent Pain](packages/agent-pain-plugin/README.md) | Durable feedback and execution signals |
| [Reflect Loop](packages/reflect-loop-plugin/README.md) | Group feedback and deliver reflection work |
| [Sleep Loop](packages/sleep-loop-plugin/README.md) | Schedule incremental session analysis |
| [Trainer](packages/trainer-agent/README.md) | Reviewed plans, isolated changes, integration |
| [Agent Test](packages/agent-test-plugin/README.md) | Isolated evaluations and reports |
| [Human Request](packages/human-request-plugin/README.md) | Persistent requests and human replies |
| [Review Agent](packages/review-agent/README.md) | Structured review of frozen evidence |

## Documentation

- [Architecture](docs/architecture.md)
- [Configuration and embedding](docs/configuration.md)
- [Training and evaluation tutorial](docs/training.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

Packages use the `@mozi-forge/*` namespace. This checkout is the source of the
initial release; publishing is a separate maintainer action. See the configuration
guide for local consumption and the [release checklist](docs/releasing.md).

## Development

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm check:pack
```

Deterministic tests use scripted model responses with real Harness services, Web
RPC, subprocesses and temporary Git repositories. They do not require provider keys.
Live provider behavior requires a separately configured provider.

## License

[Apache License 2.0](LICENSE). Dependency licenses remain applicable to their
respective packages; see [third-party notices](THIRD_PARTY_NOTICES.md).
