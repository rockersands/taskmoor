# Status

Updated 2026-10-29. The task list lives in [docs/plan/backlog.csv](docs/plan/backlog.csv).

## Milestones

| Milestone | Scope | State |
|---|---|---|
| M0 Foundation | Repo, test backbone, CI, ADRs, spikes, install skeleton | Accepted by the user on 2026-10-12 |
| M1 Release 1.0 | Jira Software parity, query language, importer, SSO, Builder, AI gateway | In progress |
| M2 Release 2.0 | Enterprise, automation, Plans, service desk core | Not started |
| M3 Release 3.0 | ITSM, on-call, status pages, CMDB, mobile apps | Not started |
| M4 Release 4.0 | Discovery, portfolio, test management | Not started |

## M0 tasks

| Task | State | Notes |
|---|---|---|
| M0-001 Repo and governance | Done | Repo pushed through the GitHub CLI token; CI green on main |
| M0-002 CLAUDE.md, HANDOFF.md, STATUS.md | Done | Required sections checked in `pnpm verify` |
| M0-003 Backlog CSVs and next-task | Done | `pnpm next-task`; progress in `docs/plan/progress.csv` |
| M0-004 ADR process, ADR-001 to 003 | Done | ADR-002 accepted: AGPL-3.0-only with DCO |
| M0-005 Clean-room protocol | Done | `docs/legal/clean-room.md`; counsel review deferred by the user to the first public release |
| M0-006 Provenance check | Done | Spec front matter checked in `pnpm verify` |
| M0-007 Public name screening | Done | The user chose taskmoor (`docs/decisions/name.md`); the rename is next |
| M0-008 Monorepo scaffold | Done | Biome instead of ESLint and Prettier (ADR-004) |
| M0-009 Embedded Postgres harness | Done | CI runs the same suites on Postgres 16 and 18 |
| M0-010 Module boundaries | Done | dependency-cruiser rules with a failing fixture |
| M0-012 Security and licence gates | Done | Licence allowlist and secret scan in `pnpm verify`; SBOM and Trivy in CI (ADR-029) |
| M0-013 Spec import and IDs | Done | 347 requirements; spec lint in `pnpm verify` |
| M0-014 Traceability | Done | `pnpm trace`; unknown IDs cited by tests fail |
| M0-015 Synthetic data generator | Done | `pnpm gen --items N`; deterministic; COPY loader with verified counts |
| M0-016 Field storage spike | Done | Side tables chosen; at 10M every query within budget (slowest 123 ms p95); ADR-008 accepted |
| M0-017 Query compiler spike | Done | 22 queries under 18 ms p95 at 10M after side-table driving; ADR-010 accepted |
| M0-020 Rich text spike | Done | `@taskmoor/richtext`, Yjs and Hocuspocus verified (ADR-014) |
| M0-021 Queue spike | Done | In-house SKIP LOCKED queue chosen (ADR-015) |
| M0-023 AI gateway skeleton | Done | `@taskmoor/ai` with contract tests (ADR-028) |
| M0-018 Permission engine spike | Done | In-process evaluator 1.5 ms p95 vs OpenFGA 15.9 ms; pre-filter overhead measured (ADR-012) |
| M0-019 Sync engine spike | Done | In-house change log: 52k-item bootstrap in 2.6 s, delta p95 1 ms, idempotent outbox (ADR-013) |
| M0-022 XML parser spike | Done | 5 GB parsed in 2.6 min at 303 MB RSS, lossless after cleaning (ADR-025) |
| M0-024 Remaining ADRs | Done | All 33 ADRs accepted |
| M0-033 Nightly benchmarks and weekly report | Done | bench:check with budgets and a 20% regression check; status-report; nightly job green on main with its results as the CI baseline |
| M0-011 GitHub Actions | Done | Lint, types, tests, e2e, Postgres 16 and 18, weekly Windows, security scan, multi-arch image build, nightly benchmarks |
| M0-026 All-in-one image and Compose kits | Done | deploy/allinone and deploy/compose; smoke-kits.sh green locally and in CI |
| M0-027 First-run setup | Done | Setup link with a one-time token, admin creation, cookie sessions and sign-in; e2e on the real backend |
| M0-025 Single image | Done | Roles by TASKMOOR_ROLE, esbuild bundle, multi-arch Dockerfile; smoke test green on amd64 and arm64; CI builds both |
| M0-031 Design system | Done | Tokens, shell components, Storybook with axe on every story (ADR-024) |
| M0-032 App shell | Done | Hash routing, session guard stub, command palette, ICU i18n, pseudo-locale checks |
| M0-035 DCO enforcement | Done | Git hooks, `pnpm dco` and CI; no branch protection on the free plan |
| M0-029 Migrations and upgrade harness | Done | Forward-only migrations, upgrade tests from the last three releases' schemas, `node cli.mjs check-upgrade`, `migrate` and `status` in the image |
| M0-030 Backup and restore | Done | `node cli.mjs backup`, `restore --yes` and `checksum`; drill (back up, wipe, restore, compare) green locally and in CI |
| M0-028 Install matrix | Done | Nightly workflow green on five images: 17 to 18 s to /ready on Ubuntu 22.04, 24.04 and arm64; 36 s in Debian 12 and Rocky 9 containers with prerequisites |
| M0-034 M0 gate | Done | `pnpm gate M0 --ci` all green; the user accepted M0; local demo from the Compose kit (HANDOFF: Local demo) |
| All other M0 tasks | Not started | |

## M1 tasks started early

| Task | State | Notes |
|---|---|---|
| M1-022 Workflow behaviour spec and conformance suite | Done | `@taskmoor/workflow`: 374 data cases for WF-001 to WF-012, `pnpm conformance` reports per section; reference model passes all |
| M1-033 Query conformance suite | Done | 2,220 data cases for QRY-001 to QRY-013 in `@taskmoor/query`; `pnpm conformance query` reports the pass rate per section (grammar 100%, 76% overall); the rates are a golden |
| M1-034 Native grammar and parser | Done | Grammar spec (file 06), error recovery with line, column and hints, nesting limit, 1,000+ parser tests; two one-hour fuzz runs, the second with no failure in 6.4 million inputs |
| M1-035 Jira-compatible dialect | Done | `toNative` and `toJira` rename fields and functions between the vocabularies on the shared tree; parse cases 100% green |
| M1-036 Field and operator resolver | Done | Every field of spec 1.5 under all its names, custom fields by name or id with ambiguity errors, one operator table per type checked by a 17-operator matrix; `GET /api/v1/search/check`; conformance 94% (functions and sprints left for M1-038 and M1-045) |
| M1-103 Health page, metrics, traces | Done | /metrics on port 9464, OTLP traces when configured, admin System status page, example alerts and dashboard; CI green |
| M1-099 Helm chart | Done | Chart with lint and render tests; on kind in CI: helm test green and a rolling upgrade with 55,271 requests and none failed |
| M1-001 Identity foundation | Done | Workspaces, users, nested groups, Argon2id with a pepper keyring, lockout and rate limits, hashed sessions, password links, account UI; ASVS L2 authentication checks as tests |
| M1-002 Roles and authorization | Done | Roles, access policies, global grants, track role actors; authorization service with cache, list filter and explainer; 10k-grant property test, check p95 under 10 ms |
| M1-005 Domain event bus | Done | One typed event per mutation in its transaction, relay to subscriber jobs, queue with backoff; fitness test over every mutating route |
| M1-003 Audit log | Done | Monthly partitions, one hash chain per workspace, verify, retention in whole months, search and streamed export; refused sign-ins and single sign-ons recorded |
| M1-004 API tokens and service accounts | Done | Prefixed, hashed, scoped, expiring tokens with rotation; service accounts; admin inventory and bulk revoke; UI and e2e |
| M1-006 Tracks | Done | Keys with history, categories, feature toggles, shared or local mode, archive and restore |
| M1-007 Ticket types and hierarchy levels | Done | Unlimited levels above Outcome, the subticket level, ticket types and type sets (local tracks own theirs); impact preview; property tests for cycles and parent levels; ticket mapping and rollback wait for M1-008 |
| M1-008 Tickets | Done | Per-track numbers (1,000 parallel creates give 1..1000), key history across moves and renames, system fields, global rank (ADR-037), edit with per-field permissions and optimistic versions, move with subtickets, trash and restore; type mapping when a type leaves a track; no UI yet |
| M1-009 Change history | Done | One row per changed field with names, partitioned by ticket; a 1,000-step edit sequence replays exactly; any page of 20,000 changes under 300 ms |
| M1-014 Priorities, close reasons, labels, releases, areas | Done | Ordered priority and close reason lists with replacement on delete, priority sets per track, label autocomplete and merge, releases with order, ship (open tickets, approvals), merge and archive, areas with owners and the default-assignee rule; all on tickets with history; no UI yet |
| M1-084 Two-factor sign-in | Done | Authenticator apps, security keys, recovery codes, policy with enrolment at sign-in; UI and e2e |
| M1-122 Skins and the soft visual language | Done | Light and dark skins in the soft pastel style, Appearance under Account saved with the account, axe on every story in both skins |
| M1-080 OpenID Connect sign-in | Done | Providers, JIT, group sync, enforcement with break-glass accounts, Keycloak e2e; email-first sign-in with provider buttons and the Single sign-on admin page, e2e against a fake provider |
| M1-023 Statuses and workflows | Done | Statuses with stages; workflows as versioned data (ADR-039) with draft, impact, instant publish remapping removed statuses with history, version history and restore; transitions (close reason semantics corrected in M1-024); status mapping on workflow switch and ticket move; no editor UI yet (M1-030) |
| M1-010 Field types and contexts | Done | 14 custom field types with a conformance suite (validate, serialise, sort, empty, REST); contexts per track and type with options, defaults and restricted user pickers; local fields for local-mode tracks; values on tickets with history; no UI yet, side tables in M1-011 |
| M1-011 Field storage | Done | Typed side tables kept in step on every write, property-tested; daily repair job and `field-values` CLI; edit p95 35 to 46 ms with 1,500 fields defined |
| M1-012 Field rules and layouts | Done | Rule sets (required, hidden, help per type) and layout sets (tabs and sections per type and operation) enforced on create, edit and transitions; create page `#/create` with refusals per field; e2e green. Admin pages are M1-053 |
| M1-016 Attachments | Done | Local disk or S3-compatible storage behind one interface, streamed uploads with an admin limit and no ceiling, signed S3 downloads, previews, ZIP browsing and download-all, ClamAV hook, thumbnails, attachment panel; e2e on local disk and a signature-checking fake S3. Checked against a real MinIO in CI's Storage workflow |
| M1-030 Workflow editor | Done | Admin pages for workflows and statuses; editor with a diagram mode (picture plus accessible lists) and a lossless JSON text mode, rule forms for every guard, check and effect, checks before publishing, publish with status mapping; e2e on desktop and mobile with axe |
| M1-020 Visibility levels | Done | Visibility policies with levels and members of any grantee type, defaults on create and move, Set visibility level permission, ticket-level grantees (requester, assignee, fields); enforced in the statement for lists and per ticket everywhere else, the two readings property-tested to agree; visibility matrix test over every read path; explainer names the level. No admin UI yet |
| M1-057 Email notifications | Done | SMTP from the environment; one email per ticket per two-minute window, daily and weekly digests in the person's time zone, quiet hours, one-click unsubscribe, visibility rechecked at send time, no cap; Notifications section on the Account page and an unsubscribe page; tested against a real SMTP server |
| M1-021 Bulk operations | Done | Edit, move, transition and delete many tickets as a background job through the same checks as single changes, with per-ticket results, progress, cancel and audit; a progress page with the tickets not changed and why; 10,000 tickets edited in 50 s (budget 2 min). Selection by query waits for M1-037 |
| M1-055 Guardrails | Done | Ten admin-adjustable limits on configuration (fields per track, options per field, releases and areas per track and the others of spec 01a section 1.7); additions beyond a limit are refused with the limit named and nothing written; an admin page shows usage against each limit |
| M1-041 Query editor | Done | A search page with a basic mode (tracks, stages, assignment, words) and an advanced editor with suggestions at the caret and errors where they are; basic and advanced convert both ways; the query lives in the address |
| M1-042 Search results | Done | Results as a table in columns each person picks (kept in the browser), summary, assignee, priority, labels, dates and simple custom fields edited in place through the ticket route with refusals on the cell, and CSV and JSON export streamed a page at a time: 100,000 tickets in 5.4 s (ADR-052) |
| M1-063 Saved searches | Done | Saved searches kept by their owner and shared with people, groups, track roles, everyone signed in or the public; referenced in queries (`filter = "name"`) with cycles refused; emailed on a schedule to a person or each group member as that member sees them; boards on a saved search (ADR-053) |
| M1-044 Sprints | Done | Sprints on Scrum boards: create, reorder, start, complete with unfinished tickets sent to the backlog, a planned sprint or a new one, delete; several active at once when the board allows; tickets added or removed after the start recorded as scope change with their estimates; a sprint report (completed, not completed, removed, added after start, estimate changes, totals); each board picks its estimation statistic (time, a number field such as story points, or ticket count) and time tracking. Backlog page with sprint sections and the report page (ADR-054) |
| M1-045 Sprint and release functions, cycles | Done | The sprint field, `openSprints()`, `futureSprints()`, `closedSprints()` and `@current`, `@next`, `@previous` (relative to the board) answered in the statement, release functions in the manual release order; auto-rolling cycles rolled over by the worker on the cycle's wall clock. A Sprints section in a Scrum board's settings page edits the estimation statistic (with a number-field picker), time tracking, parallel sprints and the cycle, with the server's refusals next to their fields |
| M1-067 Webhooks | Done | Signed JSON or chat messages (Slack, Teams, Mattermost, Matrix) for the events of spec 02a 1.3, filtered by any query as the webhook's owner sees tickets; retries on 408, 409, 425, 429 and 5xx, failed list and replay under the original id, no expiry. API only for now |
| M1-059 Report event store | Done | Reports read the change history and sprint changes as typed events; a ticket's state at any past moment is a fold, unchanged by later edits; `replayCheck` and `node cli.mjs report-verify` prove the events reproduce every ticket |
| M1-052 Home, create dialog, palette | Done | A home page of assigned, recently opened and followed tickets; creating in a dialog from anywhere (New ticket, C, the palette), honouring each ticket type's layout, optionally starting from a ticket; a command palette that reaches every action of the ticket view, more than 30 for an administrator, all from the keyboard |
| M1-053 Admin UI | Done | Admin pages for people, groups, tracks (roles, workflow map, archive), workflow maps, fields and their options, permissions (roles, access policies, global permissions) and configuration sets (type sets, field rule sets), each with e2e journeys on desktop and mobile and no serious axe issue; 17 admin journeys in all. API only for now: formula fields, context scopes, per-type rules, layout sets, visibility and notification policies |
| M1-051 Ticket view | Done | The ticket page: summary edited in place, transitions (with a close reason form), follow, vote, details with priority, labels, dates and assignment editable, links, attachments, and activity tabs (comments, history, time entries, all); keyboard shortcuts M, W, A, T, E and ?; full lifecycle e2e on desktop and mobile with no serious axe issue. Not yet: people picker, custom fields in the view, adding links, move and clone from the view |
| M1-021 Bulk operations | Done | Edit, move, transition and delete many tickets as a background job through the same checks as single changes, with per-ticket results, progress, cancel and audit; a progress page with the tickets not changed and why; 10,000 tickets edited in 50 s (budget 2 min). Selection by query since M1-037 |
| M1-018 Comments | Done | Rich-text comments with mentions, restricted to a role or group and absent for everyone else on every read path (list, link, history, notifications, email); reactions, edit with versions for administrators, own/all edit and delete, the status comment lock, comments with transitions; comments section on the ticket page with e2e |
| M1-037 SQL compiler | Done | Queries run as one parameterised statement with browse permission and visibility levels inside it (property-tested against the per-ticket check), side-table walks and per-value branches so pages walk an index, comments only where the reader may read them, cursors, capped counts, a timeout and an admin explain; bulk changes select by query; plan regression goldens; 50-query perf set at 1M: slowest p95 116 ms (10M not run: disk) |
| M1-038 Query functions, batch 1 | Done | People, group, date, history, link, follow and vote functions (and the track, area, type and option ones) under every name, with refusals that name the argument; dates on the person's clock with Sunday weeks; ticket functions joined inside the statement so they never widen what a person sees (property-tested) and have no cap; `membersOf()` on 50,000 people in 91 ms; conformance functions 96%, all 99% |
| M1-028 Workflow maps | Done | A workflow per ticket type through shared workflow maps or a local-mode track's own map, track-local workflows, status mapping on every change of workflow (switch, change of type, move); a change of map moves tickets in the background while they stay usable; 100,000 tickets moved in 16 to 21 s (budget 5 min). No admin page yet (M1-053) |
| M1-058 Inbox, mentions and activity | Done | Real-time inbox at `#/inbox` (all, Priority of direct asks, snoozed; unread only; read, unread, snooze, mark all read; reading marks the email read), every item judged again by the reader's current permissions; mentions of people and teams in descriptions, the environment and comments notify exactly once per change and channel, only those who may see the ticket and read the comment, with warnings for the rest; activity streams per ticket and per track from the history. A mention shows in an open inbox in 0.24 to 0.35 s on a quiet machine (under 1 s with other suites running) |
| M1-029 Edit locks | Done | A status can reserve editing, assigning, attaching and moving on to roles or groups, enforced on every write path including co-editing; field rules can name who may set a field; refusals and the UI say what is locked and who may change it; permission matrix and e2e on desktop and mobile |
| M1-013 Formula fields | Done | Arithmetic, dates and working days, text and roll-ups over children in a sandboxed language with its own parser and checker; values computed in the same write, kept queryable, and refreshed by jobs after formula or calendar changes; 217 conformance cases and two one-hour fuzz runs without a failure |
| M1-017 Rich text | Done | Tiptap editor (toolbar, Markdown shortcuts and paste, mentions, links, tables, keyboard only) in the create form; descriptions co-edited live over Yjs with the same permission checks and history as an edit; Markdown and the Jira-compatible document format in and out, originals kept; two-browser e2e |
| M1-032 Websocket, local copy and outbox | Done | Mutations with a client and mutation id run at most once and replay their answer; a same-origin websocket pushes log positions; the browser keeps each person's tickets in IndexedDB, follows the log, and sends an ordered outbox that survives offline spells; ticket open measured under 100 ms warm and 300 ms cold in e2e |
| M1-031 Change log and sync groups | Done | Triggers log every ticket and track change with a snapshot, numbered at commit so order is commit order; sync groups by permission; bootstrap and follow with per-row visibility; 30-day retention with resync; convergence property test with three replicas |
| M1-056 Notification rules | Done | Policies mapping events to every recipient type, a default policy, custom transition events, per-event and per-channel preferences and own-change opt-in; recipients resolved after commit and redacted to those who may see the ticket; notifications recorded for email and the inbox to deliver (M1-057, M1-058) |
| M1-024 Transitions | Done | Global, multi-source and self-loop transitions, layouts with field values, properties, custom events and the trigger hook for M2; production engine passes all 374 conformance cases |
| M1-025 Guards | Done | Every built-in guard with nested all/any; property test (2,000 runs) agrees with the reference model |
| M1-026 Checks | Done | Required field, pattern, date compare, parent status, permission, field changed; refusals carry the check so the client words it (localised, pseudo-locale tested) |
| M1-027 Effects | Done | Essential effects in fixed order, assign to the current user, requester or owner, update, copy and clear field, webhooks and custom events; order tested by the conformance suite and the server |
| M1-102 Upgrade command | Done | `cli.mjs upgrade`: pre-flight checks, plan, pre-upgrade backup, all migrations in one transaction checked against the schema golden, rollback by transaction or restore; Compose `upgrade.sh` and all-in-one upgrade at start. Docker paths are checked by CI's smoke-kits job |
| M1-101 Backups and trash | Done | Scheduled backups on by default (daily, keep 14, weekly restore drill), `cli.mjs drill`, trash retention setting with an hourly purge, a trash for tracks, admin Trash page; 1M tickets back up in 22 s and restore in 39 s. The Helm worker change is checked by CI's helm job |
| M1-019 Time tracking | Done | Working-week settings, estimates, time entries with own/all permissions and role or group visibility, remaining estimate modes, time spent kept per ticket, history; no UI yet |
| M1-015 Links, followers, votes | Done | Link types with remap on delete and a workspace switch, cross-track links read from each side, web links with global ids, followers and votes with permission-gated lists, auto-follow; a ticket with 1,000 links loads under 300 ms; no UI yet |
| M1-073 AI gateway core | In progress | One provider interface; Claude adapter for the Anthropic API, Bedrock (Mantle), Vertex and Foundry; OpenAI-compatible adapter for Ollama and vLLM; 30 recorded-fixture contract tests green. Waiting on one live smoke run with a test key |
| M1-074 AI request policy | In progress | Adaptive thinking, explicit effort per feature, strict outputs and tools with automatic choice, cache breakpoints, refusal fallbacks, typed retries with a circuit breaker, streaming, batches; policy tests green. The live cache-read check waits on the same test key |
| M1-081 SAML 2.0 sign-in | Done | Several IdPs beside OpenID Connect; own verifier on xml-crypto refusing signature wrapping (XSW1-8), replays and unsolicited responses; admin UI with metadata import; Chromium e2e against a fake IdP. The Keycloak SAML e2e runs in CI's sso workflow (needs Docker) |
| M1-082 LDAP and Active Directory | Done | Several directories with precedence, full and incremental sync with nested groups, sign-in by bind, read-only and read-write modes, admin page; passes against a real OpenLDAP 2.6.10 (100k people in 29 s) and in CI's OpenLDAP container (`ldap.yml`: 10k people, four levels of nesting, under two minutes) |
| M1-083 SCIM 2.0 provisioning | Done | Users and groups with filter, PATCH and deprovisioning through a service account's scim-only token; own compliance suite and Entra ID and Okta request fixtures; the providers' own validators wait for a public test instance |
| M1-043 Boards | Done | Scrum and Kanban boards on a query (saved searches later) in a track or kept by a person: columns mapping several statuses with an unmapped count, min and max WIP that count cards a board filter hides, swimlanes by query (first match wins, catch-all), assignee, parent or none, board filters combined with AND, card colours by the first matching rule and up to 10 fields, days in column, a sub-filter; every read through the search compiler with the viewer's permissions; moving a card runs the ticket's transition (asking which when several lead there) and re-ranks. Board page with keyboard moves, a settings page and a boards list; 5,000 cards of a 50,000-ticket board read in about 0.3 s |
| M1-086 Importer framework | Done | Extract, map and load in resumable batches with external ids, dry run and a fidelity report (zod schema, JSON Schema golden, HTML); a synthetic source format of our own; kill-and-resume property test (random kill points) ends identical to an uninterrupted run; admin routes and audited events. Source formats come with M1-087 onwards |
| M1-100 Air-gap bundle | In progress | Bundle, verify and offline install tested on an internal network; release signing key waits on the user |
