# Tracksmith: working agreement for Claude sessions

Tracksmith (working name) is an open-source, self-hostable work tracker with every premium
feature included. Claude writes the code; the user decides product questions. Start every
session by reading `HANDOFF.md`, then `STATUS.md`.

## Identity (non-negotiable)

- Commit only as `Rockersands <42122514+rockersands@users.noreply.github.com>`, set in this repository's local git config.
  Never read from, change or fall back to the global git config or any other identity.
- Before every push, check `git log --format='%an <%ae> | %cn <%ce>' origin/main..HEAD`: every
  line must be the identity above.
- Remote: `https://github.com/Rockersands/tracksmith` (private until the name and licence are
  settled).

## Commands

pnpm comes from corepack. If `pnpm` is not on PATH, prefix commands with `corepack`.

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies (lockfile is committed) |
| `pnpm verify` | **The gate.** Lint, typecheck and every Vitest suite; prints one summary line and only the failures |
| `pnpm verify --e2e` | Also runs Playwright on a desktop and a mobile viewport |
| `pnpm verify --changed` | Only tests affected by uncommitted changes (`--changed=<ref>` for a branch) |
| `pnpm verify --only=tests -- <filter>` | A subset; anything after `--` goes to Vitest (`--project=db`, a file path) |
| `pnpm verify --update` | Rewrite golden files after an intended change; review the diff |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm format` | Biome format and safe fixes |
| `pnpm dev:web` / `pnpm dev:server` | Dev servers (`dev:server` needs `DATABASE_URL`) |

Full logs land in `.verify/<step>.log`; `.verify/summary.json` holds the last result.
Tests need no Docker: the first run creates an embedded Postgres 16 cluster in
`.cache/pg-test`, later runs start it in about a second. Set `TRACKSMITH_TEST_DATABASE_URL` to use
another server instead (CI does this).

## Definition of done

1. `pnpm verify` passes; UI work also passes `pnpm verify --e2e`.
2. Behaviour comes from the spec in `docs/specs`. Test names cite requirement IDs, for example
   `it('[CORE-028] creates a Form label on submission', ...)`.
3. New decisions get an ADR in `docs/adr`; changed decisions update the ADR and the plan.
4. `HANDOFF.md` says what changed, what is next and anything half-done.

## Layout

| Path | Contents |
|---|---|
| `apps/server` | Fastify API (`buildApp` for in-process tests, `main.ts` to listen) |
| `apps/web` | Static React frontend (Vite); Playwright tests in `apps/web/e2e` |
| `packages/db` | Kysely client, `Database` types, forward-only migrations, `useMigratedDatabase()` |
| `packages/testkit` | Embedded Postgres harness, per-file databases, `stableJson`, fast-check defaults |
| `tools/verify` | `pnpm verify` and its Vitest reporter |
| `docs/plan` | Build plan, backlog, milestones, decisions and risks (CSV) |
| `docs/specs` | Requirements spec with stable IDs (`requirements-index.csv`) |
| `docs/adr` | Architecture decision records |
| `docs/research` | Research report behind the plan |

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
- Property tests: `import { fc } from '@tracksmith/testkit/property'`.
- UI: desktop first, and it must still work on phones (ADR-033). Use design tokens from
  `apps/web/src/styles/tokens.css`; touch targets of at least 44px under `(pointer: coarse)`; no
  sideways scrolling. Component tests use `setViewportWidth()` for compact layouts.
- Accessibility: semantic roles and names first; tests query by role and name.
- Secrets never enter the repo or the frontend bundle.

## Clean room (ADR-003)

- Never copy Atlassian code, documentation text, screenshots, icons or other assets. Specs are
  written in our own words with source links; behaviour is rebuilt from them.
- Never sign in to or use an Atlassian product to build or test. Fixtures are synthetic.
- The product name must not include "Jira". Compatibility is described as "Jira-compatible".

## Open decisions owned by the user

- Licence: AGPL-3.0 with DCO is recommended (ADR-002, Proposed). Do not add a LICENSE file
  until the user confirms.
- Public name: "Tracksmith" may clash with an apparel brand; screening is task M0-007.
