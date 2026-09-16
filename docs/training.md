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
3. Review the plan and each proposal through Human Request.
4. Trainer prepares a Git worktree at the selected repository's HEAD, evaluates a
   baseline, edits the target and evaluates the same suite again.
5. Inspect the result Markdown and evaluation artifacts before approving integration.

A worktree starts from committed HEAD. Uncommitted main-checkout edits are not its
training baseline. For a fresh checkout, prepare your own baseline commit before
using the worktree workflow. Integration is bound to the reviewed Git tree and
preserves unrelated destination changes.

## Deterministic acceptance example

`pnpm exec vitest run tests/trainer.web.test.ts` exercises two source sessions,
plan and proposal reviews, baseline failure, prompt improvement, passing evaluation,
and reviewed integration. It uses scripted model transport with real Web RPC,
subprocesses and a disposable Git repository. It does not prove live-model quality.

Evaluation state is written under `$DSH_HOME/agent-tests`; plan-associated evidence
is under `$DSH_HOME/trainning/<plan-id>`. Stop or cancel through public Agent Test
interfaces. Reports distinguish execution failure, automatic checks and human review.
