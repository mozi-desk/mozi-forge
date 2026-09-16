# Module rules

Inherit [repository rules](../../AGENTS.md). Responsibility and exports are in
[README.md](README.md).

- Publish immutable revisions after their files and indexes exist. Query/read responses respect byte and row limits; derived evidence is redacted.
- Keep schemas, types, prompts, public exports and documentation consistent.
- Use public APIs, process results and disk evidence for black-box tests.
- Test processes use isolated DSH_HOME and --no-open; clean up only owned resources.
- Record non-trivial decisions and actual verification in an Agent Note.
