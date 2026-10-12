# Handoff

Read this first in every session, then update it before you stop.

## Last session: 2026-10-12

### Done

- Repository initialised with the personal identity only (local git config) and the private
  GitHub remote.
- Test backbone (ADR-030) working end to end:
  - `pnpm verify` runs Biome, `tsc -b` and every Vitest project in parallel. It prints one
    summary line, then for each failure the test, `file:line`, message, diff and repo stack
    frames. With `--e2e` or in CI it also runs Playwright.
  - The `@tracksmith/testkit` package does three things:
    - runs an embedded Postgres 16 through `initdb` and `pg_ctl`, kept in `.cache/pg-test` with a warm start of about 1s;
    - gives each test file its own database, cloned from a template;
    - provides `stableJson` for golden files and fast-check defaults.
  - The `@tracksmith/db` package holds the Kysely client, the forward-only migrator, a
    migrations registry test, a schema golden file, and `useMigratedDatabase()`.
  - `@tracksmith/server` is a Fastify app with `/health` (liveness) and `/ready` (database
    check). Config is validated with Zod and errors never echo secrets.
  - `@tracksmith/web` is a desktop-first React shell. On desktop it has a collapsible sidebar;
    below 768px it switches to a modal drawer. It has 10 component tests and 6 Playwright checks
    (desktop and Pixel 7).
  - CI (`.github/workflows/ci.yml`) has three parts:
    - Ubuntu with Postgres 16 runs the full suite including e2e.
    - Ubuntu with Postgres 18 runs the tests.
    - Windows with embedded Postgres runs types and tests on pushes to main.
- Docs imported into the repo: plan, backlog and CSVs (`docs/plan`), requirements spec
  (`docs/specs`) and the research report (`docs/research`).
- ADRs written: 001, 002 (Proposed: licence), 003, 004, 030 and 033 (desktop first, mobile must
  work).
- Repo tooling in `@tracksmith/devtools`, enforced by tests in `pnpm verify`:
  - `pnpm next-task` (reads `docs/plan/backlog.csv` and `progress.csv`; checks dependencies and
    cycles);
  - governance sections, relative links and the ADR index;
  - spec provenance front matter (M0-006);
  - dependency-cruiser module boundaries (M0-010), with a fixture that breaks every rule.
- Clean-room protocol in `docs/legal/clean-room.md`; source list in `docs/research/sources.md`.
- Supply-chain gates (ADR-029): licence allowlist and secret scan in `pnpm verify`; SBOM,
  Trivy and Dependabot in CI.
- Task M0-035 added for the DCO and branch protection, which wait on the licence decision.
- Last result: `pnpm verify` passes with 78 tests in about 11s. `pnpm verify --e2e` passed
  earlier with 6 checks.

### Next (in order)

1. M0-001 rest: the first push waits on a one-time Git Credential Manager sign-in as
   Rockersands. After it lands, check that the first CI run is green on GitHub.
2. M0-013 and M0-014: spec IDs and a traceability check, so tests can cite requirement IDs.
3. M0-015: synthetic data generator in the testkit (fixed seeds; 1M, 10M and 30M items).
4. Spikes M0-016 to M0-023, in the order `pnpm next-task` prints them.

### Notes and gotchas

- If `pnpm` is not on PATH, use `corepack pnpm ...`. `corepack enable` needs admin rights on
  this machine, so it was not run.
- When `pg_ctl` starts the server it must not inherit Node's pipes, or the call hangs on Windows
  (see `runWithoutPipes` in `packages/testkit/src/pg/server.ts`).
- In Playwright, `getByRole(..., { name: 'Boards' })` also matches "Dashboards". Use
  `exact: true` for short names.
- Record task state in `docs/plan/progress.csv` (in-progress, done, waiting-on-user) as you go;
  `pnpm next-task` and a test read it.

### Waiting on the user

- Licence confirmation (AGPL-3.0 + DCO recommended).
- Public name screening (M0-007) before any public release.
