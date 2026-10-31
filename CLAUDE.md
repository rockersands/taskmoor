# Taskmoor: working agreement for Claude sessions

Taskmoor (written taskmoor in handles and identifiers; "Tracksmith" was the codename) is an
open-source, self-hostable work tracker with every premium feature included. Claude writes the
code; the user decides product questions. Start every session by reading `HANDOFF.md`, then
`STATUS.md`.

## Identity (non-negotiable)

- Commit only as `Rockersands <42122514+rockersands@users.noreply.github.com>`, set in this repository's local git config.
  Never read from, change or fall back to the global git config or any other identity.
- Before every push, check `git log --format='%an <%ae> | %cn <%ce>' origin/main..HEAD`: every
  line must be the identity above.
- Every commit carries `Signed-off-by: Rockersands <42122514+rockersands@users.noreply.github.com>` (DCO, ADR-002). The
  hook in `.githooks/` adds it; enable it once per clone with `git config core.hooksPath .githooks`.
  The pre-push hook and CI run `pnpm dco`, and unsigned commits fail.
- Remote: `https://github.com/Rockersands/tracksmith` (private; it keeps the codename until the
  user renames the repository; free GitHub plan, so there is no branch protection).
- **The gate is local:** run the whole `pnpm verify --e2e` before every push to `main`. GitHub
  Actions is not used until M1 is finished (the user's decision, 2026-10-30): every workflow
  runs only by hand, and nobody runs them. Never dispatch a workflow or treat a red or missing
  GitHub run as a blocker. The jobs with no local equivalent (Postgres 18, Windows, the image,
  Helm, the install matrix) wait for the M1 gate.

## Commands

pnpm comes from corepack. If `pnpm` is not on PATH, prefix commands with `corepack`.

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies (lockfile is committed) |
| `pnpm verify` | **The gate.** Lint, typecheck and every Vitest suite; prints one summary line and only the failures |
| `pnpm verify --e2e` | Also runs Playwright on a desktop and a mobile viewport |
| `pnpm verify --e2e --browsers` | Also Firefox, WebKit, and Safari and Chrome phones at 360 px (ADR-030); before a release |
| `pnpm verify --changed` | Only tests affected by uncommitted changes (`--changed=<ref>` for a branch) |
| `pnpm verify --only=tests -- <filter>` | A subset; anything after `--` goes to Vitest (`--project=db`, a file path) |
| `pnpm verify --update` | Rewrite golden files after an intended change; review the diff |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm next-task` | The task to resume or start next, from `docs/plan/backlog.csv` and `progress.csv` |
| `pnpm trace` | Requirements cited by tests, per milestone |
| `pnpm gen --items N` | Generate and load a synthetic dataset into the `bench` cluster (`--force` reloads) |
| `pnpm gen:dc-backup --issues N --seed N --out x.zip` | Write and validate a synthetic Data Center backup ZIP with its manifest (`--validate x.zip` checks one) |
| `pnpm spike <name> ...` | Run a benchmark spike (`field-storage`, `query`, `authz`, `authz-overhead`, `sync`, `queue`, `xml`); writes `docs/spikes/<name>.md` and `data/<name>.json` |
| `pnpm bench:search` | The search spike: the 50-query perf set against a generated dataset (`docs/spikes/search-1m.md`) |
| `pnpm load [--items 100000] [--tiers 50,500,2000]` | Load tests with k6 against the real server; writes `docs/ops/load-tests.md` with the sizing table (needs k6; ADR-082) |
| `pnpm bench:check [--size 1m] [--e2e]` | Spike results against the performance budgets and the baseline in `docs/spikes/baseline` (fails on a 20% regression), then the tests' speed limits, enforced (ADR-071) |
| `pnpm status-report [--date D]` | Weekly status report to `docs/status/<date>.md`; copy it to the user's Drive folder |
| `pnpm gate M0 [--ci]` | The milestone's exit checklist: what is green, failing or waiting on the user |
| `pnpm conformance <workflow \| query>` | A conformance suite's pass, fail and unsupported counts per section (`--json`, `--failures=N`) |
| `pnpm fuzz query [--minutes N] [--seed N]` | Fuzzes the query parser; report in `.verify/fuzz-query.json`, failing inputs in `.cache/fuzz/` |
| `pnpm build` | Production build: the frontend artefact (`apps/web/dist` with `version.json`), the offline Builder page that carries it (`apps/web/dist-builder/index.html`, ADR-088) and the bundled server (`apps/server/dist/server.mjs`), all stamped with `TASKMOOR_VERSION` (ADR-066) |
| `bash deploy/compose/upgrade.sh <image> [--dry-run]` | One-command upgrade of a Compose install: pre-upgrade backup, migrations, the previous image back on failure |
| `bash tools/image/smoke.sh` | Builds the Docker image, checks its size and probes `/health` and `/ready` (amd64, then arm64 under emulation) |
| `bash tools/image/smoke-kits.sh` | Builds the all-in-one image and brings up both Compose kits (`deploy/`) to `/ready` |
| `node apps/server/dist/cli.mjs check-upgrade` | Operator CLI from `pnpm build` (also `upgrade [--dry-run]`, `migrate`, `status`, `backup`, `restore`, `checksum`, `drill`, `purge-trash`, `field-values [--repair]`, `password-link <email>`, `audit-verify`, `report-verify`); in the image: `docker compose exec taskmoor node cli.mjs check-upgrade` |
| `pnpm builder --project <file>` | The Builder CLI (ADR-031): backend kit, frontend kit zip and single file from a project file (or `--backend-url` and `--frontend-url`); `--seed` for byte-identical rebuilds |
| `pnpm run docs [--out <dir>]` | Checks the manual in `docs/manual` and builds its offline HTML bundle into `dist/docs`; lists external links without fetching them (ADR-074). Bare `pnpm docs` is pnpm's own command |
| `pnpm i18n:check` | Hard-coded user-facing strings in the web app's components (must be none) |
| `bash tools/image/smoke-backend-kit.sh` | Makes a backend kit for https://localhost:18443 and installs it against the local image: health through Caddy, the setup link, the kit's instance at `/api/meta` |
| `pnpm dco [range]` | Checks commit sign-offs (default: commits not yet on `origin/main`) |
| `pnpm format` | Biome format and safe fixes |
| `pnpm dev:web` / `pnpm dev:server` | Dev servers (`dev:server` needs `DATABASE_URL`) |
| `pnpm --filter @taskmoor/web storybook` | Storybook; every story also runs as a browser test with axe in `pnpm verify` |

Full logs land in `.verify/<step>.log`; `.verify/summary.json` holds the last result.
Tests need no Docker: the first run creates an embedded Postgres 16 cluster in
`.cache/pg-test`, later runs start it in about a second. Set `TASKMOOR_TEST_DATABASE_URL` to use
another server instead (CI does this), or `TASKMOOR_PG_CACHE_DIR` to keep the embedded clusters
on another disk (for example while a benchmark saturates this one).

## Definition of done

1. `pnpm verify` passes; UI work also passes `pnpm verify --e2e`.
2. Behaviour comes from the spec in `docs/specs`. Test names cite requirement IDs, for example
   `it('[CORE-028] creates a Form label on submission', ...)`.
3. New decisions get an ADR in `docs/adr`; changed decisions update the ADR and the plan.
4. `docs/plan/progress.csv` records the task state; `HANDOFF.md` says what changed, what is
   next and anything half-done.

## Layout

| Path | Contents |
|---|---|
| `apps/server` | Fastify API (`buildApp` for in-process tests, `main.ts` to listen); roles by `TASKMOOR_ROLE`; first-run setup and cookie sessions under `/api/v1` |
| `apps/web` | Static React frontend (Vite); Playwright tests in `apps/web/e2e` |
| `packages/ai` | AI gateway: `AiGateway`, provider adapters (Anthropic API, Bedrock, Vertex, Foundry, OpenAI-compatible), feature registry |
| `packages/db` | Kysely client, `Database` types, forward-only migrations, `useMigratedDatabase()` |
| `packages/storage` | Attachment stores: local disk and S3-compatible behind one interface, `FakeS3` for tests |
| `packages/webconfig` | The frontend artefact's contract: the runtime-config slot in index.html and `version.json` (ADR-066) |
| `packages/iam` | Identity and access: password hashing (scrypt), one-time and session tokens; the providers of ADR-019 join in M1 |
| `deploy/` | Install kits: `compose/` (bundled or external Postgres) and `allinone/` (image with Postgres inside) |
| `packages/builder-core` | The Builder's core (ADR-031): inputs, WebCrypto secrets, the signed connection manifest, the project file, deterministic kit zips; browser-safe |
| `packages/richtext` | Document schema (Tiptap/ProseMirror) and lossless conversion to and from the Jira-compatible document format |
| `packages/spikes` | Throwaway benchmarks for ADRs (`pnpm spike`); results in `docs/spikes` |
| `packages/testkit` | Embedded Postgres harness, per-file databases, `stableJson`, fast-check defaults |
| `tools/verify` | `pnpm verify` and its Vitest reporter |
| `docs/plan` | Build plan, backlog, milestones, decisions and risks (CSV) |
| `docs/specs` | Requirements spec with stable IDs (`requirements-index.csv`) |
| `docs/adr` | Architecture decision records |
| `docs/research` | Research report behind the plan |
| `docs/manual` | The manual for administrators and users: pages with provenance front matter, ordered by `nav.json` |

## Conventions

- TypeScript strict, ESM, imports without file extensions, named exports (config files excepted).
- Biome is the formatter and linter (`biome.json`); do not add ESLint or Prettier.
- Every package has `src/`, a `tsconfig.json` referenced from the root one, and a `vitest.config.ts`
  that the root config picks up. Tests sit next to the code as `*.test.ts(x)`.
- Database: migrations are forward-only (`packages/db/src/migrations`, registered in `index.ts`).
  Add the table type to `schema.ts` in the same change. The schema golden file changes with every
  migration; review it.
- Database tests call `useMigratedDatabase()` (own database per file, cloned from a migrated
  template). Never share state between test files; never call the network.
- Golden files: `expect(stableJson(x)).toMatchFileSnapshot('./__golden__/name.json')`.
- Property tests: `import { fc } from '@taskmoor/testkit/property'`.
- Speed limits: `expectWithinBudget(measured, budget, what)` from `@taskmoor/testkit/budget`
  (e2e: `./budget`), never a bare `toBeLessThan` on a duration. `pnpm verify` measures them;
  `pnpm bench:check` enforces them (ADR-071).
- UI: desktop first, and it must still work on phones (ADR-033). Use design tokens from
  `apps/web/src/styles/tokens.css`; touch targets of at least 44px under `(pointer: coarse)`; no
  sideways scrolling. Component tests use `setViewportWidth()` for compact layouts.
- Accessibility: semantic roles and names first; tests query by role and name. Every component
  gets a story (`*.stories.tsx`); stories run in a real browser with axe (ADR-024).
- Strings: never literal UI text in components; add an ID to `apps/web/src/i18n/messages.en.ts`
  and read it with `useT()`, and give it a Spanish entry in `messages.es.ts` (a draft, typed
  against the English IDs: a missing one fails the typecheck). The `en-XA` pseudo-locale test
  and `pnpm i18n:check` fail on strings that bypass the catalogue.
- Secrets never enter the repo or the frontend bundle.
- The manual (`docs/manual`) describes the product as built: a change people or administrators
  can see updates its page in the same task, in our own words and with its `sources` current.

## Clean room (ADR-003)

- Never copy Atlassian code, documentation text, screenshots, icons or other assets. Specs are
  written in our own words with source links; behaviour is rebuilt from them.
- Never sign in to or use an Atlassian product to build or test. Fixtures are synthetic.
- The product name must not include "Jira". Compatibility is described as "Jira-compatible".

## Terminology

- Use the product's own names for structural concepts (`docs/specs/00-terminology.md`), never
  the terms Atlassian products use for them, old or current. Jira-compatible names appear only
  where compatibility needs them: import, export, the Jira-compatible API and query dialect.

## Open decisions owned by the user

- Release publishing (images on ghcr.io, the release signing key) and the GitHub repository
  rename: see `docs/plan/decisions.csv` and HANDOFF.
