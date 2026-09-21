# External session transport integration

An embedding application can deliver durable session events through an external
transport. Pain Host now accepts `collectionMode: external`, preserving tools and
engine behavior while the adapter feeds the public Collector. Existing deployments
continue to use local collection by default.

Session Insights exposes `importSnapshot(SessionSource)` to publish a complete
external prefix through its existing immutable evidence writer. Sequence gaps and
invalid inherited boundaries reject before publication. Repeated content retains
its revision. Imported evidence works with normal plan and reflection references.

Verification uses public services and disk artifacts. External collection mode was
checked through real Harness tool execution. Snapshot import was checked for
idempotence, retained prior revisions and rejected incomplete prefixes. No tested
private fields were accessed.
