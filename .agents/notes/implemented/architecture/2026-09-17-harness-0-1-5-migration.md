# Agent Note: Harness 0.1.5 migration

Status: implemented

## Problem

The workspace moved from `@deepseek-ai/dsh-*` 0.1.2-rc.1 to 0.1.5-rc.2. That release
is not a version bump for these plugins: several interfaces they read through were
replaced, and two of them failed only at runtime because the plugins reached the
Harness through hand-written structural types that the compiler could not check.

Concretely, 0.1.5 removed `SessionPersistence.readFrom()` and the header-valued
`list()`, removed the `assistant/chunk` session event and the packed chunk-run
storage codec, moved token accounting onto `assistant/message.usage`, moved the
first-token stream into that settlement as `stream`, removed `webServer` from
`dsh-client-connection`'s own dependencies, and added the `session/end-seed`
boundary event for seeded Sessions.

## Decision

**Session reads go through one adapter.** `session-insights-plugin` publishes
`./session-reader` with `listStoredSessions()` and `readStoredSession()`. They use
the 0.1.5 handle API (`open(id, 'read')`, `handle.read(offset)`, `handle.close()`)
and project it back to the `{ id }` / `{ meta, inheritedEventCount, events }` shapes
callers already consumed, so `agent-pain-plugin`, `reflect-loop-plugin`,
`session-insights-plugin` and `sleep-loop-plugin` changed only their call sites.
The adapter re-exports the persistence type, so those plugins need no direct
dependency on the persistence package and one reviewed module owns the transport.

**Plugin RPC channels own a physical route.** `connection.rpc.handle()` throws
`cannot get property "webServer" without inject` for every caller in 0.1.5, and no
0.1.5 package calls it. `human-request-plugin` publishes `./rpc-channel` with
`registerRpcChannel()`, which registers the same channel prefix on `webServer`,
applies Connection's still-public `requestRejection` fence, decodes the unchanged
`client-request` envelope and answers the unchanged `server-response` envelope. The
published URLs and the browser clients therefore did not change.

**Usage is read from the settlement.** `usageOf()` and `hasCompleteUsage()` read
`assistant/message.usage` only: a step's usage now arrives once, with its
settlement, and a step with no settlement reports missing accounting instead of
falling back to a stream value. `deriveMetrics()` recovers first-token time from
the settlement's embedded stream with `assistantStreamFirstTokenTime()`, which
keeps TTFT measurable rather than silently dropping it.

**The seed boundary is not evidence.** `analyzeEvents()` skips `session/end-seed`.
The event carries no execution facts and sits exactly on the inherited/own
boundary, so grouping it produced a factless row of its own.

**Log-only carriers follow the release.** `assistant/chunk` became
`assistant/attempt`; `session-insights`' focused index and preview omit the new
carrier for the same reason they omitted the old one.

## Alternatives

*Keeping the structural interfaces and only updating their shapes* was rejected: it
is what let `readFrom` and `list()` pass type checking while failing at runtime, and
it would repeat at the next release.

*Moving plugin endpoints under `/api` with `connection.fetch.register()`* is the
release's own composition for Host-owned endpoints and would remove the hand-rolled
carrier. It was not taken because it changes the channel URLs the browser clients
and the CloudX-facing tests already publish, which is a product contract change
rather than a migration step. The adapter is the single place to revisit if that
change is wanted.

*Typing the adapter's `webServer` parameter structurally* was rejected because
`WebServer` is public in `@deepseek-ai/dsh-host-webserver`, and importing it makes
the call site compiler-checked.

## Verification

* `pnpm --dir mozi-forge run typecheck` and `pnpm --dir mozi-agent-v2 run typecheck`: pass.
* `pnpm --dir mozi-forge run lint` and `pnpm --dir mozi-agent-v2 run lint`: pass, no errors.
* `pnpm --dir mozi-forge run test`: all package unit suites pass (runtime 1,
  session-insights 15, human-request 4, agent-pain 14, review-agent 5, agent-test 29,
  sleep-loop 21, trainer-agent 1, reflect-loop 7) and the integration suites pass
  22/22, including `trainer.web.test.ts`.
* `pnpm --dir mozi-agent-v2 run test`: 19/19 integration plus the package unit suites.
* Observed behavior that motivated the changes: before them, `agent-pain-plugin`
  raised `this.persistence(...).readFrom is not a function`, and every plugin RPC
  channel answered HTTP 405 from the SPA fallback.

Two environment notes are recorded because they cost real diagnosis time:
`NODE_USE_ENV_PROXY=1` without `NO_PROXY` sends loopback requests to the local proxy,
so tests need `NO_PROXY=127.0.0.1,localhost,::1`; and `sleep-loop-plugin`'s
2000-id scenario needs about half a minute here, so that one test carries an
explicit timeout.

## Consequences

Seeded Session fixtures must end their inherited prefix with `session/end-seed`, and
a fork's `inheritedEventCount` counts the inherited events without that marker. The
`session-reader` adapter is now the only place that knows the persistence transport,
and `rpc-channel` is the only place that knows how a plugin channel reaches HTTP.
Negative `tokenCorrections` is no longer reachable from a real log, because one step
reports usage once; the test that asserted it now records the observed settlement
instead.
