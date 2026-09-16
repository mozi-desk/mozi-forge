# Development rules

- Read module README and AGENTS before editing. Each independently maintained
  module provides both documents.
- Preserve unrelated changes. Commit, publish and operate existing services only
  when explicitly authorized. Never read or expose secret files or credentials.
- Prefer ordinary files, Markdown and existing Harness interfaces. Keep agent
  reasoning policies in prompts and execution facts in host services.
- Explain non-trivial source behavior in an English file header with an example.
  Document important public boundaries and persistence ordering near definitions.
- Keep public schemas, runtime validation, types, prompts and documentation aligned.
- Use black-box tests through public APIs, processes and disk results. Accessing a
  tested class's private fields requires explicit approval.
- Test processes use isolated homes, explicit --no-open, and deterministic cleanup.
- Add a reviewable decision note for non-trivial changes. Record actual verification
  separately from intended checks. Frozen historical notes remain unchanged.
- Public materials describe this project and generic examples. Keep runtime data,
  credentials, personal paths and unrelated organizational context out of artifacts.
