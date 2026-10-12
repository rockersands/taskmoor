# Handoff

Read this first in every session, then update it before you stop.

## Last session: 2026-10-12 (overnight and morning)

### Done

- **M0 is 28 of 35 tasks done; 31 of 33 ADRs accepted.** `pnpm gate M0` prints the exit
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
  (M0-028, `install-matrix.yml`) is written; its first run is the next step.
- Query compiler fixes found by the spike: id tiebreaker in the newest-first indexes and
  `NULLS LAST` only on nullable columns (41.7 ms to 0.65 ms); `WAS` as one history `EXISTS`
  (1.9 s to 0.65 ms for a value that never occurred); labels and word search use index-friendly
  operators.
- Test infrastructure: every Vitest project sets its own timeouts; `TRACKSMITH_PG_CACHE_DIR`
  moves the embedded clusters to another disk; a second process attaches to the running
  bench cluster instead of starting an empty one.

### Next (in order)

1. **The 10M run.** The reload chain (started 10:18 local on 2026-10-12) holds the bench
   cluster: `pnpm gen --items 10000000` finished at 11:10 (52 min, fingerprint 7ba375e3e818fa59,
   tables now LOGGED), `pnpm gen --items 1000000` follows, then the scratchpad script
   `timings.sh` runs `spike field-storage --items 10000000 --candidates side`, `spike query` and
   `spike authz-overhead` at 10M, then `query`, `authz-overhead` and `field-storage
   --candidates jsonb,side` at 1M (about an hour in all; each writes `docs/spikes/<name>-<size>.md`
   and `data/`). Then fill the 10M tables into ADR-008 and ADR-010, flip both to Accepted (README
   too), mark M0-016, M0-017 and M0-024 done, refresh `docs/spikes/baseline` with the new 1M/10M
   files if they are within budget, and run `pnpm bench:check`.
2. **Install matrix (M0-028) and the nightly baseline (M0-033).** The first matrix run failed
   on every row (port precedence in `install.sh`, curl on Rocky; both fixed and reproduced
   locally with `tools/install-matrix/run.sh` and `container.sh debian:12`), and the first
   nightly run failed on one noisy p95 (now 40 runs). After the push: `gh workflow run
   install-matrix.yml` and `gh workflow run nightly.yml`, then `gh run watch`. When the matrix
   is green, record the seconds per OS from the job summary in `progress.csv` and `STATUS.md`
   and mark M0-028 done (the arm64 row is `continue-on-error`). When the nightly is green,
   `gh run download <id> -n nightly-results` and copy its `data/*.json` into
   `docs/spikes/baseline/ci/`, then mark M0-033 done.
3. M0-034: `pnpm gate M0 --ci` all green, then the user's acceptance recorded in
   `docs/plan/decisions.csv` as an "M0 acceptance" row marked Decided.

### Notes and gotchas

- Pushes use the GitHub CLI token through a repo-local credential helper
  (`git config --local credential.helper`); Git Credential Manager would otherwise open a
  sign-in window. The CLI is signed in as rockersands. The token lacks the `workflow` scope,
  so pushes that touch `.github/workflows/*` are refused (see Waiting on the user).
- Bench datasets live in `.cache/pg-test/bench` as UNLOGGED tables: stop that cluster cleanly
  (`pg_ctl -m fast`); an immediate stop empties them. `pnpm gen` checks for rows before reuse.
  The bench cluster is shared: a second process attaches to the running server; if the owner
  stops it (a `pnpm gen` finishing), attached benchmarks fail; rerun them.
- Disks on this machine: E: and G: are NVMe, C: is a hard disk (the user asked that C: not be
  used for heavy work). The repository and its `.cache` live on E:. While a big spike
  saturates E:, run the gate with the test clusters on G:
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
  catch regressions. (Done on the user's side: the GitHub token now carries the `workflow`
  scope and Docker Desktop runs on WSL 2; Docker's disk image sits on C:, the hard disk, and
  can be moved from Docker Desktop's settings.)
- The other open decisions are listed at the end of `docs/status/2026-10-12.md`; none blocks
  M0 except the name and, before the first public release, counsel's review.
