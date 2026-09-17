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

## Reporting to the human

The persona opens with a reporting contract for a non-technical owner: every
human-facing message leads with what will change for them and what they must
choose, each decision offers two or three concrete options with one marked as
recommended, the decision list is never built from internal identifiers or
infrastructure terms, and the owner is never asked to read or approve an internal
document. Mechanical internals stay with Trainer; implementation detail appears
only when the owner asks for it.

`tests/trainer-prompt.test.ts` asserts the contract in the prompt the real Loader
composes for a Trainer turn, so the wording cannot disappear silently.

## Standard capabilities and execution sessions

Runtime composes Trainer from the installed Harness `standard` preset and the
training tools. Trainer supplies its persona; standard tool guidance, planning,
compaction, skills, goals, web tools, background jobs and delegation remain part
of the assembled prompt and tool catalog. Host providers and optional capabilities
follow that Harness installation and its deployment configuration.

`trainer_workspace_prepare` returns `executionSessionId` and `handoff`. An analysis
session receives `handoff: true` and ends its turn. The Host persists and starts
one dedicated Trainer session with the prepared worktree as its immutable cwd.
When the Host provides a workspace registry, the worktree is registered as
`Training: <plan title>` for discovery in the Web workspace list.
That session continues the existing Plan at proposal creation, using native tools
and child agents in the worktree. Repeated preparation returns the same identity;
after Host recovery it resumes the saved session and preserves files and reviews.
A pending human review keeps execution waiting for its answer.

The Plan retains its analysis `sessionId` and records `executionSessionId`.
Both identities can access the Plan; other sessions can read its public summary.
Human requests belong to their submitting session. `trainer_plan_read` exposes
Plan review answers across the two sessions, and usage includes both sessions, execution descendants and
associated evaluations. Fork-inherited history is counted in its original session. Successful integration notifies the execution caller and
the original analysis session. Session cwd and main-checkout files retain their
normal Harness meanings throughout the handoff.
