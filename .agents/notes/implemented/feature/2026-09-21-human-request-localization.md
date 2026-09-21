# Human request interface localization

Status: implemented

## Problem

The human-request client embedded Chinese strings for navigation, controls, and
editable reply templates regardless of the global language preference.

## Decision

Register English and Chinese dictionaries under `mozi-human-requests` with the
Harness locale service. Declare the locale client dependency and loader injection.
Use a translated label thunk and the slot locale seat so global language changes
refresh navigation and controls. Pass the translator into request details; quick
reply actions resolve their templates when clicked. Preserve user-authored drafts
and persisted Markdown. Standalone components default to English.

## Alternatives

A separate browser-language detector would duplicate Harness preference and
fallback behavior. Reuse the existing service and its language-pack extension API.

## Verification

Passed module typecheck, lint, build, and all six unit tests. Public component
rendering checks both languages, form labels, answered requests, and original
Markdown preservation. Existing host tests check the public response flow.
Frozen-lockfile offline installation passed using the already pinned locale
package. A running browser language switch has not been manually exercised.

## Consequences

The plugin requires the Harness locale service. New languages can contribute
namespace dictionaries through the standard language-pack API. Existing services
need to load the updated client bundle before displaying this change.
