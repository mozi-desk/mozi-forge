# Agent Note: Standard Trainer capabilities and worktree execution sessions

Status: implemented

## Problem

Trainer needs the coding, context, delegation and workflow capabilities supplied
by the installed Harness standard preset. Native tools, instruction discovery,
Skills and child agents derive their directory from immutable session metadata.
A prepared training worktree therefore needs its own execution session.

## Decision

Runtime derives the capability composition from the caller's installed Harness
standard preset, copies adjacent assets and resolves plugin entry points from
that same installation. Trainer supplies the persona; standard tool guidance,
Plan mode and compaction remain composed. Caller preset overlays apply last.
This extends the runtime composition recorded in
[Runtime composition and isolated evaluation inputs](2026-09-15-runtime-and-evaluation-inputs.md).

A TrainingPlan retains its analysis sessionId and records one executionSessionId.
Preparing the worktree persists that identity before creating its Trainer session.
The session's cwd is the worktree; native tools and spawn/fork descendants inherit
Harness directory semantics. A Host workspace registry receives the worktree
registration so Web can list the execution session. The preparation result reports handoff and the
execution identity. The analysis agent ends its turn; execution continues the
existing Plan at proposal creation. Delegated agents perform their assigned tasks
under the execution agent's training workflow.

Execution startup persists an identified inbox message before waking the loop.
Repeated preparation reuses the identity. Repeating preparation after service
reload resumes persisted execution, preserves work, and respects pending human
reviews. Session-owned human requests retain their delivery and merge-approval
identity. Both Plan sessions can inspect saved Plan reviews. Successful integration
notifies its caller and the analysis session. Token accounting folds each session
separately, includes execution descendants, and excludes their inherited prefixes.

## Alternatives

- Extending Harness with a mutable working-directory API would change its session
  and capability contracts. The selected implementation boundary is Forge only.
- Maintaining a separate standard tool list would drift from the installed release.
- Independent shell directory routing would leave filesystem, Skills and delegated
  work pointed at a different directory.

## Verification

- Package builds passed for the Forge workspace.
- Runtime and Trainer unit tests passed: 2 tests.
- Trainer, Pain integration and complete Web acceptance passed: 22 tests.
- The Web model fixture asserts the native standard tool catalog and executes file
  tools, a Skill and a real delegated Agent. Logged instructions and Skill content
  originate in the worktree; the delegated shell reports that same directory.
- Public-tool integration checks shell/filesystem/background-job cwd, distinct
  concurrent worktrees, idempotent preparation, persisted session recovery, review
  ownership and approved local integration. All Git operations and processes use
  disposable test repositories and homes.
- Type checking and focused lint passed. Web acceptance uses scripted model
  transport; external provider quality and live web search were not tested.

## Consequences

Embedding applications install Harness and use a Host profile supplying its
standard registries/providers. Optional capabilities follow that deployment's
standard configuration. Training appears as an analysis session plus an execution
session. Local file-package consumers refresh Forge dependencies after building.

Executed checks (Node 26, local checkout):

```sh
pnpm run build:trainer
pnpm --filter @mozi-forge/trainer-agent --filter @mozi-forge/runtime build
pnpm --filter @mozi-forge/runtime --filter @mozi-forge/trainer-agent typecheck
pnpm exec tsc -p tsconfig.json --noEmit
pnpm --filter @mozi-forge/runtime --filter @mozi-forge/trainer-agent test:unit
pnpm exec vitest run tests/trainer.integration.test.ts tests/trainer.web.test.ts tests/pain.integration.test.ts
pnpm exec oxlint packages/runtime/src packages/runtime/tests packages/trainer-agent/src packages/trainer-agent/tests tests/trainer-fixture.ts tests/trainer.integration.test.ts tests/trainer-web-fixture.ts tests/trainer-web-verification.ts tests/fixtures/trainer-loop-llm.mjs
git diff --check
```
