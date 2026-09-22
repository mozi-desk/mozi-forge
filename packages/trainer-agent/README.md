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

Store plans and Markdown proposals; prepare one HEAD worktree per plan. The human approves one plan describing what changes, why, and acceptance criteria. Trainer implements and assesses evaluation artifacts, then calls `trainer_merge(plan_id, checks, target_branch?)`. Host verifies the exact candidate in isolation, preserves destination changes and saves an idempotent integration receipt.

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

The persona opens with a reporting contract for a non-technical owner: the plan describes the observable changes, their reasons and acceptance criteria. Meaningful alternatives offer two or three concrete options with one marked as recommended; the decision list is never built from internal identifiers or
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
That session continues the existing Plan at autonomous implementation, using native tools
and child agents in the worktree. Repeated preparation returns the same identity;
after Host recovery it resumes the saved session and preserves files and reviews.
For `human_request_submit(type=plan-review, planId=...)`, the Host checks Plan ownership and fills the displayed title and body from the saved Plan before persisting the request. The caller can use a short body identifying the review. Workspace preparation requires approval of that saved scope; updated scope requires a new plan decision. A review persisted before plan reviews carried the saved scope (the legacy `training-plan-review` type) still authorizes its Plan when the human recorded the `approve` decision and the Plan was not saved again after that answer; its Trainer-written body is accepted in place of body equality.

A training root may be a composite checkout: when `.gitmodules` pins submodules, `trainer_workspace_prepare` mounts each pinned project as a worktree of its own repository on the plan branch (`trainer/<plan id>`) instead of cloning a second object store, and installs dependencies inside it. `trainer_merge` refuses uncommitted submodule content, freezes each project's commit in the composite tree, and fast-forwards every pinned project before it moves the composite pointer; the receipt records those commits. A root without `.gitmodules` keeps the single-repository behaviour.

The Plan retains its analysis `sessionId` and records `executionSessionId`.
Both identities can access the Plan; other sessions can read its public summary.
Human requests belong to their submitting session. `trainer_plan_read` exposes
Plan review answers across the two sessions, and usage includes both sessions, execution descendants and
associated evaluations. Fork-inherited history is counted in its original session. Successful integration notifies the execution caller and
the original analysis session. Session cwd and main-checkout files retain their
normal Harness meanings throughout the handoff.

### External session investigation

The agent plugin accepts `sessionInvestigation`, a deployment-owned investigation
workflow. When supplied, it replaces the default session investigation instructions
and omits the local `session_inspect` tool. The deployment provides its investigation
and import tools; `session_query` and `session_read` remain available for frozen
evidence. Reflect tasks follow this configured workflow.
