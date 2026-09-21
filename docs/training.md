# Training and evaluation

## Run a coding evaluation

1. Install dependencies, build and start the example as shown in the README.
2. Configure a provider in Harness settings and choose the `tester` preset.
3. Ask it to run the `coding-live` suite. The suite creates `sum.mjs`, runs it,
   checks `result.json`, and then tests default arguments in a second turn.
4. Inspect the persisted run report, source artifact and session evidence. Complete
   any human review request in the Human Request UI.

The suite lives in `tests/agent-evals/coding-live.yml`. File assertions evaluate
JSON output produced by the code; human review also inspects the source. A suite
can set tool-call budgets, cancellation timeouts, repeats and review requirements.

## Improve an agent

1. Use an agent and identify sessions or feedback that demonstrate a concrete issue.
2. Select Trainer and ask for an improvement plan tied to that evidence.
3. Review one plan through Human Request: what will change, why, and how success will be accepted.
4. Trainer prepares a Git worktree at the selected repository's HEAD and returns
   an execution session ID. Training continues automatically in that session: its native file,
   shell, skill and delegation tools use the worktree. It evaluates a baseline,
   edits the target, evaluates the same suite again and assesses the actual artifacts against the approved criteria.
5. Trainer runs final checks, integrates the verified candidate locally and reports the outcome. Result Markdown and evaluation artifacts remain available for inspection.

A worktree starts from committed HEAD. Uncommitted main-checkout edits are not its
training baseline. For a fresh checkout, prepare your own baseline commit before
using the worktree workflow. Integration verifies the exact candidate in an isolated worktree and
preserves unrelated destination changes.

## Deterministic acceptance example

`pnpm exec vitest run tests/trainer.web.test.ts` exercises two source sessions,
one plan approval, baseline failure, prompt improvement, Trainer artifact assessment,
and autonomous integration across analysis and execution sessions. It also checks
standard tool availability, worktree instructions and Skills, native file tools,
and a delegated agent's working directory. It uses scripted model transport with real Web RPC,
subprocesses and a disposable Git repository. It does not prove live-model quality.

Evaluation state is written under `$DSH_HOME/agent-tests`; plan-associated evidence
is under `$DSH_HOME/trainning/<plan-id>`. Stop or cancel through public Agent Test
interfaces. Reports distinguish execution failure, automatic checks and artifact assessments.


### Plan review content

Submit `human_request_submit` with `type: plan-review` and the saved `planId`.
The Host loads that Plan, verifies the submitting session owns it, and populates
the review title and body before displaying it. A short caller-supplied body can
identify the review; the displayed scope comes from the saved Plan. Approval
unlocks that scope. Editing the scope or acceptance criteria requires a new review.
