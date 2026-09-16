# Module rules

Inherit [repository rules](../../AGENTS.md). Responsibility and exports are in
[README.md](README.md).

- Copies defaults, overlays caller presets and resolves package exports. The caller owns process startup.
- Keep schemas, types, prompts, public exports and documentation consistent.
- Use public APIs, process results and disk evidence for black-box tests.
- Test processes use isolated DSH_HOME and --no-open; clean up only owned resources.
- Record non-trivial decisions and actual verification in an Agent Note.
