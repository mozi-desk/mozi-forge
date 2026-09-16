# Contributing

Open an issue describing the user-visible problem, a minimal reproduction, and
expected behavior. For a change, keep commits focused and include relevant public
API tests and documentation. Do not attach credentials or private session dumps.

Use Node.js 24+ and pnpm 11.7.0. Run `pnpm install --frozen-lockfile`, `pnpm build`,
`pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm check:pack` as appropriate.
Tests start only isolated processes and temporary repositories.

Document public exports and maintain module README and AGENTS files. Add a decision
note when changing architecture or a persistent contract. Describe actual validation
and known limitations in pull requests. Contributions are licensed under Apache-2.0.
