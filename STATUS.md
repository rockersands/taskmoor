# Status

Updated 2026-10-28. The task list lives in [docs/plan/backlog.csv](docs/plan/backlog.csv).

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
| M1-019 Time tracking | Done | Working-week settings, estimates, time entries with own/all permissions and role or group visibility, remaining estimate modes, time spent kept per ticket, history; no UI yet |
| M1-015 Links, followers, votes | Done | Link types with remap on delete and a workspace switch, cross-track links read from each side, web links with global ids, followers and votes with permission-gated lists, auto-follow; a ticket with 1,000 links loads under 300 ms; no UI yet |
| M1-073 AI gateway core | In progress | One provider interface; Claude adapter for the Anthropic API, Bedrock (Mantle), Vertex and Foundry; OpenAI-compatible adapter for Ollama and vLLM; 30 recorded-fixture contract tests green. Waiting on one live smoke run with a test key |
| M1-074 AI request policy | In progress | Adaptive thinking, explicit effort per feature, strict outputs and tools with automatic choice, cache breakpoints, refusal fallbacks, typed retries with a circuit breaker, streaming, batches; policy tests green. The live cache-read check waits on the same test key |
| M1-081 SAML 2.0 sign-in | Done | Several IdPs beside OpenID Connect; own verifier on xml-crypto refusing signature wrapping (XSW1-8), replays and unsolicited responses; admin UI with metadata import; Chromium e2e against a fake IdP. The Keycloak SAML e2e runs in CI's sso workflow (needs Docker) |
| M1-083 SCIM 2.0 provisioning | Done | Users and groups with filter, PATCH and deprovisioning through a service account's scim-only token; own compliance suite and Entra ID and Okta request fixtures; the providers' own validators wait for a public test instance |
| M1-100 Air-gap bundle | In progress | Bundle, verify and offline install tested on an internal network; release signing key waits on the user |
