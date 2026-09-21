# Single plan approval and autonomous execution

Status: implemented

## Decision

The human reviews one plan explaining what changes, why, and how success is
accepted. Its saved Markdown is submitted as `plan-review`; workspace preparation
and integration require an explicit approval matching the current body. Execution
sessions, reflection and sleep instructions all continue autonomously within that
scope. Internal implementation notes and baseline/candidate evidence remain available.

Trainer evaluates registered artifacts against the approved criteria and records
an evidence-based pass/fail through `agent_test_review`. Plan-associated evaluations
use `waiting-review`, notify their owner and retain their assessments across recovery.
The tool enforces run ownership and persists the rationale. Identical retries reuse
the assessment. Standalone evaluations retain their human assessment workflow.
Artifact paths are compared against the canonical run directory, including macOS
filesystem aliases.

`trainer_merge(plan_id, checks, target_branch?)` captures a candidate and verifies
it in an isolated integration worktree before updating the local branch. The latest
evaluation in each suite must pass, including its required artifact assessment.
A failed baseline can be superseded by a successful candidate. Verification commands
are required and run for both unchanged and advanced destinations. Dirty destinations,
conflicts, changed scope and concurrent source changes preserve the destination.
An integration record written before the Git update supports receipt recovery.

## Verification

Public-interface checks cover the single plan decision, scope changes, artifact
ownership, assessment persistence and retries, failed verification, advanced branches,
source mutation during checks, dirty destinations and interrupted receipt recovery.
The scripted Web test uses two source sessions, one human decision, actual evaluation
subprocesses, artifact reads and agent assessments, then a local integration in a
disposable repository. It demonstrates protocol behavior with a scripted model.

Forge build, typecheck, lint, 104 module tests and 24 integration/prompt/Web tests passed. Lint reports existing unused
imports in other host modules. RSI build, typecheck and 15 tests passed after refreshing
its local Forge packages. The existing application service was left running as-is.
