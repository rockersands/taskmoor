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
- ADRs written: 001, 002 (AGPL-3.0-only with DCO, accepted), 003, 004, 030 and 033 (desktop first, mobile must
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
- Spec lint (M0-013) and `pnpm trace` (M0-014): tests cite requirements as `[CORE-028]` in
  their names; unknown IDs fail `pnpm verify`.
- Licence decided (AGPL-3.0-only with DCO). `LICENSE` added; the sign-off is added by
  `.githooks/prepare-commit-msg` and checked by the pre-push hook, `pnpm dco` and CI. The user
  stays on GitHub's free plan: no branch protection, so CI is the gate, and CI is trimmed to fit
  the free minutes (PRs run one Linux job; Windows runs weekly).
- Synthetic data generator (M0-015): `@tracksmith/testkit/gen` builds users, spaces, fields,
  items and history from a seed (Zipf-skewed spaces and users, epic/subtask hierarchy, custom
  field values); `pnpm gen --items N` loads it with COPY into the `gen` schema of the embedded
  `bench` cluster (`.cache/pg-test/bench`, kept between runs, skipped when the fingerprint
  matches). 100k items load in about 20s; expect about 30 min for 10M.
- Last result: `pnpm verify` passes with 105 tests in about 11s. `pnpm verify --e2e` passed
  earlier with 6 checks.

### Next (in order)

1. M0-016 and M0-017: when the 10M field-storage spike finishes (`docs/spikes/field-storage-10m.md`),
   run `pnpm spike query --items 10000000` and `--items 1000000` on an idle machine, then write
   ADR-008 and ADR-010 with the measured p95 figures and mark both tasks done.
2. M0-018 (permission engine spike, ADR-012), M0-019 (sync engine spike, ADR-013), M0-022
   (XML parser spike, ADR-025), in the order `pnpm next-task` prints them.
3. M0-033 nightly benchmark job; M0-025 to M0-030 once Docker works (WSL install pending).

### Notes and gotchas

- Pushes use the GitHub CLI token through a repo-local credential helper
  (`git config --local credential.helper`); Git Credential Manager would otherwise open a
  sign-in window. The CLI is signed in as rockersands.
- Bench datasets live in `.cache/pg-test/bench` as UNLOGGED tables: stop that cluster cleanly
  (`pg_ctl -m fast`); an immediate stop empties them. `pnpm gen` checks for rows before reuse.
- While a big spike saturates the repository's disk, database tests time out. Run the gate
  with the test clusters on another disk: `TRACKSMITH_PG_CACHE_DIR=C:/Users/you/AppData/Local/Temp/tracksmith-pg-test pnpm verify`
  (and `PLAYWRIGHT_BROWSERS_PATH=<empty dir>` skips the browser stories). Each Vitest project
  sets its own timeouts; the root config's are not inherited.
- The OpenFGA server binary for the permission spike is in `.cache/tools/openfga` (v1.22.0,
  downloaded from its GitHub release and checksum-verified); `pnpm spike authz --openfga`
  needs it. CI has no binary, so that candidate and its test are skipped there.
- The bench cluster is shared: a second process attaches to the running server. If the owner
  stops the server (a `pnpm gen` finishing), attached benchmarks fail; rerun them.
- In `pnpm verify ... | grep`, use `set -o pipefail` before chaining a commit, or the grep
  status hides a failure.

- If `pnpm` is not on PATH, use `corepack pnpm ...`. `corepack enable` needs admin rights on
  this machine, so it was not run.
- When `pg_ctl` starts the server it must not inherit Node's pipes, or the call hangs on Windows
  (see `runWithoutPipes` in `packages/testkit/src/pg/server.ts`).
- In Playwright, `getByRole(..., { name: 'Boards' })` also matches "Dashboards". Use
  `exact: true` for short names.
- Record task state in `docs/plan/progress.csv` (in-progress, done, waiting-on-user) as you go;
  `pnpm next-task` and a test read it.

### Waiting on the user

- Run `gh auth refresh -s workflow` (browser sign-in as Rockersands) so pushes may change
  `.github/workflows/*`. A ci.yml change (Chromium in every test job) is parked in
  `git stash` as "ci: chromium in all jobs"; pop, commit and push it after the refresh.

- Public name: pick from the shortlist in `docs/decisions/name.md` (issuetide, workrill,
  taskmoor) or propose another; the codename stays until then.
