# Module rules

Inherit [repository rules](../../AGENTS.md). Responsibility and exports are in
[README.md](README.md).

- Deliver bounded work to Trainer and record feedback coverage. Integration receipts resolve the reviewed coverage.
- Keep schemas, types, prompts, public exports and documentation consistent.
- Use public APIs, process results and disk evidence for black-box tests.
- Test processes use isolated DSH_HOME and --no-open; clean up only owned resources.
- Record non-trivial decisions and actual verification in an Agent Note.
