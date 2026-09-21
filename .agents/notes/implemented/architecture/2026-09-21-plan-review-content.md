# Host-generated plan review content

Status: implemented

## Problem

The generic request tool accepted a paraphrased review body, while workspace
preparation required approval of the saved Plan body. This allowed an apparently
successful human approval that could never unlock its intended Plan.

## Decision

Prepare domain review content before persistence. Human Request emits the awaited,
sequential `human-request/prepare(input, sessionId)` hook and validates the result.
Trainer handles plan-review submissions by requiring a Plan ID, checking ownership,
and copying the saved Plan title and body into the request. The human sees the
same scope that workspace preparation and integration verify. Ordinary questions
retain their submitted Markdown, and same-ID retries remain idempotent.

Saved review records remain immutable evidence of what the human saw. Changing
the Plan scope requires approval of the changed scope. Existing response history
is preserved.

## Alternatives

Prompt-only verbatim copying leaves a mechanical correctness requirement with the
model. Matching only a Plan ID could carry approval across scope changes. A new
review tool and a separate revision store would duplicate existing request and
Plan mechanisms. Preparing the displayed content uses the current approval gate.

## Verification

- Trainer integration and assembled prompt tests: 23 passed.
- Human Request and Trainer package tests: 11 passed.
- Pain integration and real Web RPC training workflow: 3 passed, including one
  approval followed by evaluation and autonomous integration.
- Both changed packages passed typecheck and lint.
- Forge build and dependency synchronization succeeded; RSI build and 19 root
  tests passed against the synchronized package graph.
- Black-box cases submit a paraphrase, inspect the persisted displayed review,
  approve once, prepare/recover its worktree, and reject changed scope. Missing,
  unknown and other-owner Plans fail before a request is persisted. Generic
  questions preserve their body.
- Runtime approval records were inspected read-only. Existing services were not
  restarted and historical approvals were not rewritten.

## Consequences

The model can identify the requested review concisely; the Host owns the displayed
Plan scope. Updated package code requires a Host restart for an existing process.
