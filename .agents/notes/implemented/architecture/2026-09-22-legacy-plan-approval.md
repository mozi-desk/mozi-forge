# Legacy plan approvals after the single-review upgrade

Status: implemented

## Problem

Plan review was renamed from `training-plan-review` to `plan-review`, and workspace
preparation began requiring the persisted review body to equal the saved Plan body.
Records written before that change kept the old type and a Trainer-written review body,
so a genuinely approved Plan could no longer pass `requireApproval` and reported
`Plan approval required` forever. Repairing those records by hand does not scale and
leaves an upgrade path that silently disables already-reviewed Plans.

## Decision

`requireApproval` recognizes both record types and still demands the human's structured
`approve` decision in each case:

- `plan-review` keeps the strict contract: the persisted body must equal the saved Plan
  body, so editing the Plan invalidates its approval.
- `training-plan-review` accepts its Trainer-written body and instead requires that the
  Plan was not saved again after the answer (`plan.updatedAt` absent or not later than
  `response.answeredAt`). That timestamp is the analogue of body equality for a record
  whose body cannot match the saved Plan body.

A free-text legacy answer without a decision is not an approval, an answer from another
session never authorizes the Plan, and any other request type stays rejected, so the gate
never opens without a human decision on the current scope.

## Alternatives

Migrating records on read would rewrite human evidence and had to invent a decision for
answers that only contained prose. Accepting any answered legacy request would promote
"please adjust" answers into approvals. Requiring body equality for legacy records leaves
them permanently blocked, which is the reported defect. Both-record support is the
smallest change that repairs upgrades without loosening the gate.

## Verification

- `vitest run tests/trainer.integration.test.ts`: baseline with the previous
  `requireApproval` fails the new black-box case with `Plan approval required`; after the
  change the same file passes 23/23.
- The new case submits a legacy review, asserts its persisted body differs from the Plan
  body, approves it, prepares the worktree, and then re-saves the Plan to confirm the
  stale approval is rejected again. A legacy answer without a decision is rejected.
- Package typecheck, lint and the workspace test command are recorded in the training
  Plan evidence.

## Consequences

Pre-upgrade approvals authorize their unchanged Plans again. The legacy branch can only
match records carrying an explicit `approve` decision, so deployments that never recorded
structured decisions still need a new review. Keeping the legacy type in the comparison
is intentional documentation of an upgrade boundary.
