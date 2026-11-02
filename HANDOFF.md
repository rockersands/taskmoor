# Handoff

Read this first in every session, then update it before you stop.

## Side session 2026-11-02 (cloud, branch `claude/ui-overhaul`): interface overhaul and tutorial

The user asked for the whole web interface to be reworked (clear sections, every panel saying
what it is for, glass surfaces, drag and drop, light and dark) and a sectioned guided tutorial
(offered at first sign-in, skippable, all sections again under Settings, Tutorials).
- **State: waiting for the user's go-ahead on the direction** (ADR-112, Proposed). Nothing is
  pushed yet: the branch is local until the direction is agreed and `pnpm verify --e2e` passes.
- **Prototype on the branch:** glass tokens and fallbacks (`tokens.css`), the shell in glass with
  grouped navigation (`NAV_GROUPS` in `shell/NavList.tsx`), `shell/PageHeader.tsx`,
  `shell/HelpTip.tsx`, `shell/EmptyState.tsx`, `shell/ThemeToggle.tsx`, `styles/surfaces.css`;
  Home, the board and the ticket header reworked; `tutorial/` (sections, picker, the
  Settings, Tutorials page at `#/settings/tutorials`, no storage yet).
- **Claimed numbers:** ADR-112, migration 0084 (`tutorial_progress`), tasks M1-135 and M1-136.
  If the main session takes them first, renumber here when merging.
- **Not done yet:** component tests and stories for the new pieces (old HomePage and NavList
  tests still expect the previous markup), the rollout to every other page, the tutorial's
  coach card, first-run offer, server storage and route, drag for dashboard widgets and board
  columns, the manual pages.
- **Running the demo here (root container):** `service postgresql start`, a password for the
  `postgres` user, `TASKMOOR_TEST_DATABASE_URL` pointed at it, then `pnpm demo`. The demo
  caches the built frontend: rebuild (`pnpm --filter @taskmoor/web build`) and restart it to see
  changes.

## Start here: 2026-11-02 (cloud session): M1-079 merged, M1-117 done, the ASVS gaps next

- **M1-079 (AI v1 features) is on `main`** (ADR-108). It stays in-progress only for the measured
  thresholds, which need an AI key (`pnpm eval all --candidate apps/server/src/ai/evals/candidates/live.ts`).
- **M1-117 is done at 1M** (`docs/spikes/search-1m.md`, `docs/spikes/estimates-10m-30m.md`).
  The bench database `m1037_bench_1m` (system Postgres) keeps only the generated dataset
  (`gen`, 1 GB); its product schema (9.5 GB) was dropped after the run to free disk.
  `pnpm bench:search --database-url <url> --label 1m` migrates and reloads it (about 10
  minutes) and reuses it on later runs; `ensureTrackKeys` adds the track keys the old loader
  left out.
  bench:search now also times opening a ticket; bench:check holds it to 100 ms.
  - A finished, real import runs `ANALYZE` on the tables it fills (`analyzeImported` in
    `import/run.ts`): without it similar tickets took a second after a bulk load. Partitioned
    `ticket_change` keeps its statistics on the partitions.
  - The board draws a cell's first 50 cards (`FIRST_CELL`) and the rest in a transition.
    The 5,000-card story watches the page from the data's arrival (`watchBoard`): the play
    function of a story starts only once the page is drawn, so it cannot time
    interactivity itself.
  - Under load, the enforced speed limits of the 1,500-field edit (50 ms) and the 2,000-row
    timeline (1.5 s) fail by a few percent; alone they pass.
- **ASVS group A, security events (ADR-109, migration 0081, branch `work/asvs-events`):**
  2.2.3, 2.5.5, 7.1.3, 7.2.1, 7.2.2, 11.1.7 and 11.1.8 are Met.
  - Security emails are their own table and mailer (`security/notices.ts`, `security/mail.ts`,
    every 15 s on the worker), not notifications: no preference, digest, quiet hours or
    unsubscribe applies.
  - `domain_event.user_agent` is new, filled from the request scope like `ip`. An event with an
    explicit `ip` (also `null`) in its context takes no User-Agent from the request.
  - Every 403 to a person or token costs one upsert in `security_counter` (`onSend` hook in
    `security/refusals.ts`). A test that makes many refusals by one person now writes
    `access.refused_repeatedly` records, and at 50 in 15 minutes a `security.alert_raised`
    event. The same goes for five exports by one person in an hour, or for failed sign-ins:
    check there first if a test that counts events or audit records breaks after a merge.
  - The inbox reads notifications with outer joins: alert items have no ticket (`ticket: null`,
    `alert`) and show only to site administrators. `inbox.large.test.ts` holds its budget
    (first page 17 ms p95 at 50,000 items).
  - Notices other than an email change go to the address the account has when the subscriber
    runs, not when the change happened.
  - IAM-018 (anomaly detection, M3) is cited by the alert tests: exports are counted, not
    weighed by ticket volume; new countries and impossible travel stay for M3.
- **ASVS group B (outbound requests and inputs), branch `work/asvs-inputs`** (ADR-110,
  migration 0082): 5.2.6, 12.6.1, 12.1.2, 12.1.3 are Met.
  - Every request to a typed address goes through `outbound/guard.ts` (`guard.fetch`): webhooks,
    AI adapters (`adapterOptions.fetch` in `app.ts`), OpenID Connect (`customFetch`) and the
    Cloud import transport. Loopback is refused too, so a test with a fake provider, IdP or
    receiver on 127.0.0.1 passes `outbound: loopbackOutbound()` (`testing/outbound.ts`) to
    `buildApp` or `registerWebhookJobs`; the e2e server sets `TASKMOOR_OUTBOUND_ALLOW`. A new
    outbound call must use the guard, never the global `fetch`.
  - Archive ceilings (`import/archive.ts`) run before DC staging, the import route's backup
    check and the export ZIP unpack; a failed export unpack now removes its `.part` folder.
  - Storage quotas are columns of `attachment_setting`, off by default; CORE-021's wording
    changed to "no storage quota by default". The form is a section of the guardrails page.
- **Merged to `main` (2026-11-02):** the three ASVS groups (ADR-109 to ADR-111, migrations 0081
  to 0083); gate 5,601 tests and 165 e2e; `tools/image/smoke-kits.sh` green with the four new
  database checks (it now takes `BUILD_CA` and passes `HTTPS_PROXY` for the all-in-one build).
  The ASVS checklist has one gap left, 1.14.2, closed by signing the 1.0 release.
- **Image scans done:** Trivy on the full image (PostgreSQL client layer included) and on the
  all-in-one image: no finding (`docs/security/scan-results.json`). Trivy runs as
  `mirror.gcr.io/aquasec/trivy:0.76.1` with `--network host` and the proxy's CA mounted.
- **Fuzzing in stages** (the user's decision of 2026-11-02): 1, 2, 4 and 8 hours, all 13
  targets in parallel at `nice 19`, a stage only after the one before was clean for every target;
  8 hours clean is the M1 bar (`FUZZ_GATE_SECONDS`). The runner is the session scratchpad's
  `fuzz/staged.sh`: it leaves `stage-<h>h/done` or `failed`, copies each `.verify/fuzz-<t>.json`
  there, and on a restart resumes at the interrupted stage (run it again; it skips finished
  stages). When stage 8 h is done, copy its reports into `docs/security/fuzz-results.json`.
  Runs under an hour found two real bugs, fixed on main (6b0522c).
- **Next:** M1-120 (release) once the fuzzers are clean and the user has answered: is 1.0 an LTS
  release, does the repository go public, the storage quota default (off, CORE-021 reworded),
  the ghcr.io token and network access, the AI key; M1-091's 1M-issue run last, on a machine
  with about 30 GB free and more cores.
- **ASVS group C (8.3.2, 1.9.1; ADR-111, migration 0083), branch `work/asvs-privacy`:**
  - Personal data: `apps/server/src/privacy/` (`export.ts` job `privacy.export` writes the ZIP
    into the attachment store; `erase.ts` erasure plus job `privacy.scrub` for history displays
    and mention labels, found by id only), routes in `routes/personal-data.ts` (self routes are
    session-only), web `account/PersonalDataSection.tsx` and `people/EraseUserForm.tsx`. Both
    jobs are registered in `main.ts`; `expirePersonalExports` runs with the housekeeping.
  - The audit log is not rewritten: `audit/query.ts` masks an erased subject's personal keys
    and an erased actor's address on every read (`masked: true`); `verifyChain` still passes
    (tested). Erasure refuses directory- or SCIM-managed accounts until they are removed there.
  - Database TLS: one definition in `packages/builder-core/src/postgres-tls.ts` for both Compose
    kits; `packages/devtools/src/compose-tls.test.ts` holds `deploy/compose/docker-compose.yml`
    to it and runs the certificate script with the local `openssl`. `upgrade.sh` brings an old
    install onto TLS (checked by hand here with the existing `taskmoor:dev` image: old kit up,
    new kit file, `upgrade.sh`: 10 of 10 backend connections TLS 1.3, plain TCP refused,
    `cli.mjs backup` over TLS fine, the CA unchanged after a restart). The all-in-one image now
    uses the Unix socket (`listen_addresses=''`): not run here, the image smoke test checks it.
  - For the merge: `tools/image/smoke-kits.sh` must print "all-in-one database: Unix socket
    only", "compose database: TLS only", "plain TCP refused, verify-full accepted" and "the same
    certificate authority after the upgrade". Counts in `docs/security/asvs-l2.md` assume only
    this group; groups A and B change the same line.

## Start here: 2026-10-31 (cloud session): the user's decisions, search changes, batch 3

**Batch 3 is on `main`** (one gate, `pnpm verify --e2e`: 5,215 tests, 157 e2e): M1-093 boards and
sprints, M1-094 saved filters, M1-128 imported links, M1-075 AI key storage, M1-076 the AI
settings page, M1-077 AI spend and audit, M1-131 agent budgets, and the M1-040 changes below.
Their entries are in the 2026-10-30 evening section. What the merge joined:
- **One `AiService`** (`apps/server/src/ai/service.ts`): stored keys and settings (M1-075/076),
  and on every workspace gateway the meter, redaction and AI audit of M1-077 (the settings page's
  test connection is not metered). `deps.ai.source` supplies a provider in tests and wins over
  the stored settings. `app.ai` is `{ service, context, agents }`. Agent runs go through
  `AiService.call` (so workspace, track, strict and feature switches apply) and keep one gateway
  for the run; the data statement reads `AiService.summary`. The usage page's message ids that
  clashed with the settings page's are `ai.statement.*`.
- **The DC importer** has both parts: agile (M1-093) and filters (M1-094) hook the stage,
  generator and validator, agile first (it lets `SearchRequest` rows pass). `STAGE_VERSION` is 6.
  Board filters (12000 and up) are saved searches too, so `dc-filters.test.ts` counts the added
  boards. Sprints and rank now resolve in translated filters.

The user answered the open questions on 2026-10-31 (rows in `docs/plan/decisions.csv`):

- **M1-040 search** (done on this branch): `ORDER BY relevance` ranks only the 10,000 most
  recently updated matches (`RANKED_CAP` in `apps/server/src/search/compile.ts`; the page reads
  from a capped subquery, and `rankedWarning` in `routes/search.ts` warns when there are more).
  Patterns are dropped: a `*` anywhere but the end of a word is refused ("A * can only end a
  word"). Spec 01b 1.8, ADR-069 (Changes), ADR-010, ADR-011 and the manual's search page are
  updated. The trigram indexes of migration 0057 are no longer used: a later migration (0076 or
  after) may drop them.
- **DC import system administrators** (M1-090): both, as an import setting, site administrator
  by default and configuration administrator as the option. Built: the DC source's
  `systemAdmins` (`site_admin` | `configuration_admin`; `dc.ts`, `dc-schemes.ts`
  `mapGlobalGrant`, `regrant` in `load-access.ts`, the route passes it on), ADR-090 Changes, the
  manual's import page; tested by the last case of `dc-access.test.ts`. The import wizard
  (M1-097) should offer it.
- **Bundled embedding model (M1-078, started):** `packages/ai/models/all-MiniLM-L6-v2/`
  (int8 ONNX, 23 MB, Apache 2.0) from huggingface.co, commit `1110a24`, every file verified
  against the source's hashes; provenance in its `SOURCE.md`, `SHA256SUMS` checked by
  `packages/ai/src/models.test.ts`. Nothing downloads a model at build or run time: the user
  may remove the Hugging Face hosts from the environment's network access again. Still to
  build for M1-078: the runtime (onnxruntime-node or -web, tokenizer), pgvector, the index and
  permission-filtered retrieval.
- **M1-117 measures at 1M tickets** (the user, 2026-11-01): done when every budget is green at
  1M (`pnpm bench:check --size 1m`); 10M and 30M are documented estimates, not runs.
- **AI provider key:** not yet. M1-073 and M1-074's live tests stay skipped.
- **Spanish review:** the user does it once every M1 task is finished.
- **Images on ghcr.io** (the user, 2026-11-01): public, `ghcr.io/rockersands/taskmoor`, published
  only at the 1.0 release (M1-120). Until then build locally. To publish: `ghcr.io` in the
  environment's network access and a token with package write rights as an environment secret
  (never in the repository or the chat).
- **M1-119 is dropped** (the user, 2026-11-01): no design partner; the first users are a new
  company of the user's own. The repository rename to `taskmoor` is the user's to do on
  github.com; afterwards update the remote, `CLAUDE.md` and the docs that name
  `Rockersands/tracksmith`.
- **Release signing key** (M1-100, done): made in the cloud session on 2026-10-31 at the user's
  request (they chose this over making it on the Mac). The private key (ECDSA P-256) is in the
  user's Google Drive, folder "Taskmoor release signing key" inside "JIRA knockoff", with a
  README; it was never in the repository and was deleted from the container after the upload.
  The public key is `tools/airgap/taskmoor-release.pub` (SHA-256 of its DER form starts
  `bbca863a`). To sign a bundle: download the key to a private folder outside the clone, run
  `SIGNING_KEY=<file> PUBLIC_KEY=tools/airgap/taskmoor-release.pub bash tools/airgap/bundle.sh
  <version>`, delete the file. `.gitignore` refuses `*.pem` and `*.key`.
- **M1-113 is done** (ADR-105): `bash tools/image/fresh-vm.sh` (needs the image from
  `tools/image/smoke.sh`; behind this sandbox's proxy run the image build with
  `--network host --secret id=build_ca,src=/root/.ccr/ca-bundle.crt --build-arg HTTPS_PROXY=...`
  and set `BUILD_CA` for the harness). It found and fixed: live updates were never shown on open
  tickets and boards (NTF-008), the create dialog lost its ticket types when the same track was
  chosen again, and the signed-out start page said "under construction". Docker Hub and
  dl-cdn.alpinelinux.org must stay in the network access. The harness loads the images the kit's Compose
  file names (now `pgvector/pgvector:0.8.1-pg16-trixie`). When Docker Hub answers 429 (rate
  limit), pull it from `mirror.gcr.io/pgvector/pgvector:0.8.1-pg16-trixie` and tag it.
- **Security defaults (the user, 2026-11-01):** how long a sign-in lasts is a workspace setting
  (`session-policy.ts`, migration 0080, Settings > Security > Sign-in sessions; default 14 days
  and 3 days idle; a shorter value ends older sessions at once). First-run setup sets the
  two-factor policy to site administrators, so a fresh install's administrator enrols at the
  next sign-in. `e2e/setup.spec.ts` checks that and turns it off for its later journeys; the
  fresh-install run enrols through the frontend. Right after a page reload the session check can
  answer "signed out" for a moment before the signed-in state arrives (seen in the keyboard
  journey); not traced yet, harmless so far.
- **The 1M-issue import run (M1-091) goes last**, after every other M1 task (the user, 2026-10-31).

## Start here: 2026-10-30 evening (cloud session): M1-129, M1-072 OAuth, M1-068 to M1-071, M1-108, M1-112, M1-089 to M1-092, M1-095 and three fixes

All on `main`, each push after a green `pnpm verify --e2e`:

- **Fixes** (commits `314f4de`, `7e60c86` and `7e34932`):
  - **Backend-kit test:** the "Docker missing" case no longer finds a real `/usr/bin/docker`
    (`packages/devtools/src/backend-kit.test.ts`).
  - **Upgrade rollback:** it now drops foreign keys a newer migration added before
    `pg_restore --clean`. The restore failed on `user_session_parent_id_fkey` (0064). This
    test only runs where `pg_dump` is installed, so this Mac skips it: install the PostgreSQL
    client tools to run it.
  - **E2E servers:** they listen on IPv4 when the machine has no IPv6 loopback
    (`apps/web/e2e/loopback.ts`).
- **M1-129 entity properties** (migration 0066, ADR-083):
  - Code: `apps/server/src/properties/model.ts` and `apps/server/src/routes/properties.ts`;
    board and sprint routes are registered in `routes/boards.ts`.
  - Query syntax `ticket.property[key].path` lives in `packages/query`: parser, printer,
    dialect, fields and resolver. The binder branch is in `apps/server/src/search/bind.ts`.
  - Tests are in `routes/properties.test.ts` and `packages/query/src/properties.test.ts`, plus
    the event and API contract scenarios.
  - `syncFieldValues` now also rewrites property index rows on every full rewrite. Code that
    creates, moves, trashes or restores tickets keeps them in step without doing anything else.
  - Fastify's `maxParamLength` is now 3,072 (for 255-character keys).
- **Left for later:**
  - The Jira-compatible property routes come with M1-069, over the same tables.
  - The query editor's autocomplete does not suggest property fields.
  - Properties and property indexes are not in the full export (M1-098). Web links, boards and
    sprints are not in it either. Backups (`pg_dump`) include them.
  - `cli.mjs restore` into a database that a newer migration already changed may hit the same
    foreign-key problem as the rollback did: `dropNewObjects` runs only in the upgrade
    rollback.
- **M1-072 OAuth for MCP clients** (2026-10-31; migration 0067, ADR-084): M1-072 is done.
  - Server: `apps/server/src/oauth/clients.ts` (registration, redirect matching, pending
    requests). In `routes/oauth.ts`: discovery, `register`, authorize for registered clients,
    `requests/:id` for consent, and `admin/oauth-clients`.
  - Token binding is in `app.ts`. A scoped family's token is accepted only at `/api/v1/mcp`,
    plus the tools' in-process calls, which carry `INNER_CALL_HEADER` with a per-process
    secret. If you add an in-process caller for MCP, send that header.
  - Web: `apps/web/src/oauth/ConsentPage.tsx` at `#/oauth/consent`. The MCP settings page has
    a registration switch, and the sessions list names an app's grant.
  - Tests use the official MCP client's OAuth flow (`routes/mcp-oauth.test.ts`) and a
    Playwright spec (`e2e/mcp-oauth.spec.ts`).
  - Also fixed: personal tokens now reach `/api/v1/users/:id/properties` with read and write.
    Before this, `/api/v1/users` as an admin prefix demanded the admin scope.
  - Not yet: client ID metadata documents (an SSRF-safe fetch is needed first); browser-based
    MCP clients on other origins (the origin policy refuses them).
- **M1-068 Jira-compatible API contract** (2026-10-31; ADR-085, which amends ADR-016; no
  migration).
  - New package `packages/api-jira-compat`:
    - `operations.ts`: 72 operations in our own words, with sources and `verify` notes;
    - `cases.ts`: synthetic cases;
    - `runner.ts`: per-operation states;
    - `openapi.ts`: generates `docs/api/jira-compat/openapi.json`.
  - `apps/server/src/compat/conformance.test.ts` writes `docs/api/jira-compat/matrix.md`. It
    reads 31 missing and 41 untested today.
  - **For M1-069:**
    - Build the shim inside `packages/api-jira-compat`, on the core's public services (ADR-016),
      and register its routes in the server.
    - Watch the matrix turn complete. A shim route counts as done when its cases pass.
    - Add cases when a route needs more.
    - The suite's issue type on our server is `Chore`: the defaults have no `Task`.
  - `pnpm conformance compat --url=... --project=...` runs it against a running install (token
    in `TASKMOOR_TOKEN`). It refuses Atlassian hosts.
  - The container's Postgres had stopped after a restart: `pg_ctlcluster 16 main start` (the
    first start replays about 15 GB of test databases).
- **M1-069 Jira-compatible API core** (2026-10-31; ADR-086; no migration).
  - `packages/api-jira-compat/src/shim` (`COMPAT_ROUTES`) is registered by
    `apps/server/src/compat/register.ts` under `/rest/api/2` and `/3`. Native calls run in
    process with the caller's token. The sign-in is Bearer or Basic (email plus API token);
    cookies and passwords are refused.
  - The matrix reads 57 of 72 complete.
  - **M1-070 (Agile, done)**: `shim/agile.ts` on the native board and sprint API, plus a new
    native `GET /api/v1/sprints/:id`. "Back to the backlog" searches the open sprints of the
    boards the caller sees. The matrix now reads 71 of 72.
  - **M1-071 (wiki markup, done; ADR-091, no migration)**: v2 now carries wiki markup.
    - `packages/richtext/src/wiki.ts` has `toWiki`, `fromWiki` and `toPlainText`. The reader
      and writer share one set of rules: marker flanking, braced `{*}` inside words, and
      escapes only where text could read as markup. Change one side only with the other.
    - The corpus is `wiki-corpus.ts`: 252 documents and 40 sources, with goldens in
      `__golden__/wiki`. Each document also checks that v2 and v3 agree. The fast-check
      properties in `wiki.test.ts` found every escaping bug so far. After any change to the
      rules, run them with `FC_RUNS=20000` and `--testTimeout=600000` (from
      `packages/richtext`: `npx vitest run src/wiki.test.ts -t properties`).
    - On the native API, `?format=wiki` reads and writes and `?format=text` only reads (a write
      with rich text in it gets `invalid`). The OpenAPI and SDK goldens are updated.
    - Not done: mentions written through v2 have no display name (the markup names people by
      id), so the editor shows the id; HTML as a format.
  - Not done: bulk label ADD and REMOVE, which need a native bulk add or remove, and
    attachments.
  - `TASKMOOR_JIRA_COMPAT=off` turns it off.
  - On a loaded machine, `search/plans.test.ts` once chose an equivalent index. It passes alone:
    rerun it before treating it as real.
- **Next free numbers:** migration **0076** and ADR-102 (batch 3 merged on 2026-10-31: 0073 to
  0075, ADR-095 to ADR-101). **Never use 0069, 0070 or 0072**: they were held and left unused, and
  Kysely refuses a migration that sorts before one a database already ran.
- **M1-112 Builder page** (2026-10-31; ADR-088, no migration): M1-112 is done.
  - The page is a second entry of the web app (`apps/web/src/builder`,
    `vite.builder.config.ts`). It is built into one file, `apps/web/dist-builder/index.html`,
    by `pnpm build` or `pnpm --filter @taskmoor/web build:builder`. The web build must exist
    first: the page carries it in a JSON data block. Its policy allows no request.
  - The page and the CLI share `builder-core/src/run.ts` (`kitOutputs`,
    `kitOutputsFromProject`, `runSecrets`). The CLI's `--version` now defaults to the web
    build's `version.json`.
  - Tests: `apps/web/build/builder-page.test.ts` (one file, policy, page bytes against
    `runBuilder`), `src/builder/*.test.ts(x)`, stories, and `e2e/builder-page.spec.ts`. The
    spec serves the page on 4184 (a new webServer entry), refuses every other request and
    compares the downloads' SHA-256 with `pnpm builder` run as a process.
  - Not yet: branding (the kits ignore the accent colour, so the page has no field for it;
    OPS-016 (3) waits), publishing the page with a release, and a language picker on the page
    (`?locale=es` works).
- **M1-108 origin registration** (2026-10-31; migration 0068, ADR-087; branch
  `work/m1-108-origins`): done.
  - `OriginPolicy` (`apps/server/src/origins.ts`) now reads `TASKMOOR_ALLOWED_ORIGINS` plus the
    `frontend_origin` table through `await policy.current()`, cached five seconds per process
    and refreshed at once by `policy.changed()` after an admin change. Every origin decision
    goes through it: the CORS hook, both socket handshakes (which also need the row's
    `websocket` grant), the OAuth authorize redirect URIs, and the OpenID Connect and SAML
    return addresses. Code that needs a decision without waiting (the sync socket handler,
    right after the hook) reads `policy.latest`.
  - Admin API: `routes/frontends.ts` (`/api/v1/admin/frontends`, list, add, `PATCH`, remove;
    events `frontend_origin.*`, audited). Validation is in `network/frontends.ts`
    (`frontendOrigin`), which `config.ts` now uses too: a wildcard in the environment stops
    the server at start.
  - Versions: a frontend with an `apiUrl` (a kit on another origin) sends
    `GET /api/meta?frontend=<version>`; the backend writes it for registered origins only.
  - Web: `apps/web/src/admin/FrontendsPage.tsx` at `#/admin/frontends` (story, tests). The
    page adds and removes; label, redirect URIs and the socket grant change only through
    `PATCH`.
  - E2E: `e2e/frontends.spec.ts`. kit-server.ts serves a third kit at
    `kit2.taskmoor.localhost:4183` that the 8794 backend does not list; the spec registers it
    and removes it again (desktop project only, since the list is shared).
  - Not done: versions of environment-only origins (register them too), closing open sockets
    and ending OAuth families when a frontend is removed.
- **M1-089 Data Center custom fields and forms** (branch `work/m1-089-dc-fields`, side session
  2026-10-31; ADR-089, no migration; M1-089 is done):
  - The generator now writes custom fields, contexts, options, defaults, field configurations,
    screens and scheme associations (`dc-backup/fields.ts`; format notes 02d, all **Verify** or
    **Our choice**). The golden manifest and M1-088's golden report changed with it.
  - **Tickets arrive now**, with their own fields, custom values, labels and parent
    (`dc-backup/stage-issues.ts`, `mapTicket` in `import/dc.ts`). M1-091 adds history,
    comments, time, links, attachments, followers and votes to the same `ticket` kind. The
    stage keeps each issue's custom values and labels in memory until the end of the file;
    check that at a million issues. Descriptions and paragraph values are plain text paragraphs
    until wiki markup is converted.
  - New framework kinds `field_rule_set` and `layout_set` (`import/load-forms.ts`). Rules and
    layouts are checked and written by `fields/sets.ts`, which `routes/layouts.ts` uses too.
  - `"scope": "configuration"` on a `dc-backup` source leaves the issues out. M1-088's test
    (`dc.test.ts`) uses it. M1-089's golden is `dc-fields.test.ts`: 4,000 issues, seed 89,
    18,464 of 18,464 values match.
  - Open: issue type schemes are not mapped, so tickets warn `type_not_offered`. Identical
    schemes are not merged (IMP-005).
- **M1-091 Data Center issue content** (branch `work/m1-091-dc-tickets`, side session
  2026-10-31; ADR-092, no migration; **in progress**: only the million-issue run is left):
  - Stage: `dc-backup/stage-issues.ts` and `spill.ts`. Nothing per issue stays in memory: ticket
    rows spill to buckets by issue id range, history to buckets by change group id range, the
    rest to one file each; each bucket is joined alone after the file. Attachment files are
    indexed by attachment id while staging (hash, sniffed type, ZIP offset); `DcBackupSource
    .openFile` reads one entry from its offset. Keep the ZIP until the import is done.
  - Mapping: `import/dc-content.ts` (comments, history, time entries, links, web links,
    attachments), tickets in `dc.ts` (followers, voters, `formerKeys`, wiki descriptions).
    History items are stored items with backup ids; the history loader maps them and corrects
    starting values as before. New kind `web_link` (`load-weblinks.ts`). New scope
    `"tickets"`: M1-089's and M1-092's tests use it, so they skip content.
  - Loaders changed for speed, not behaviour (check them if history looks odd):
    `writeChangeSets` (one statement), starting values written at a ticket batch's end,
    the history loader's per-batch picture of each ticket's rows (`historyStates`), deferred
    content history entries (`deferChanges`, flushed in each loader's `finish`), pooled change
    set and rank numbers (`nextFrom`), `DEFAULT_BATCH` 250.
  - Fidelity checker: `import/dc-fidelity.ts`, against the generator's world via external
    ids. Golden: `dc-content.test.ts` (3,000 issues, 100%, about 100 s). Large:
    `TASKMOOR_LARGE_DC_IMPORT=1 pnpm verify --only=tests -- apps/server/src/import/dc-import.large.test.ts`
    (`_ISSUES`, `_DIR`, `_REPORT`, `_EVERY`). 100,000 issues: 1,630 s, 100% of 859,788.
  - **Left:** the 1,000,000-issue run on a machine with 40 GB free (it needs about 24 GB of
    database); here it extrapolates to 4.5 h, above the 4 h bar. The import is serial (load
    average about 1 on four CPUs); parallel content kinds or set-based loading are the next
    levers. Also not done: mentions (`[~key]` keeps the key), paragraph values as wiki, a
    source time zone, attachments outside the ZIP.
  - `pnpm verify --update` ignores the file filter after `--` and runs the whole suite; to
    rewrite one file's golden, delete it and run the file normally.
- **M1-092 Data Center access, visibility and notifications** (same branch, second commit;
  ADR-090, no migration; M1-092 is done):
  - Generator `dc-backup/schemes.ts` (permission, issue security and notification schemes, global
    permissions, each issue's level); mapper `import/dc-schemes.ts`; loaders
    `import/load-access.ts`; five new kinds; tickets carry `visibilityLevel`.
  - Identical permission schemes merge (IMP-005 (1)). Notification rules are written by
    `notifications/rules.ts`, which `routes/notifications.ts` now uses.
  - `SYSTEM_ADMIN` becomes `site_admin`, so those people browse every track (warned). The parity
    golden `import/__golden__/dc-access-seed92.parity.json` expects that for them, and the
    source's model for everyone else.
- **M1-090 Data Center workflows and workflow maps** (branch `work/m1-090-dc-workflows`, side
  session 2026-10-31; ADR-093, no migration; M1-090 is done):
  - Format layer: `dc-backup/workflow-format.ts` holds the new elements (`Workflow`,
    `WorkflowScheme`, `WorkflowSchemeEntity`, `EventType`, spread into `ENTITIES`), the
    descriptor model, its writer and reader, and `workflowCases`. The generator's workflows are
    `dc-backup/workflows.ts`; `generate.ts` only calls `writeWorkflowEntity`, which also adds
    a transition screen (ids from 10500) and `WorkflowScheme` associations. Issues are
    unchanged: every workflow in use holds all six statuses, so other fixtures' data is the same.
  - Stage `dc-backup/stage-workflows.ts` (`STAGE_VERSION` is 4: older stages are redone),
    validator `dc-backup/validate-workflows.ts` (hooked at the top of `record` and in
    `crossCheck`), mapper `import/dc-workflows.ts`. The loaders are the existing `workflows`
    and `workflowMaps` of `load-config.ts`, unchanged.
  - Unmapped rules: a condition becomes `always-false` (the transition stays closed), a
    validator is dropped, a function a `placeholder`; each is a warning on the workflow's record
    naming workflow, transition, id, class and reason. Conditions on custom fields cannot map
    (workflow guards read system fields only), nor updates that set an id (`remap.ts` does not
    remap effect values, which is also a gap in Taskmoor's own export round trip).
  - Small hooks in shared files: `StatusCommand.inWorkflow` (no `status_not_in_workflow` for
    statuses a workflow holds), `StagedNotificationScheme` notifications carry `eventName`,
    and `dc-schemes.ts` exports `PERMISSIONS` and `customEventName` (custom events now import as
    `custom:<name>`). `FieldCollector.screen(id)` is public. M1-091 also edits `generate.ts`,
    `stage.ts` and the goldens: expect conflicts in `STAGE_VERSION` and the regenerated
    goldens (rerun with `--update` after merging, and review).
  - Tests: `import/dc-workflows.test.ts` (goldens `dc-workflows-seed90.workflows.json` and
    `.report.json`, the oracle of unmapped rules, the transition and refusal end to end) and
    `dc-backup/workflows.test.ts` (descriptor round trip, damaged backups). A site
    administrator does not see tickets with a visibility level they are not in: the test picks
    tickets without one.
  - Not done: ticket counts per unmapped rule (IMP-005 (2)), webhook functions, drafts, triggers,
    each issue's workflow state (counted `not_needed`).
- **M1-095 Cloud REST import** (branch `work/m1-095-cloud-import`, side agent 2026-10-31;
  migration 0071, ADR-094; M1-095 is done):
  - Code in `apps/server/src/import/cloud/`: `client.ts` (throttling, backoff, concurrency),
    `fetch.ts` (the resumable fetch into `import_staged`, state in `import_run.fetch_state`),
    `source.ts` (settings, source, mapper), `people.ts`, `replay.ts`. Boards and sprints are new
    framework kinds (`import/load-agile.ts`). `ImportSource.prepare(until)` runs before the first
    batch; `format.open` now gets `{ db, runId, workspaceId }`.
  - The token is sealed with the pepper ring: `registerImportJobs` needs `peppers` (main.ts
    passes them). Formats come from `importFormats({ peppers, transport })`.
  - **Fixtures**: `cloud/__fixtures__/compat-source.json`, recorded from Taskmoor's own
    compatible API over the synthetic source in `testing/compat-source.ts`. If the fetch's
    requests change, the replay misses: run `cloud.test.ts` with
    `TASKMOOR_RECORD_CLOUD_FIXTURES=1`, then `pnpm format` and `pnpm verify --update`, and
    review the fixture and goldens. Never record from anything but Taskmoor.
  - The synthetic format's example of an unsupported kind is now `filter` (was `board`, which
    the framework now loads).
  - Not done: issue links and attachments (the compatible issue has no `issuelinks`), watchers,
    votes, schemes, comment visibility, custom field history, real contexts and options, a
    1M-item rate run (IMP-002 (1)), clearing a finished run's sealed token; M1-096 builds delta
    runs on `fetch_state`, M1-097 the wizard and CLI.
- **M1-094 Data Center saved filters, dashboards and subscriptions** (branch
  `work/m1-094-dc-filters`, side agent 2026-10-31; migration 0073, ADR-096; M1-094 is done):
  - Translator `import/translate/jql.ts`: `analyseQuery` runs in the stage
    (`dc-backup/stage-filters.ts`, which knows the source's fields, people, projects and filters)
    and leaves references in a query template; `renderQuery` runs in the loader
    (`import/load-filters.ts`), which then prepares the text as the owner would run it. Change
    the translator and you must bump `STAGE_VERSION` (now 6; M1-093 took 5).
  - Corpus `translate/corpus.ts` (100 entries, written against a vocabulary); its golden
    `translate/__golden__/corpus.json` is the review point. The generator's filters
    (`dc-backup/filters.ts`) use the same corpus, so `dc-filters.test.ts` meets every entry.
  - New framework kinds `saved_search`, `subscription`, `dashboard`, last in `ENTITY_KINDS`.
    Boards' own filters (`SearchRequest` rows the boards name) become saved searches too.
    `FilterCollector` consumes `SearchRequest` (M1-093's boards keep a copy of their filter's
    query and still report the element `not_imported_yet`: on merging, drop that report, since
    the filters import now). M1-093's `unresolved()` and `withTargetFields()` in
    `load-agile.ts` check a board's query against the target; saved searches use
    `prepareSearch` as the owner instead. Sprint gadgets
    resolve boards through `{ kind: 'board' }` refs once boards are imported.
  - Untranslatable queries keep their text with `saved_search.import_problem` (API
    `importProblem`, a note on the search page; a new query clears it). Report warnings
    `query_not_translated`, `query_flagged`, `query_changed` carry `<code>: <name>`.
  - All DC report goldens, the fidelity report schema, OpenAPI, reference and SDK goldens
    changed. The synthetic format's unsupported example kind is now `automation` (`dashboard`
    is a framework kind).
  - Not done: user shares, edit rights, dashboard stars, a source time zone for schedules.
- **M1-128 keys and links from the earlier tracker** (same branch, second commit; ADR-097, no
  migration; M1-128 is done):
  - The link patterns are in `packages/webconfig/src/links.ts`, shared by `frontend.ts` (302s,
    only when the backend serves the frontend) and the app (`routing/ImportedLinkPage.tsx`, for
    static kits). Filters, boards and dashboards go to `#/imported/<kind>/<source id>`, resolved
    by `GET /api/v1/imported-links/:kind/:sourceId` (signed in, visibility checked, newest
    external id wins). Page paths carry no session, so the server never resolves ids itself.
  - `router.redirect(route)` is new: replace the entry and notify (Back skips the old link).
  - Renamed projects: `TrackCommand.formerKeys`; the generator option `renamedProjects` makes
    one (off by default). `original_key_not_kept` is gone (dc.test.ts now checks the key).
  - E2E: `e2e/imported-links.spec.ts`; web-server.ts seeds ABC-42, NEW-9 (was OLD-5) and two
    external ids on the 4176 and 4177 instances.
  - When M1-093 lands, check that its boards write external ids of kind `board` with the
    source's rapid view id: the board link and the sprint gadgets of M1-094 resolve through it.
- **M1-096 delta runs** (branch `work/m1-096-delta-wizard`, side agent 2026-10-31; migration
  0076, ADR-102; M1-096 is done):
  - `deltaFrom` on `POST /api/v1/admin/imports` (Cloud REST and Data Center runs only). Cloud:
    `fetch_state.startedAt` is the mark, the delta's settings carry `since`, the search adds
    `updated >= -<n>m` (15-minute overlap; tests set `deltaOverlapMs: 0` and backdate the source),
    then a `listing` step stages every issue id as `listed:ticket`. Full runs send the same
    requests as before (the replay fixture is unchanged).
  - Deletions: `ImportSource.coverage` per kind; the run's last phase (checkpoint
    `{ deleted: <index> }`) writes `deleted` records and the `deleted_in_source` warning, and
    removes nothing. Acting on them (trash) is the obvious next step if the user wants it.
  - `ImportFormat.sourceHistory` (DC, Cloud): a ticket update writes no history of its own except
    for fields edited in Taskmoor since the import last wrote it (`edited_in_target`). The
    external id's `updated_at` now moves only on writes: that is how target edits are found.
  - An attachment's checksum no longer covers its locator: the first re-run after this reports
    attachments `updated` once, writing nothing.
  - Tests: `import/cloud/delta.test.ts`, `import/dc-delta.test.ts` (edits a generated backup's
    `entities.xml` in place: a pattern for other later-backup tests).
- **M1-097 import wizard and CLI** (same branch, second commit; ADR-103, no migration; M1-097
  is done):
  - Web: `apps/web/src/admin/imports/` at `#/admin/imports` (Settings > Imports). New routes:
    `GET`/`POST /api/v1/admin/imports/files` (the folder listing and a raw-body upload; event
    `import_file.uploaded`). People mode `map` for Cloud and Data Center (`cloud/people.ts`,
    `dc.ts` `people` setting by user key).
  - CLI: `node cli.mjs import ...` goes through the API (`import/cli.ts`, `TASKMOOR_URL`,
    `TASKMOOR_TOKEN`); it is handled before the CLI's own option parsing. CLAUDE.md's command
    table does not list it yet (left for the main session).
  - E2E: `e2e/import-wizard.spec.ts` uses a fourth instance in `web-server.ts` on 4185 (its own
    imports folder and import worker loop; it starts before 4177, which Playwright waits for).
    The 10,000-issue backup is generated once into `.cache/e2e/dc-backup-10000-seed97.zip`
    (about 10 s); the admin's password comes from `TASKMOOR_E2E_IMPORT_PASSWORD`
    (playwright.config.ts). Desktop runs the import (the spec took 3.0 minutes with the servers'
    start); mobile checks the layout.
- **M1-118 security hardening** (branch `work/m1-118-security`, side agent 2026-10-31; ADR-104,
  no migration; **in progress**: the 24-hour fuzz runs, the live-model injection run and the
  full image scan are left):
  - Documents in `docs/security/`: `threat-model.md`, `asvs-l2.md` (258 requirements, 16 gaps,
    none high), `scan-triage.md`, and the records `scan-results.json` and `fuzz-results.json`
    that `pnpm gate M1` reads (new: `m1SecurityChecks` in `packages/devtools/src/gate.ts`; M1-120
    adds the rest of the M1 gate). The gate waits while a row of `asvs-l2.md` says Gap.
  - Fuzzing: `pnpm fuzz <target>|all --minutes N`. Harness `@taskmoor/testkit/fuzz` (targets,
    mutation helpers, reproducible inputs) and `fuzz-run` (a worker with a heartbeat: a hang is
    stopped and reported with its input). Targets in `packages/devtools/src/fuzz/targets.ts` and
    `apps/server/src/fuzz/targets.ts`, listed by path in `packages/devtools/src/fuzz/registry.ts`
    (devtools may not import the server; `apps/server/src/fuzz/` is exempt from the test-helper
    rule). For the 24-hour bar run one lane per target, `pnpm fuzz <t> --minutes 1440 --seed <n>`,
    and copy the summaries into `fuzz-results.json`.
  - **For M1-079** (ADR-104 "What M1-079 adds"): mark write tools `effect: 'write'` and pass a
    `confirm` to `runAgent` (no confirm: no write runs); fence every ticket, comment and field
    with `fenceUntrusted` (`AiContext` does for tickets); screen every answer with
    `screenAnswer`; run `packages/ai/src/injection/corpus.ts` (exported from
    `@taskmoor/ai/testing`) against a live model.
  - Behaviour changes others may meet: every answer gets `nosniff` and `Referrer-Policy:
    same-origin`, HTTPS instances HSTS, API JSON `Cache-Control: no-store` and
    `Content-Disposition: attachment; filename="api.json"` unless the route set its own
    (`apps/server/src/security-headers.ts`); rich text with non-object attributes, non-list
    content, nesting deeper than 128 or a table span outside 1 to 1,000 is refused as `invalid`
    (`adfShapeProblem`, `docShapeProblem`; a `colspan` of `1e308` used to kill the server when
    the ticket was written as Markdown); workflow regex validators with nested repetition are refused as
    `invalid_pattern` and never run (`packages/workflow/src/pattern.ts`); the image has no npm,
    corepack or yarn. Dependencies bumped (Storybook 10.6.5, Vitest 4.1.12, Fastify 5.12.7,
    Nodemailer 10.1.4; overrides for follow-redirects, fast-uri, nodemailer).
  - Scanners used here, none committed: Semgrep (pip) with rules cloned from their repository,
    osv-scanner and gitleaks (`go install`), Trivy from its container image. The secret scan of
    the whole history found no real secret. `scan-triage.md` has the commands for the gate.
  - The user decides: the session lifetime (ASVS 3.3.2 asks 12 hours, or 30 minutes idle; today
    14 days, 3 idle) and whether a second factor is required for site administrators by default
    (4.3.1). Both are in `asvs-l2.md` as gaps.
  - Do not add `../richtext` to `packages/devtools/tsconfig.json` references: `apps/web`
    references devtools, and through it the web program would read richtext's `.d.ts`, which
    lacks the Tiptap command augmentations (`toggleBold` and the rest stop typechecking).
    devtools imports `@taskmoor/richtext` by source, as the web app does.
  - The first full verify of this branch failed because the disk filled up (PostgreSQL went into
    recovery); the second one had one failure, `apps/web/build/artefact.test.ts` "fails a build
    that would bundle a server package", which names `node:crypto` before `packages/db/src` under
    load and passes alone (twice). It is order-dependent, not caused by this branch.
- **M1-078 bundled embeddings and similar tickets** (branch `work/m1-078-embeddings`, from
  `claude/api-key-upload-prevention-9ucz4x` for the model commit; migration 0079, ADR-106;
  M1-078 is done):
  - Runtime: `packages/ai/src/embed` (our WordPiece tokenizer, `LocalEmbedder` on a worker
    thread with `onnxruntime-web`, `EndpointEmbedder`). `tools/build/server.mjs` now also writes
    `dist/embed-worker.mjs`, `dist/ort/` and `dist/models/`, and maps without `sourcesContent`
    (the image was 404 MB with them; now 365 MB). `.dockerignore` keeps the model's `*.md`.
  - Server: `apps/server/src/embeddings` (indexer, subscriber and sweep job, lookups, pgvector
    set-up) and `routes/similar.ts`. The embeddings subscriber is registered only when
    `registerSubscribers` gets `embeddings` (main.ts passes it): other tests never load the
    model. `buildApp` takes `embedder` (default: the shared local model) and `vectorSearch`.
  - pgvector's extension and HNSW indexes are made at start, not by a migration: the schema
    golden is the same with or without pgvector; the upgrade check sees them as allowed
    extras. Tests force the exact scan and run the pgvector path where the server has it (this
    sandbox's Postgres 16 has 0.6.0; the Mac's embedded Postgres has none, so that test skips).
  - The Compose kit and the Builder backend kit now use `pgvector/pgvector:0.8.1-pg16-trixie`.
    `CLAUDE.md`'s CLI list does not name `embeddings` yet (the manual's CLI page does).
  - The Dockerfile carries M1-113's build-secret change (same lines as `ad68952`), so the
    merge with that branch should be clean.
  - Next (M1-079): the duplicate-suggestion and similar-ticket UI on these two routes, and
    model re-ranking when a provider is set (AI-016).
- **M1-133 AI eval sets** (branch `work/m1-133-evals`, side agent 2026-11-01; ADR-107, no
  migration; M1-133 is done):
  - Everything is in `apps/server/src/ai/evals/`: `dataset.ts` and `seed.ts` (the synthetic
    dataset, seeded through the API, fixed now 2026-09-16 10:00 UTC), `query-corpus.ts` and
    `query-eval.ts` (125 pairs, exact-result scoring as the asking person), `summary-corpus.ts`,
    `rubric.md`, `judge-prompt.md` and `summary-eval.ts` (12 cases, 39 graded examples, the
    automatic grader), `duplicates-corpus.ts` and `duplicates-eval.ts` (46 queries, recall@3),
    `runner.ts` and `cli.ts` (`pnpm eval <query|summary|duplicates|all> [--candidate <module>]
    [--json]`). The CLI is allowed to use testkit (`packages/devtools/src/boundaries.ts`).
  - **For M1-079:** export `{ name, query?, summary?, embed?, rerank? }` from a module and run
    `pnpm eval all --candidate <module>`; thresholds are in `THRESHOLDS` (query 85%, summaries
    all pass, duplicates recall@3 80%, the last one proposed). Calibrate the judge prompt on the
    graded examples before trusting it. A summariser gets a `request` function that acts as the
    reader: read through it, never through the database, or the leak checks mean nothing.
  - **For M1-078:** once the runtime is on main, pass its `embed` as a candidate and record the
    score in ADR-107 (the bag-of-words stand-in scores recall@3 67.4%).
  - Changing the dataset or the query engine changes `__golden__/query-expected.json` (expected
    keys per pair); review the diff. `pnpm eval` needs no key and calls no model; CLAUDE.md's
    command table does not list it yet.

- **M1-079 AI v1 features** (branch `work/m1-079-ai-features`, side agent 2026-11-01; ADR-108,
  no migration; **in progress**: only the measured thresholds are left, and they wait for a key):
  - Server: `routes/ai-features.ts` (summary as server-sent events with cancel, query from text
    checked with `prepareSearch` and never run, drafts and breakdown as proposals) and
    `reasons: true` on `POST /api/v1/tickets/similar` (a model re-ranks within 2 s, else the
    embedding order). Prompts and parsing in `ai/features/`; `AiContext` gained `comments`
    (readable ones only, set-based) and `changes`. All read-only token class; contract
    exemptions; no domain events (the AI audit log books every call).
  - Web: `SummaryPanel`, `AskQuery`, `DraftFromText`, `BreakdownAction` (in `apps/web/src/ai/`),
    `DuplicateSuggestions` (tickets, not an AI control). `useFirstUse` shows `AiNotice` before the
    first call. Pages take an `ai` prop for stories and tests.
  - Evals: `pnpm eval all --candidate apps/server/src/ai/evals/candidates/live.ts` with
    `TASKMOOR_AI_EVAL_KEY` (or `TASKMOOR_AI_TEST_KEY`) measures the thresholds, judges summaries
    with `judge-prompt.md` (calibration printed first) and runs the injection corpus through every
    feature. Without a key it stops with exit 2. `candidates/replay.ts` proves the wiring
    (query 125/125, summary 12/12 automatic, duplicates recall@3 100%, injection 40/40). Record
    the live numbers in ADR-108 and set M1-079 to done when they meet `THRESHOLDS`.
  - e2e: two new backends in `api-server.ts`, AI on the fake provider (8797, preview 4186) and no
    provider (8798, preview 4187), each with an embedding worker; `FakeProviderServer.answer`
    scripts the model per feature. `ai-features.spec.ts` and `ai-features-fake.spec.ts`.
  - Targeted vitest runs: `node node_modules/vitest/vitest.mjs run --project=<name> <file>`
    from the root; `pnpm verify --update --only=tests -- <one file>` once ran the whole suite here.
  - Left for later: images in drafts (the gateway has no image content parts), a similar-ticket
    panel on the ticket page.

## Start here: 2026-10-30, overnight and day (Mac, main session)

Everything below is on `main` and passed `pnpm verify --e2e` before each push. In order:
M1-115 accessibility, M1-105 static frontend, M1-106 meta endpoint, M1-116 i18n and Spanish,
M1-087 synthetic backups, M1-109, M1-111 and M1-110 (the Builder core and both kits), M1-134
clean URLs, M1-132 cross-browser e2e, M1-130 async bulk API, M1-040 full-text search, M1-127
workflow files, M1-114 the manual, M1-125 info fields, M1-066 rate limits, eight fixes for
gaps the manual found, then together M1-085 (IP allowlists, the audit log page, syslog,
external people), M1-123 teams, M1-124 clone and M1-126 board-managed workflows, then
M1-104 load tests, and last the two side sessions' branches: M1-107 cross-origin sign-in
(OAuth 2.1, strict CORS and CSP; migration 0064, ADR-080) and M1-088 Data Center import of
people and configuration (migration 0065, ADR-081). Each has its own section below. Migrations
run to 0065 and ADRs to 082.

**Since M1-107**: the backend refuses any `/api/` request whose Origin is neither its own nor in
`TASKMOOR_ALLOWED_ORIGINS`, and every e2e spec runs under the strict CSP. New backend calls in
the web app go through `apiFetch` (`apps/web/src/api/client.ts`), or they break in the OAuth
layout; a library that injects `<style>` elements or evaluates text fails under the CSP.

**Merging side branches**: resolve the appended rows (progress, STATUS, HANDOFF, the ADR
index, migration index, upgrade seeds) by keeping both sides, then `pnpm verify --update`,
`npx vitest run --project sdk -u packages/sdk/src/generate.test.ts`, and the full gate. The
upgrade seeds file is an object: when two branches append to it, rebuild the tail from each
branch's own block rather than keeping both conflict sides line by line. A merge commit made
with `--no-edit` has no sign-off: `git commit --amend --no-edit -s` before the next merge.

**Gate under load**: several sessions share this Mac and one lock (`/tmp/taskmoor-gate.lock`).
Write gate logs outside `.verify/`, which verify clears. Do not run other tests while a gate
runs: a query-timeout test and the spike tests' pools were flaky under load (both fixed today).

**Decisions waiting for the user**: answered on 2026-10-31 (see the 2026-10-31 section at the
top). Still open: image publishing on ghcr.io and the repository rename.

**Product gaps the manual found (M1-114)**: fixed on 2026-10-30 (commit "Fix eight gaps the
manual found"): the setup form's mail server is used, Compose passes mail, S3, backup and
telemetry settings, `cli.mjs backup` honours `TASKMOOR_BACKUP_DIR`, labels split the same way
everywhere, "screens" left the layouts permission, a read-only token may end its MCP session,
the admin token scope is offered to every administrator, and the account's language applies.
Still open: Helm runs no backup before migrating and its worker has nowhere to keep backups;
backups skip attachments outside `TASKMOOR_DATA/files` (S3); "Call a webhook" sends nothing;
track feature switches hide nothing; five global permissions are never checked; the server
reads none of the Builder's `TOKEN_SIGNING_KEY` (not needed: ADR-080), `MASTER_KEY` and `AI_*`
(M1-075; `TASKMOOR_ALLOWED_ORIGINS` is read since M1-107); `install.ps1` ignores `TASKMOOR_PULL` and `TASKMOOR_COMPOSE_OVERRIDE`;
the Builder CLI takes no SMTP password or AI key and fails on a From with a display name. The
manual states each as "not yet"; update its page with each fix.

**Not verified here**: a fresh-VM install with real DNS, `install.ps1` on Windows, real static
hosts for the frontend kit (Apache, Netlify, Cloudflare Pages, S3 with a CDN), branded Edge and
real phones, backup and restore of the full-text columns (no `pg_dump` on this Mac).

**Next free numbers**: migration 0066 and ADR-083 (now 0072 and ADR-095: see the cloud session above).

## Earlier: what changed on 2026-10-30 (cloud session, with the user)

The user worked with a cloud session while this Mac was busy. Pull first, then read the three
sections below this one. See every change with `git log --stat 62b5a68..3182b16` (four commits:
4f3d4b5, 31e075a, 0d633ad, 3182b16). Where to look:

| What | Where |
|---|---|
| GitHub Actions off until M1 is finished; the local `pnpm verify --e2e` is the gate | `CLAUDE.md` (Identity), `.github/workflows/*.yml` (all `workflow_dispatch` only), section "No GitHub Actions" below |
| Docker (Colima) installed; the image, kit, backup-drill and Helm checks pass | Section "Docker checks on the Mac" below |
| 33 new tasks (239 in all), reworded tasks, new dependencies | `docs/plan/backlog.csv` (M1-123 to M1-134, M2-022 to M2-037, M3-016 to M3-018, M4-014, M4-015); section "Backlog review applied" below; `pnpm next-task` |
| The user's decisions (IP allowlists in 1.0, SIEM split, "Should" items to 2.0, English and Spanish in 1.0, clean URLs in the kits, no Actions until M1) | `docs/plan/decisions.csv` (rows dated 2026-10-30) |
| Requirements moved or changed | `docs/specs/01b`, `01c`, `02a`, `02c` (six requirements now M2), `05b` (NFR-006 languages), `docs/specs/requirements-index.csv` |
| Routing default | `docs/adr/0066-frontend-artefact-and-runtime-config.md` (Consequences), task M1-134 |
| Milestone brief and backlog review for the user | Google Drive, folder "JIRA knockoff" > "Taskmoor milestone briefs" (keep them current when milestones move; ask the user before rewriting them) |

What changes for the next task: M1-116 is now a Spanish translation (not "a second language");
M1-085 keeps only a syslog audit export; M1-120 also waits for M1-123 to M1-132 and M1-134.

## Docker checks on the Mac (2026-10-30): done

Asked for by the cloud session with the user. Colima, Docker (with the Compose and Buildx
plugins), kind, Helm and kubectl (`kubernetes-cli`; Colima ships no kubectl) are installed with
Homebrew. `~/.docker/config.json` names `/opt/homebrew/lib/docker/cli-plugins`. The VM runs with
`colima start --vm-type vz --vz-rosetta --cpu 4 --memory 8 --disk 60`, and `hello-world` ran.
Results at 15d2659, from a clean worktree of main:

| Check | Result |
|---|---|
| `tools/image/smoke.sh` | Passed in 37 s. Image 77 MB; web-only with hash routing and clean URLs, all roles next to Postgres 16, arm64. This Mac is arm64, so amd64 was not exercised |
| `tools/image/smoke-kits.sh` | Passed in 27 s: the bundled-Postgres and external-Postgres Compose kits reach `/ready` |
| `tools/image/drill-backup.sh` | Passed in 21 s: backup, restore, table checksums equal, the restored administrator signs in |
| `tools/helm/kind-test.sh` | Failed first: `helm test` ran two seconds after the pods started, before the new cluster routed the Service ("fetch failed"). Fixed in 63c7e79 (the probe retries for a minute). Then passed in 224 s: `helm test` ok, a rolling upgrade under load with 47,733 requests and none failed |

## Backlog review applied (2026-10-30)

A review of the backlog against the requirements (Drive: "Taskmoor backlog review, 30 October
2026") was applied with the user's decisions (`docs/plan/decisions.csv`). 31 new tasks, 237 in
all: M1-123 to M1-133 (teams, clone and deep clone, computed info fields, board-managed
workflow, workflow export and import, Jira URL redirects, entity properties, async bulk API,
agent budgets, cross-browser e2e, AI eval sets; the first ten gate M1-120), M2-022 to M2-036,
M3-016 to M3-018, M4-014 and M4-015. Six M1 "Should" requirements (AGL-020, NTF-009, API-015,
API-016, AI-010, RPT-009) moved to M2 in the specs. M1-085 keeps IP allowlists and a syslog
audit export; continuous SIEM streaming is M2-018. M0-001, M0-008, M1-116 and M1-118 reworded.
Also decided: release 1.0 ships English and Spanish (M1-116; the other five languages of NFR-006
are M2-037), and the Compose, all-in-one and Helm kits default to clean URLs (M1-134, ADR-066).

## No GitHub Actions until M1 is finished (2026-10-30)

GitHub Actions stopped starting jobs on 2026-10-29 evening (the free private-repo minutes ran
out: "recent account payments have failed or your spending limit needs to be increased"). The
user decided not to pay for GitHub and not to use Actions at all, free minutes included, until
the full M1 version can be tested.

- **The gate is local:** the whole `pnpm verify --e2e` before every push to `main` (CLAUDE.md).
  Pushing and pulling work as before.
- **Every workflow is manual only** (`workflow_dispatch`): no runs on push, pull request or
  schedule. Do not dispatch any.
- **Not checked since M1-059** (29 October): Postgres 18, Windows, the Docker image for both
  architectures, the Compose kits, Helm on kind, the install matrix, the security scan and the
  nightly benchmarks. They are run once at the M1 gate; expect fixes then. With Docker on the
  Mac, `bash tools/image/smoke.sh` and `smoke-kits.sh` cover the image and kits locally.

## Moved to a Mac (2026-10-15)

Development resumed on a Mac (Apple silicon, macOS). The repository lives in
`~/Documents/claude` (not a folder named tracksmith). The Windows notes below (drives E: and
G:, MSYS, CRLF, `pg_ctl` pipes) are history for this machine; see "On the Mac" under Notes.

No branch holds unfinished work any more. `wip/m1-083-scim` was finished as M1-083 (below) and,
like `wip/m1-007-ticket-types`, can be deleted from GitHub. Migration numbers 0011 to 0014 are
all on the branch now; a long-lived development database that ran 0013 or 0014 before 0012
existed refuses it ("corrupted migrations", Kysely applies migrations in name order): recreate
it. The local demo is such a database (`docker compose down -v`, then `bash install.sh`).

## 2026-10-30: M1-104 load tests and sizing

ADR-082; no migration. `pnpm load` (needs k6: `brew install k6`) makes a dataset in the bench
cluster, 2,000 people with tokens, starts the server as in production and runs k6 per tier;
it writes `docs/ops/load-tests.md` and `docs/ops/data/load-<label>.json`. First run on the M3
Pro, 100,000 tickets: one API process met every target up to 500 people; at 2,000 only ticket
creation was over (236 ms against 200). The reference-hardware and 10M runs are M1-117.

## Side session 2026-10-30: M1-107 cross-origin sign-in

ADR-080; migration **0064** (`0064_oauth`). The main session gave this task 0064 and ADR-080,
so the "Next free numbers" line above moved on when this merged.
- **Origins**: `apps/server/src/origins.ts`. Every `/api/` request with an Origin that is neither
  the instance's own nor in `TASKMOOR_ALLOWED_ORIGINS` gets 403 before authentication, including
  `/api/meta` (no longer `*`) and the sync socket's handshake. Co-editing checks the same policy.
  A new route other sites post to by design (like the SAML ACS) goes in `OPEN_TO_ANY_ORIGIN`.
- **OAuth**: `oauth/tokens.ts`, `routes/oauth.ts`. A token family is a `user_session` row with
  `client_id` and the approving cookie session as `parent_id`, so existing session code reaches
  it. `request.tokenFamily` marks requests signed in by an access token. A refresh emits no
  event, on purpose (ADR-080).
- **Web**: `session/oauth.ts` (the client), `api/client.ts` (`apiFetch`, `openSocket`; new raw
  `fetch` calls to the backend should go through `apiFetch`), `session/OAuthSignIn.tsx`,
  `attachments/media.tsx`. Runtime config key `auth`.
- **CSP everywhere**: the e2e preview (4173) now sends the policy, so the whole browser suite
  runs under it. Tiptap's `injectCSS` is off; its base rules are in `richtext.css`. A library
  that injects a `<style>` element or evaluates text will break under it.
- **e2e**: `web-server.ts` runs a third backend at `api.taskmoor.localhost:8794` (listening on
  `::`); `kit-server.ts` serves `app.taskmoor.localhost:4181` (same site) and `127.0.0.1:4182`
  (another site). `cross-origin.spec.ts` covers both layouts. Not tried on Firefox or WebKit
  (`--browsers`), where `*.localhost` resolution may differ.
- **Gate**: `pnpm verify --e2e` green on the branch (4,619 tests, 144 e2e). Two earlier runs each
  had one unrelated failure under load that passed on the rerun: the artefact guard's
  server-package test (Rolldown reported `node:crypto` before `packages/db`) and setup.spec's
  NTF-008 live-update test (the change reached the local copy before the test read its
  starting position).
- **Not done**: origins and redirect URIs in the admin area (M1-108); OAuth for MCP clients
  (ADR-080 lists client registration, consent, scopes and discovery); S3 previews in the OAuth
  layout need a bucket CORS rule, untested; SSO errors from a sibling frontend land on the
  backend's sign-in page.

## 2026-10-30: M1-085 IP allowlists, audit log page, syslog

ADR-078; migration **0062** (0060 and 0061 are reserved for M1-123 and M1-124, which may merge
after it: fresh databases do not mind; a long-lived one that ran 0062 first must be recreated).
- The allowlist hook runs after authentication; `cli.mjs allowlist-off` is the way back in.
- Syslog forwarding runs in the worker by cursor (`audit_syslog.last_seq`), at least once.
- External people (IAM-004), decided by the user on 2026-10-30: anyone whose email is not at one
  of the organization's domains (Security page) must use two-factor; nothing else differs.
## 2026-10-30: M1-126 board-managed workflow

ADR-079; migration **0063** (0060 to 0062 are M1-123, M1-124 and M1-085).
- The managed workflow is an ordinary versioned workflow with `definition.board`; the board
  rewrites and publishes it on every column change (`workflows/board-managed.ts`).
- One `board.updated` event carries the workflow change (M1-005: one event per mutation).
- `writeVersion` now lives in `workflows/store.ts`.

## 2026-10-30: M1-066 rate limits and API usage

ADR-075; migration **0059** (`0059_rate_limits.ts`).
- Buckets live in each API process (`ratelimit/limiter.ts`); `buildApp` applies them only when
  given `rateLimits` (the server always does; tests and the e2e servers do not).
- Usage is counted in memory and added to `api_usage` every 10 seconds; the page flushes first.
- Exact limits across several API processes would need the buckets in Postgres: see the ADR.

## 2026-10-30: M1-125 read-only info fields

ADR-010 has a new section; migration **0058** (`0058_info_fields.ts`).
- `ticket.first_response_at` and `last_comment_at` are kept by triggers; code never writes them.
  Only comments without a role or group restriction and outside the trash count.
- Query fields `firstResponse`, `daysSinceLastComment` (ordering uses the column reversed) and
  `participants`. `GET /api/v1/tickets/:id/info` adds time in status from the history.
- The ticket page has an Info panel under Details (a new `.ticket-side` column wrapper).
## Side session 2026-10-30: M1-088 Data Center mapping, people and configuration

Built on the branch `claude/kind-feistel-083114` in a side session; the main session merges it
after its own gate. ADR-081; migration **0065** `0065_import_labels.ts` (0064 is the main
session's; a database that ran 0065 before 0064 exists must be recreated). Upgrade seed
`0065_import_labels`.

- **Reader** `import/dc-backup/stage.ts`: one streaming pass (the validator's `parseXml`, now in
  `parse.ts`) writes `<zip>.staged/<kind>.ndjson` and `stage.json`, reused for the same file.
  Configuration only in memory; issues and the rest are counted. M1-089 onwards add their
  elements to `Collector.row` and `resolve()`, their kinds to `STAGED_KINDS` and `CONSUMED`,
  and stream large ones to files instead of memory.
- **Source and mapper** `import/dc.ts` (format `dc-backup`, `system` default `dc`).
- **Framework** (`model.ts`, `run.ts`, `report.ts`): `ImportSource.unsupported(kind)` counts a
  kind at once with its reason, so a large backup is not read only to be counted;
  `ImportSource.notes()` adds source warnings once (`removed_character`, kind `source`);
  `SourceRecord.label` and `import_record.label` feed the report's new `mapping` section
  (configuration kinds, 500 per kind); `TrackCommand.roleActors`. `run.unsupported` values may
  now be `{count, reason}`; `runView` still shows numbers. JSON-lines reading is shared in
  `import/lines.ts` (the export source uses it).
- **Route** `GET /api/v1/admin/imports/:id/records` (OpenAPI regenerated); `POST` takes
  `{"format": "dc-backup", "path", "system"}` and checks only the ZIP's directory.
- **Goldens**: `import/__golden__/dc-10k-seed1.report.json` (new),
  `fidelity-report.schema.json`, `packages/db/src/__golden__/schema.json`, `docs/api/openapi.json`.
- **Manual** `admin/import-export.md`: "Data Center backups"; format notes 02d section 6.
- **Not done**: nested groups (warned), earlier project keys (warned, M1-128), archived projects,
  project avatars and user time zones (not in the generator), matching people by Data Center
  user name (by address only), and a setting for the backup's time zone (M1-091 needs one for
  issue times).

## Side session 2026-10-30: M1-123 teams

Built on the branch `claude/gallant-bhaskara-72bcdc` in a side session; the main session merges
it after its own gate. ADR-076; migration **0060** `0060_teams.ts` (0058 and 0059 belong to
M1-125 and M1-066, ADR-075 to another branch).

- **Data** (0060): `team` (name unique ignoring case, description, `lead_id`), `team_member`,
  `board.team_id`, `area.owner_team_id`; field type `team`. 0060 extends `field_type_check`
  from the definition the database holds, so 0058's new types survive; a later migration that
  rewrites the check from a fixed list must keep `team`. Upgrade seed `0060_teams`.
- **API** `routes/teams.ts` (lookups shared with search and import in `teams.ts`): reads for
  everyone signed in, changes for site administrators; five `team.*` events, audited, in the
  events contract. Boards take `teamId` (list filter `?teamId=`), areas `ownerTeamId`; both show
  the team by its current name. OpenAPI and the reference regenerated (board `team`, `teamId`).
- **Team field**: custom type `team`, one value, stored and searched like a group field
  (`v_option`), ordered by team name (`teamName` in `search/compile.ts`).
  `membersOf("id:<teamId>")` binds in `search/bind.ts`; a name still means a group.
- **Export and import**: `teams.ndjson` after groups; an area's `ownerTeam` only when set, so
  older exports keep their bytes. The fidelity report schema lists `team`.
- **Web**: Settings > Teams (`people/TeamsPage.tsx`, `teamsClient.ts`, `fakeTeamsClient` in
  `people/fixtures.ts`), Team on board settings, the Team type on the fields page.
- **Manual**: `admin/people-and-groups.md` is now "People, groups and teams"; fields, tracks
  (areas), boards, search and import-export pages updated; `docs/export-format.md`,
  `docs/csv-import.md`.
- **Not done**: velocity per team (AGL-011 (3)); choosing a Team value in the web ticket form
  (the form has no reference pickers yet: people, groups, releases and areas are set through the
  API, CSV or bulk changes too); teams in roadmaps and on-call (M2, M3).

## 2026-10-30: M1-130 async bulk API

ADR-043 has a new section; no migration.
- **Contract:** the five bulk routes are stable operations (tag "Bulk changes"); the OpenAPI
  document, reference and SDK are regenerated, and `contract.test.ts` calls each.
- **Limit:** the guardrail `tickets_per_bulk_operation` (default 10,000) caps ticket lists and
  queries; 400 `too_many_tickets` carries `max` and the guardrail name.
- **Retention:** `trimBulkOperations` in the housekeeping loop removes finished operations 14
  days old; running ones are never removed.

## 2026-10-30: M1-132 cross-browser end-to-end

ADR-030 has a new section; no migration.
- `pnpm verify --e2e --browsers` adds Firefox and WebKit on a desktop and Safari and Chrome
  phones at 360 px to the routine Chromium projects. It is not in the routine gate (about three
  times the e2e time); run it before a release and after input, focus or clipboard changes.
- `setup.spec.ts` runs only on desktop Chromium (one setup per backend); the keyboard journey
  skips WebKit (Tab skips links, as in Safari by default).
- **Pending:** branded Edge (not installed here; same engine as Chromium) and real devices.

## 2026-10-30: M1-110 backend kit

ADR-031 has a third implementation section; no migration.
- **Builder CLI:** `pnpm builder` writes the full backend kit: Compose with PostgreSQL, the
  pinned backend and Caddy, `install.sh` and `install.ps1` with a preflight, and a DNS README.
  Helm projects get `values.yaml` and `secret.yaml`.
- **Smoke test:** `bash tools/image/smoke-backend-kit.sh` installs a kit for
  `https://localhost:18443` against the local image. It needs Colima running and the image
  from `tools/image/smoke.sh`.
- **Pending:** the fresh-VM install with real DNS, and `install.ps1` (no PowerShell on this
  Mac).

## Side session 2026-10-30: M1-040 full-text search

Built on the branch `claude/gracious-meninsky-4dae8f` in a side session while the main session
did M1-049 and M1-065 (merged in); the main session merges it after its own gate. ADR-069
(065 to 068 were taken), sections in ADR-010 ("Text search (M1-040)") and ADR-011 ("Changes");
migration **0057** `0057_full_text_search.ts`.

- **Words** (migration 0057): `taskmoor_search` text search configuration (English Snowball,
  no stop words), `taskmoor_document_text(jsonb)` (a document's text, marks joined, blocks
  apart), stored generated columns `ticket.summary_words`, `description_words`,
  `environment_words`, `ticket_comment.body_words` with GIN indexes over live rows (they replace
  0043's `simple` expression indexes of the same names), `v_text_words_idx` on custom text
  values, `pg_trgm` with trigram indexes on summaries and `v_text`. Schema type `SearchWords`
  (never written). The schema snapshot now shows generated columns' expressions. Upgrade seed
  `0057_full_text_search` checks the words of a ticket and a comment.
- **Syntax** (`packages/query/src/text.ts`, `parseTextSearch`; spec 01b 1.8): words ANDed,
  phrases, trailing `*`, `?` (at most two a word), `term~` (one edit), `-term`, backslash
  escapes, and patterns (`*` anywhere but the end: `*Exception`) on summaries and text fields
  (refused on description, environment, comment and history; `text ~` applies them to summaries
  and text fields with a warning). The resolver refuses what cannot run at the value's
  position. **Patterns were an extension beyond spec 1.8**; the user dropped them on 2026-10-31
  (now refused).
- **Compile** (`search/text.ts`, `search/compile.ts`): one `to_tsquery('taskmoor_search', $n)`
  parameter per search with quoted operands; `?` and fuzzy words expand into the words they
  stand for and are read by probing the word index once per word (`matchesFrom`, a fenced `LATERAL`
  subquery per word) into an id
  array (`k.id = ANY(ARRAY(...))`), because the planner takes an OR of hundreds of unknown
  words for most of the table. `text ~` has two forms chosen in `bind.ts` `textForms` from an
  `EXPLAIN` of the set form (`perRow`): a set of ids (`k.id IN (... UNION ALL ...)`), or an OR
  tested per row for a page from max(5,000, 0.3% of tickets) expected matches, for a count from
  max(20,000, sqrt(10,000 · tickets / 4)), and when ordering by relevance from max(5,000, a
  quarter of the tickets) (Postgres estimates a UNION ALL's distinct ids at 200, so the set form
  always reads every match first). The count and sample statements are compiled with
  `purpose: 'count'`.
  Searches of several words or a phrase are counted in the word index when bound
  (`countInIndex`, table scans off for that statement, up to the page threshold); few matches
  start from the index (`fromIndex` on `words` conditions, the set form of `text ~`), because the
  planner takes words for independent. The comment branch reads each comment's track by key (`commentReadableSql` takes a `track`
  expression now; `CompileOptions.commentsOf`, passed by search, boards and webhooks). A
  condition tested on a few known tickets passes `rows: true` (webhooks do), which keeps every
  text search a test of the row instead of a set of all matches in the workspace.
- **`ORDER BY relevance`**: a system field of type `relevance` (no operators; refused without a
  text search that must match). Weighted `ts_rank` (summary 1, description 0.4, environment
  0.2, custom 0.4, best readable comment 0.2), negated `float8`: ascending (the default) puts the
  best first. Keyset cursors carry it.
- **Counts** (`search/count.ts`): exact to 10,000, then an estimate from a `TABLESAMPLE SYSTEM`
  block sample (mean matches per block times the table's current blocks; given only when its
  standard error is at most 3.5%, so within 10% 99 times in 100; the sample grows once, to at
  most 500,000 rows), else "more than 10,000". `total: { count, exact, approximate? }` in the
  search route, the REST API contract (`SearchTotal`, both search operations; OpenAPI document,
  reference and SDK regenerated), the web ("About 123,456 tickets") and subscription emails
  ("about"). Estimates are cached per process for `TASKMOOR_COUNT_CACHE_SECONDS` (60) per
  statement and parameters, dropped when more tickets changed than 2% of the count.
- **Tests**: `packages/query/src/text.test.ts` (forms, escapes, refusals, a print/parse
  property), 12 new conformance Text cases (text 152 of 152), `search/text.test.ts`
  (expansions, quoting, patterns), `search/text.run.test.ts` (QRY-007 (1), (2), (3) through the
  API, every form on every text, comments by readability, relevance and paging, a property that
  every search the syntax reads runs in Postgres, every Text conformance case on the server),
  `search/count.test.ts` (estimates within 10%, the error judged and the sample grown, the
  cache and what drops it), text plans in `plans.test.ts` (`__golden__/plans-text-pg16.json`),
  3 golden statements in `compile.test.ts` (its fuzz property compares a text search with one
  of the same shape), `search/text.large.test.ts` (`TASKMOOR_LARGE_TEXT=1`, size from
  `TASKMOOR_LARGE_TEXT_TICKETS`), web tests for the estimated total.
- **Fixed on the way:** `apps/server/src/upgrade.test.ts` seeded every release's rows after
  migrating straight to the third-newest migration; with 0057 that start passed 0055 (no
  default workspace) and the 0002 seed failed. It now seeds each migration's rows right after
  it, as `packages/db` does.
- **Measured** (`text.large.test.ts`, 2026-10-30, load average 5 to 21 from other sessions;
  ADR-069 "Measurements"): at 200,000 tickets every first page under 300 ms (slowest:
  relevance over a word in 42% of tickets, 205 ms) and every estimate within 3.8%; at
  **1,000,000 tickets** every first page under 300 ms (fuzzy word 179 ms, comment search 78 ms,
  the rest under 27 ms) except `ORDER BY relevance` on common words (821 ms over 424,000
  matches, 1,541 ms over 48,000), every estimate within 5.4%, counts 1 to 902 ms (a text search
  with another condition walks to 10,001 matches before sampling).
- **Decision for the user:** `ORDER BY relevance` ranks every match, so a common word costs in
  proportion (about 10 s at 10M for a word in 40% of tickets). Proposed: rank only the 10,000
  most recently updated matches when there are more, and say so in the answer. Not built.
- **Pending (not blocking):** the done-when "p95 < 300 ms at 10M tickets" (no 10M dataset on
  this Mac, which held 1M; M1-117 should load text as `text.large.test.ts` does and run its
  queries; relevance over common words is already over budget at 1M, see above). Backup
  and restore of the new function, configuration and generated columns are untested here (no
  `pg_dump` on this Mac; the backup tests skip). Not built: changing the site language (alter
  `taskmoor_search`, rewrite the word columns), relevance from comments and text fields under
  `text ~`, full paragraph text (text fields still index a paragraph's first 255 characters),
  `pg_trgm` for autocomplete.

## 2026-10-30: M1-111 frontend kit

ADR-031 has a second implementation section; no migration.
- **Pinning:** the runtime config has `instanceId` and `instanceKey`. The app refuses a
  backend that is not the pinned instance.
- **Builder CLI:** `pnpm builder --project <file>` writes
  `taskmoor-backend-kit.zip` (the `.env` and the manifest, for now),
  `taskmoor-frontend-kit.zip` and `taskmoor-frontend-single.html`.
- **e2e:** `e2e/kit-server.ts` (ports 4178 to 4180) serves the kits for `kits.spec.ts`.
- **Flake seen:** `sync/log.test.ts` (commit order of two racing transactions) failed once
  under a full gate and passed three times alone.
- **Next:** M1-110 grows the backend kit (Compose pinned to the version, Caddy, `install.sh`
  and `install.ps1`, the DNS README) around the same `.env`. The web Builder page is still to
  come. Real static hosts (Apache, Netlify, Cloudflare Pages, S3 with a CDN) are untried.

## 2026-10-30: M1-134 clean URLs in the install kits

ADR-066 has the note. The Compose kits, the all-in-one image and Helm (`webRouting`) default to
`TASKMOOR_WEB_ROUTING=path`. `smoke-kits.sh` and `helm test` check deep links on every kit;
both were run on the Mac with Colima and passed.

## 2026-10-30: M1-109 Builder core library

ADR-031 has an implementation section; no migration.
- **Package:** `packages/builder-core` is browser-safe and uses Web Crypto only. Keep
  `node:` imports out of it, because the web Builder runs it as is.
- **Server:** `TASKMOOR_INSTANCE_ID` and `TASKMOOR_INSTANCE_KEY` from a backend kit seed the
  instance identity of M1-106.
- **Next:** M1-110 (backend kit) and M1-111 (frontend kit) wrap `buildKits` with the Compose,
  Caddy and installer files and with the static app. The web Builder page and the CLI come
  with them.
- **Dockerfile:** it copies `packages/builder-core/package.json`, because the server depends on
  it in its tests.

## 2026-10-30: M1-116 i18n completeness

ADR-024 has a new section; no migration.
- `pnpm i18n:check` reports zero hard-coded strings, and a test keeps it there. Mark a literal
  that is not language with `i18n-ignore` and a reason.
- `?locale=ar-XB` mirrors the app right to left. New CSS uses logical properties
  (`margin-inline-start`, `inset-inline-end`, `text-align: start`). Drawings in their own
  coordinates set `direction: ltr`.
- **Spanish:** `apps/web/src/i18n/messages.es.ts` is a machine draft of every message, with
  its glossary in the header. New English messages need a Spanish entry or the typecheck
  fails. `DRAFT_LOCALES` keeps Spanish opt-in (`?locale=es`) until a native speaker reviews
  it.
- **Open:** that review is the user's to arrange. The person's saved language (`user.locale`)
  does not choose the catalogue yet.

## 2026-10-30: speed limits moved to the benchmark run (ADR-071)

The user asked for this. Time budgets in tests now go through `expectWithinBudget`, from
`@taskmoor/testkit/budget` (Vitest), `apps/web/e2e/budget.ts` (Playwright) or
`apps/web/src/test/budget.ts` (stories).
- `pnpm verify` measures them into `.verify/budgets.jsonl` and prints a note when this machine
  missed some; it never fails on them.
- `pnpm bench:check` runs the 14 files that hold them with `TASKMOOR_ENFORCE_BUDGETS=1`
  (`--e2e` adds the e2e specs). Run it on a quiet machine before a release.
- New tests with a time budget must use the helper (CLAUDE.md, Conventions).

## 2026-10-30: M1-106 meta endpoint, instance identity and update banner

ADR-070; no migration.
- **Identity:** the instance's identity lives in `instance_setting` under `identity`
  (`apps/server/src/meta/identity.ts`): an id and an Ed25519 key pair. The private key is
  sealed with the pepper. A lost pepper refuses signing (503); it never makes a new identity.
- **Meta endpoint:** `GET /api/meta` (`routes/meta.ts`) is a public route and the stable
  operation `getMeta`; the SDK is regenerated.
- **Shared rules:** `@taskmoor/webconfig` has `versions.ts` (the window and the skew) and
  `identity.ts` (`verifyInstance`), for the backend and for the kits of M1-110/M1-111.
- **Web:** the artefact plugin defines `__TASKMOOR_WEB_VERSION__` (`runtime/version.ts`).
  `meta/VersionGate.tsx` wraps `Pages`, and the shell's `<main>` starts with `UpdateBanner`.
- **Pending:** the previous release's kit running its core e2e against the new backend. It
  needs two releases and the kits; the release steps are in `docs/api/README.md`.
- **Next:** M1-107 can replace the `*` CORS of `/api/meta` with the allowed origins if it
  wants to; the value is public either way. Key rotation needs a procedure when kits pin the
  key (ADR-070).

## Side session 2026-10-30: M1-124 clone and deep clone

Built on the branch `claude/vigorous-curie-c18ac3` in a side session; the main session merges
it after its own gate. ADR-077 (and a section in ADR-043); migration **0061** `0061_clone.ts`
with upgrade seed `0061_clone`. No new dependency.

- **API**: `POST /api/v1/tickets/:id/clone` (`routes/clone.ts`, stable operation `cloneTicket`)
  answers 202 with a bulk operation of the new action `clone`. Body: `track` (default the
  ticket's own), `summary` (the first copy's), `subtickets`, `attachments`, `links` (default
  true), `descendants` (deep clone, default false). Needs browse and "Create tickets" in the
  target track, not "Make bulk changes". A subticket only into its own track. Capped by the
  `tickets_per_bulk_operation` guardrail.
- **Job** (`clone/run.ts`, called from `bulk/run.ts`, one item at a time): each copy through
  the create route as the person; refused values the person may not set are left out and
  listed in `result.left`; type, parent, visibility level and required fields are never left
  out (the item fails, its descendants fail with `parent_not_cloned`). Then one transaction:
  Copies link (copy to original, while links are on), links (rejoined between two copies),
  web links, attachments (bytes copied to the active store first, registered as uploads), one
  `ticket.cloned` event (not audited, not a webhook event), the item's outcome.
  `bulk_item.result_ticket_id` makes it resumable. `registerBulkJobs` now takes `stores`
  (`main.ts` and the e2e API server pass them).
- **Web**: Clone in the ticket header opens `tickets/clone/CloneDialog.tsx` (summary, track,
  subtickets, deep clone for level 1 and up, attachments, links); it polls the operation and
  opens the copy, or says what was left out with links to the copy and `#/bulk/<id>`. 34 new
  messages in English and Spanish.
- **Tests**: `clone/clone.test.ts` (CORE-023 (1) and (2): a level-2 Objective with an outcome,
  features and subtickets deep-cloned into another track), API contract, events contract (the
  route scenario and the job's `ticket.created` then `ticket.cloned`), dialog tests and
  stories, `e2e/clone.spec.ts` (both criteria through the dialog).
- **Reading of CORE-023 (2)**: with default levels an outcome has only two levels below it, so
  the tests deep-clone an objective (a level an administrator adds) with its outcome, features
  and subtickets: three levels below it. Outcome-rooted deep clones are tested too.
- **Not built**: type mapping when the target track lacks a type (the item fails with
  `ticketTypeId: not_in_track`), copying comments, followers, time or sprints.
- **Merge notes**: likely conflicts in `events/catalogue.ts`, `audit/subscriber.ts`,
  `events/contract.test.ts`, `api/operations.ts`, `api/schemas.ts`, `messages.*.ts`,
  `migrations/index.ts`, `upgrade-fixtures.ts`, the schema golden and the generated OpenAPI,
  reference and SDK (regenerate with `pnpm verify --update` after merging rather than
  hand-merging).

## Side session 2026-10-30: M1-127 workflow files

Built on the branch `claude/blissful-hawking-450e3f` in a side session; the main session merges
it after its own gate. ADR-073 (and a pointer in ADR-039); no migration, no new dependency.

- **Format** (`apps/server/src/workflows/transfer.ts`): `format: "taskmoor-workflow"`,
  `version: 1`, the definition in its stored shape with **document ids** (1..n per kind, in the
  order the definition first names them, the workflow's statuses first) and tables naming them:
  statuses (stage, description), groups, roles, people (email), priorities, close reasons,
  ticket types, releases and areas (track key). Exporting what an import made gives the same
  bytes. `mapDefinition` is the one walker for both directions.
- **What does not map never widens access**: guards become `always-false` (an empty `any`
  would allow everyone, so emptied lists do too), lists lose members, checks and `restrict-*`
  rules are removed and their transition gets an `always-false` guard first, effects, other
  rules and layout fields are removed, status locks narrow; unknown permission keys stay.
  Every case is a report entry (`kind`, the file's name, `rule`, `outcome`, where).
- **Matching** (`transfer-store.ts`): statuses by name without case, created when missing
  (under the status list lock); groups, roles, priorities, close reasons, ticket types by
  name; people by email; releases and areas by track key and name. Only statuses are created.
- **Routes** (`routes/workflows.ts`, admin token scope): `GET /api/v1/admin/workflows/:id/export
  [?version=N]`, `POST /api/v1/admin/workflows/import` (new workflow, version 1 published;
  `name`, `description`, `trackId`), `POST /api/v1/admin/workflows/:id/import` (next draft).
  Events `workflow.exported` and `workflow.imported` (one per import, with the created status
  ids), both audited. A result that fails `definitionProblem` rolls back whole (the created
  statuses too). `saveDraft` was split: `writeDraft` writes without an event.
- **Web**: "Import a workflow" and a Download link per workflow on `#/admin/workflows`
  (`workflow/WorkflowImport.tsx`: the form and the report); 32 new messages in English and
  Spanish. The file is read with `FileReader` (jsdom has no `Blob.text`).
- **Tests**: `routes/workflow-transfer.test.ts` (two databases: goldens of three fixture files
  byte for byte, `__golden__/workflow-file-*.json`; same-workspace import gives an identical
  draft; import into a bare database with the report golden; byte-identical re-export once the
  target has the named objects; refusals and rollback; events), `workflows/transfer.test.ts`
  (property: never widens a guard; identity changes nothing), contract scenarios for both
  imports (the export is in `EXPORT_EVENTS`), `WorkflowsPage.test.tsx`, stories with axe, and
  two e2e tests in `setup.spec.ts` (download and import on desktop; the page on a phone).
- **Not done**: custom fields and visibility levels are not workflow references yet (levels
  are names already); the Jira-compatible mapping is M1-090 and can reuse `mapDefinition`.

## Side session 2026-10-30: M1-105 static frontend artefact

Built on the branch `claude/nifty-hermann-b572d0` in a side session and merged into main after
M1-115 (the MCP admin link it did not know about now goes through `routeHref`); ADR-066; no
migration; new package `packages/webconfig`. The default routing mode is an open decision in
`docs/plan/decisions.csv`.

- **Artefact:** `pnpm build` writes `apps/web/dist` with `version.json` (name
  `taskmoor-web`, the version from `TASKMOOR_VERSION`, every file with size and SHA-256);
  `tools/build/server.mjs` stamps the same version into `server.mjs`/`cli.mjs`
  (`__TASKMOOR_BUILD_VERSION__`, now the default of `TASKMOOR_VERSION`) and stops when
  `apps/web/dist` holds another version. The web role refuses a folder with no
  `version.json`, another version or no config slot (`apps/server/src/frontend.ts`). The
  Dockerfile's build stage takes `ARG TASKMOOR_VERSION` (after the install layer); the Helm
  chart no longer sets `TASKMOOR_VERSION` from the image tag (it would now refuse to start).
- **No server code:** the Vite plugin `apps/web/build/artefact.ts` fails the build on a module
  of a server-side workspace package, a third-party package only they use (from the
  manifests) or a Node built-in, then writes `version.json` and scans the output. It imports
  `packages/webconfig` and `packages/devtools/src/secrets` **by relative path**: Vite loads
  its config with plain Node, which cannot run workspace TypeScript (bare imports are left
  external), and Storybook loads the same config. The boundary rules exempt `apps/web/build/`.
- **Runtime config:** a JSON block in index.html
  (`<script id="taskmoor-config" type="application/json">`), keys `apiUrl`, `routing`,
  `basePath`, `instanceName` only (`@taskmoor/webconfig`: tolerant `parseRuntimeConfig`,
  strict `fillRuntimeConfig` that also writes `<base href>` for clean URLs). The server fills
  it per request: `TASKMOOR_WEB_ROUTING` (`hash` default, `path`), the base path from
  `PUBLIC_URL`, the instance name from setup.
- **Routing:** pages still use routes written `#/boards/7`; `apps/web/src/routing/router.ts`
  maps them to the address. Use `navigate`, `currentRoute`, `replaceRoute`, `routeHref`
  (links), `routeUrl` (copying) and `useRoute`; never `window.location.hash` or
  `history.replaceState` with a route, which break clean URLs. Token routes (`?token=`) stay
  in the fragment. Server fallback: clean URLs get the shell, hash mode redirects `/x` to `/#/x`.
- **Tests:** `packages/webconfig`, `routing/router.test.ts`, `apps/server/src/frontend.test.ts`,
  the new Vitest project `web-build` (`apps/web/vitest.build.config.ts`: a real build, about
  10 s), and `e2e/routing.spec.ts` on `e2e/web-server.ts` (ports 4176 hash and 4177 clean URLs,
  its own embedded cluster `e2e-web`).
- **Gotcha:** the e2e build is unversioned (`0.0.0-dev`); after it, a `server.mjs` from a
  versioned `pnpm build` refuses `apps/web/dist`. Rebuild both with the same
  `TASKMOOR_VERSION`.
- **Pending (not blocking):** `bash tools/image/smoke.sh` (now checks `/version.json` against
  `/health` and both deep-link behaviours) was not run: no Docker on this Mac.
- **Next:** clean URLs as the single-server default is a product call (the spec's default for
  kits is clean URLs); credentials for a cross-origin `apiUrl` come with M1-107; M1-106 can
  compare `version.json` with the meta endpoint; M1-111 fills the slot and adds the host
  fallbacks (`.htaccess`, `_redirects`, nginx) with `fillRuntimeConfig`.

## Side session 2026-10-30: M1-087 synthetic Data Center backups

Built on the branch `claude/vigilant-ramanujan-625cc8` in a side session; the main session
merges it after its own gate. ADR-072; no migration; one new server dependency (`saxes` 6.0.0,
ISC, already in the lockfile through the spikes).

- **Format notes** `docs/specs/02d-dc-backup-format.md`: the backup ZIP, the entities file, the
  active-objects file and the attachment layout, in our own words. Every statement cites one of
  53 numbered public sources (also in `docs/research/sources.md`) or is marked **Verify** (an
  assumption the generator writes until a design partner's backup confirms it) or **Our
  choice**; `dc-backup.test.ts` fails an unmarked statement. The research ran in subagents
  separate from the code (ADR-003); only facts reached the notes.
- **Code** `apps/server/src/import/dc-backup/` (the format layer, so it uses the format's
  names): `format.ts` (files, roots, every element's attributes and types, the attachment path,
  timestamps, the two agile tables), `world.ts` and `parts.ts` (the synthetic instance: small
  parts built once, every issue and its comments, history, links, labels, time entries and
  attachments recomputed from their own seed streams), `generate.ts` (one pass per element into
  a yazl ZIP, a manifest beside it), `validate.ts` (streams through `clean.ts`, moved from the
  parser spike, and saxes; checks rows, references after the file, issue numbers, sequences,
  attachment paths and sizes, active-objects tables, and the manifest), `cli.ts`
  (`pnpm gen:dc-backup --issues N --seed N --out x.zip`, `--validate x.zip`).
- **Manifest** (`<zip>.manifest.json`, `manifest.ts`): options, both XML files' size and
  SHA-256, attachments, rows per element and table, the importer's cases (deleted and inactive
  people, skipped numbers, sub-tasks, restricted comments, anonymous and custom-field changes,
  sprint states, CDATA splits) and the forbidden characters written on purpose. Golden for
  10,000 issues, seed 1: `__golden__/dc-backup-10k-seed1.manifest.json`; **M1-088 onwards
  compare their imported counts with it**, and every generator change shows there.
- **Tests**: `dc-backup.test.ts` (10,000 issues validate, every element, table, case and
  forbidden kind non-zero, golden manifest; same seed same bytes; CDATA and escaping; every
  forbidden kind counted; attachment path rule; eight kinds of damage the validator must catch;
  the notes' citations), `clean.test.ts` (the cleaner's spike tests), and
  `dc-backup.large.test.ts` with `TASKMOOR_LARGE_DC_BACKUP=1` (1,000,000 issues;
  `TASKMOOR_LARGE_DC_BACKUP_DIR` keeps the ZIP for M1-091, `TASKMOOR_LARGE_DC_BACKUP_REPORT`
  appends the measurements to a file, since Vitest here drops console output).
- **Measured** (2026-10-30, load average 9 to 18 from other sessions): 1,000,000 issues give
  9,490,567 rows, a 343.4 MB ZIP (entities.xml 1,850.9 MB, 100,104 attachment files of 195.7
  MB). It was written in 280.9 s with a peak live heap of 99 MB, while a whole-repo typecheck
  ran beside it (an earlier run without the typecheck took 141 s to write and validate), and
  validated in 48.0 s with 148 MB. 100,000 issues through the CLI: 33.2 MB ZIP, 34.6 s,
  validated in 26.1 s. The 10,000-issue gate test takes about 2 s.
- **For M1-088 onwards**: rows are written in name order (comments and history before their
  issues), so the reader stages and resolves after the file; people are named by user keys
  (a third are lower-case user names, the rest `JIRAUSER<n>`), one in 40 is deleted (named,
  no rows); times have no zone (the generator writes UTC); the sub-task link type is
  `jira_subtask_link` with style `jira_subtask`. Not generated yet (each mapping adds what it
  maps, with the notes and the validator): custom fields and values, versions, components,
  followers and votes, key history, renamed projects, workflows, rank, board columns and sprint
  membership, schemes, other filters, dashboards, avatars, thumbnails.

## Side session 2026-10-30: M1-039 history operators

Built on the branch `claude/m1-039-history-operators-d9010b` in a side session while the main
session did M1-047 and another M1-098; the main session merges it after its own gate.

- **M1-039 WAS and CHANGED** (ADR-010 "History operators (M1-039)"; migration **0056**
  `0056_history_search.ts`, five indexes on `ticket_change`, each partition's under a plain
  name such as `ticket_change_p03_to_idx`). `WAS`, `WAS NOT`, `WAS IN`, `WAS NOT IN` and
  `CHANGED` with `FROM`, `TO`, `BY`, `AFTER`, `BEFORE`, `ON`, `DURING` run on every field the
  change history records, custom fields included, through search, boards, saved searches,
  webhooks and reports alike (all go through `bindPlan`/`compileCond`).
  - `packages/query`: the resolver takes `FROM`/`TO EMPTY` (`HistoryPredicate.empty`), turns
    `ON d` into the day's two instants on the person's calendar, and refuses `FROM`/`TO` with
    `WAS`, a predicate twice, `AFTER`/`BEFORE`/`ON` without exactly one date, `DURING` without
    two or ending first. `updated`, `closed` and `parentTrack` now have `history: null`
    ("keeps no change history"). 15 new conformance cases.
  - `search/bind.ts` `history()`: values become what history stores (ids as text, `String(n)`,
    ISO days and instants, keys; lists by item; text by words); a name no value has now is
    matched by the name it had when written (`*_display`), so renamed statuses, options and
    people match by their old names. `findNamed`, `findPeople`, `findOptions` return the names
    they did not find instead of refusing (the old `named`, `people`, `options` wrap them).
    Stage, hierarchy level, track type and category read their source field's history;
    creator and created are fixed (`held` condition). Refused with a message: sprint (sprint
    changes are in `sprint_change`), EMPTY on links, ticket functions as values, saved searches.
  - `search/model.ts` conditions `history` and `held`; `search/compile.ts` `historyCond` (one
    `EXISTS` per clause; see the ADR for the SQL and which index each form uses).
  - Tests: `search/history.test.ts` (model of history, 15 random worlds by default,
    `SEARCH_HISTORY_RUNS` for more; passed 300; three mutations of the SQL caught),
    `search/history.run.test.ts` (QRY-005 (1), (2), (3) through `/api/v1/search`, every kind of
    field, refusals, every history conformance case on the server), 8 golden statements and 2
    fuzz templates in `compile.test.ts`, history plans in `plans.test.ts`
    (`__golden__/plans-history-pg16.json`; the other plan goldens did not change),
    `search/history.large.test.ts` (`TASKMOOR_LARGE_HISTORY=1`, size from
    `TASKMOOR_LARGE_HISTORY_TICKETS`). `routes/search.run.test.ts` no longer expects WAS to be
    refused.
  - Conformance: history 239 to 254 cases, all passing; parser and resolver 2,409 of 2,423 (the
    14 SLA function cases of M2-013 as before).
  - **Gotcha for migrations:** the migrated test template is keyed by each migration's
    `up.toString()` (`migrationsFingerprint`). A constant outside `up` that a migration reads
    (0056's index list was one) does not change it, so the cached template kept the old
    schema until the list moved inside `up`.
  - **Measured** (`history.large.test.ts`, 200,000 tickets, 1,159,066 history rows, the member's
    filter, p95 of 20, load average 8 to 16 from other sessions, 2026-10-30): first page 1.3 to
    78 ms (slowest `status WAS "In Review" AFTER .. BEFORE ..`), page plus capped count 1.9 to
    264 ms (slowest `assignee WAS EMPTY AFTER ..`, 2.8 s before its stretches became a hashed
    set); a name no value has now 1.9 ms with its index (70 ms reading the field's rows); the
    ticket with 12,000 changes 4.1 ms.
  - **Pending (not blocking):** the done-when "p95 < 800 ms at 10M tickets". This Mac has no
    10M dataset (it stayed on Windows) and the bench loader writes no history; M1-117 (10M
    nightly) should load history (about 9 rows a ticket, as `history.large.test.ts` does) and
    run the same 14 queries.

## M1-098 CSV import and full export (side session, 2026-10-30)

Built in a side session on the branch `claude/m1-098-csv-export-553b10`; ADR-063 (and a
"Changes (M1-098)" section in ADR-048); no migration. References: `docs/export-format.md`,
`docs/csv-import.md`, `deploy/README.md` "Exports and imports".

- **Full export** (`apps/server/src/export/`): `format.ts` (file list in load order, manifest
  schema), `write.ts` (`exportWorkspace`: one keyset-paged query per kind, canonical JSON lines,
  times as UTC text with microseconds from SQL, tickets by hierarchy level from the top, history
  per page of tickets through its primary key; `translate` writes ids back as an import's source
  knew them; `translationOf` builds that from `import_external_id`; `exportSystem` keeps one
  name per instance and workspace in `instance_setting.export_system`), `sinks.ts` (folder, and a
  ZIP streamed with yazl). `GET /api/v1/admin/export[?tracks=KEY,KEY]` (`routes/exports.ts`, site
  administrators, audited as the new event `workspace.exported`) and `node cli.mjs export <dir>`.
- **Import of an export** (`import/taskmoor.ts`, source `taskmoor`, verbatim): a folder or a ZIP
  (unpacked once beside itself as `<zip>.unpacked`) read by byte offsets. New loaders in
  `import/load-config.ts` (roles, priorities, close reasons, link types, releases, areas, fields,
  contexts, options, workflows, workflow maps) and `import/load-files.ts` (attachments); `LOADERS`
  moved to `import/loaders.ts`. Ids inside stored values go through `import/remap.ts` (custom
  values, history values per field, mentions, workflow definitions, formula expressions), the
  same walkers in both directions. `ENTITY_KINDS` grew and history now runs last.
- **CSV import** (`import/csv.ts`, source `csv`): mapping of columns to system fields, custom
  fields by id, labels, releases, areas and the parent (another row's id or key, or a key the
  target has); rows ordered parents first; create or update by key, unmapped fields kept on
  update; `mappingFrom` reuses an earlier run's mapping. Files by path only inside
  `TASKMOOR_IMPORT_DIR` (default `TASKMOOR_DATA/imports`, `off` refuses). Each record's warnings
  are kept (`import_record.error.warnings`) and listed by `GET /api/v1/admin/imports/:id/problems`.
- **Tests**: `export/export.test.ts` (an API-built workspace with every kind round-trips with
  identical per-file SHA-256; dry run writes nothing; a second import changes nothing; the ZIP
  download reads as the folder; audit), `import/csv.test.ts` (reader property test against the
  export's own quoting, dry-run problems per row, hierarchy, people, custom values, re-import
  updates, by-key update keeps unmapped fields, reused mapping, path guard),
  `routes/export-roundtrip.large.test.ts` with `TASKMOOR_LARGE_ROUNDTRIP=1` (100,000 tickets, and
  100,000 CSV rows with a parent column), `tickets/rank.test.ts` (`sequenceValueOf`).
- Measured (2026-10-30, load average 15 to 20 from other sessions' gates): 100,000 tickets
  (395,271 records, 184.4 MB with 100 attachments) export in 8.0 s with no live heap growth,
  import into a newly migrated database in 413.5 s (3,967 batches of 100), export again in
  13.5 s; all 22 files and the attachments identical by SHA-256. 100,000 CSV
  rows with a parent column (children listed before their parents) import in 790.6 s with
  every parent right (IMP-012 (1)).
- Not done / follow-ups: the import wizard and CLI for these sources (M1-097); a ZIP named by
  path is unpacked inside the start request (a very large ZIP should be unpacked by the job);
  set-based loading for faster imports (M1-091); the "Not carried in version 1" list of
  `docs/export-format.md` (access, visibility and notification policies, boards, sprints,
  saved searches, dashboards, local-mode ownership, custom levels, comment versions, key history).

## Side session 2026-10-30: M1-114 the manual

Built on the branch `claude/elegant-feistel-f32e66` in a side session; the main session merges
it after its own gate. ADR-074; no migration; no new packages (devtools now depends on
`micromark` 4.0.3 and four of its GFM extensions, MIT, already in the lockfile through
`@taskmoor/richtext`, and on `@taskmoor/webconfig` for the version stamp).

- **The manual** `docs/manual`: `index.md`, `concepts.md`, `use/` (7 pages for people using the
  app) and `admin/` (22 pages: installing, people and access, configuring work, integrations,
  running a server), ordered by `nav.json`. Written from the code, specs, ADRs and the existing
  developer docs, in our own words; each page's `sources` lists what it was written from.
  Product gaps the writing turned up are listed under "Follow-ups" below.
- **Build** `pnpm run docs [--out <dir>]` (`packages/devtools/src/manual.ts`, `cli/docs.ts`):
  checks, then writes `dist/docs` (one HTML page per Markdown page, the same folders, plus
  `search.html`). Stylesheet and script are inlined (`manual-assets/`) under a CSP that allows
  exactly them by hash, so nothing is fetched; search runs over a JSON index inside
  `search.html`. Works from `file://` and any web server; same bytes for the same input;
  `TASKMOOR_VERSION` stamps the footer.
- **Checks** (`manual-check.ts`, `checkManualProvenance` in `provenance.ts`), all in
  `manual.test.ts` and so in `pnpm verify`: provenance front matter (`title`, `audience`,
  `sources` that exist and are not Atlassian sites, `accessed`, `attestation: own-words`, H1 =
  title); Atlassian terms refused unless the page declares `jira-names: <reason>`
  (`admin/import-export.md` does); one H1, unique anchors, a language on every code block; nav
  lists every page once; links stay inside the manual and their anchors exist; no images.
  External links are listed (golden `__golden__/manual-external-links.json`), never fetched. The
  built bundle is checked as a browser sees it: CSP present, no element loads a resource, no
  request API in the script, every relative link and anchor resolves.
- **Frontend build guard** (`apps/web/build/artefact.ts`): devtools' direct micromark dependency
  made the server-code guard flag micromark, which the app bundles through `@taskmoor/richtext`.
  The guard now counts the browser side's dependencies transitively; only `micromark` and
  `pngjs` changed (now browser code), and the artefact test says so.
- **Writing a page**: copy any page's front matter, add the page to `nav.json`, run `pnpm run docs`.
  CLAUDE.md now says a visible change updates its page in the same task. Bare `pnpm docs` is
  pnpm's own command (it opens a package's home page), so the script runs with `pnpm run docs`.
- **Follow-ups**: the writing turned up product gaps, each stated on its page as "not yet"; the
  full list is in the side-session notes folder (`m1-114-manual-product-gaps.md`). The ones to
  fix before 1.0:
  - the setup form's mail fields are stored but unused, and its hint names `SMTP_PASSWORD`;
  - the Compose files pass only 8 variables from `.env`, so mail, S3, `METRICS_PORT` and
    `OTEL_*` need an override although `.env.example` lists the last two;
  - `deploy/README.md` says Helm runs `cli.mjs upgrade`, but the chart only runs
    `check-upgrade`;
  - `cli.mjs backup` ignores `TASKMOOR_BACKUP_DIR`, and the Helm worker cannot mount a backup
    volume;
  - the workflow effect "Call a webhook" never sends a request;
  - track feature toggles hide nothing;
  - five global permissions are never checked;
  - the saved language is not applied;
  - the UI label "Change screens and layouts" uses the term "screens".
  Also not done: serving the bundle from the image at `/docs` with a Help link in the app;
  images in the manual; Spanish pages.

## Last session: 2026-10-29 (Mac, afternoon)

Back on the Mac after the overnight cloud run: `main` fast-forwarded 106 commits, the gate
green here (one load-only failure, below). The user asked to continue with what is on `main`
and to commit on `main` itself (no branch). Since the afternoon of 2026-10-29 the user allows
merging finished work and pushing to `main` without asking, ticket after ticket, until they say
stop (CI is the gate).

### Done

- **M1-045 sprint and release functions, cycles** (ADR-010 "Functions (M1-045)", ADR-054
  "Auto-rolling cycles"; no migration). Two commits:
  - Query: the `sprint` field over `sprint_ticket` joined to `sprint` (the module refusal is
    gone; deleted sprints never match), `openSprints()` (active), `futureSprints()`,
    `closedSprints()` as a condition on the sprint state (never a list of ids; 60,000 sprints
    tested), `@current`, `@next`, `@previous` (QRY-013: a `{ type: 'token' }` value from the
    resolver; `bindCondition` passes the board, so on a board they are its sprints, in a search
    every board's), `ORDER BY sprint`, and the four release functions in the manual release
    order. `search/sprints.run.test.ts`. Conformance: sprints 7 of 7; the function section's
    14 failures are the SLA functions of M2-013.
  - Cycles (AGL-012): `sprintSettings.cycle` `{ lengthDays, timeZone }`; `rollSprintCycles`
    (`sprints/cycles.ts`) every minute in the worker role (`main.ts`). The create, start and
    complete transactions moved into `sprints/lifecycle.ts` (an actor instead of the request)
    for the routes and the worker; `boardRecord` and `workspaceScope` in `boards/data.ts`.
    `sprints/cycles.test.ts`: Madrid's change of summer time, catch-up, two workers at once.
- **M1-082 LDAP closed**: its last criterion, the OpenLDAP container run, passed in CI
  (`ldap.yml` on `main`, 2026-10-28 and 2026-10-29).
- **M1-067 webhooks** (ADR-055; migration 0053 `webhook`, `webhook_delivery`): a bus subscriber
  (`webhooks/subscriber.ts`, registered in `events/subscribers.ts`) records one delivery per
  webhook and event with the body to send and queues `webhook:deliver`
  (`webhooks/deliver.ts`, registered in `main.ts` with the 30-day trim in housekeeping).
  Only spec 02a 1.3 events go out (`WEBHOOK_EVENTS` in `webhooks/model.ts`); the query runs as
  the owner through `bindCondition`. Formats `json` (HMAC-SHA256 `X-Taskmoor-Signature`),
  `slack`, `teams`, `mattermost`, `matrix` (`webhooks/payload.ts`, goldens in
  `webhooks/__golden__`). Routes `routes/webhooks.ts` (site admins; admin token scope).
  `webhooks/webhooks.test.ts` runs a local receiver; its `pump()` makes retries due at once.
- **M1-059 report event store** (ADR-056; no migration): `reports/events.ts` reads
  `ticket_change` and `sprint_change` as typed report events (`readReportEvents`), folds them to
  a state per ticket (`fold`, `stateAt` for a past moment) and checks the fold against the live
  tickets and open sprint memberships (`replayCheck`; `node cli.mjs report-verify`). M1-060 to
  M1-062 compute their reports from these events only.
- **M1-060 sprint charts** (ADR-057; no migration): `reports/sprint-charts.ts` computes the
  burndown and burnup from the report events (start, steps with their cause, local days on the
  viewer's zone, guideline, end); `GET /sprints/:id/burndown` and `GET /boards/:id/velocity`
  (`routes/sprints.ts`) count only tickets the viewer sees. The web's first charts live in
  `apps/web/src/reports` (`LineChart`, `ColumnChart`, `chart.ts`) with `styles/charts.css` and
  the chart tokens (`--color-chart-1`, `-2`, `-guide`, validated per skin); M1-061, M1-062 and
  the M1-064 widgets reuse them. The sprint report page shows burndown, burnup and velocity. Not
  done: scope-change markers on the line, velocity per team, a sprint selector.
- **M1-061 flow reports** (ADR-058; no migration): `reports/flow.ts` (cumulative flow, cycle
  points over the chosen columns, two centred rolling averages, statistics, bins, time in
  status) on `readStatusChanges` (`reports/events.ts`); routes in `routes/board-reports.ts`
  (`/boards/:id/reports/cumulative-flow`, `/cycle-time`, `/time-in-status`; `from`/`to` or
  `days`, `filters`, and for cycle time `columns`, `average`, `window`, `limit`), registered
  from `routes/boards.ts` for any board the viewer sees. Web: `#/boards/<id>/reports/<report>`
  (`reports/BoardReportsPage.tsx`, linked from every board), `StackedAreaChart` and
  `ScatterChart`, tokens `--color-flow-first` and `--color-flow-last` (an ordinal ramp, mixed
  with `color-mix` in oklab). e2e `board-reports.spec.ts`. 100,000 tickets:
  `board-reports.large.test.ts` with `TASKMOOR_LARGE_REPORTS=1`.
- **M1-062 release, outcome and general reports** (ADR-059; no migration). General reports over
  any query, counted in SQL (`reports/general.ts`, `routes/reports.ts`):
  `GET /api/v1/reports/created-vs-closed` (closings are close-reason events; day, week, month)
  and `/two-dimensional` (system fields and grouping custom fields; several values count under
  each; 50 values then "other"); `compileQuery` in `boards/data.ts` compiles any query for the
  viewer. Release and outcome reports of Scrum boards from report events
  (`reports/scope-burndown.ts`, `routes/scope-reports.ts`, registered with the sprint routes):
  `/boards/:id/reports/release-burndown`, `/outcome-burndown`, `/release-report`. Report
  events follow `targetRelease` now and the replay check compares it. Web: three Scrum tabs on
  the reports page (`reports/ScopeReports.tsx`). Charts: x labels thin by their own width, and
  the charts' and reports' tables scroll inside their own box on phones (ADR-033).
- **M1-064 dashboards, part 1 of 4** (ADR-060; migration 0054 `dashboard`, `dashboard_share`):
  the model and API (`routes/dashboards.ts`: list, create, read, change with a version, copy,
  delete, the administrators' default at `/dashboards/default`), widgets checked per kind
  (`dashboards/model.ts`, sixteen kinds), shares through `sharing/shares.ts`, which saved
  searches now use too. Part 2: each widget's data as the viewer at
  `GET /dashboards/:id/widgets/:widgetId` (`dashboards/widgets.ts`; `visibleBoardRecord` in
  `routes/boards.ts` and `sprintBurndown` in `routes/sprints.ts` are shared with it;
  `averageAge`, `timeToClose`, `oneDimensional` and `parseAxis` in `reports/general.ts`),
  golden-tested in `routes/dashboard-widgets.test.ts` (`__golden__/dashboard-widgets.json`,
  dates as days before today). Part 3, the web: `#/dashboards` (`DashboardsPage`: list, create,
  wallboard of the chosen), `#/dashboards/<id>` (`DashboardPage`: widgets by column, editing in
  place with `WidgetSettings` per kind, who sees it, copy, everyone's home for site
  administrators), `#/dashboards/<id>/wallboard?rotate=&seconds=` without the shell;
  `WidgetView` draws each kind, `reports/DonutChart` the pie with chart tokens 3 to 6; e2e
  `dashboards.spec.ts`. Part 4: track summaries (`routes/track-summary.ts`,
  `GET /api/v1/tracks/:keyOrId/summary`; `tracks/TrackSummaryPage.tsx` at `#/tracks/<KEY>`;
  every number is its query's search count; e2e `track-summary.spec.ts`). `#/tracks` itself is
  still the placeholder the shell tests use. Public dashboards open only signed in on the web for
  now (the API serves anonymous visitors).
- **M1-115 accessibility pass** (ADR-024 "The WCAG 2.1 AA pass"): e2e `a11y.spec.ts` (every page,
  axe WCAG 2.1 AA, 0 serious or critical) and `a11y-keyboard.spec.ts` (keyboard-only journey);
  `styles/contrast.test.ts` (token pairs). A new page belongs in the sweep's list.
- **M1-072 MCP server** (ADR-068; no migration): `apps/server/src/mcp` (protocol, tools over the
  REST API as the caller, settings in `instance_setting` `mcp`, the stdio bridge behind
  `node cli.mjs mcp`), `routes/mcp.ts` (`/api/v1/mcp`, `/api/v1/admin/mcp`), web
  `admin/McpPage.tsx` at `#/admin/mcp`. Tests use the official MCP client (dev dependency).
  Left in progress only for OAuth 2.1, which needs M1-107.
- **M1-065 REST API v1** (ADR-067; no migration): the contract is `apps/server/src/api/operations.ts`
  (stable operations over the routes' exported zod schemas) and `schemas.ts` (responses);
  `openapi.ts` builds `docs/api/openapi.json` (committed; `pnpm verify --update` rewrites it, the
  reference page and the SDK's generated files); `diff.ts` fails the build on a breaking change
  against `docs/api/baseline/openapi-v1.json` (re-baseline only with a new major version);
  `contract.test.ts` calls every stable operation and validates its answer. SDK:
  `packages/sdk` (`@taskmoor/sdk`). Adding a stable operation: export its route's schemas, add
  it to `OPERATIONS` with its response schema, call it in `contract.test.ts`, run
  `pnpm verify --update`. Biome skips `docs/api/**/*.json` and `packages/sdk/src/generated`.
- **M1-049 list and calendar views** (ADR-065; no migration): `routes/list-views.ts`
  (`POST /search/format-rules`, `GET /tracks/:keyOrId/calendar`), `tracks/lookup.ts`
  (shared track lookup); web `apps/web/src/list` (`ListPage`, groups from the
  two-dimensional report with `y=track`; rules and columns in localStorage) and
  `apps/web/src/calendar` (`CalendarPage`), `styles/views.css`; `ResultTable` takes a
  `format` callback. e2e `list-calendar.spec.ts`.
- **M1-048 timeline** (ADR-064; no migration): `routes/timeline.ts` (one read with
  recursive roll-ups over the whole track), `apps/web/src/timeline` (`TimelinePage` at
  `#/tracks/<KEY>/timeline`, `styles/timeline.css`); rescheduling is the ticket PATCH.
  Tests: `routes/timeline.test.ts`, `timeline.large.test.ts` (`TASKMOOR_LARGE_TIMELINE=1`),
  `TimelinePage.test.tsx`, the `TwoThousandTickets` story (render budget), e2e
  `timeline.spec.ts`.
- **M1-121 contract step for M1-001** (ADR-022 "Contract step for M1-001"): migration
  `0055_contract_m0_session` drops the M0 `session` table and the `app_user.workspace_id`
  default. The user chose to land it before the first release (none is published). M1-039's
  history indexes, first written as a 0055, are `0056_history_search` (renumbered on its branch).
- **M1-054 track templates** (ADR-062; no migration): `tracks/templates.ts` recipes;
  `POST /api/v1/tracks` takes `template` (then makes the board through
  `BoardRoutes.createBoard`, which `registerBoardRoutes` now returns; the track routes get it
  through `TrackRouteHooks`, filled in `buildApp` after the boards register) and `copyFrom`
  (shared sources only, sets by reference). Web: "Start from" in the tracks admin page's add
  form. Tests: `routes/track-templates.test.ts`, `ConfigurationPages.test.tsx`, e2e
  `track-templates.spec.ts`.
- **M1-050 releases hub** (ADR-061; no migration): `routes/release-hub.ts` serves
  `GET /releases/:id/overview` (stage counts and warnings as search-runner counts with their
  queries, approvers, the viewer's rights) and `GET /releases/:id/notes` (closed tickets by
  type; done is the first close reason or none; Markdown, `?format=markdown` as a file;
  golden `__golden__/release-notes.json`, shipped on a fixed day so it never changes).
  `GET /tracks/:id/releases` now says `mayManage`. Web: `apps/web/src/releases`
  (`ReleasesPage` at `#/tracks/<KEY>/releases`, `ReleasePage` at `#/releases/<id>`,
  `ReleaseState`, `styles/releases.css`); the track summary links the hub. e2e
  `releases.spec.ts`.
- **M1-047 backlog planning** (ADR-054 "Planning on the backlog"; no migration):
  `routes/backlog-planning.ts` serves the panels (`GET /boards/:id/backlog/panels`) and three
  batches (`POST /boards/:id/backlog/rank`, `/parent`, `/release`) that run the ticket routes
  as the person, one ticket at a time, through `callRoute` (registered in `routes/boards.ts`
  with `sprintRoutes.board`). The backlog route adds `parentId`, `releaseIds` and the board's
  `track`. Web: `sprints/BacklogPage.tsx` (selection, drag to a section place or a panel item,
  the selection's menus, Alt+arrows, filter, inline create) and `sprints/PlanningPanels.tsx`.
  Tests: `routes/backlog-planning.test.ts`, `BacklogPage.test.tsx`, stories, e2e
  `backlog-planning.spec.ts` (desktop drags; mobile menus and keyboard); 10k ranking stability
  in `routes/backlog-planning.large.test.ts` (`TASKMOOR_LARGE_BACKLOG=1`; longest key 14,
  block move p95 74 ms).
- **M1-046 board drag and drop** (ADR-049 "Drag and drop"): `boards/BoardPage.tsx` cards are
  draggable, cells take drops (place by the pointer's half of a card), one move request with
  `before`/`after`; cards grouped by cell once per render. `FiveThousandCards` story times the
  render (455 to 458 ms, budget 1 s; axe off there only). e2e `board-drag.spec.ts` (desktop;
  phones use the Move menu): Start runs, Close's close-reason check refuses, ranking by drop.
- **Sprint settings in the web UI** (follow-up of M1-044 and M1-045; built in a side session on
  the branch `claude/sharp-agnesi-5b4a10`; no server change). A Sprints section in the board
  settings page of a Scrum board (`sprints/SprintSettingsSection.tsx`), shown only in the
  editable page (`board.mayConfigure`, the server's rule): estimation statistic with a picker
  of the number fields `GET /fields` shows the person (`boardClient.numberFields`; a saved field
  they cannot see stays, named by its id), time tracking, parallel sprints, and the cycle (off,
  or 1 to 91 days on a time zone from `account/options.ts`, the person's zone or UTC to begin
  with). It saves with the rest of the board (`PATCH /boards/:id`, `sprintSettings` only while
  the board is Scrum). `not_a_number_field`, `not_with_parallel_sprints` and
  `unknown_time_zone` (and a bad length) show next to their field. The board fake refuses the
  same (`fixtures.ts`, `unknownTimeZones`). e2e `sprint-settings.spec.ts`. Node's ICU lists
  old zone names (`Europe/Kiev`, `Asia/Calcutta`): tests pick zones every list has.
- **NTF-008 co-editing e2e fixed on macOS** (`apps/web/e2e/richtext.spec.ts`, test only): it
  failed on every Mac run since it was written ("The login fails.Since Monday:  Only on
  Safari."). The test pressed `ControlOrMeta+Home` and `+End`; Chromium on macOS only scrolls on
  Home and End (Playwright's macOS key map gives `Meta+Home` no editing command), so the first
  person's caret stayed at the end. `DOC_START` and `DOC_END` are now `Meta+ArrowUp` and
  `Meta+ArrowDown` on darwin, `Control+Home` and `Control+End` elsewhere (CI unchanged). The
  editor was right. The spec passed 20 of 20 on both projects (`--repeat-each=5`).

### Next (in order)

1. The overnight list below without M1-045: M1-040 full-text search and M1-039 history
   operators (both measured at 10M tickets: this Mac has 33 GB free, the 137 GB dataset stayed
   on Windows, so their timing criteria need another machine or CI), M1-098 CSV, M1-105,
   M1-115, M1-116; RPT-002 (3) (general reports on 1M tickets in 3 s)
   is still to measure.
2. Sprint editing in the web UI (name, goal and dates; API only since M1-044) and the rest of
   M1-044's "Left" list below. Sprint settings are in the web UI now (above). Webhooks have no
   web page yet (API only).
3. M1-073 and M1-074 still wait for a live test key in the environment (`TASKMOOR_AI_TEST_KEY`);
   M1-100 for the release signing key.

### Notes from the Mac

- **Docker on this Mac is Colima** (free, command line). `colima start` brings it up with the
  settings it was created with; `colima stop` frees its 8 GB of memory, and `colima status`
  says whether it runs. The image, kit, drill and Helm scripts under `tools/` need it running.
  Run them from a clean worktree (`git worktree add --detach <dir> origin/main`), because they
  build from the working tree.
- **GitHub Actions did not run** for the pushes of M1-059 and M1-060 (2026-10-29 evening): every
  job ended in seconds with "The job was not started because recent account payments have
  failed or your spending limit needs to be increased". Only the account owner can fix that
  (Billing & plans). Until then the local `pnpm verify --e2e` is the only gate: run it whole
  before every push. The Postgres 18, Windows, image and Helm jobs have no local equivalent.
- The query editor placed the caret after an accepted suggestion in a `setTimeout`; keys typed
  straight after the Tab could land first and the caret jumped back, so `search.spec.ts` failed
  about one run in eight ("ATT" not offered after `track = `). It is placed in a layout effect
  now (`SearchPage.tsx`, `caretAfter`).
- `BulkOperationPage.test.tsx` read the failed tickets as soon as their region showed, before
  their own request answered, and failed under load; it waits for the items now.
- Watch list: `routes/fields.test.ts` "[CORE-009] renames, reorders and disables options"
  got 409 `in_use` deleting a field once in a full gate (load about 30) and passes alone. Its
  ticket change before the delete was not checked; it is now, so a repeat names the cause.
- Watch list: `e2e/setup.spec.ts` "[NTF-008] a ticket opens from the local copy" failed its last
  step (a change reaching the local copy through the socket within 1.5 s) in two gates at load 10
  to 20 on 2026-10-29, and passes in a quiet run.

- `apps/server/src/routes/search.run.test.ts` "[QRY-010] stops a query over the timeout" timed
  out at 60 s in a full gate here (load average 16 to 19: its 20,000-row insert waits); it
  passes alone in 5 s. Add it to the watch list below.
- `apps/server/src/sync/log.test.ts` "[NTF-008] numbers rows in commit order and trims the log"
  failed once in a full gate at load 15 and passes alone; also for the watch list.
- e2e outside CI reuses whatever already listens on 4173 to 4175, 8787, 8788, 8791 and 8792
  (`reuseExistingServer`). With two sessions running e2e at once, one gets the other's servers
  and their per-run passwords, and every sign-in answers 401. Check the ports first, or run
  with `CI=1 ... --retries=0` so Playwright refuses busy ports instead.
- Once, in `richtext.spec.ts --repeat-each=3` (about a dozen ATT creates at once, load ~10),
  `POST /api/v1/tickets` answered 500 twice; it did not come back in the 36 tests run after it. The e2e API
  server has no logger, so the cause was not recorded. Likely the same as the next note; if it
  returns at low load, give `e2e/api-server.ts` a logger and look at concurrent creates in one
  track.
- At load averages of 100 to 185 (macOS system daemons, not the tests), the embedded Postgres
  fails file opens with `could not open file "base/...": Interrupted system call` (500 with
  code `XX000` through the API) and vitest cannot start workers: a full gate had 31 failures,
  all of them these or timeouts. Wait for `uptime` to come down before believing a red gate.

## Earlier: 2026-10-29 (cloud container, overnight)

### Resume here (overnight run, 2026-10-29, 01:13 to 08:00 the user's time)

The user asked for as much as possible until 8 am (14:00 UTC) and approved merging to main at
will ("i allow you to merge into main all you want"). Main moves by fast-forward once CI is
green on the branch head (`git push origin <sha>:main`); the CI workflow cancels an older run
on the same branch when a new one starts, so dispatch once per head. The branch is
`claude/api-key-upload-prevention-9ucz4x`. If `origin/main` is behind the branch when you
start, the last CI run on the branch head failed or did not finish: look at Actions first.

Done tonight, newest first (details under Done): M1-044 sprints, M1-063 saved searches,
M1-042 search results, M1-038 query functions, M1-043 boards, M1-055 guardrails, M1-041 query editor, M1-052 home, create dialog
and palette, M1-086 importer, M1-058 inbox, M1-037 SQL compiler, M1-053 admin UI, M1-051
ticket view, Windows CI fixes. M1-037, M1-058, M1-086, M1-043, M1-038, M1-042, M1-063 and
M1-044 were built by background agents in worktrees and merged here; their worktrees are removed, the local
`work/*` branches stay.

Also fixed tonight:
- A query leak (M1-037): a hidden ticket named by key or id in `key`, `parent` or `ticketLink`
  confirmed it existed and showed what hangs off it; it now reads like an unknown key.
- The top bar overflowed a 360px phone with CI's fonts: New ticket is a plus on phones.
- Stray "terminating connection due to administrator command" errors failed some gates. The
  verify summary now names the test file of an unhandled error (`tools/verify/reporter.mjs`),
  which traced them to the Graphile Worker spike test; its teardown now waits for the pool.
- CI limits: the Postgres 16 job (lint, types, tests, e2e) passed 20 minutes and was cancelled;
  it now has 30, the Postgres 18 job 20. The 1 ms query-timeout test reads 20,000 tickets so
  that Windows' coarse timers still stop it.

Numbering: migrations 0043 search indexes, 0044 inbox, 0045 imports, 0046 ticket visits, 0047
boards, 0050 guardrails, 0051 saved searches, 0052 sprints (0048 and 0049 unused). ADRs 046
(home, create dialog, palette), 047 (inbox), 048 (importer), 049 (boards), 050 unused, 051
(guardrails), 052 (search results), 053 (saved searches), 054 (sprints).
A long-lived database that
ran a later number before an earlier one refuses the earlier (Kysely): recreate it.

Watch, under load only (they pass alone and in CI): the 1,500-field edit p95
(`fields/storage.test.ts`, 50 ms), the authorizer p95 (`authz/authorizer.test.ts`, 10 ms),
`routes/identity.test.ts` "limits one address to 50 failures" (20 s timeout) and the NTF-008
ticket-open timing e2e. With two agents and a gate running, the load average here was 10 to 25.

Left in the container (lost with it): `/home/user/wt-compiler` (an older M1-037 draft), the
11 GB `m1037_bench_1m` database on the system Postgres (migrated only to 0043), and the M1-044
agent's worktree under `.claude/worktrees/` (locked by the agent tool; its branch is merged).

### Done (newest first)

- **M1-044 sprints** (built by a background agent on `work/m1-044-sprints`; migration 0052;
  ADR-054). Server: `routes/sprints.ts` (registered from `registerBoardRoutes`, which hands it
  the board lookup and the manage right), `sprints/model.ts` (settings and bodies). Board PATCH
  takes `sprintSettings`; `GET /boards/:id/data?sprints=active` shows the active sprints only.
  Web: `sprints/BacklogPage.tsx`, `sprints/SprintReportPage.tsx`, `sprints/client.ts`; routes
  `#/boards/<id>/backlog` and `#/boards/<id>/sprints/<id>/report`; Scrum boards ask for the
  active sprints and link the backlog. e2e `sprints.spec.ts`.
  - Membership is `sprint_ticket` (`open` while future or active, one open sprint per ticket);
    closed sprints keep their rows, so M1-045 can add `sprint = <id>` and `openSprints()` over it.
    Every change is a `sprint_change` row with time, author, `after_start` and the estimates
    then; the report is computed from those rows by the board's current statistic.
  - Done is the rightmost column. Completing: tickets the board's query no longer shows go to
    the backlog (the shared-sprint rule); a deleted closed sprint keeps its rows (`deleted_at`).
  - Left: reopen, wiki link, the subticket completion block (spec says verify), sprint settings
    and sprint editing in the web UI (API only), velocity per team.
  - Measured (`sprints.large.test.ts`, `TASKMOOR_LARGE_SPRINTS=1`, 20,000 tickets): backlog
    p95 55-59 ms, report of 1,000 tickets p95 57-60 ms, completing 1,000 162-230 ms.

- **M1-063 saved searches** (built by a background agent on `work/m1-063-saved-searches`;
  migration 0051; ADR-053). Server: `routes/saved-searches.ts` (`/api/v1/saved-searches` CRUD,
  `/:id/star`, `/:id/subscriptions`), `search/saved.ts` (who sees a saved search, as one SQL
  predicate; `expandSavedSearches`), `search/schedule.ts` (cron and daily/weekly/monthly on a
  time zone's wall clock), `search/subscriptions.ts` (the mailer, every minute in `main.ts` when
  SMTP is set). Boards take `source: {savedSearchId}` (ADR-049's reserved column is wired).
  Web: `search/SavedSearchBar.tsx` and `search/savedClient.ts` on the search page;
  `#/search?savedSearch=<id>` opens one with its columns; e2e `saved-searches.spec.ts`.
  - References (`savedSearch`/`filter` `=`, `!=`, `IN`, `NOT IN`) are expanded AST to AST before
    `resolveQuery` in `prepareSearch` and in the boards' `bindCondition`, as the runner sees
    saved searches; the resolver, binder and compiler are unchanged. A hidden saved search reads
    exactly like a missing one (same message, same shape). Cycle and depth (10) refusals are
    QueryErrors at the reference.
  - A shared query that names a track the runner cannot browse fails for them as "Unknown
    track" (as typing it would). Tests that share across tracks use `summary ~ ...`.
  - Reply objects are thenables: never `return reply...send()` out of an async helper whose
    result is awaited (the awaited value is undefined). `refuseQuery` returns a boolean.
  - Not yet: share with people, groups or tracks from the web (API only), system saved
    searches, an admin list of every shared saved search, subscription import (QRY-012 (3)),
    HTML through the notification templates, the board settings page showing
    `source.savedSearchId` errors on the query field.

- **M1-042 search results** (built by a background agent on `work/m1-042-results`; no
  migration; ADR-052). Server: `GET /api/v1/search/export?q=&format=csv|json&columns=`
  (`routes/search-export.ts`, registered in `app.ts`) streams every match through
  `prepareSearch` and `compiled.page` by keyset (500 per page, each page read again under the
  permission filter by `searchViews`, now exported from `routes/search.ts` with `projection`
  and `project`; the compiler is untouched). CSV uses the audit export's `csvField` (RFC 4180,
  formula guard); JSON is an array of tickets as search shows them. 100,000 tickets: CSV
  5.4 to 8.7 s, JSON 5.0 to 14.8 s over three runs under load, live heap growth about 2 MB
  (`search-export.large.test.ts`, `TASKMOOR_LARGE_EXPORT=1`). Web: `search/ResultTable.tsx` (table in a focusable scroll
  region, cells edited in place through `PATCH /api/v1/tickets/:id` with `version`),
  `search/ColumnPicker.tsx`, `search/columns.ts` (column ids, localStorage per person, cell
  editors and PATCH bodies), `styles/search.css`, export links; e2e
  `apps/web/e2e/search-results.spec.ts`; `search.spec.ts` now finds result links by key.
  - The export prepares the query with `...searchPerson(request)` as the search route does
    (M1-038: time zone, session, allowed tracks), so functions read the same in both.
  - Not yet: export as a background job (500,000 rows, QRY-015 (1)), Excel, Word and XML,
    all-fields export, the CSV importer round trip (QRY-015 (2)), server-side column sets
    (with saved searches, M1-063), column widths, a people picker for the assignee cell,
    editing select, user and other reference custom fields in place.
  - The agent found that basic mode wrote a track key that is a word of the grammar (`ON`,
    `IN`, `OR`, `EMPTY`, ...) bare, so `track = ON` did not parse back; fixed after the merge
    (`valueWord` in `search/basic.ts`, also used by suggestions for track keys and custom field
    names such as `Order`).

- **M1-038 query functions, batch 1** (built on `work/m1-038-functions`; no migration; ADR-010
  "Functions (M1-038)"). `packages/query`: `functions.ts` (the signature of every function of
  spec 01b 1.6), `dates.ts` (wall-clock arithmetic in a time zone), the resolver checks calls
  (refusals name the argument), evaluates `currentUser()` and the date functions, and leaves
  the rest as `{ type: 'call', fn, args }`; dialect `nativeFunctionName`, `PERMISSION_NAMES`.
  Server: `search/bind.ts` turns calls into ids (people, tracks, areas, types, options) or ticket
  sets (`TicketSet` in `model.ts`, compiled as semi-joins in `compile.ts`); `search/run.ts`
  reads sign-in times for `currentLogin()`/`lastLogin()`; routes pass the person's time zone,
  session and `allowedTracks` (`searchPerson()` in `routes/search.ts`).
  - **Behaviour changes:** dates in queries are read in the person's time zone
    (`app_user.time_zone`, UTC when unset); weeks now start on Sunday (spec 1.4; they started
    on Monday); `startOfMonth(-1M)` and the like move on the calendar (they moved by a fixed
    number of milliseconds); `now()` takes an increment; a function returning several values
    with `=` is refused (`use IN or NOT IN`).
  - **`Typed` has a `call` variant** without `value`: code that reads `Typed.value` must handle
    it (the binder's `content()` refuses a call where none can stand; the spike compiler
    refuses them).
  - **Never widen:** new ticket functions must be ticket sets inside the statement (or check
    their ticket arguments against `BindContext.filter`, as `linkedTickets()` does); comments
    only through `commentReadableSql`. `search/functions.test.ts` is the property test to
    extend.
  - Conformance: functions 96% (the seven SLA functions need an SLA field, M2-013), all 99%.
  - Not built: teams in `membersOf("id:...")`, `cascadeOption(parent, none)`, ticket functions
    on `ticketLink`, a site setting for the first day of the week, sprint and release functions
    (M1-045), functions in history predicates (M1-039).
  - Fixed at the merge: `parent = KEY`, `ticketLink = KEY` and `key = KEY` (M1-037) did not
    check that the named ticket is one the person sees, so a known key could confirm that a
    hidden ticket exists (no "No ticket" warning) and show the visible tickets hanging off or
    linking to it. `keys()` in `search/bind.ts` now keeps only tickets the viewer sees, keys and
    ids alike, and warns for a hidden key exactly as for an unknown one
    (`routes/search.visibility.test.ts`).

- **M1-043 boards** (built by a background agent on `work/m1-043-boards`; migration 0047;
  ADR-049). Server: `apps/server/src/boards/model.ts` (zod schemas of columns, swimlanes, board
  filters and card rules, defaults, `withIds`, `wipState`, `enteredColumn`), `boards/data.ts`
  (the board's conditions compiled with `compileCond` from the viewer's catalogue of the whole
  workspace and the viewer's ticket filter; counts per status, cards in rank order with lane and
  colour `CASE`s, card details by a slim statement or the ticket view), `routes/boards.ts`
  (`/api/v1/boards` CRUD, `/boards/:id/data?filters=`, `/boards/:id/moves`); events
  `board.created`, `.updated`, `.deleted` (audited); moves emit the ticket routes' own events.
  Web: `apps/web/src/boards/` (`BoardsPage` at `#/boards`, `BoardPage` at `#/boards/<id>`,
  `BoardSettingsPage` at `#/boards/<id>/settings`, client, fake client, stories, tests),
  `styles/boards.css`; e2e `apps/web/e2e/boards.spec.ts`. Shell tests and the mobile drawer
  e2e now use Dashboards as their page without a session (Boards needs one).
  - **Saved searches (M1-063)** add `board.saved_search_id` beside `filter_query` with a check
    that exactly one is set, and `source: {savedSearchId}` in the API (ADR-049).
  - **A move runs the ticket route handlers** (`ticketRoutes()`, as bulk jobs do): the list of
    transitions, then the transition, then the rank. Two writes: a refused rank answers with
    `transitioned: true`. Board queries ignore ORDER BY; cards order by `ticket.rank`.
  - **Board queries resolve against every track and field of the workspace** (`boardScope`),
    so viewers see the part of a multi-track board they may; saving checks them against the
    editor's own catalogue (`editorScope`). The ticket filter alone decides what is shown.
  - Measured (`routes/boards.large.test.ts`, `TASKMOOR_LARGE_BOARD=1`): 5,000 cards of a
    50,000-ticket board p95 about 0.3 s, all 50,000 cards about 2 s, on the loaded machine.
  - Not built: board admins and location in the settings page (API only; the list page creates
    a board kept by its maker), swimlanes by subtickets and by tracks, card covers and development icons, the Kanban
    backlog column, estimation and sprints (M1-044), drag and drop, virtualised rendering and
    the 5,000-card render budget (M1-046), the workflow lint for statuses unmapped on boards
    (`apps/web/src/workflow/lint.ts` mentions it).
  - The agent found M1-052's Home failing in tests that sign in with a stub backend
    (`HomeList` read `tickets.length` of a missing answer; the heading read "Hello, <name>").
    Both were fixed on the branch before the merge: a list without tickets shows as empty, the
    heading is "Home" with the greeting under it.

- **M1-055 guardrails** (migration 0050; ADR-051). `apps/server/src/guardrails/model.ts`: the
  ten guardrails of spec 01a section 1.7 with their defaults, `guardrailLimits` (a workspace's
  own rows in `guardrail_limit`, the default otherwise), `enforceLimit` (throws
  `GuardrailExceeded` inside the route's transaction), `fieldsPerTrackWith`, `guardrailUsage`.
  `app.ts` turns `GuardrailExceeded` into 409 `{error:'guardrail_exceeded', guardrail, limit}`
  and rethrows anything else. Enforced in releases (create, restore), areas, priorities (set
  members), ticket types (type sets), workflow maps, workflows (create and drafts), visibility
  (levels; `LEVELS_PER_POLICY` stays as a request cap of 1,000), access grants (with a lock on
  the policy row) and fields (scopes and options). `routes/guardrails.ts`: `GET/PUT
  /api/v1/admin/guardrails` (site administrators, admin token scope, `guardrail.changed`,
  audited). Web `apps/web/src/guardrails/` (`#/admin/guardrails`: a meter per limit, above-limit
  marks, a raise shows performance guidance). The old `too_many_options` and `too_many_levels`
  refusals are gone; a client that matched on them now sees `guardrail_exceeded`.
  - Migration order on the branch: 0047 (boards) was merged after 0050 had been written, so the
    files sort 0043 to 0047, then 0050. No database outside this container ran 0050 before
    0047; one that did refuses 0047 (Kysely): recreate it. 0048 and 0049 are free (0049 was
    held for M1-038, which needed none).

- **M1-041 query editor** (no migration; ADR-010 "Query editor (M1-041)"). `apps/web/src/search/`:
  `basic.ts` (`basicToQuery`, `queryToBasic`, the basic subset: tracks, stages, assigned to me or
  nobody, words; a property test checks the round trip), `suggest.ts` (`suggest(text, caret,
  {customFields, tracks})`: fields, common ones first, operators, values, connectives, ORDER BY),
  `SearchPage.tsx` (`#/search?q=`, basic and advanced forms, the editor as a combobox with a
  listbox of suggestions, the server's check under the editor with its column, results a page
  at a time), `client.ts`, `fixtures.ts`. The web app depends on `@taskmoor/query` for parsing.
  e2e `search.spec.ts` (desktop and mobile, axe).

- **M1-052 home, create dialog and palette** (migration 0046; ADR-046).
  - Palette: `shell/paletteCommands.tsx` is a registry in two contexts (a stable setter, the
    commands) so a page registers its commands without re-rendering in a loop;
    `usePaletteCommands(id, commands)`. `Command.values` fills label placeholders. Ranking: label
    prefix, then label contains, then keyword. The query clears when the palette closes.
  - Ticket view registers every action (each transition, assign to me, unassign, follow, vote,
    comment, edit summary, activity tabs, copy link, shortcuts); `followSeq` and `voteSeq` refs
    keep an older refresh from overwriting a newer follow or vote; a transition form submits only
    once its options are in.
  - `tickets/CreateTicketDialog.tsx` (New ticket in the top bar, a plus on phones; C outside
    fields; the palette) wraps `CreateTicketPage` (`variant`, `template`/`templateOf` to start
    from a ticket). Layouts per ticket type come from the track's layout set.
  - Home `#/home` (`home/HomePage.tsx`): assigned (search), opened lately (`GET /me/recent-tickets`,
    `PUT /me/recent-tickets/:id` from the ticket view, the latest 50 kept in `ticket_visit`), and
    followed (`GET /me/followed-tickets`), all read through the search filter.
  - e2e: `ticket.spec.ts` (30+ palette actions from the keyboard alone), `create.spec.ts`
    (a layout per type; the home lists).

- **M1-086 importer framework** (migration 0045; ADR-048; built on `work/m1-086-importer`).
  `apps/server/src/import/`: `model.ts` (entity kinds in dependency order, `ImportSource`,
  `Mapper`, the commands), `load.ts` (a loader per kind: plan with reads only, apply with SQL in
  the batch's transaction, read back for samples), `run.ts` (batches: lock the run, extract a
  page after the checkpoint, map, load each record in a savepoint, write `import_record`,
  `import_external_id`, tallies and the checkpoint, commit), `report.ts` (zod schema of the
  fidelity report, JSON Schema golden in `import/__golden__`, HTML), `jobs.ts` (`import.run`,
  50 s parts, ten attempts, registered in the worker in `main.ts`; `IMPORT_FORMATS`),
  `synthetic.ts` (our own NDJSON format, its mapper and a seeded fixture generator). Routes in
  `routes/imports.ts` under `/api/v1/admin/imports` (start from an upload or a generated
  source, dry run, list, progress, report JSON or HTML, cancel), site administrators only;
  events `import_run.created`, `.cancelled` and `.finished` (job, no actor), all audited.
  - **Next importers (M1-087 onwards)** add an `ImportSource` and a `Mapper` and register in
    `IMPORT_FORMATS`; new kinds (custom fields, attachments, followers, votes, key aliases,
    releases, areas, boards) add a command, a loader and a place in `ENTITY_KINDS`. Loaders
    write record by record inside a batch: make the ticket loader set-based before the
    1M-ticket run of M1-091. Not built: delta runs (`updated >= last run`), pause and resume
    and downloadable logs (IMP-013), adding imported statuses and types to workflows and type
    sets (the report warns `status_not_in_workflow`, `type_not_offered`).
  - **New write rules must reach the loaders too** (history, formulas, counters, side tables),
    as they reach the routes: imports write SQL, not through the routes (ADR-048 says why).
  - Fixed on the way: the upgrade harness now runs each seed right after its own migration
    (with 0045 after it, `from 0042` ran the 0024 seed against a schema without
    `track.workflow_id`), and the 0042 seed named the renamed track `SEEDOLD` (now `SEEDNEW`).

- **M1-058 inbox, mentions and activity streams** (built by a background agent on
  `work/m1-058-inbox`; migration 0044; ADR-047). Server: `notifications/mentions.ts` (mention
  ids in documents: `"42"` a person, `"group:7"` a team), `notifications/warnings.ts`
  (`mentionWarnings` on ticket and comment answers), the subscriber writes `mentioned`
  notifications (exactly once per change and channel, superseding the policy's for that
  person, never the writer, only to those who may see the ticket and read the comment) and
  bumps `inbox_state`; `routes/inbox.ts` (`/api/v1/inbox`, `/inbox/count`, `PATCH /inbox/:id`,
  `POST /inbox/read`), `routes/activity.ts` (`/tickets/:id/activity`, `/tracks/:id/activity`);
  the sync socket also pushes `{type: "inbox", version}`. Web: `apps/web/src/inbox/`
  (`InboxPage` at `#/inbox`, nav entry after Home), `styles/inbox.css`; the comments panel shows
  mention warnings. e2e `apps/web/e2e/inbox.spec.ts`; the e2e API server now runs the worker's
  event loop (audit and notifications) on the attachments database.
  - **Event payloads:** `ticket.created`, `comment.created`, `comment.updated` and
    `ticket.transitioned` take an optional `mentions {users, groups}`; `ticket.updated` keeps
    carrying both documents of a rich text change (the subscriber diffs them). **New write
    paths that create rich text must do one or the other**, or their mentions notify nobody.
  - **Inbox reads judge every item again** (ticket list predicate, comment rule) in the
    statement; any new inbox-like reader must too. Reading in the inbox marks the email twin
    read; the mailer now drops notifications already read.
  - The worker's idle wait is 200 ms (was 500), and the notification subscriber now runs before
    the audit subscriber, so an event reaches an open inbox within a second: 239 to 348 ms on a
    quiet machine, 840 to 850 ms during the full e2e run on this loaded machine. At size
    (`routes/inbox.large.test.ts`, `TASKMOOR_LARGE_INBOX=1`): 50,000 items read in 15 to 25 ms
    p95; a track's activity costs one probe per ticket (120 ms at 2,000 tickets).
  - `mentioned` is a product event (`PRODUCT_EVENTS`): preferences accept it, policies do not;
    `GET /notification-events` lists it as `productEvents`. The Account page's event table does
    not offer it yet.
  - Upgrade fixtures: the 0024 seed no longer writes `track.workflow_id` on a database past 0042
    and the 0042 seed uses the renamed local track `SEEDNEW` (both broke once 0042 stopped
    being the newest migration).
  - Not built: an unread badge in the navigation, mentions in custom rich text (paragraph)
    fields, approvals on the Priority tab (M2), reading a very large track's activity by track
    (see ADR-047).

- **M1-037 SQL compiler** (branch `work/m1-037-sql-compiler-2`; migration 0043; ADR-010
  "Implementation (M1-037)", ADR-043 "Selection by query"). Built from the uncommitted draft in
  `/home/user/wt-compiler` (left untouched there), ported onto M1-028 and finished.
  `apps/server/src/search/`: `bind.ts` (names to ids, NOT pushed down, refusals),
  `compile.ts` (pure; SQL is the golden `search/__golden__/compile.json`), `run.ts` (read-only
  transaction under `TASKMOOR_QUERY_TIMEOUT_MS`, keyset cursors, capped counts, explain,
  `collectIds`), `bench/` (`pnpm bench:search`, the 50-query perf set). Routes:
  `GET`/`POST /api/v1/search`, `GET /api/v1/admin/search/explain`; `POST
  /api/v1/bulk-operations` takes `query` instead of `tickets`.
  - **Every statement carries `ticketFilter()`**, value branches and side-table walks
    included; `search/authz.test.ts` property-tests the results against `ticketPermissions`.
    **Comments** are searched only through `commentReadableSql` (`comment ~`, `text ~`).
  - **Value branches:** an order whose first key is priority, status, type, level, close
    reason or track key becomes a `UNION ALL` per value, each walking an index. New indexes
    for that and for search in 0043 (`ticket_priority_created_idx` replaces
    `ticket_priority_idx`; word GIN indexes on summary, description, environment, comments).
  - **Measured at 1M only** (the draft's `m1037_bench_1m` database on the system Postgres,
    11 GB, migrated to 0043 by hand: 0030 applied out of order, the draft's 0035 removed):
    all 50 queries under 300 ms, slowest statement p95 116 ms. 10M needs about 110 GB; the
    risky queries at 10M are two-word summary searches, custom text fields and capped counts
    (ADR-010). `docs/spikes/search-1m.md`.
  - **Upgrade seeds fixed:** with 0043 the upgrade test starts at 0042 for the first time;
    the 0024 seed wrote the dropped `track.workflow_id` and the 0042 seed used the renamed
    `SEEDOLD` track. Both now work from any start.
  - Not done: approximate counts and full text (M1-040), history operators (M1-039),
    functions (M1-038), a word index on custom text values (M1-040), a search page or query
    entry in the bulk UI (M1-041, M1-046).
- **M1-053 admin UI** (no migration). New pages, each with a client interface, an in-memory
  fake (`fixtures.ts`), stories, unit tests and e2e in `apps/web/e2e/configuration.spec.ts` and
  `people.spec.ts`: `people/` (users, groups), `configuration/` (`TracksAdminPage`,
  `WorkflowMapsPage`), `fields/FieldsAdminPage`, `permissions/PermissionsPage`,
  `sets/ConfigurationSetsPage`; routes `#/admin/{users,groups,tracks,workflow-maps,fields,
  permissions,configuration-sets}`, Settings links and palette entries. Every permission has a
  readable name (`permission.*` strings). Still API only: formula fields, context scopes and
  defaults, per-type rules and field editors, layout sets, visibility and notification policies,
  field grantees, status mappings when a map switch is refused.
- **M1-051 ticket view** (no migration). `apps/web/src/tickets/view/` (`TicketPage`,
  `ActivityPanel`, `client.ts`, fixtures, stories, tests) replaces the interim
  `TicketAttachmentsPage` at `#/tickets/<key>`; `styles/ticket-view.css`; e2e
  `apps/web/e2e/ticket.spec.ts`. The create form now links the ticket it made. Shortcuts live in
  the page (a document `keydown` listener that ignores fields and dialogs). Not yet: a people
  picker (only assign to me and unassign), custom fields in the view, adding links, move and
  clone from the view, ticket actions in the command palette (AGL-018 (1)).
- **M1-028 workflow maps** (migration 0042; ADR-045; ADR-039 amended). A ticket's workflow is
  the one its track's map gives its ticket type: `workflow_map` (default workflow and entries per
  type; the default map for tracks without one; a local-mode track owns its own),
  `workflow.owner_track_id` for track-local workflows, `track.workflow_map_id` instead of the
  dropped `track.workflow_id` (each track's workflow became its map's default).
  `workflows/maps.ts` resolves it (`ticketWorkflowId`, `holdTicketWorkflow`, `holdMapWorkflows`,
  the SQL function `ticket_workflow_id()`); `workflows/migration.ts` plans and runs status
  migrations; routes in `routes/workflow-maps.ts`.
  - **API change:** track PATCH and view take `workflowMapId` (null: the default map) instead of
    `workflowId`, with `statusMapping` and per type `typeStatusMapping`; 409
    `status_mapping_required` lists `{ticketTypeId, statusId, ticketCount, workflowId}`. Tests
    and the e2e that set a track's workflow now make a map (`POST /api/v1/workflow-maps
    {name, defaultWorkflowId}`) and assign it. `GET /api/v1/tracks/:id/workflow` takes
    `?ticketTypeId=`; ticket PATCH takes `statusId` with a new `ticketTypeId`.
  - Status migrations: up to 500 tickets in the request, more as the `workflow.migrate` job
    (registered in the worker in `main.ts`), progress at `GET /api/v1/workflow-migrations/:id`.
    A transition on a ticket not yet moved moves it first. While one runs, its tracks refuse a
    map switch, their maps a change of entries, their workflows a publish (409
    `status_migration_running`). 100,000 tickets in 16.4 to 20.9 s (`workflows/migration.large.test.ts`,
    `TASKMOOR_LARGE_MIGRATION=1`).
  - **New workflow readers must take the ticket's type**, never the track alone; statusGate and
    statusGateFor now take the ticket type too (the comment lock checks were updated at the
    merge).
  - Not built: an admin page for maps (M1-053 brings the configuration pages); local-mode
    tracks start on the shared default workflow and make their own with `trackId` on create
    (no automatic copy); statuses stay workspace-wide (only administrators add them).
- **M1-018 comments** (migration 0041; ADR-044). Server: `routes/comments.ts`,
  `tickets/comments.ts` (`readsComment`, `commentReadableSql`, `commentText`); transitions take
  `comment` and `commentVisibility` (`routes/tickets.ts`); history hides rows of unreadable
  comments; notifications (`notifications/subscriber.ts`) and the mailer (`email/deliver.ts`)
  check the comment's readers, the mailer quotes the text. Web: `apps/web/src/comments/`
  (`CommentsPanel` on the ticket page), `richtext/RichTextView.tsx` (read-only rich text from
  the shared schema, no HTML parsing), `styles/comments.css`; e2e `apps/web/e2e/comments.spec.ts`.
  **Search and export (M1-037 and later) must filter comments with `commentReadableSql`.**
  Not yet: mention notifications (NTF-005), reply by email (NTF-009), bulk comment actions
  (the comment routes are plain Fastify routes, not `Caller` handlers), ADF originals for
  comments. The draft in `/home/user/wt-comments` was taken over and that worktree removed.
- **M1-021 bulk operations, finished.** Web: `apps/web/src/bulk/` (`client.ts`,
  `BulkOperationPage.tsx` at `#/bulk/<id>`, stories, fixtures, tests), `styles/bulk.css`, the
  `bulk.*` strings; e2e `apps/web/e2e/bulk.spec.ts` on the attachments database, whose bulk
  jobs the e2e API server now runs. `JobRunner` takes `{ tasks }` to claim only those tasks.
  The 10,000-ticket edit took 50.0 s (`bulk/bulk.large.test.ts`, run with
  `TASKMOOR_LARGE_BULK=1`). Not yet: an entry point from ticket lists (no list page exists;
  M1-046 and the search page should start bulk changes), selection by query (M1-037).
- **Main's CI fixed** after the merge: label suggestions sort with `COLLATE "C"` (CI's
  Postgres sorts by another collation), the email tests no longer depend on the time of day
  or on quoted-printable line breaks in headers, the all-in-one image removes a stale
  `postmaster.pid` left by an unclean stop, and Docker Hub dropped `minio/minio`:
  `tools/storage/minio-test.sh` tries `quay.io/minio/minio`, then the community fork
  `pgsty/minio`, both pinned (`TASKMOOR_MINIO_IMAGE` overrides). On 2026-10-29 the quay.io tag
  did not pull and the fork passed the live S3 tests, so **M1-016 is done**.
- **M1-021 bulk operations, server side** (migration 0040; ADR-043). `apps/server/src/bulk/`
  (`model.ts` request schema, `run.ts` runner, `jobs.ts` the `bulk.run` task, registered in the
  worker in `main.ts`), `routes/bulk.ts`, `tickets/caller.ts`. `routes/tickets.ts` now builds
  plain handlers in `ticketRoutes()`; handlers may only use the `Caller` fields (`workspaceId`,
  `user`, `authz`, `apiToken`, `params`, `query`, `body`). New writes that bulk changes should
  reach must be ticket routes, or routes made callable the same way.
- **M1-029 edit locks** (migration 0038; ADR-042). `apps/server/src/workflows/locks.ts`
  (`statusGate`, `statusGateFor`, `statusLock`, `fieldLockList`, `lockedBody`) and
  `fieldLocks` in `fields/layouts.ts`. Enforced in ticket create, edit, move and transition
  layouts, attachment upload and delete, and co-editing (`collab/persist.ts` `mayEditText`).
  **Comments (M1-018) must check the status's `comment` lock, and bulk operations (M1-021) the
  edit and assign locks and field locks, through the same helpers.** Routes:
  `GET /api/v1/tickets/:id/locks`; layouts and the attachment list report locks. Web:
  `apps/web/src/locks/useLockText.ts` words a lock; the ticket view (M1-051) should grey out
  what `/locks` lists. Two fixes came with it in the create form: a late layout answer for an
  earlier ticket type no longer replaces the chosen type's form, and the labels hint is linked
  to its field. The attachment panel shows a status lock before "not set up".
- **M1-013 formula fields** (built by a background agent on `work/m1-013-formulas`, reviewed
  and merged; migration 0033; ADR-009 "Implementation (M1-013)"; new package
  `@taskmoor/formula`). Formula custom fields compute from custom number, date and text
  fields and the system dates, estimates, time spent and summary: arithmetic,
  avg/min/max/sum/count, rounding, date differences, `workingDaysUntil` (the workspace's
  working week; "Overdue" through `if`) and roll-ups over children (`sum(children.{Points})`).
  A hand-written parser, checker and interpreter with limits (4,000 characters, 64 levels,
  1,000 parts, 1M steps); refusals give their place (400 `invalid_formula`), cycles included.
  Values live in `ticket.fields` and the side table of their output. **Every write path must
  call `refreshFormulas` in its transaction and append the history rows it returns; the M1-021
  bulk edit included.** Collaborative saves (M1-017) do since the merge. Also fixed at the
  merge: `workingDaysUntil`/`workingDaysBetween` looped for ever on a date value far outside
  the calendar (a random property-test seed hung the gate); such values now give empty. Parents are
  recomputed with SKIP LOCKED; held ones go to the `formula.recompute` job; `formula.refresh`
  walks all tickets after formula, context or working-week changes, and daily for date-based
  formulas. `GET /api/v1/formulas/check`; `pnpm fuzz formula`; `pnpm conformance formula`
  (CLAUDE.md's Commands and Layout tables do not list these yet). Not yet: select, people,
  label and rich-text inputs; a workspace time zone and holidays; the editor UI (M1-053).
- **Flaky test fixed:** `storage.test.ts` [NFR-002] "keeps the side tables in step" now runs a
  fixed first example that writes every kind of value, so its closing "rows of every kind"
  check no longer depends on the random seed.
- **M1-017 rich text** (built by a background agent on `work/m1-017-rich-text`, reviewed and
  merged; migration 0034 adds `ticket_text_original` and `ticket_text_state`; ADR-014
  "Implementation (M1-017)"). The editor lives in `apps/web/src/richtext/`, the conversions in
  `packages/richtext` (`markdown.ts`, `collab.ts`), co-editing in `apps/server/src/collab/`
  (realtime role, `/api/v1/collab`). New write paths to description or environment need
  nothing extra: open documents pick up API writes within about 50 ms, or 30 s otherwise.
  Comments (M1-018) should reuse `RichTextEditor` and `readRichText`/`inFormat` from
  `tickets/rich-text.ts`; mention notifications (M1-056, M1-058) can find mention nodes in the
  stored documents (`canView` logic in `routes/rich-text.ts`). Several realtime processes need
  routing by document until updates are relayed between them. At the merge both realtime
  features share one upgrade dispatcher in `app.ts` (co-editing takes `/api/v1/collab`, the
  rest goes to Fastify's WebSocket routes).
- **M1-032 websocket, local copy and outbox** (migration 0037; ADR-013 "Implementation
  (M1-032)"). Server: `apps/server/src/sync/mutations.ts` (idempotent mutations by
  `taskmoor-client-id` and `taskmoor-mutation-id`, answers carry `taskmoor-position`) and
  `sync/socket.ts` (websocket under the `realtime` role; the Vite proxy has `ws: true`). Web:
  `apps/web/src/sync/` (`store.ts` IndexedDB, `engine.ts`, `browser.ts`, `SyncProvider.tsx`
  around the pages in `App.tsx`). Only the ticket page reads the local copy so far; the ticket
  view (M1-051), boards (M1-046) and the inbox (M1-058) should read it and edit through
  `engine.mutate()`. Two fixes came with it: the create form clears the ticket type while a new
  track's types load (a type picked meanwhile was overwritten), and the ticket page no longer
  resets when the engine starts after it (it remounted the attachment panel mid-upload).
  The provider retries a first bootstrap that fails (offline at load) and starts from an
  existing local copy offline.
  New dependencies: `@fastify/websocket` 11.3.4; `ws` 8.22.0 and `fake-indexeddb` 6.2.5 for
  tests. Timings measured on the e2e instance only (see the ADR).
- **M1-031 change log** (migration 0036; ADR-013 "Implementation (M1-031)"). Triggers on
  `ticket`, `track` and `authz_epoch` write `change_log`; a deferred constraint trigger gives
  `seq` at commit. Readers in `apps/server/src/sync/log.ts`, routes `/api/v1/sync/*`, hourly
  trim job in `sync/jobs.ts`. Every ticket write now also writes a log row (and numbers it at
  commit): keep an eye on bulk rewrites (M1-021) and the edit p95. M1-032 adds the websocket
  push, the IndexedDB client store and the outbox on top.
- **M1-057 email notifications** (migration 0032; ADR-041 "Implementation (M1-057)";
  deploy/README "Email notifications"). `apps/server/src/email/` (`deliver.ts` mailer,
  `render.ts`, `transport.ts`); the worker runs it every 30 s when `TASKMOOR_SMTP_URL` is set.
  New dependencies: `nodemailer` 10.1.0, and `smtp-server` 3.19.21 for tests (both MIT-0,
  versions over two weeks old). Web: `apps/web/src/notifications/` (Account page section,
  `#/unsubscribe`). **Not run here:** a real mail provider; set `TASKMOOR_SMTP_*` in an install
  to try it. Email strings are English only (server-side table in `render.ts`).
- **M1-056 notification rules** (migration 0030; ADR-041). `apps/server/src/notifications/`:
  `model.ts` (events, recipient types, channels) and `subscriber.ts` (the bus subscriber that
  writes `notification` rows). Routes `/api/v1/notification-policies`,
  `/api/v1/notification-events`, `/api/v1/account/notification-preferences`, and
  `notificationPolicyId` on track PATCH. Nothing delivers yet: email is M1-057 (SMTP, batching,
  digests) and the inbox M1-058; both read `notification` rows (`delivered_at`, `read_at`) and
  must render content with the recipient's own permissions. Comments (M1-018) should add
  `ticket_commented` and check a restricted comment like a restricted time entry.
- **M1-020 visibility levels** (migration 0029; ADR-012 "Visibility levels and ticket-level
  grantees"). `apps/server/src/authz/visibility.ts` holds the rules; `request.authz.ticket(row)`,
  `canTicket(p, row)` and `seesTicket(row)` replace track checks wherever a ticket is at hand,
  and lists put `(await request.authz.ticketFilter()).sql` (a predicate on alias `k`) in their
  statement; `visibleTickets(ids)` filters a set of ids. **Every new read path must use them**:
  search results (M1-037), notifications (M1-056), sync and exports are not built yet. Site
  administrators are not exempt from levels. Routes: `/api/v1/visibility-policies` (admin scope;
  levels, members, `replaceWith` on delete), `GET /api/v1/tracks/:id/visibility-levels` and
  `/api/v1/tickets/:id/visibility-levels` for forms, `visibilityPolicyId` on track PATCH,
  `visibilityLevelId` on ticket create, edit and move, `?ticket=` on the explainer. No admin UI
  yet (M1-053); the create form does not offer levels yet (M1-051).
- **M1-030 workflow editor** (built by a background agent, reviewed and merged; ADR-039
  "Implementation (M1-030)"). Web only, on the M1-023 API: `#/admin/workflows` (list, create,
  copy, delete, statuses) and `#/admin/workflows/<id>` (the editor), both in Settings and the
  command palette. Code in `apps/web/src/workflow/`: `definition.ts` (pure draft operations),
  `diagram.ts` (layout), `catalogue.ts` (rule forms, typed against `@taskmoor/workflow`, a
  type-only dev dependency of the web app), `shape.ts` and `lint.ts` (checks before
  publishing). `axe-core` is a dev dependency of the web app for the e2e axe check. Board
  column mapping waits for boards (M1-043).
- **M1-016 attachments** (built by a background agent, reviewed and merged; migration 0031;
  ADR-040; new package `@taskmoor/storage`). Files go to local disk (`TASKMOOR_DATA/files` or
  `TASKMOOR_FILES_DIR`) or an S3-compatible bucket (`TASKMOOR_S3_*`, from the environment only)
  under random keys never derived from file names. Routes `/api/v1/tickets/:id/attachments`
  (list, upload, metadata, content, thumbnail, text, entries, entry content, archive, delete)
  and `/api/v1/admin/attachment-settings` (maximum size, default 1 GiB, no ceiling). Uploads
  stream and are refused with 413 `file_too_large` past the limit. S3 files are served only by
  a 302 to a URL signed for 5 minutes after the browse check. `storage_cleanup` is swept after
  deletes, the trash purge, hourly in the worker and every 10 minutes per API process.
  `TASKMOOR_SCAN_CLAMD` plugs in ClamAV. The UI is `AttachmentPanel` on `#/tickets/<key>` until
  the ticket view (M1-051) takes it over.
  - e2e now also needs ports 4174, 4175 and 8791 to 8793 (local-disk and fake-S3 servers).
  - **Not run here:** a real S3-compatible store (`bash tools/storage/minio-test.sh`, CI
    `storage.yml`; the MinIO image tag is unchecked), a real ClamAV, the Helm chart.
  - Left for later: copying attachments on clone (CORE-023 (1)), the Jira-compatible
    attachment API, attachment files in S3 backups, moving files between stores.
- **M1-036 query resolver** (ADR-010 "Implementation (M1-036)"): `packages/query/src/fields.ts`
  holds the spec's field catalogue and `OPERATORS_BY_TYPE`; `resolve.ts` checks queries against
  it; `apps/server/src/search/catalogue.ts` builds a person's catalogue (custom fields they may
  see, track keys old and new) and `GET /api/v1/search/check?q=` checks a query. The M0 spike
  compiler (`compile.ts`) still targets the spike schema; M1-037 replaces it with the
  production compiler over `ticket` and the `v_*` side tables.
- **M1-012 field rules and layouts** (migration 0028; ADR-009 "Implementation (M1-012)"):
  rule sets and layout sets in `fields/layouts.ts` (loaded with the field catalogue), admin
  routes in `routes/layouts.ts`, enforcement in `routes/tickets.ts` (create, PATCH,
  `runTransition`). Writes whose refusal is found after the ticket is written throw `Rollback`
  inside `transact()`; returning an outcome from a Kysely transaction commits it, so do the same
  for any new post-write check. The create page `#/create` (`apps/web/src/tickets/`) is the
  first ticket UI; the ticket view and its edit form come with M1-051.
- **M1-102 upgrade command** (built by a background agent, reviewed and merged; ADR-022
  "Implementation (M1-102)"; no migration). `node cli.mjs upgrade [--dry-run] [--no-backup]
  [--unattended]` (`apps/server/src/upgrade.ts`): read-only pre-flight checks (lock, unknown
  or out-of-order migrations, the N-3/LTS path from `packages/db/src/releases.ts`, backup
  room, a running backup, other `taskmoor-*` processes), a plan, a full backup into
  `<backup dir>/pre-upgrade-<time>` (logged as `manual` with `purpose: 'pre-upgrade'`, never
  pruned), all pending migrations in one transaction verified against the shipped schema
  golden (`EXPECTED_SCHEMA`) before the commit, and rollback by the transaction or, after a
  committed online migration, by dropping new objects and restoring the backup. Exit codes 0,
  1 and 3; the last output line is the report as JSON.
  - `RELEASES` in `packages/db/src/releases.ts` is empty until the first release; cutting a
    release appends `{version, lastMigration, lts?}`.
  - The migration runner (`packages/db/src/migrate.ts`) now pins one connection with a session
    lock and runs pending migrations in one transaction; `export const online = true` runs a
    migration alone outside it. `migrationStatus` reports `outOfOrder`, so a development
    database that applied a later migration before an earlier one is named clearly.
  - Kits: `bash deploy/compose/upgrade.sh <image>`; the all-in-one image runs
    `upgrade --unattended` at every start (marker `upgrade-failed.json`) and
    `taskmoor-allinone upgrade` by hand. **Not run here:** both under Docker (CI's
    `smoke-kits.sh` now exercises them).
- **M1-011 field storage** (migration 0027; ADR-008 "Implementation (M1-010 and M1-011)"):
  side tables `v_text`, `v_number`, `v_date`, `v_time`, `v_user`, `v_option`, written by
  `syncFieldValues` (`fields/storage.ts`) in every transaction that changes a ticket's values,
  track or trash state. Any new write path to `ticket.fields` (bulk edit, import, workflow
  effects on custom fields) must call it too; the property test in `fields/storage.test.ts`
  catches a path that forgets. Daily repair job `field_values.verify` (`fields/jobs.ts`) and
  `node cli.mjs field-values [--repair]`.
  - `ticketQuery` (the ticket view) now reads one-row lookups as scalar subqueries: planning
    the sixteen-table join cost 4 to 7 ms per read.
- **M1-082 LDAP and Active Directory** (built by a background agent, reviewed and merged;
  migration 0021; ADR-019 "LDAP and Active Directory"): directories in `ldap_directory`
  (LDAPS or StartTLS, sealed bind password, precedence, schedule), synced by the worker
  (`ldap/scheduler.ts`, runs in `ldap_sync_run`), full or incremental (AD USN per domain
  controller, otherwise modifyTimestamp with a 10-minute overlap, plus an identifier scan for
  deletions). People are linked by stable identifier or email; disabled or removed entries are
  deactivated (break-glass accounts and the last active admin never). Groups are mirrored with
  nesting at any depth, loops broken by DN. Sign-in binds as the person. Read-only directories
  refuse changes to what they own (`409 directory_managed`); read-write ones take them. API
  `/api/v1/directories`; admin page `#/admin/directories`. Migration 0021 also made the epoch
  triggers on group_member, group_nesting and user_group per statement.
  - e2e now needs port 8790 as well (a fake directory in `e2e/api-server.ts`; its passwords
    are made per run in `playwright.config.ts`).
  - **Not run here:** `bash tools/ldap/openldap-test.sh` in Docker (CI `ldap.yml`); the same
    suite passed with `--local` against slapd 2.6.10 (10,000 people in 3.0 s; 100,000 in
    29 s). Left for later: just-in-time accounts at first sign-in, memberships of accounts
    another directory manages, DirSync or persistent search, writing new entries.
- **M1-010 custom field types, contexts and options** (migration 0026; ADR-009 "Implementation
  (M1-010)", ADR-008 note). Types in `fields/types.ts` (conformance suite beside it), the
  catalogue in `fields/catalog.ts` (one per process, reloaded when `field_epoch` moves),
  values in `fields/values.ts`, routes in `routes/fields.ts`: `/api/v1/fields` (CRUD,
  `/contexts`, `/contexts/:id/options`, `.../options/order`, `/labels`, `/people`) and
  `GET /api/v1/tracks/:id/fields?ticketTypeId=` (what a create form offers). Tickets take
  `fields: {"<fieldId>": value}` on create and PATCH and show `fields` in REST form; history
  rows are named `cf[<id>]`. `FieldCatalogs` is built in `app.ts` and passed to the ticket and
  field routes.
  - Not yet: workflows naming custom fields (M1-012), side tables and indexes (M1-011), option
    mapping on move (M1-021), a UI (M1-053).
- **M1-024 to M1-027 transitions, guards, checks and effects** (migration 0025, ADR-039
  "Implementation (M1-024 to M1-027)"). `packages/workflow/src/engine.ts` is the production
  engine (all 374 conformance cases; property test against the reference in `engine.test.ts`).
  The server feeds it through `workflows/state.ts` (ticket to engine state, results to column
  updates) and `workflows/fields.ts` (fields workflows read and write). Definitions now carry
  `layout`, `guards` (nested `all`/`any`), `checks`, `effects`, `properties`, `event`,
  `triggers`, plus `onCreate`, `rules` and `statusPermissions` (`workflows/model.ts`, refused on
  save when they name unknown or read-only fields). `POST /tickets/:id/transitions` takes
  `{transitionId, fields?, version?}`; `comment` answers 400 until M1-017 brings comments.
  Refusals: 409 `transition_unavailable`, 409 `transition_refused {by, name, message?, check?}`,
  403 `forbidden` with `permission: 'transition'`. `POST /tickets/:id/trigger {event}` is the
  hook M2 automation calls. `GET .../transitions` lists layout and properties. The web side has
  `apps/web/src/workflow/refusal.ts`, which words refusals from the `workflow.*` messages.
  - **Changed behaviour (M1-023 corrected):** the close reason is set only by a layout or an
    effect and cleared only by an effect; the seeded Close asks for one, Reopen clears it.
    Publish, workflow switch and move map statuses only. Global transitions are offered from
    their own target too. `closing` and `transitionsFrom` are gone from `model.ts`.
  - Lookups through the pooled `db` (authz, assignable people) must happen before
    `db.transaction()`; doing them inside exhausted the pool under concurrent transitions.
  - Tests: `routes/transitions.test.ts` (8), `workflows.test.ts` updated, two new contract
    scenarios (transition fields, trigger), `workflow/refusal.test.ts` (4).
  - Next for workflows: M1-028 workflow maps and local workflows, M1-029 per-status edit locks
    (the engine's `checkPermission` is ready), M1-030 the editor.
- **M1-101 scheduled backups, restore drill, trash retention, track trash** (built by a
  background agent, reviewed and merged; migration 0022; ADR-022 "Implementation (M1-101)").
  Scheduled backups are on by default: daily 02:30 UTC in the worker, keep 14, weekly restore
  drill, through the CLI backup path into `TASKMOOR_BACKUP_DIR` (or `TASKMOOR_DATA/backups`;
  folder 0700; `off` disables them for that process). Every run is in `backup_run`; status and
  settings at `GET /api/v1/admin/backups` and `PUT .../schedule`, and on the System status page.
  Manifests carry row counts from the dumped snapshot. `node cli.mjs drill` restores the latest
  backup into a scratch database, checks every table and drops it; `purge-trash` runs the purge
  now. Trash retention is a workspace setting (`/api/v1/admin/trash-policy`, 1 to 365, default
  30); an hourly job purges tickets and tracks past retention with audited
  `ticket.purged`/`track.purged` and history rows on the tickets that remain. Tracks have a
  trash (`DELETE /api/v1/tracks/:id`, `POST .../undelete`, `GET /api/v1/trash/tracks`); the
  authorizer grants nothing in a trashed track and its keys stay reserved until the purge.
  Admin Trash page at `#/admin/trash`. With 1M synthetic tickets: backup 22 s, drill 36 s,
  in-place restore 39 s (`tools/backup/bench-restore.sh`).
  - `linkChange` moved from `routes/links.ts` to `tickets/history.ts`; track views carry
    `trash: null` outside the trash.
  - **Not run here:** the Helm chart (the worker now sets `TASKMOOR_BACKUP_DIR=off` because its
    `/data` is an emptyDir; CI's `helm.yml` lints it) and the Compose kits. Next for backups:
    encryption, S3/SFTP targets, PITR, single-track or deleted-ticket restore from a backup
    (OPS-009 (2)).
- **M1-023 statuses and workflows** (migration 0024, ADR-039): `/api/v1/statuses` (CRUD,
  order), `/api/v1/workflows` (create published as version 1, `PUT/DELETE .../draft`,
  `GET .../impact`, `POST .../publish` with `statusMapping`, `.../versions`,
  `.../versions/:v/restore`), `GET /api/v1/tracks/:id/workflow` (read-only), and
  `GET/POST /api/v1/tickets/:id/transitions`. Tickets have `status`; track PATCH takes
  `workflowId` with `statusMapping`; move takes `statusId`. The rules are in
  `workflows/model.ts` (definition schema) and
  `workflows/store.ts` (`holdWorkflow`, `remapStatuses`). A ticket inserted without a status
  gets its workflow's initial status from a trigger. Entering the closed stage sets the close
  reason and `closedAt`; a close reason set by hand now also sets `closedAt` (it meant
  nothing before workflows). Next for workflows: M1-024 transitions (layouts, properties,
  trigger hook), M1-025 guards, M1-026 checks, M1-027 effects, M1-028 workflow maps.
- **M1-019 time tracking** (migration 0023, ADR-009 note): `GET/PATCH /api/v1/time-tracking`
  (settings), `/api/v1/tickets/:id/time-entries` (list, record with `remainingEstimate`
  `{mode: auto|leave|set|reduce}`, edit, delete with `?remainingEstimate=`), and
  `originalEstimate`/`remainingEstimate` on ticket create and edit (seconds or text such as
  "1w 2d"). The ticket view has `timeTracking` in seconds with `effortRatio`. Durations are
  parsed in `tickets/duration.ts`; `Authorizer.audience(trackId)` gives a person's roles in a
  track and groups, for restricted comments (M1-017) as well. Tests: `routes/time.test.ts` (7),
  `tickets/duration.test.ts` (5).
- **M1-081 SAML 2.0** (built by a background agent, reviewed and merged; migration 0020,
  renumbered from 0016 on merge because 0018 and 0019 had landed; ADR-019 "Single sign-on
  with SAML 2.0"): SAML providers are `identity_provider` rows with `kind` 'saml' and share
  domains, enforcement, break-glass, JIT, group maps and audit with OIDC through
  `sso/sign-in.ts`. The verifier in `sso/saml.ts` (xml-crypto 6.4, @xmldom/xmldom 0.8) refuses
  signature wrapping and reads only the signed bytes; trust comes from the configured
  certificates, never KeyInfo. Endpoints: `/api/v1/auth/saml/:id/{metadata,start,acs}` and
  `/auth/saml/continue` (the ACS answers 303 to `/continue`, where the Lax cookie travels).
  `saml_assertion` is the replay cache; IdP-initiated sign-in is off by default. The admin
  page takes pasted metadata or manual settings and shows the addresses to register. The fake
  SAML IdP (`testing/fake-saml-idp.ts`) generates its keys at run time; e2e now needs ports
  4173, 8787, 8788 and 8789.
  - **Not run here:** the Keycloak SAML e2e (`bash tools/sso/keycloak-test.sh saml`; CI's
    `sso.yml`, whose path filter now includes `routes/saml.ts`). The `taskmoor-saml` realm
    client is untried against a real Keycloak and may need a small fix on its first run.
  - Left for later: signed AuthnRequests, encrypted assertions, metadata from a URL.
- **M1-015 links, web links, followers and votes** (migration 0019, `routes/links.ts`, ADR-009
  note): `/api/v1/link-types` (CRUD, delete with `?replacementId=`), `PUT /api/v1/link-policy`,
  `/api/v1/tickets/:id/links` (GET lists links and web links; POST with `linkTypeId`,
  `ticket` and `direction`; DELETE `/links/:linkId`), `/tickets/:id/web-links` (a repeated
  `globalId` updates), `GET /api/v1/web-links?globalId=`, `/tickets/:id/followers[/:userId|me]`
  and `/tickets/:id/votes`, `/api/v1/account/preferences` (`autoFollow`). The ticket view has
  `followerCount` and `voteCount`. `tickets/followers.ts` holds `autoFollow`, for comments
  (M1-017) to call too. Tests: `routes/links.test.ts` (10).
- **M1-073 and M1-074 AI gateway** (built by a background agent, reviewed and merged; ADR-028
  implementation section): `@taskmoor/ai` has one `ProviderAdapter` interface (generate,
  stream, token counting, model listing, batches, capabilities, typed errors); a Claude adapter
  for the Anthropic API, Bedrock (Mantle client, `anthropic.` model IDs), Vertex and Foundry;
  an OpenAI-compatible adapter for Ollama and vLLM; `createProviderAdapter(config, secrets)`.
  The request policy is checked before every send: adaptive thinking, explicit effort per
  feature (spec 1.2), strict structured output and strict tools with automatic choice, cache
  breakpoints, refusals as data with fallbacks, retries honouring Retry-After and a circuit
  breaker, one repair attempt, streaming with cancel, batches resumable by id. 30 recorded
  fixtures (placeholder credentials only) drive the contract tests.
  - **Half-done:** `packages/ai/src/live.test.ts` has never run. Run it once with
    `TASKMOOR_AI_TEST_KEY=<key with a spend cap> pnpm verify --only=tests -- --project=ai` to
    close M1-073's live smoke test and M1-074's live cache read. The key comes from the
    environment only; it never goes into the repository.
  - The fallback beta names (`server-side-fallback-2026-07-01`, `fallback-credit-2026-07-01`)
    and the Mantle client were checked against the Claude API reference; `claude-opus-5` was
    added to the server-side fallback models.
  - Next for AI: M1-075 key storage, M1-076 settings page (`gateway.listModels()`,
    `availability()`, `capabilities()`), M1-077 spend limits and audit (cost from
    `result.usage`; fallback answers already sum every attempt).
- **M1-014 priorities, close reasons, labels, releases and areas** (migration 0018, ADR-009
  note):
  - `routes/priorities.ts`: `/api/v1/priorities`, `/priority-sets`, `/close-reasons` (CRUD,
    `PUT .../order`, delete with `?replacementId=`), `/labels?q=` suggestions and
    `POST /labels/merge` (administrators). Track PATCH takes `prioritySetId`.
  - `routes/releases.ts`: `/api/v1/tracks/:id/releases` and `/areas` (list, create, release
    order) and `/api/v1/releases/:id` (edit, ship, unship, archive, restore, merge, delete,
    approvers, approval decision), `/api/v1/areas/:id` (edit, archive, restore, delete).
  - Tickets take `priorityId`, `closeReasonId`, `labels`, `targetReleaseIds`,
    `foundInReleaseIds` and `areaIds`; the view shows them, history records them. Mass
    rewrites go through `rewriteTickets` in `tickets/fields.ts` (locks, versions, one change
    set); ticket writes call `holdValues` before locking the ticket (lock order in ADR-009).
  - Tests: `routes/ticket-fields.test.ts` (15, CORE-014 to CORE-017) and 28 contract
    scenarios.
- **M1-083 SCIM 2.0** (ADR-038; ADR-019 points to it), finished from the WIP branch, whose
  filter, PATCH, schema and resource modules held up under the new tests:
  - `/api/v1/scim/v2` (`routes/scim.ts`, data in `scim/store.ts`): discovery, Users and Groups
    with filter, paging, `attributes`, `excludedAttributes`, POST, PUT, PATCH and DELETE; SCIM
    errors and `application/scim+json` throughout (an encapsulated Fastify plugin with its own
    error, not-found and content-type handling).
  - Access: the `scim` token scope, held alone and only by service accounts (`tokens/scopes.ts`
    classes the SCIM routes as `scim`; personal tokens refuse it). No other token and no
    session reaches SCIM.
  - Accounts keep email, name, locale, time zone and active state; `scim_user` the rest.
    `active` false or DELETE deactivates and ends sessions; the account stays and comes back
    when its email is provisioned again. Break-glass accounts and the last active site
    administrator cannot be deactivated through SCIM. SCIM sees only the groups it created.
  - Six audited events `scim.*`. The service account token form offers "SCIM provisioning",
    which clears the other scopes (`TokenForm` `allowScim`).
  - Tests: `routes/scim.test.ts` (compliance over HTTP), `routes/scim.idp.test.ts` with the
    Entra ID and Okta sequences in `testing/scim-idp.ts`, `scim/filter.test.ts` (with 2,000
    random inputs) and `scim/patch.test.ts`, contract scenarios, web tests and a story.
- **M1-009 change history** (migration 0015, `tickets/history.ts`, ADR-009 note): every ticket
  mutation writes `ticket_change` rows (field, old and new value with names, change set);
  `GET /api/v1/tickets/:id/history`. New ticket mutations must call `recordChanges` with
  `ticketChanges(before, after)` from rows read with `loadTicket(s)` in the same transaction.
- The e2e API server (`apps/web/e2e/api-server.ts`) uses `TASKMOOR_TEST_DATABASE_URL` when it
  is set, like the unit tests, so `pnpm verify --e2e` runs in a container that runs as root
  (24 passed here). CI sets the variable, so its e2e now runs on the Postgres 16 service.

### Next (in order)

1. `pnpm next-task` lists 17 ready tasks. In the query engine: M1-040 (full-text search, text
   operators, rank, approximate counts), M1-039 (WAS and CHANGED). Reports: M1-064 dashboards
   (needs M1-062 too), whose widgets can run saved searches. In planning: M1-045 (sprint and
   release functions over `sprint_ticket`, no schema change needed), M1-046 (drag and drop,
   WIP indicators, the 5,000-card render budget), M1-062 (burndown and reports from
   `sprint_change`). Others: M1-067 webhooks, M1-098 CSV import and export, M1-105
   static build, M1-115 accessibility pass, M1-116 i18n completeness.
2. M1-073 and M1-074 (AI gateway) are marked in progress from an earlier session; their done
   criteria need a live smoke test with a test key, which must come from the environment at
   run time and never be written to the repository.
3. Follow-ups named in the Done entries: board admins and location in the settings page, drag
   and drop and the 5,000-card render budget (M1-046); teams in `membersOf()`; Recent in the
   sidebar and starred lists (M1-052); point-and-click for more fields in basic search (M1-041).
4. Run the Entra ID and Okta provisioning validators against a test instance with a public URL
   (IAM-006 (1)); the fixtures here imitate their request shapes.

## Earlier: 2026-10-26 (cloud container)

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

### Notes for cloud sessions (Linux container, running as root)

- The embedded Postgres refuses to run as root. Start the system one
  (`service postgresql start`), give its `postgres` user a password and point
  `TASKMOOR_TEST_DATABASE_URL` at it, as the CI job does (`.github/workflows/ci.yml`); the
  e2e API server uses it too.
- The container's Chromium (`/opt/pw-browsers`, build 1194) is older than Playwright 1.64's
  (1248). Linking it under the new names in a scratch folder and setting
  `PLAYWRIGHT_BROWSERS_PATH` there runs every story (193 passed).
- The unhandled 57P01 ("terminating connection due to administrator command") that ended some
  full runs was a real bug: no pool had an `error` listener, so an idle connection the server
  ended (a test database dropped, in production a restart or failover) crashed the process.
  `createDb` now always listens (`onIdleError`, logged by the server); `client.test.ts` proves it.

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
5. (Done 2026-10-30, migration 0055.) M1-121 was the contract step for M1-001: drop the M0 `session` table and
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
- **Merging `claude/api-key-upload-prevention-9ucz4x` into `main`**: it holds M1-008 and
  M1-083, each gated green. Whether to merge directly or through a pull request is the
  user's call; nothing on it is half-done.
