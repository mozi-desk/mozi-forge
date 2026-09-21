# Structured human decisions

Status: implemented

## Decision

Human-request responses persist an optional `decision` enum (`approve` or
`request-changes`) and `decidedAt` alongside the human note. Merge and test reviews
require this decision. Buttons select the enum, and submission sends it explicitly.
The UI translates labels independently from protocol values. Blank notes are valid
with an explicit decision. Trainer checks the approval field; Agent Test maps the
decision to its review verdict. Notifications include the decision for the agent.

## Persistence and recovery

Both fields are saved before notifications. Identical retries remain idempotent;
a different note or decision is rejected. Older responses may acquire a decision
with the original body retained. The UI shows confirmation controls and preserves
the original note. A decision-specific notice marker allows confirmation delivery
without duplicating an earlier answer notice. Existing completed plans remain intact.

## Verification

Passed affected-module builds, typechecks, lint, and root TypeScript checking.
Forty module tests and twenty-five integration/prompt tests passed. Black-box
checks cover decision persistence and retry conflicts; confirmation of earlier
responses; English, Chinese, Japanese and blank notes; explicit rejection despite
approval wording; missing decisions; Agent Test verdict mapping; and existing
Git ownership/tree/destination protections. Live browser interaction and restart
of the existing service were not performed.
