# Handoff

Read this first in every session, then update it before you stop.

## Last session: 2026-10-12 (overnight)

### Done

- **M0 is 22 of 35 tasks done; 31 of 33 ADRs accepted.** `pnpm gate M0` prints the exit
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
- Query compiler fixes found by the spike: id tiebreaker in the newest-first indexes and
  `NULLS LAST` only on nullable columns (41.7 ms to 0.65 ms); `WAS` as one history `EXISTS`
  (1.9 s to 0.65 ms for a value that never occurred); labels and word search use index-friendly
  operators.
- Test infrastructure: every Vitest project sets its own timeouts; `TRACKSMITH_PG_CACHE_DIR`
  moves the embedded clusters to another disk; a second process attaches to the running
  bench cluster instead of starting an empty one.

### Next (in order)

1. **The 10M run.** The chain started at 03:18 local time holds the bench cluster:
   `pnpm gen --items 10000000` (done, 38 min) then `pnpm spike field-storage --items 10000000`
   (jsonb done, side building, then eav). The EAV candidate is already ruled out at 1M, so when
   the chain reaches the eav build (`gen.pairs` and `fs_side` complete), stop it and run
   `pnpm spike field-storage --items 10000000 --candidates jsonb,side` (reuses the built
   schemas, times queries only), then `pnpm spike query --items 10000000` (builds the extra
   indexes first, about 20 min) and `pnpm spike authz-overhead --items 10000000`, then the same
   two at `--items 1000000`. Fill the 10M tables into ADR-008 and ADR-010, flip both to
   Accepted (README too), mark M0-016, M0-017 and M0-024 done, refresh the baselines in
   `docs/spikes/baseline` with the new 1M/10M files if they are within budget.
2. M0-025 to M0-030 (image, all-in-one, setup page, install matrix, migration harness,
   backup drill) once Docker works; M0-011's image build goes with M0-025.
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
- While a big spike saturates the repository's disk, database tests time out. Run the gate
  with the test clusters on another disk:
  `TRACKSMITH_PG_CACHE_DIR=C:/Users/you/AppData/Local/Temp/tracksmith-pg-test pnpm verify`
  (and `PLAYWRIGHT_BROWSERS_PATH=<empty dir>` skips the browser stories; CI runs them).
  Each Vitest project sets its own timeouts; the root config's are not inherited.
- The OpenFGA server binary for the permission spike is in `.cache/tools/openfga` (v1.22.0,
  downloaded from its GitHub release and checksum-verified); `pnpm spike authz --openfga`
  needs it. CI has no binary, so that candidate and its test are skipped there. Its metrics
  port is disabled in the spike; an orphaned instance otherwise blocks the next one.
- `pnpm spike xml` writes its synthetic file under `.cache/xml` unless `--dir` says otherwise;
  the 5 GB file was generated on C: (`C:/Users/you/AppData/Local/Temp/tracksmith-xml`).
- In `pnpm verify ... | grep`, use `set -o pipefail` before chaining a commit, or the grep
  status hides a failure. Editing TypeScript through `node -e` string replacement mangles
  `\n` escapes inside quoted strings; use the Edit tool for source edits.
- If `pnpm` is not on PATH, use `corepack pnpm ...`. `corepack enable` needs admin rights on
  this machine, so it was not run.
- When `pg_ctl` starts the server it must not inherit Node's pipes, or the call hangs on Windows
  (see `runWithoutPipes` in `packages/testkit/src/pg/server.ts`).
- In Playwright, `getByRole(..., { name: 'Boards' })` also matches "Dashboards". Use
  `exact: true` for short names.
- Record task state in `docs/plan/progress.csv` (in-progress, done, waiting-on-user) as you go;
  `pnpm next-task`, `pnpm status-report`, `pnpm gate` and a test read it.

### Waiting on the user

- Run `gh auth refresh -s workflow` (browser sign-in as Rockersands) so pushes may change
  `.github/workflows/*`. The local branch `ci-workflows` holds the nightly benchmark job
  (`nightly.yml`, M0-033) and Chromium in every test job (`ci.yml`); after the refresh:
  `git push origin ci-workflows`, then merge it into main (or `git merge ci-workflows` and push).
  After the first green nightly run, copy its `nightly-results` artifact's JSON files into
  `docs/spikes/baseline/ci/` so later runs catch regressions.
- Docker Desktop is installed but needs WSL: run `wsl --install` as administrator and reboot.
  M0-025 to M0-030 (images, install kits, migrations, backup drill) wait for it.
- Public name: pick from the shortlist in `docs/decisions/name.md` (issuetide, workrill,
  taskmoor) or propose another; the codename stays until then.
- The other open decisions are listed at the end of `docs/status/2026-10-12.md`; none blocks
  M0 except the name and, before the first public release, counsel's review.
