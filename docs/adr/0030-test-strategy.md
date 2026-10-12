# ADR-030: Test strategy and the verify gate

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-008, M0-009, M0-011, M0-014

## Context

No human re-tests changes by hand. Claude must be able to change complex code, run one command,
wait, and trust the answer. The answer must be short enough to read in full and precise enough to
act on.

## Decision

### One gate: `pnpm verify`

Runs Biome, `tsc -b` and the whole Vitest suite in parallel (Playwright too with `--e2e` or in CI)
and prints one line per step plus only the failures: test name, `file:line`, message, the
expected/received diff and the stack frames inside the repo. Full logs go to `.verify/`. Exit
code 0 means done.

### Layers

| Layer | Tool | Where | Notes |
|---|---|---|---|
| Unit | Vitest | `*.test.ts` next to the code | Pure logic, no I/O |
| Integration | Vitest + real Postgres | same | `useMigratedDatabase()` gives each file its own database cloned from a migrated template |
| Component | Vitest + Testing Library + jsdom | `apps/web/src` | Query by role and name; `setViewportWidth()` for compact layouts |
| Golden | Vitest file snapshots | `__golden__/` | `stableJson()` output; `pnpm verify --update` rewrites; CI never writes |
| Property | fast-check | any | `FC_RUNS` and `FC_SEED` control runs and replay |
| End-to-end | Playwright | `apps/web/e2e` | Production build; desktop (1440x900) and mobile (Pixel 7) projects |
| Contract, conformance, benchmarks, upgrade, install | later tasks | | See the plan, section 7 |

### Postgres without Docker

Tests run against real PostgreSQL, never a mock. Locally the testkit starts Postgres 16 from the
`embedded-postgres` npm binaries using `initdb` and `pg_ctl` directly, keeps the cluster in
`.cache/pg-test` between runs (warm start about a second) and runs with `fsync=off`. A second
concurrent run gets a throwaway cluster. With `TASKMOOR_TEST_DATABASE_URL` set (CI service
containers on Postgres 16 and 18) that server is used instead.

Each test file gets `CREATE DATABASE ... TEMPLATE tpl_<migration hash>`, so files are isolated and
can run in parallel; the template is rebuilt only when migrations change.

### Rules

- Tests come from the spec and cite requirement IDs in their names (`[CORE-028] ...`); a
  traceability check (M0-014) will fail on unknown IDs.
- No network calls in tests; AI providers are tested against recorded contracts.
- A flaky test is a failing test: fix it or delete it, never retry it into passing locally.

## Consequences

Running every suite on each change stays fast while the suite is small; `--changed` limits the
run to affected tests as the repo grows. Windows CI runs the embedded-Postgres path on pushes to
main so the Docker-free harness keeps working.
