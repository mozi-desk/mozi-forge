# Agent Note: Runtime composition and isolated evaluation inputs

Status: implemented

## Problem

An agent foundation must work from installed packages and evaluate reproducible
inputs when consumers keep local plugins in separate repositories.

## Decision

Public packages use @mozi-forge names and explicit exports. Runtime owns shared
presets and host configuration; applications supply their project root, preset
files, plugin export mappings and extra package identities. Application settings
are applied after defaults. Plugin services keep their public tool and persistence
contracts. Each training operation targets one repository.

Evaluation snapshots materialize local file/link/workspace dependencies and their
transitive local inputs. Registry packages use installed store locations. Dependency
links resolve inside the snapshot for copied packages. Input digests normalize
local dependency identity across original and copied locations. Installed metadata
is discovered through Node's package search paths, including packages whose exports
hide package.json. Host defaultSuite is supplied by the embedding configuration.

## Alternatives considered

- Cross-repository source imports: couple compilation and fail for packed consumers.
- Sharing mutable local dependency directories: makes an in-flight evaluation change
  when another checkout is edited.
- A fixed built-in target plugin: prevents independent applications from selecting
  their own preset and artifact contract.

## Verification

- `pnpm build`, `pnpm typecheck`, and `pnpm lint` passed locally.
- The package and root test collection passed 111 tests across 25 files, including
  runtime overlays, local input digests, session evidence, feedback loops, requests,
  evaluation and reviewed integration.
- Trainer Web verification launches the example through dist/start.js and uses
  scripted model transport with real RPC, shell, subprocesses and temporary Git.
- A separate source copy installed with the frozen lockfile, built, and passed
  runtime, snapshot and launcher-driven Trainer Web tests.
- `pnpm check:pack` installed 9 archives in a clean consumer and loaded 51 exports.
  Browser builds also generate bundled dependency license texts.
- Source review found no application-specific names or personal filesystem paths.

## Consequences

Consumers of local file dependencies refresh installed copies after a Forge build.
Packaging prepares a public release; publication and registry ownership are separate
maintainer actions. Scripted-model acceptance proves orchestration and artifacts,
while live-provider behavior requires separate configured-provider validation.
