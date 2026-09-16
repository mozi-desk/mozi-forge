# Module rules

Inherit [repository rules](../../AGENTS.md). Responsibility and exports are in
[README.md](README.md).

- Use DSH_HOME, bounded changed-session summaries and a fixed 24-hour deadline. Persist delivery identity before waking the target; retries reuse it.
- Keep schemas, types, prompts, public exports and documentation consistent.
- Use public APIs, process results and disk evidence for black-box tests.
- Test processes use isolated DSH_HOME and --no-open; clean up only owned resources.
- Record non-trivial decisions and actual verification in an Agent Note.
