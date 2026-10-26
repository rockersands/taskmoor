# Handoff

Read this first in every session, then update it before you stop.

## Moved to a Mac (2026-10-15)

Development resumed on a Mac (Apple silicon, macOS). The repository lives in
`~/Documents/claude` (not a folder named tracksmith). The Windows notes below (drives E: and
G:, MSYS, CRLF, `pg_ctl` pipes) are history for this machine; see "On the Mac" under Notes.

**One branch still holds unfinished work** from a background session that was stopped (one
commit, marked "WIP, unverified"; the gate was never run on it). It starts from `f735251`, two
commits before the skins, so cherry-pick it onto `main` first:

| Branch | Task | Contents |
|---|---|---|
| `wip/m1-083-scim` | M1-083 SCIM 2.0 | Migration 0012, `apps/server/src/scim/`; about 1,550 lines |

To resume it: cherry-pick its commit onto a new branch from `main`, read the diff, finish it,
run `pnpm verify` (and `--e2e` for UI), then squash into a real commit. Migration numbers are
reserved: 0011 ticket types, 0012 SCIM; 0013 is appearance on `main`. If a branch looks wrong,
redo the task instead: nothing depends on it. `wip/m1-080-sso-ui` and
`wip/m1-007-ticket-types` were finished (below); the first is deleted from GitHub, the second
can be.

## Last session: 2026-10-26 (cloud container)

### Done

- **M1-008 tickets** (migration 0014; ADR-009 implementation note; ADR-037 for the rank):
  - Tables: `ticket`, `ticket_counter` (consecutive numbers per track under a row lock),
    `ticket_key_history` (trigger-written; a number belongs to one ticket for good, so old keys
    resolve after a move as old track keys do after a rename), `ticket_detached_parent` and the
    sequence `ticket_rank_seq`. Date columns now read as `YYYY-MM-DD` text (a type parser in
    `packages/db/src/client.ts`), never as a Date at local midnight.
  - `apps/server/src/tickets/rank.ts`: fractional rank keys, new tickets at the bottom through
    the sequence, moves to a random point in the middle of the gap, retry on a clash.
  - `routes/tickets.ts` (data access in `tickets/store.ts`, rules in `tickets/model.ts`):
    create, view by id or any key it has had (with `redirect`), list in rank order by track or
    parent, edit with a permission per field and an optional `version`, `PUT .../rank`,
    `POST .../move` (subtickets come along; types the target lacks need `ticketTypeId` or
    `subticketTypeId`), `DELETE` to the trash (subtickets go along, other children lose the
    link), `POST .../restore` (links come back), `GET /api/v1/trash`. Errors in values answer
    400 `invalid_fields` with a reason per field. Description and environment are ProseMirror
    documents checked against `@taskmoor/richtext` (now a server dependency, about 1 MB more in
    `server.mjs`).
  - Locks: ticket writes that check levels hold the hierarchy lock shared (`shareHierarchy`), and
    every writer takes the hierarchy, then the track and type set (key share), then tickets.
  - M1-007 hooks filled: `hierarchyTickets` reads only tickets of types whose level changes and
    their parents and children; `ticketsOfTypes` counts the trash too. `ticketTypeMapping` on
    `PATCH /type-sets/:id` and `PATCH /tracks/:id` maps tickets of a leaving type to one at the
    same level (CORE-005 (2)).
  - Events `ticket.created`, `.updated`, `.moved`, `.ranked`, `.deleted`, `.restored`; the last
    two are audited (`audit/subscriber.ts`), the others wait for the change history (M1-009).
  - Tests: `routes/tickets.test.ts` (1,000 parallel creates give 1..1000, moves keep key
    history, concurrent rank moves, trash round trip, type mapping, hierarchy impact),
    `tickets/rank.test.ts` (properties), `packages/db/src/tickets.test.ts`, contract scenarios.
- `apps/web/src/tokens/AdminTokensPage.test.tsx` typed a fixed 2026-10-01 against fixtures dated
  relative to today, so it failed from 2026-10-21 on; it now types a day ten days back.

### Next (in order)

1. **M1-083 SCIM** (`wip/m1-083-scim`), as described at the top. Migration 0012 is still reserved for it; 0014
   is now taken by tickets, so a long-lived development database that ran 0014 will refuse
   0012 ("corrupted migrations"): recreate it.
2. **M1-009 change history**: every ticket mutation writes per-field change rows; the
   `ticket.updated` payload already carries the field changes in API names.
3. `pnpm next-task`: M1-014 (priorities, close reasons, labels, releases, areas), M1-015
   (links, followers, votes), M1-010 (field types) are ready.
4. Later for tickets: the trash retention setting and purge (M1-101; `TRASH_RETENTION_DAYS` is
   30 for now), ticket-level grantees and visibility levels (M1-020), hierarchy rollback
   (CORE-007 (2)), a ticket UI (the ticket view is M1-051, boards M1-043 and M1-046), block
   ranking and a background rank rebalance if keys grow long (M1-047).

### Notes for cloud sessions (Linux container, running as root)

- The embedded Postgres refuses to run as root. Start the system one
  (`service postgresql start`), give its `postgres` user a password and point
  `TASKMOOR_TEST_DATABASE_URL` at it, as the CI job does (`.github/workflows/ci.yml`).
  `--e2e` still needs the embedded cluster and was not run here (no UI changed).
- The container's Chromium (`/opt/pw-browsers`, build 1194) is older than Playwright 1.64's
  (1248). Linking it under the new names in a scratch folder and setting
  `PLAYWRIGHT_BROWSERS_PATH` there runs every story (193 passed).
- A full run once ended with an unhandled 57P01 ("terminating connection due to administrator
  command") from `packages/db/src/schema.test.ts` while its database was dropped; every test
  passed and reruns were clean (the same flake as under "On the Mac" below).

## Earlier: 2026-10-15 (Mac)

### Done

- **Set up on the Mac**: Node 22 (Homebrew `node@22`), pnpm 10 through corepack, the local
  identity and hooks, and the gate green (2,119 tests, 23 e2e) before any change.
- **M1-080 finished** and merged into `main` with the user's go-ahead. Started from the WIP
  branch, then:
  - Wired `#/admin/identity-providers` into the app, Settings ("Single sign-on") and the
    command palette; styles in `apps/web/src/styles/sso.css`; fieldsets for the button and
    mapping groups (Biome's a11y rule).
  - `GET /api/v1/identity-providers` now also answers `redirectUri`, built from `PUBLIC_URL`:
    the WIP showed `window.location.origin`, wrong behind a proxy or another host name.
  - Fixed: an `sso_error` such as `toString` matched an inherited property and passed a
    function to the translator; the email's blur now reads the field, not the last render.
  - At the break-glass address a refused password explains that only break-glass accounts may
    use one for that domain.
  - Tests: `SignInForm.sso.test.tsx`, `sso/*.test.ts(x)` (one reads the server's `fail()` codes
    so the error list cannot drift); stories for every new component, axe in both skins.
  - e2e: `e2e/api-server.ts` starts the fake provider (`FakeIdp`, now exported as
    `@taskmoor/server/testing`) on port 8788, signing in Sam (`sam@sso.test`). The last test
    in `setup.spec.ts` adds the provider through the page, then covers no account, JIT,
    enforcement (password field gone, backend answers `sso_required`) and delete.
  - ADR-019 records the sign-in page and administration design.
- **M1-007 ticket types and hierarchy levels** (finished from the WIP branch in its own
  worktree, then cherry-picked onto `main`; ADR-009 implementation note): migration 0011
  (levels, ticket types, type sets, the default set per track type, `track.type_set_id`), the
  pure model with its property tests in
  `apps/server/src/tickets/hierarchy.ts`, the API in `routes/ticket-types.ts`
  (`/api/v1/hierarchy-levels` with `/impact`, `/api/v1/ticket-types`, `/api/v1/type-sets`) and
  `GET /api/v1/tracks/:id/ticket-types`; tracks get their type's default set (local-mode tracks
  a copy they own, plus their own ticket types). Nine events, all audited; read and write token
  scopes. No UI yet.

### Next (in order)

1. **M1-008 tickets**: the core path to boards. It fills the two hooks M1-007 left in
   `apps/server/src/tickets/configuration.ts`: `hierarchyTickets` (tickets with type and
   parent, so hierarchy changes see the links they break) and `ticketsOfTypes` (a type with
   tickets cannot leave a set until they are mapped to another type, CORE-005 (2); add the
   mapping then). Rollback of a hierarchy change that broke links (CORE-007 (2), 30 days)
   needs tickets too; until it exists such a change is refused with its impact.
2. **M1-083 SCIM** (`wip/m1-083-scim`): SCIM clients are service accounts with a `scim` token
   scope; compliance suite and Okta / Entra ID shaped fixtures.
3. The break-glass switch per account comes with the user admin UI (M1-053); the backend has
   it (`breakGlass` on `PATCH /users/:id`).
4. `pnpm next-task` for the rest (M1-073 AI gateway core and M1-082 LDAP are also ready). The
   query catalogue gaps (targetRelease, area, sprint, due; history on every field; user values
   by name; function arity) belong to M1-036.
5. M1-121 is the contract step for M1-001: one release later, drop the M0 `session` table and
   the default on `app_user.workspace_id` (ADR-022).
6. **Upgrade the local demo** once the WIP branches are merged or dropped. It ran on the Windows
   machine (see Local demo); this Mac has no Docker yet.

## Earlier: 2026-10-12 to 13 (night)

### Done

- **M1-122 skins** (ADR-036, the user's request): light ("Soft daylight") and dark ("Soft
  night") skins as token blocks on `[data-skin]` in `apps/web/src/styles/tokens.css`;
  `apps/web/public/skin-boot.js` paints the saved skin before the app loads; Account,
  Appearance offers System, Light and Dark, applies at once and saves to the account
  (migration 0013 `app_user.appearance`; every sign-in answer and `GET /session` carry it).
  The shell, forms, buttons and cards moved to the soft look (floating rounded panels, pills,
  circles, soft shadows, pastel canvas, waves on the stand-alone pages). Storybook has a skin
  toolbar, and every story runs its axe test in both skins (`vitest.stories.config.ts` and
  `vitest.stories-dark.config.ts`, the skin passed through `test.env.STORY_SKIN`). Adding a
  skin: a token block, an entry in `src/skins/skins.ts`, the name in `public/skin-boot.js` (a
  test keeps them equal).

- **Four parallel branches merged** (each built in its own worktree, then merged in migration
  order 0006 to 0010): M1-003 audit log (ADR-034), M1-004 API tokens and service accounts
  (ADR-035; its ADR was renumbered from 034), M1-006 tracks, M1-084 two-factor UI. Merge rules
  that keep coming up: union the migration index, upgrade seeds and catalogue in number order;
  rebuild `events/contract.test.ts` from main plus each branch's added scenarios (order matters:
  the two-factor policy scenario demands a second factor of later users); regenerate the schema
  golden with `pnpm verify --update --only=tests -- --project=db`; every new event type needs a
  decision in `audit/subscriber.ts`, and every new route a class in `tokens/scopes.ts`.
- **M1-080 single sign-on, backend** (ADR-019 "Single sign-on with OpenID Connect"):
  `apps/server/src/sso/oidc.ts`, `routes/sso.ts`, migration 0010. Providers with sealed client
  secrets, domains and group maps; code flow with PKCE, state and nonce bound to the starting
  browser; JIT and linking only for verified addresses of served domains (never service
  accounts); group sync; enforced single sign-on with break-glass accounts (`breakGlass` on
  `PATCH /users/:id`); refusals in the audit log. Tests use the in-process
  `testing/fake-idp.ts`; `bash tools/sso/keycloak-test.sh` runs the real flow against
  Keycloak 26.7.4 (also `sso.yml` in CI).
- **Fixes found by CI after the merges:** restore now drops partitioned tables before
  `pg_restore --clean` (it cannot drop a partition's inherited primary key); shutdown answers
  with `Connection: close` for `TASKMOOR_SHUTDOWN_DRAIN_MS` before closing, so keep-alive clients
  lose no request during a rolling upgrade (kind lost 1 in 55k before); the licence test counts
  packages per store folder.
- **Skins requested by the user:** light and dark first, in the soft pastel style of their
  reference image. Plan: ADR-036 and M1-122 (see Next).

## Earlier: 2026-10-12 (overnight and morning)

- **M1-005 event bus** (ADR-015 implemented): `apps/server/src/events` (catalogue, emit,
  relay, job queue, worker loop in the worker role). Every new mutating route must emit one
  event in its transaction and get a scenario in `events/contract.test.ts`, or the test fails.
  Subscribers register in `events/subscribers.ts` (none yet; audit is first).
- **M1-002 authorization** (ADR-012 implemented): roles, access policies and grants, global grants,
  track role actors, and `apps/server/src/authz/authorizer.ts` (per-track permission sets, list
  filter for search, explainer, epoch-checked cache). Routes check `request.authz`; site
  administration can now come from a group. The track table exists with its permission columns;
  M1-006 adds the rest.
- **M1-001 identity foundation** (after the user tested the demo): `workspace` table and
  `workspace_id` on every table (fitness test `packages/db/src/workspace-scope.test.ts`), users
  with profiles, nested groups, Argon2id (`hash-wasm`) keyed with a pepper from
  `TASKMOOR_DATA/secrets/password-peppers` or `TASKMOOR_PASSWORD_PEPPER` (backups carry the
  keyring, restore merges it), a password policy with the zxcvbn-ts breached list, lockout and
  address limits in Postgres, hashed session tokens with idle and absolute expiry, session list
  and revoke, admin users and groups API, one-time password links and `node cli.mjs
  password-link <email>`. `apps/server/src/asvs.test.ts` is the ASVS level 2 checklist (three
  todo items wait for email, M1-057). UI: user menu with sign-out, Account page, password link
  page; e2e covers sign-out and in, lockout, password change and activation. ADR-019 records
  the design.
- **Own terminology** (the user's request; `docs/specs/00-terminology.md`): ticket, track,
  ticket type, Outcome / Feature / Bug / Chore / Subticket, requester, followers, close reason,
  stage, areas, releases, guards / checks / effects and the rest, in the specs, ADRs, plans,
  the native query vocabulary (`track`, `closeReason`, `stage`, `targetRelease`, ...), the
  workflow model and the UI ("Tracks" in the navigation). Jira's names, classic and 2025, stay
  in the Jira-compatible dialect, import mappings and Source columns. The compiled SQL of the
  query golden is byte-identical; the workflow suite still passes 374 of 374. The M0 spike
  schema keeps `space_id` and `item_id` (rule 6 of the terminology file).
- **Renamed to taskmoor** (the user's choice): packages `@taskmoor/*`, variables `TASKMOOR_*`,
  images `taskmoor` and `taskmoor-allinone`, the chart in `deploy/helm/taskmoor`, metrics
  `taskmoor_*`, UI and docs. Kept on purpose: the GitHub URL (until the repository is renamed),
  the local folder, dated reports, recorded benchmark data and historical codename mentions.
  The cluster folders moved with it: `G:/taskmoor-pg` (bench) and `G:/taskmoor-pg-test`.
- **M0 accepted by the user (2026-10-12).** `pnpm gate M0 --ci` is all green; the counsel
  review is deferred to the first public release (`docs/plan/decisions.csv`). The local demo
  runs on port 8080 (see Local demo).
- **M0 was 30 of 35 tasks done; 31 of 33 ADRs accepted** at the start of the day. `pnpm gate M0` prints the exit
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
  image with roles by `TASKMOOR_ROLE`, the all-in-one image, two Compose kits with
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
  "has been in" and the current status, parent-status check without a parent, Jira class
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
- Evening: the bench cluster moved to G: (NVMe) after E: turned out to be a hard disk; on
  NVMe the 10M runs pass every field-storage and query budget (ADR-008 and ADR-010 accepted,
  M0-016, M0-017 and M0-024 done); multi-select queries needed (field_id, value) statistics
  with target 5000. M1-099 Helm chart green on kind in CI (55,271 requests, none failed during
  a rolling upgrade). M1-100 air-gap bundle tooling and its offline install test.
- Query compiler fixes found by the spike: id tiebreaker in the newest-first indexes and
  `NULLS LAST` only on nullable columns (41.7 ms to 0.65 ms); `WAS` as one history `EXISTS`
  (1.9 s to 0.65 ms for a value that never occurred); labels and word search use index-friendly
  operators.
- Test infrastructure: every Vitest project sets its own timeouts; `TASKMOOR_PG_CACHE_DIR`
  moves the embedded clusters to another disk; a second process attaches to the running
  bench cluster instead of starting an empty one.

### Local demo

The demo runs from a copy of the Compose kit in `G:/taskmoor-demo` with the locally built
image (`docker build -t taskmoor:dev .` from the repository). Its `.env` pins the project
name, image, port 8080 and `PUBLIC_URL=http://localhost:8080`. Start or update it with
`bash install.sh` in that folder (it prints the one-time setup link until an administrator
exists; each restart issues a new link, so use the latest one); stop it with
`docker compose down` (add `-v` to delete its data). The old `G:/tracksmith-demo` folder is
unused and can be deleted by the user. What it shows today:
first-run setup, sign-in, the app shell with the command palette, Settings and the admin System
status page. Boards, items and queries arrive with M1.

### Notes and gotchas

- **On the Mac:**
  - Use Node 22: `PATH="/opt/homebrew/opt/node@22/bin:$PATH"`. The default `node` is 25, whose
    built-in `localStorage` hides jsdom's, and 9 web tests fail with
    "window.localStorage.clear is not a function".
  - Run the gate with a resolved temporary folder:
    `TMPDIR="$(cd "$TMPDIR" && pwd -P)/" pnpm verify`. macOS's `os.tmpdir()` is under `/var`, a
    link to `/private/var`, and dependency-cruiser reports resolved paths, so 5 cases in
    `packages/devtools/src/boundaries.test.ts` fail without it (a `realpathSync` around the
    test's `mkdtempSync` would remove the need).
  - e2e needs ports 4173, 8787 and 8788 (the fake identity provider) free.
  - Not on this Mac: Docker (local demo, image smoke tests, `tools/sso/keycloak-test.sh`; CI
    runs `sso.yml`), PostgreSQL client tools (the backup round trip skips; set
    `TASKMOOR_PG_BIN`), the 137 GB benchmark data (stayed on the Windows machine's G:) and the
    OpenFGA binary.
  - In the Storybook dev UI, `userEvent.type` in a play function fills the field without
    React seeing the change (also `PasswordShown`, which predates single sign-on). The same
    plays pass in `pnpm verify`, which runs them through Vitest; check interactions there.
  - The GitHub CLI token here has `repo` but not `workflow`: a push that changes
    `.github/workflows/*` needs `gh auth refresh -s workflow` first.
  - `migrate.test.ts` "applies each migration exactly once when several servers start
    together" once threw an unhandled 57P01 under the load of a full `--e2e` run; reruns
    were clean.

- Pushes use the GitHub CLI token through a repo-local credential helper
  (`git config --local credential.helper`); Git Credential Manager would otherwise open a
  sign-in window. The CLI is signed in as rockersands; its token has the `workflow` scope, so
  pushes that change `.github/workflows/*` go through.
- Bench datasets live in `G:/taskmoor-pg/bench` as UNLOGGED tables: stop that cluster cleanly
  (`pg_ctl -m fast`); an immediate stop empties them. `pnpm gen` checks for rows before reuse.
  The bench cluster is shared: a second process attaches to the running server; if the owner
  stops it (a `pnpm gen` finishing), attached benchmarks fail; rerun them.
- **Disks on this machine (measured 2026-10-12 with Get-PhysicalDisk):** E: is a Seagate
  ST4000DM004, a 5,400 rpm hard disk (random 8 KB reads 13 ms p50), and holds the repository
  and `.cache/pg-test` (the default place for test clusters). C: (Kingston NV1, 342 GB free) and G: (XPG
  S40G, 86 GB free) are NVMe; D: is another hard disk. The user confirmed this and said C:
  and G: are free to use: database clusters and benchmarks go there through
  `TASKMOOR_PG_CACHE_DIR`, the source tree stays on E:. Benchmarks on E: measure seeks, not
  the design. Run the gate with the test clusters on an NVMe drive:
  `TASKMOOR_PG_CACHE_DIR=G:/taskmoor-pg-test pnpm verify`
  (and `PLAYWRIGHT_BROWSERS_PATH=<empty dir>` skips the browser stories; CI runs them).
  Each Vitest project sets its own timeouts; the root config's are not inherited.
- The OpenFGA server binary for the permission spike is in `.cache/tools/openfga` (v1.22.0,
  downloaded from its GitHub release and checksum-verified); `pnpm spike authz --openfga`
  needs it. CI has no binary, so that candidate and its test are skipped there. Its metrics
  port is disabled in the spike; an orphaned instance otherwise blocks the next one.
- `pnpm spike xml` writes its synthetic file under `.cache/xml` unless `--dir` says otherwise
  (use `--dir G:/taskmoor-xml` while E: is busy; the 5 GB file takes two minutes to make).
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
  start until setup completes; `TASKMOOR_SETUP_TOKEN` fixes the token (the e2e suite uses
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
  server's major; `TASKMOOR_PG_BIN` points at another directory. The round-trip test
  (`backup.roundtrip.test.ts`) skips when no matching client is on this machine; PostgreSQL
  16.14 client tools are at `G:/tools/pgsql/bin`, so run it with
  `TASKMOOR_PG_BIN=G:/tools/pgsql/bin` after schema or backup changes. The CI image job runs the
  real drill.
- Python's `Path.write_text` on Windows writes CRLF: Biome's format check then fails and git
  shows whole-file diffs. Open files with `newline='\n'` or run `sed -i 's/\r$//'` afterwards.
- Commit 5ffe3ad carries the message of the commit before it; it holds the upgrade harness and
  the operator CLI (M0-029). Noted in the body of the commit that followed.
- `pnpm gate` only counts a full `pnpm verify`: a run narrowed with `--only`, `--changed` or a
  filter writes `partial: true` into `.verify/summary.json` and the gate reports it.
- Spike p95 is nearest-rank: with 10 runs it is the slowest sample. Use 40 or more runs for
  sub-millisecond queries on shared runners.
- `install.sh` resolves the port as Compose does: `TASKMOOR_PORT` in the environment first,
  then `.env`, then 8080. The install-matrix scripts set it in the environment.
- Sign-in limits count per client address. In-process tests pass `remoteAddress` to
  `app.inject` so one test's failures never lock another; behind a proxy the server needs
  `TASKMOOR_TRUSTED_PROXIES`, or every visitor shares the proxy's address.
- Argon2id costs tens of milliseconds per hash: a test that needs many users where the
  password does not matter should reuse one precomputed hash.
- Record task state in `docs/plan/progress.csv` (in-progress, done, waiting-on-user) as you go;
  `pnpm next-task`, `pnpm status-report`, `pnpm gate` and a test read it.

- Parallel sessions: three gates running at once on this machine made the server suite take
  over 800 s and time out in dozens of tests; two at a time is the practical limit. Each
  session needs its own `TASKMOOR_PG_CACHE_DIR` and its own migration number, and e2e runs need
  ports 4173 and 8787 free. Stop a session's embedded Postgres (`pg_ctl stop -m fast -D
  <dir>`) before deleting its worktree, or the folder stays locked.
- Merging parallel branches: union the migration index, upgrade seeds and event catalogue in
  migration order; rebuild `events/contract.test.ts` from `main` plus each branch's added
  scenarios; regenerate the schema golden; give every new event type an audit decision
  (`audit/subscriber.ts`) and every new route a token scope class (`tokens/scopes.ts`).
- Kysely applies migrations only in name order: a database that has run a later migration
  (0013 from `main`) refuses an earlier one merged after it (0011, 0012) as "corrupted
  migrations". Test and e2e databases are created fresh, so only long-lived development
  databases are affected: recreate them. Released databases never meet this, because numbers
  are reserved before a release.
- `apps/server/src/shutdown.test.ts` models two pods behind a Service; without the drain it
  fails with resets, so keep the drain (`TASKMOOR_SHUTDOWN_DRAIN_MS`) when touching shutdown.

### Waiting on the user

- **Release publishing** (decisions.csv): pushing images to ghcr.io and the release signing key
  for the air-gap bundle (M1-100). The user first wanted a local demo; it runs (see Local demo).
- **Repository rename** on GitHub to match the new name; outward-facing, so it waits for the
  user's go-ahead.
- **Counsel review**: deferred by the user to the first public release; it covers the
  clean-room protocol, ADR-002, ADR-003, the terminology and the name screening.
