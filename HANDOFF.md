# Handoff

Read this first in every session, then update it before you stop.

## Last session: 2026-10-12 (overnight and morning)

### Done

- **M0 is 30 of 35 tasks done; 31 of 33 ADRs accepted.** `pnpm gate M0` prints the exit
  checklist; `STATUS.md` has the task table; `docs/status/2026-10-12.md` is the first weekly
  report (also in the user's Drive folder as a Google Doc).
- Foundation (earlier today): repo with the personal identity only, DCO hooks and CI (Postgres
  16 and 18, weekly Windows), `pnpm verify` gate with embedded Postgres, module boundaries,
  licence and secret gates, spec import with stable IDs, traceability, synthetic data generator,
  design system with Storybook and axe, app shell with the command palette and ICU i18n.
- Spikes, each with a report in `docs/spikes` and an accepted ADR:
  - Queue and outbox (ADR-015): in-house SKIP LOCKED queue, 18k jobs/s.
  - Rich text (ADR-014): Tiptap, Yjs, Hocuspocus, lossless conversion.
  - Permissions (ADR-012): in-process SQL evaluator, check p95 1.47 ms cold / 0 ms cached
    against OpenFGA 15.9 ms at 100k users and 30k spaces; pre-filter overhead at most 1.3 ms.
  - Sync (ADR-013): in-house change log, 52k-item bootstrap in 2.6 s, delta p95 1 ms,
    1,392 lock-ordered mutations/s, idempotent outbox replay.
  - Backup XML (ADR-025): 5 GB parsed in 2.6 min at 303 MB RSS with every forbidden
    character removed and logged.
  - Field storage (ADR-008, Proposed) and the query compiler (ADR-010, Proposed): 1M and 200k
    runs within budget; the 10M run is in progress (see Next).
- Stack ADRs 005, 006, 007, 009, 011, 016 to 023, 026, 027, 031, 032 written from the plan.
- Benchmark tooling (M0-033): `pnpm bench:check` (budgets plus a 20% regression check against
  `docs/spikes/baseline`), `pnpm status-report`, the nightly workflow on the `ci-workflows`
  branch (see Waiting on the user).
- Install skeleton (M0-025 to M0-027, M0-029, M0-030; M0-011's image build): one multi-arch
  image with roles by `TRACKSMITH_ROLE`, the all-in-one image, two Compose kits with
  `install.sh`/`install.ps1`, first-run setup with cookie sessions, the upgrade harness and the
  operator CLI in the image (`node cli.mjs check-upgrade | migrate | status | backup | restore |
  checksum`), and the restore drill `tools/image/drill-backup.sh` (back up, wipe, restore,
  compare table checksums, sign in) in the CI image job. The nightly install matrix
  (M0-028, `install-matrix.yml`) is green on all five images: 17 to 18 s to `/ready` on the
  Ubuntu 22.04, 24.04 and arm64 runners, 36 s inside Debian 12 and Rocky 9 containers.
- Nightly benchmarks (M0-033): the first green run's results are the CI baseline in
  `docs/spikes/baseline/ci` and `pnpm bench:check --size 200k --baseline docs/spikes/baseline/ci`
  passes against it.
- M1-022 (started while the 10M run holds the bench cluster): `packages/workflow` holds the
  workflow behaviour model, a data-only conformance case format with provenance, 374 cases for
  WF-001 to WF-012, the runner (`pnpm conformance`) and an in-memory reference model that passes
  every case. The engine (M1-023) implements the same `WorkflowEngine` interface and is checked
  against the reference model. Open points are `verify` notes on the cases (history entry order,
  "has been in" and the current status, parent-status validator without a parent, Jira class
  names for the import mapping).
- M1-033 (also while the 10M run holds the bench cluster): the query conformance suite in
  `packages/query/src/conformance`, 2,220 data cases for QRY-001 to QRY-013 with provenance,
  run by `pnpm conformance query` against this repository's parser and resolver. Grammar
  passes in full; the per-section pass rates (76% overall) are a golden
  (`__golden__/pass-rates.json`) that M1-034 and M1-035 raise. The failures are gaps, not
  wrong cases: fields the catalogue lacks (versions, components, sprint, due, text, comment,
  resolution, filter), history on every field, user values by name, `@current` sprint tokens,
  slash dates, function arity, ordering comparisons on priorities and versions, ambiguous
  custom names, `=` accepted on text fields.
- M1-034 (in progress, the one-hour fuzz is the last step): the native grammar spec
  (`docs/specs/06-query-language-grammar.md`); the lexer and parser recover from errors
  (`parseWithDiagnostics` reports every independent mistake with offsets, line, column and
  expected tokens, and returns a partial tree that always prints as a valid query;
  `parseQuery` throws the first); a nesting limit of 100 levels (20,000 nested parentheses
  overflowed the stack before); `@current` tokens and slash dates lex. Tests: the 969 parse
  cases of the conformance suite run as parser tests, plus recovery, position, hint, limit
  and property tests. `pnpm fuzz query --minutes 60` is the fuzzer (`packages/devtools`).
- Afternoon (Opus 5.5): M1-035 Jira-compatible dialect (`toNative`/`toJira` on the shared tree);
  M1-103 metrics on port 9464, OTLP traces when configured, the admin System status page (CI
  green including e2e) and example Prometheus rules and a Grafana dashboard in
  `deploy/observability`; the compiler drives custom-field queries from their side table when
  the order allows (10M results under Next); the licence gate now reads the 26 packages pnpm
  stores under hashed folder names (it skipped them before); the fuzzer found a numeral
  precision bug in the lexer (fixed).
- Query compiler fixes found by the spike: id tiebreaker in the newest-first indexes and
  `NULLS LAST` only on nullable columns (41.7 ms to 0.65 ms); `WAS` as one history `EXISTS`
  (1.9 s to 0.65 ms for a value that never occurred); labels and word search use index-friendly
  operators.
- Test infrastructure: every Vitest project sets its own timeouts; `TRACKSMITH_PG_CACHE_DIR`
  moves the embedded clusters to another disk; a second process attaches to the running
  bench cluster instead of starting an empty one.

### Next (in order)

0. **Where the benchmark data lives (2026-10-12, 14:30).** E: is a 5,400 rpm hard disk (see
   Notes); the user made room on G: for the bench cluster. It is being copied from
   `.cache/pg-test/bench` to C: and then moved to `G:/tracksmith-pg/bench` (137 GB after
   dropping the ruled-out 10M JSONB and EAV schemas). From now on run benchmarks with
   `TRACKSMITH_PG_CACHE_DIR=G:/tracksmith-pg`. Once G: has served a full run, delete the E:
   copy. Helper scripts in `.cache/scripts/` (run with `corepack pnpm exec tsx`, with
   `TRACKSMITH_PG_CACHE_DIR` set): `hold-bench.mts` keeps the cluster up between spikes
   (create `.cache/scripts/release-bench` to stop it cleanly), `activity.mts` shows running
   statements, `prepare-10m.mts` adds the newest-first side index and vacuums, `stats-10m.mts`
   adds (field_id, value) extended statistics, `explain-multi.mts` explains the multi-select
   query in both compiler forms, `sizes.mts` lists table sizes.
1. **The 10M results and what is left (M0-016, M0-017, then ADR-008 and ADR-010).**
   - **Query compiler at 10M with side-table anchoring (committed)**, measured on the E: hard
     disk: 21 of 22 queries under 20 ms p95 (option-eq 1.2 ms, date-window 0.5 ms,
     user-field-mine 0.7 ms, number-gt-sorted 0.8 ms; before: three timeouts and 4.5 s). Log:
     `.cache/scripts/rerun-query-10m.log`; report `docs/spikes/query-compiler-10m.md`.
   - **multi-in is still bad**: `"multi" IN (A, B) AND status != Done ORDER BY created DESC`
     times out in both compiler forms. The planner estimates 121 matching side rows where there
     are about 37,000 (two values of 18,600 rows each), because a 30,000-row ANALYZE sample of
     a 147M-row table cannot see per-field option values; it then fetches every match and
     sorts. Extended statistics on (field_id, value) (added to the spike schema, committed)
     moved the estimate only from 58 to 121. Next, on C:: raise the statistics target of
     `value` and of the extended statistics on the side tables (`ALTER TABLE ... ALTER COLUMN
     value SET STATISTICS 5000`, `ALTER STATISTICS ... SET STATISTICS 5000`), ANALYZE, and
     check that the plan walks `(field_id, created_at DESC)` and stops after 50. If estimates
     stay unreliable, keep per-option counts in the app (they are cheap to maintain) and let
     the compiler choose the plan shape from them; record the outcome in ADR-008 and ADR-010.
   - **Field storage at 10M**: the semi-join rewrite and the newest-first index cut the date
     window from 57 s to 1.8 s and option-plus-number from 13 s to 3.2 s on the hard disk;
     rerun on C: (`pnpm spike field-storage --items 10000000 --candidates side --runs 20`).
     `docs/spikes/field-storage-1m.md` was overwritten by a run without the new index;
     rerun at 1M too (`--candidates jsonb,side` reuses the schemas).
   - **Permission pre-filter at 10M**: every filtered query stays under 15 ms, but the
     relative budget in `pnpm bench:check` (at most 20% where it costs more than 2 ms) fails
     at up to 310% (2.6 ms to 10.7 ms). Waiting on the user (see below).
   - Then fill the 10M tables into ADR-008 and ADR-010, flip them to Accepted (README too),
     mark M0-016, M0-017 and M0-024 done, refresh `docs/spikes/baseline`, `pnpm bench:check`,
     commit the reports with the ADRs.
2. **M1-099 Helm chart: done.** CI's helm.yml (kind) passed: helm test green, a rolling
   upgrade under load with 55,271 requests and none failed. Locally, kind's etcd timed out
   while robocopy saturated C: (Docker's disk); rerun `tools/helm/kind-test.sh` locally only
   on a quiet disk. The upgrade rolls the same image; test two versions with the first release.
3. **M1-034**: a second one-hour fuzz (seed 20261013) runs on the fixed lexer; when it ends
   with no failures, mark M1-034 done and M1-035 with it (record inputs and the slowest time).
4. M0-034: `pnpm gate M0 --ci` all green, then the user's acceptance recorded in
   `docs/plan/decisions.csv` as an "M0 acceptance" row marked Decided.
5. Next M1 work that does not wait on M0 acceptance: M1-100 (air-gap bundle), the catalogue
   gaps the query suite lists; M1-001 once M0-034 is accepted.

### Notes and gotchas

- Pushes use the GitHub CLI token through a repo-local credential helper
  (`git config --local credential.helper`); Git Credential Manager would otherwise open a
  sign-in window. The CLI is signed in as rockersands. The token lacks the `workflow` scope,
  so pushes that touch `.github/workflows/*` are refused (see Waiting on the user).
- Bench datasets live in `.cache/pg-test/bench` as UNLOGGED tables: stop that cluster cleanly
  (`pg_ctl -m fast`); an immediate stop empties them. `pnpm gen` checks for rows before reuse.
  The bench cluster is shared: a second process attaches to the running server; if the owner
  stops it (a `pnpm gen` finishing), attached benchmarks fail; rerun them.
- **Disks on this machine (measured 2026-10-12 with Get-PhysicalDisk):** E: is a Seagate
  ST4000DM004, a 5,400 rpm hard disk (random 8 KB reads 13 ms p50), and holds the repository
  and `.cache/pg-test`, so every bench cluster. C: (Kingston NV1, 342 GB free) and G: (XPG
  S40G, 86 GB free) are NVMe; D: is another hard disk. The user confirmed this and said C:
  and G: are free to use: database clusters and benchmarks go there through
  `TRACKSMITH_PG_CACHE_DIR`, the source tree stays on E:. Benchmarks on E: measure seeks, not
  the design. Run the gate with the test clusters on an NVMe drive:
  `TRACKSMITH_PG_CACHE_DIR=G:/tracksmith-pg-test pnpm verify`
  (and `PLAYWRIGHT_BROWSERS_PATH=<empty dir>` skips the browser stories; CI runs them).
  Each Vitest project sets its own timeouts; the root config's are not inherited.
- The OpenFGA server binary for the permission spike is in `.cache/tools/openfga` (v1.22.0,
  downloaded from its GitHub release and checksum-verified); `pnpm spike authz --openfga`
  needs it. CI has no binary, so that candidate and its test are skipped there. Its metrics
  port is disabled in the spike; an orphaned instance otherwise blocks the next one.
- `pnpm spike xml` writes its synthetic file under `.cache/xml` unless `--dir` says otherwise
  (use `--dir G:/tracksmith-xml` while E: is busy; the 5 GB file takes two minutes to make).
- In `pnpm verify ... | grep`, use `set -o pipefail` before chaining a commit, or the grep
  status hides a failure. Editing TypeScript through `node -e` string replacement mangles
  `\n` escapes inside quoted strings; use the Edit tool for source edits.
- If `pnpm` is not on PATH, use `corepack pnpm ...`. `corepack enable` needs admin rights on
  this machine, so it was not run.
- When `pg_ctl` starts the server it must not inherit Node's pipes, or the call hangs on Windows
  (see `runWithoutPipes` in `packages/testkit/src/pg/server.ts`).
- In Playwright, `getByRole(..., { name: 'Boards' })` also matches "Dashboards". Use
  `exact: true` for short names.
- First-run setup (M0-027): the API role prints `{"msg":"first-run setup","link":...}` at every
  start until setup completes; `TRACKSMITH_SETUP_TOKEN` fixes the token (the e2e suite uses
  `e2e-setup-token-0123456789`). `pnpm verify --e2e` starts `apps/web/e2e/api-server.ts` (embedded
  Postgres cluster `e2e`, port 8787) and the Vite preview proxies `/api` to it.
- Docker drills from Git Bash: wrap docker so that `MSYS_NO_PATHCONV=1` applies to it alone
  (`docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }`), or `/data/...` arguments become
  Windows paths; exporting it instead breaks curl's `-o /dev/null` (exit 23) and `$WORK` paths.
  `docker cp` needs a native host path (`cygpath -w`) and an existing parent directory in the
  container. `curl | grep -q` under `pipefail` can fail with curl's exit 23 because grep closes
  the pipe first (GNU grep also stops early when its output is /dev/null); read the body into a
  variable and match on it.
- PostgreSQL client versions: a pg_restore newer than the server fails on
  `SET transaction_timeout` (17+ emits it), so the image ships clients 16, 17 and 18 under
  `/usr/libexec/postgresql<major>` and `clientBinary()` in `apps/server/src/backup.ts` picks the
  server's major; `TRACKSMITH_PG_BIN` points at another directory. The round-trip test
  (`backup.roundtrip.test.ts`) skips when no matching client is on this machine; the CI image
  job runs the real drill.
- Python's `Path.write_text` on Windows writes CRLF: Biome's format check then fails and git
  shows whole-file diffs. Open files with `newline='\n'` or run `sed -i 's/\r$//'` afterwards.
- Commit 5ffe3ad carries the message of the commit before it; it holds the upgrade harness and
  the operator CLI (M0-029). Noted in the body of the commit that followed.
- `pnpm gate` only counts a full `pnpm verify`: a run narrowed with `--only`, `--changed` or a
  filter writes `partial: true` into `.verify/summary.json` and the gate reports it.
- Spike p95 is nearest-rank: with 10 runs it is the slowest sample. Use 40 or more runs for
  sub-millisecond queries on shared runners.
- `install.sh` resolves the port as Compose does: `TRACKSMITH_PORT` in the environment first,
  then `.env`, then 8080. The install-matrix scripts set it in the environment.
- Record task state in `docs/plan/progress.csv` (in-progress, done, waiting-on-user) as you go;
  `pnpm next-task`, `pnpm status-report`, `pnpm gate` and a test read it.

### Waiting on the user

- Public name: pick from the shortlist in `docs/decisions/name.md` (issuetide, workrill,
  taskmoor) or propose another; the codename stays until then.
- After the first green nightly run (03:00 UTC, or "Run workflow" on the Actions tab), copy
  the `nightly-results` artifact's JSON files into `docs/spikes/baseline/ci/` so later runs
  catch regressions. (Done: the CI baseline is in `docs/spikes/baseline/ci`.)
- Permission pre-filter budget: at 10M every filtered query stays under 15 ms, but the
  overhead is up to 310% of a 2.6 ms query. Keep the relative budget (and optimise the
  pre-filter), or state it as an absolute one (for example at most 10 ms added)?
- The other open decisions are listed at the end of `docs/status/2026-10-12.md`; none blocks
  M0 except the name and, before the first public release, counsel's review.
