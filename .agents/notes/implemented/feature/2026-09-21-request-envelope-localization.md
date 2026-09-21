# Localized request envelopes and approval replies

Status: implemented

## Problem

Generated review titles and merge snapshot envelopes were persisted in Chinese.
Translated buttons alone did not affect those records, and English quick replies
were not recognized by the owning review and merge services.

## Decision

Generate new host envelopes in English. At render time, project known English and
Chinese wrappers into the active dictionary. Require merge tree, branch and check
metadata to match before translating the wrapper. Keep authored Markdown and diff
payload intact. Recognize both shipped languages for explicit approvals and test
rejections. Select a test-specific rejection template for the request-changes action.

## Alternatives

Rewriting saved records would mutate review evidence. Translating arbitrary body
text would alter authored content or source diffs. Render only recognized wrappers.

## Verification

Three affected modules passed build, typecheck and lint, plus 37 unit tests.
Twenty Trainer integration tests passed, including English and Chinese explicit
approval, rejection, changed-tree protection, and destination conflict protection.
Component tests render historical Chinese envelopes in English while preserving
proposal and diff content. Browser hot switching has not been manually exercised.

## Consequences

Client changes cover existing generated envelopes. Restart the host to load the
new reply recognition and generation code. Authored content retains its language.
