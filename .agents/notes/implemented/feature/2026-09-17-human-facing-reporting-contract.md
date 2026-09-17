# Agent Note: Human-facing reporting contract in the Trainer persona

Status: implemented

## Problem

The Trainer persona described the training loop and internal tools only. Asked
"现在有哪些需要我决策的内容，每个一段话，分点，要清晰", Trainer answered with plan ids
and request ids as the skeleton of a roughly thirty-item decision list and asked
the owner to read and approve internal documents. The owner rejected that twice in
session `af1add53` ("我不会看这两个plan的，你不要说是否看这两个Plan！！太复杂了"), and the
workspace decision log records the same expectation as a long-term requirement:
present what will change and what must be chosen, without internal detail.

## Decision

`packages/trainer-agent/prompts/trainer-prompt.md` gains a `Reporting to the human`
section that a chat reply and a `human_request_submit` body both obey:

1. Lead with the change the owner will see and the choice they must make; two or
   three concrete options per decision with one marked as recommended.
2. No internal identifiers or infrastructure terms as the decision skeleton — plan
   ids, request ids, proposal or branch names, preset names, tool names, test
   suites, script paths. Name the human-visible effect instead.
3. Never ask the owner to read, review or approve an internal document; the effect
   and the choice belong in the message.
4. Ask only for choices that genuinely need a human, and expand on implementation
   detail only when asked.

Nothing else changes: no tool, schema, preset or storage surface. The plugin
already registers this file as the whole `deployment:persona` section, so the
persona is the single place the rule has to live.

## Alternatives

- A reporting tool or message template: more machinery than the problem needs; the
  complaint was about wording and framing, not about a missing capability.
- A deployment-global prompt section: it would apply the rule to agents with
  different contracts and belongs to the deployment, not to this module.

## Verification

- `tests/trainer-prompt.test.ts` runs one scripted turn through the real fixture
  composition and asserts the contract phrases inside the leading system-role
  message of the exact model request. Baseline (prompt unchanged): the same test
  fails on the first phrase. After the change: it passes.
- `pnpm run typecheck`, `pnpm run lint` and `pnpm run test` pass before and after;
  the full suite reports the same failure set (none) and the integration group grows
  from 3 files / 22 tests to 4 files / 23 tests.
- Real-model behavior is not verified here. The live key and the live budget were
  outside this change's approved scope, so the wording guarantee is a prompt-surface
  assertion plus the recorded owner feedback, not an end-to-end model result.

## Consequences

The rule reaches every Trainer entry point (analysis session, execution session,
sleep and reflect prompts) because they share one persona. A future change that
removes the section, or rewords it past the asserted phrases, fails
`tests/trainer-prompt.test.ts` until the test is deliberately updated with the
contract.
