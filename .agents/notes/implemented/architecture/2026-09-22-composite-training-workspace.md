# Composite training workspaces

Status: implemented

## Problem

Training worktrees live outside the repository parent directory, so a project whose packages
resolve through `file:../<sibling>/...` cannot install dependencies there. Preparation fell
back to linking dependencies from the main checkout, and verification of an integration
candidate linked a second time from that workcopy, which produced empty package directories.
Cross-repository plans had no way to express both changes as one verifiable candidate.

## Decision

A training root may be a superproject. When the root declares `.gitmodules`:

- `trainer_workspace_prepare` records each pinned commit from the plan's base tree and mounts
  every submodule as `git worktree add -b trainer/<plan id> <workspace>/<path> <commit>` of the
  sibling checkout. One object store per repository, sibling `file:` dependencies resolve, and
  the plan branch already lives where integration expects it. Submodule cloning is not used
  because a worktree-local clone would hide training commits from the repository that lands them.
- Dependencies are installed with `pnpm install --frozen-lockfile --prefer-offline` inside every
  pinned project, because only a real install resolves sibling paths in that layout.
- `trainer_merge` refuses uncommitted submodule content, records each project's commit as a
  gitlink in the composite candidate, mounts the candidate commits in the verification worktree,
  and fast-forwards every pinned project before it moves the composite pointer. The receipt lists
  the integrated project commits, so a partially landed plan is visible.
- Deployments set the training root explicitly (`TRAINER_PROJECT_ROOT`); the default stays the
  launching working directory, and a root without `.gitmodules` behaves exactly as before.

The worked example is a local superproject pinning `mozi-forge`, `mozi-agent-v2` and
`calendar-plugins`, so a training worktree carries the sibling layout those projects expect.

## Alternatives

Copying or linking dependencies per workcopy cannot express sibling `file:` paths. Cloning
submodules inside each training worktree duplicates object stores and separates training commits
from the repositories that integrate them. Making the projects themselves submodule-aware would
impose the composite layout on every other user of those repositories.

## Verification

- `tests/trainer.integration.test.ts`: a superproject fixture mounts its pinned project on the
  plan branch, refuses dirty submodule content, integrates the project commit before the
  composite pointer, and leaves no stale mount. Full forge suite: 28 integration tests and all
  package unit tests pass; typecheck and lint are clean.
- `packages/agent-test-plugin/tests/workcopy.test.ts`: a merge-verification shaped link now copies
  a dependency that resolves through an earlier snapshot (fails before the fix).
- The local superproject was verified by creating a worktree, mounting the pinned projects,
  running an install there and executing the trainer integration suite inside it.

## Consequences

A composite root adds one concept (pinned projects are worktrees of their own repositories) and
makes cross-repository candidates verifiable end to end. Each training worktree carries its own
installed dependencies, which the shared pnpm store keeps cheap. Integration is not atomic across
repositories: pinned projects move first and the composite pointer last, and the receipt records
exactly what landed.
