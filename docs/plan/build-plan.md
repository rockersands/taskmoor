# AI Build Plan: Taskmoor, an Open-Source, Self-Hostable Jira Replacement

*Prepared 11 October 2026 under the codename "Tracksmith"; the user chose the public name taskmoor on 12 October 2026. Every effort, size and date figure is an estimate unless it carries a link to evidence from the research report.*

## 1. Summary

**Conclusion.** Claude can build Taskmoor alone, using the repository as its memory and CI as its judge, if the user supplies accounts, compute, a usage budget, legal sign-offs and about half a day of acceptance testing per release. The build follows the research's order: the Data Center exit core first (release 1.0), breadth second.

- **What gets built:** one product covering Jira Software, business tracks, Jira Service Management with on-call and Assets, Product Discovery, Align-style portfolio, Automation, JQL, a Jira-compatible REST API and AI features that run on the admin's own AI key. Every premium feature is free.
- **How it ships:** a **Builder** turns one form into two packages: a backend kit the user runs on a server (Compose with PostgreSQL and automatic HTTPS) and a static frontend kit that can be uploaded to any web host and works at once.
- **Order:** M0 foundation; M1 Jira Software parity plus DC-exit core (1.0); M2 enterprise, automation and service desk (2.0); M3 ITSM, operations and CMDB (3.0); M4 discovery, portfolio, quality and ecosystem (4.0).
- **Effort (estimate):** about 2,500 session-sized tasks and 3,000–3,800 sessions, producing about 700K lines of application code plus a similar volume of tests; about 230 person-years in human terms.
- **Calendar (estimate):** with 3 parallel lanes and scheduled runs, 1.0 about 5–6 months after start and full parity in about 2 years; with one lane, 1.0 in about 12 months and parity in about 5 years. Every scenario ships 1.0 before Atlassian stops Data Center expansions on 30 March 2028 ([Atlassian](https://www.atlassian.com/licensing/data-center-end-of-life)).
- **From the user:** GitHub access, a Google Drive folder for reports, a benchmark machine, Docker or a VPS before the M1 install gates, a test domain, a usage and CI budget, an AI key with a spend cap, licence confirmation, lawyer sign-offs and design partners with real Jira data.
- **Biggest risks:** security bugs, drift across hundreds of sessions, tests that mirror code instead of spec, invented Jira behaviour, AI data leaks and prompt injection, deployment misconfiguration, and missing the DC window (section 12, risks.csv).

## 2. Product definition

"All Jira functionality" means the seven products the research identified plus the Marketplace categories customers buy most: scripting, time tracking, test management, hierarchy and BI ([Atlassian Marketplace](https://marketplace.atlassian.com/addons/app/jira/top-selling)).

| Area | What ships | When |
|---|---|---|
| Jira Software | Tracks, ticket types, unlimited hierarchy, typed fields with contexts and formulas, workflows with guards, checks, effects, boards, backlog, sprints, timeline, releases, dashboards, agile reports | M1 |
| Search | Native query language plus a JQL dialect (old and new vocabulary, history operators on every field) | M1 |
| Business tracks | List, calendar, timeline, summary (M1); forms, approvals, templates (M2) | M1–M2 |
| Admin and security (Guard) | SSO, SCIM, LDAP, 2FA, IP allowlists on the API, scoped tokens, audit, visibility levels (M1); BYOK, classification, SIEM, sandbox, HA (M2) | M1–M3 |
| APIs and migration | Native REST, Jira-compatible shim, signed webhooks, MCP; DC XML and Cloud importer, CSV, full export | M1 |
| AI (Rovo equivalent) | Summaries, NL to query, assisted creation, duplicates (M1); triage, NL automation, agents, semantic search (M2); virtual agent, incident AI (M3); evidence clustering, customer-service AI (M4) | M1–M4 |
| Automation and planning | Unmetered automation, roadmaps, approvals, capacity, hierarchy grid | M2 |
| Service desk core | Help portal, request forms, queues, SLAs, email, forms, CSAT, KB basics | M2 |
| ITSM, Opsgenie, Assets | Incident, problem, change, alerting, on-call, heartbeats, SMS and voice, status pages; unmetered CMDB with discovery | M3 |
| Discovery and Align | Ideas, evidence, formulas, public idea portal; OKRs, PI planning, SAFe, WSJF, budgets | M4 |
| Marketplace categories | Workflow functions (M1); scripting, time tracking, hierarchy, OData BI, dev integrations (M2); OLAP, test management (M4) | M1–M4 |

**Devices:** desktop first. Every screen is designed and polished for desktop browsers; the same frontend stays responsive and usable on phones and tablets (navigation drawer, touch-sized targets, touch drag and drop, no sideways scrolling), but desktop wins any trade-off (ADR-033). Native mobile apps remain an M3 item.

**Beyond parity:** ticket open under 100 ms; one configuration model, with legacy schemes mapped only by the importer, as Atlassian is itself simplifying ([Atlassian](https://support.atlassian.com/jira-cloud-administration/docs/what-are-field-configurations-and-field-configuration-schemes/)); no metering; no paywalls.

**Integrated, not rebuilt:** a Confluence-class wiki (link and embed XWiki, Outline, BookStack or Wiki.js; only service-desk KB articles are built, because a wiki is a separate product and the clearest route to the scope sprawl that sank Huly); chat (Slack, Teams, Mattermost, Matrix); a Backstage plugin instead of a Compass clone; source control, CI, BI tools, identity providers, SMTP, SMS, voice and LLMs as pluggable integrations. Out of scope: Loom-style video, Atlassian Talent, cross-tool enterprise search, running Forge or Connect apps.

## 3. Easy self-hosting

Self-hosting is a release gate. The Builder (section 5) writes the connection settings into both kits, so nothing is wired by hand.

1. Open the Builder page (or CLI), enter backend URL, frontend URL, name, branding and optional SMTP and AI key; download both kits.
2. Create the DNS records listed in the kit README; run `install.sh` (or `install.ps1`) on the server. It checks prerequisites, starts PostgreSQL, the backend and Caddy (automatic HTTPS), waits for health and prints the setup link.
3. Upload the frontend zip to any static host; open the setup link, use the one-time token and create the admin.

| Target | Measure | Checked by |
|---|---|---|
| Fresh VM to working app on a domain | < 15 min, DNS records already created | cross-origin e2e harness |
| Backend only, fresh VM to admin login | < 10 min on 2 vCPU / 4 GB Ubuntu 24.04 | nightly install matrix |
| Frontend kit | works on cPanel, S3 plus CDN, Netlify, Cloudflare Pages or nginx with zero configuration | cross-origin e2e |
| Install options | backend kit; Helm values; single-server mode (backend serves the frontend); no-Docker binary in M2 | install tests |
| Required state | PostgreSQL 16+ only; S3 and search optional | fitness test |
| Footprint | idle ≤ 1.5 GB RAM; 500 users on 4 vCPU / 8 GB within budgets | k6 load tests |
| Air-gap | zero outbound connections by default; signed offline bundle | no-egress VM test |
| Upgrades | 3 minor versions in one step, 0 manual steps; automatic backup; rollback; kits regenerated from the saved project file | upgrade matrix |
| Backups | daily by default; one-command restore; 1M tickets < 30 min; 30-day trash | restore drill |
| Health | /health, /ready, admin page (DB, queue lag, disk, backup age, certificates) | e2e |
| Platforms | amd64, arm64; Ubuntu, Debian, RHEL; Docker, Podman, Kubernetes | nightly matrix |

Published sizing (estimate until M1 load tests replace it): up to 50 users on 2 vCPU / 4 GB with bundled Postgres; up to 500 on 4 vCPU / 8 GB; up to 2,000 on 8 vCPU / 16 GB plus an external 4 vCPU / 16 GB Postgres; up to 10,000 on Helm HA (M2). That is near Plane's 2 vCPU / 4 GB floor ([Plane](https://developers.plane.so/self-hosting/methods/install-methods-commercial/docker-compose)) and far below self-hosted Sentry's 16 GB ([Bugsink](https://www.bugsink.com/blog/why-i-gave-up-on-self-hosted-sentry/)).

## 4. How Claude works on this

### Where things live

- **Code:** a local git repo at `E:\programing\Projects\Web\Tracksmith`, pushed to `github.com/Rockersands/tracksmith` (personal account). Commits are authored as `Rockersands <42122514+rockersands@users.noreply.github.com>` through the repo's local git config. The user creates the repo or authorises access; GitHub CLI is not installed yet. Packages are named `@taskmoor/*`.
- **Docs for the user, weekly reports and milestone release packages:** the user's Google Drive folder, written through the Drive connector or a folder synced by Google Drive for desktop. Engineering docs stay in the repo.
- **Local environment:** the user's machine has Node 22 and git but no Docker, so local tests use an embedded Postgres (PGlite or embedded-postgres). Container builds and tests run on GitHub runners and the benchmark host. Docker Desktop or a Linux VM/VPS is needed before the M1 install and cross-origin gates.

### State lives in the repository

| File | Purpose |
|---|---|
| `CLAUDE.md` | Conventions, commands, module map, hard rules (clean room, licences, tests); under 300 lines |
| `docs/specs/<module>.md` | Requirement IDs and behaviour in Claude's words, with provenance |
| `docs/adr/`, `docs/modules/` | Binding decisions; module invariants, interfaces, owned tables |
| `backlog/backlog.csv` | Rows as in backlog.csv plus Status, Lane and PR columns |
| `backlog/decisions.csv`, `risks.csv` | Owner decisions and risk register |
| `HANDOFF.md` | Current state, next steps, blockers; under 150 lines |
| `STATUS.md`, `docs/status/` | Progress summary and weekly reports (copied to Drive) |
| `tools/` | `next-task`, `gate`, `trace`, `check-governance` |

### Task lifecycle

1. Read `CLAUDE.md` and `HANDOFF.md`; run `tools/next-task` (or take the lane's assigned task) and mark it in progress.
2. Read the cited spec sections, ADRs and module docs; split an M or L row into session-sized sub-tasks (M1-045.1, M1-045.2).
3. Write failing tests that cite requirement IDs.
4. Implement inside the module's boundary.
5. Run full local CI: lint, types, unit, integration, affected e2e, boundaries, licences, perf smoke.
6. Self-review with `/code-review`; run `/security-review` on IAM, API, importer, extension, AI or Builder changes. Fix findings.
7. Commit with DCO sign-off; open a PR naming the task ID; merge only when GitHub CI is green.
8. Update the backlog row and `HANDOFF.md`; add owner questions to decisions.csv.

**Sizing:** one task is one session-sized change of about 300–1,500 lines including tests, inside one module. Backlog sizes: S = 1 task, M = 2–3, L = 4–6. M2–M4 rows are epics (S ≈ 10 tasks, M 15–40, L 40–100), split into task rows when each milestone starts.

### Parallel work, schedules and reporting

- **Lanes:** each lane is a session in its own git worktree, one branch per task, on tasks from different modules. A coordinator session assigns lanes, merges green PRs in dependency order and resolves conflicts. 1 lane in M0, 3 from M1, more only while CI time and conflicts stay low.
- **Subagents** explore code, write spec-derived tests without seeing the implementation, review and draft docs. The **Workflow tool** is used only after the user opts in, for batches of independent items (query functions, importer mappers, translations, the parity audit).
- **Scheduled runs:** work sessions in hours the user approves; nightly full CI, benchmarks at 1M and 10M tickets (30M weekly), install, upgrade and cross-origin matrices, security scans and an AI smoke test. Failures become top-priority tasks.
- **Reporting:** a short weekly report (tasks done versus estimate, CI health, performance, risks, decisions needed with dates) in Drive; per milestone, a release package in Drive, a candidate on the demo host and a 1–2 hour acceptance script; urgent items as GitHub issues labelled `needs-owner`.

### Consistency across hundreds of sessions

ADRs are binding and change only through a superseding ADR. Lint enforces module boundaries; fitness tests check that every table has `workspace_id`, every route has an authorization check and Postgres is the only required service. Snapshots of the OpenAPI contract, database schema and event catalogue fail CI on unreviewed change. Golden tests cover reports, importer output and compiled SQL. A generated code map orients new sessions, and every ~50 tasks an architecture-review task looks for drift and duplication.

### Dependency and licence hygiene

Allowed: MIT, BSD, Apache-2.0, ISC, MPL-2.0, PostgreSQL, CC0 and other AGPL-compatible licences. Denied: SSPL, BSL, FSL, Commons Clause, GPL-2.0-only, non-commercial and unlicensed code. Each new runtime dependency needs a PR note (purpose, licence, maintenance); large ones need an ADR. CycloneDX SBOM per release, weekly Dependabot (ADR-029), pinned lockfile, ScanCode snippet scan before releases, no code pasted from the web.

## 5. Architecture and stack

Claude records these decisions as ADRs in M0; starred ones are confirmed by spike benchmarks.

| ADR | Decision | Why |
|---|---|---|
| 001 | Decisions recorded as ADRs (MADR) | Sessions forget |
| 002 | AGPL-3.0, DCO, always-free charter (confirmed by the user on 2026-10-12) | OSI licence for public buyers |
| 003 | Clean-room rules enforced in CI | Contracts are the main legal risk |
| 004 | Modular monolith, pnpm workspaces with TypeScript project references, enforced boundaries; Turborepo added when build caching pays off | One image, clear modules |
| 005 | TypeScript end to end: Node.js LTS, React | Shared code for optimistic sync |
| 006 | PostgreSQL 16+ only; `workspace_id` everywhere; partitioned history; embedded Postgres for local dev | Simple self-hosting |
| 007 | Typed SQL builder (Kysely), SQL migrations | Predictable SQL |
| 008* | Field definitions, JSONB values, typed side tables | Field count drove Jira latency ([Atlassian](https://confluence.atlassian.com/enterprise/managing-custom-fields-in-jira-effectively-945523781.html)) |
| 009 | One configuration model; legacy schemes mapped in the importer | Simpler admin |
| 010* | Own grammar, AST, resolver, SQL with permission pre-filter; JQL as a dialect | No open JQL compiler ([Atlassian](https://atlaskit.atlassian.com/packages/jql/jql-parser)) |
| 011 | Postgres full-text; optional OpenSearch | One stateful service |
| 012* | OpenFGA-style model plus permission cache | 10 ms checks ([Atlassian](https://www.atlassian.com/blog/how-we-build/how-we-unlocked-performance-at-scale-with-jira-platform)) |
| 013* | Change log, monotonic sequence, sync groups, IndexedDB, outbox | Speed ([reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine)) |
| 014* | Tiptap, Yjs, Hocuspocus; ADF originals kept | Lossless import |
| 015* | Transactional outbox plus Postgres queue | No broker |
| 016 | Contract-first OpenAPI 3.1; compat shim as separate package | Legal separation |
| 017 | Webhooks with HMAC, idempotency, replay, no expiry | Known Jira pain |
| 018 | MCP server over the native API | Agents as clients |
| 019 | OIDC, SAML, LDAP, SCIM, TOTP, WebAuthn | Free identity |
| 020 | S3 API with local-disk fallback | Optional store |
| 021 | One multi-arch backend image (roles by env var); static frontend; Compose plus Caddy kit; Helm; signed air-gap bundle | Install in minutes |
| 022 | Forward-only expand/contract migrations, pre-flight, auto backup | Unattended upgrades |
| 023 | OpenTelemetry, Prometheus | Standard tooling |
| 024 | ICU MessageFormat; WCAG 2.1 AA | Public buyers |
| 025* | Staged idempotent importer; streaming DC XML; Cloud REST with customer token | Beyond Atlassian's tool ([Atlassian](https://support.atlassian.com/migration/docs/what-gets-migrated-with-the-jira-cloud-migration-assistant/)) |
| 026 | WASM extensions via Extism; iframe UI slots | Sandboxing ([Extism](https://extism.org)) |
| 027 | Daily snapshot store over OData | BI without another DB |
| 028* | AI provider gateway | AI with the admin's key |
| 029 | Licence allowlist, SBOM | No contamination |
| 030 | Test strategy: spec IDs, conformance, golden, property, perf | CI decides "done" |
| 031 | Builder: browser page plus CLI on one core; two kits; signed connection manifest | Zero hand wiring |
| 032 | Cross-origin auth and versioning: SameSite cookies or OAuth 2.1 PKCE; meta endpoint; N-1 compatibility | Frontend anywhere |
| 033 | Desktop-first responsive UI: desktop is the primary target; phones and tablets must work; e2e runs on a desktop and a mobile viewport | User priority: PC first, mobile must work |
| 034 | Audit log: append-only monthly partitions, one SHA-256 hash chain per workspace, retention that drops whole months behind a checkpoint | Tamper-evident audit without a 180-day ceiling (IAM-013) |
| 035 | API tokens and service accounts: `tmk_` prefix and checksum, SHA-256 at rest, read / write / admin scopes checked per route, mandatory capped expiry, rotation with overlap, service accounts as non-person users | Programs get the people's permission model; leaked tokens findable and revocable |
| 036 | Skins: named token sets on `data-skin` (light and dark first), chosen under Account and saved with it, applied before first paint; soft pastel visual language with contrast measured and axe run in every skin | The user's requested look; room for more skins without code changes |

### AI provider gateway (ADR-028, shipped in M1)

- **One provider interface;** each adapter uses its vendor's official SDK. Anthropic Claude is first class through `@anthropic-ai/sdk`, plus `AnthropicBedrockMantle` (`@anthropic-ai/bedrock-sdk`), `AnthropicVertex` (`@anthropic-ai/vertex-sdk`) and `AnthropicFoundry` (`@anthropic-ai/foundry-sdk`) for existing cloud accounts. Other providers get adapters; an OpenAI-compatible adapter covers Ollama and vLLM for air-gapped installs.
- **Admin "AI settings":** choose provider; paste a key (or supply `ANTHROPIC_API_KEY` or the backend kit's `.env`, imported into encrypted storage on first boot); "test connection" lists live models from the Models API; model and effort per feature; workspace and track switches; spend limits and usage dashboard.
- **Models:** `claude-opus-5-5` for every feature by default; admins may pick `claude-sonnet-5-5` or `claude-haiku-5-5` per feature. Exact IDs, no date suffixes. Effort is set per feature (low for classification and summaries, medium for drafting, high for agents), because Opus 5.5 defaults to medium and its thinking cannot be disabled.
- **Request policy:** streaming for long outputs; structured outputs (`output_config.format`) for triage, query and classification; strict tools with `tool_choice` auto (forced tool choice returns a 400 on Opus 5.5 and Sonnet 5.5); prompt caching with a stable system prompt and tool list first, verified by `usage.cache_read_input_tokens`; Message Batches (about 50% cheaper) for bulk jobs; `stop_reason: "refusal"` handled with server-side fallbacks where offered and SDK fallback middleware elsewhere; typed retries for 429 and 5xx; optional `inference_geo`; compaction and task budgets for long agent runs.
- **Keys and privacy:** keys envelope-encrypted (kit master key, KMS or Vault), write-only in the UI (last 4 characters shown), never sent to browsers or logs, never placed in the frontend kit, rotated without downtime. An AI audit log records who, feature, model, tokens and cost, not content. Per-track off switch, field redaction, a plain notice of what leaves the server, and a strict (HIPAA) mode that keeps AI off unless the admin opts in; Atlassian's HIPAA customers must switch AI off entirely ([Atlassian](https://support.atlassian.com/organization-administration/docs/the-hipaa-implementation-guide)).
- **No key, no AI controls.** Duplicates and semantic search use a bundled local embedding model with pgvector.

### Builder and two-kit delivery (ADR-031, ADR-032, shipped in M1)

- **Where it runs:** a static web page that works entirely in the browser (secrets from WebCrypto, zips built locally, nothing sent anywhere) and a CLI on the same core for automation. A saved project file (secrets excluded or passphrase-encrypted) regenerates kits for upgrades or rebranding.
- **Inputs:** backend URL (e.g. `https://api.example.com`), frontend URL (e.g. `https://app.example.com`), instance name, branding, default language, routing mode, optional SMTP, optional AI provider and key, deployment target (Compose on a VPS by default; Helm values; single binary in M2).
- **Backend kit:** `docker-compose.yml` pinned to the exact image version, PostgreSQL and Caddy for automatic HTTPS; `.env` with fresh secrets (database password, token-signing keys, the master key for stored AI keys, a one-time setup token), `PUBLIC_URL`, `ALLOWED_ORIGINS`, OAuth redirect URIs and `INSTANCE_ID`; `install.sh` and `install.ps1`; a README listing DNS records.
- **Frontend kit:** a zip (or one self-contained `index.html`) of the static app for the same version, with public config inlined (API and WebSocket URLs, instance ID, key fingerprint, branding, routing mode), SRI hashes and `.htaccess`, `_redirects` and nginx fallbacks for clean URLs; hash routing for hosts without rewrites. No secret is ever baked in.
- **Connection manifest:** signed and shared by both kits; the frontend checks that the backend's public meta endpoint returns the same instance ID and key, so a bundle cannot talk to the wrong backend.
- **Versions:** the meta endpoint reports API version and minimum frontend version; the backend keeps N-1 compatibility; old bundles show "update available". The admin area lists registered frontends and versions, adds origins and can serve the frontend on its own origin for a single-server install.
- **Auth:** sibling subdomains (`app.` and `api.`) use SameSite cookies; cross-site setups use OAuth 2.1 with PKCE, short-lived bearer tokens and refresh-token rotation. Strict CORS, CSP and WebSocket origin checks.

### Layout, data model and boundaries

```
apps/      server (api, worker, realtime), web (static), builder (static), cli, mobile (M3)
packages/  core, workflow, query, agile, reporting, notify, iam, sync, richtext,
           api-native, api-jira-compat, webhooks, mcp, ai-gateway, builder-core,
           importer-jira, storage, jobs, extensions, ui, sdk, testkit
deploy/    kits, allinone, helm, airgap      docs/ backlog/ bench/ e2e/ tools/
```

**Core entities:** workspace; user, group, role, service account, token; track; ticket type and hierarchy level; ticket; field definition, context, field rules, layout; workflow, status, transition, rule; board, sprint, release, area; saved search, subscription, dashboard, widget; comment, time entry, attachment, link, follower, vote; access policy, grant, visibility level; audit event; change-log entry; sync-log entry; notification; webhook subscription; registered frontend origin; AI provider config and usage record; import job and external-ID map.

**Boundaries:** each package owns its tables and exposes a typed service interface; others call it or consume domain events, never its tables. The Jira shim and importer are adapters over public services, removable without touching the core. Only `ai-gateway` can decrypt AI keys.

## 6. Milestones

| Milestone | Release | App KLOC (est.) | Tasks (est.) | Sessions (est.) |
|---|---|---|---|---|
| M0 Foundation | skeleton | 8 | 72 | 85–110 |
| M1 Jira Software + DC exit | 1.0 | 102 | 370 | 445–555 |
| M2 Enterprise, automation, service desk | 2.0 | 170 | 600 | 720–900 |
| M3 ITSM, operations, CMDB | 3.0 | 220 | 770 | 925–1,155 |
| M4 Discovery, portfolio, quality | 4.0 | 200 | 700 | 840–1,050 |
| Total | | 700 | 2,512 | 3,000–3,800 |

Sessions are tasks × 1.2–1.5 for rework and review fixes. KLOC ranges: M0 5–12, M1 90–120, M2 145–205, M3 180–260, M4 160–240.

**M0 Foundation.** Goal: repo, governance, CI, clean-room protocol, spikes, AI gateway design, backend install skeleton. Gate: ADR-001 to 032 accepted; spikes meet budgets (query p95 < 300 ms and field edit p95 < 50 ms at 10M tickets, permission check p95 < 10 ms); tests green on embedded Postgres locally and PostgreSQL 16 in CI; scans and nightly benchmarks running; skeleton install < 10 min on 5 OS images. User provides: GitHub access, Drive folder, benchmark runner, budget, licence confirmation, counsel review. Acceptance: the user reads the first weekly report and tries the skeleton on a CI-built VM.

**M1 Jira Software parity and DC-exit core (1.0).** Goal: a team leaves Jira DC or Cloud with data, filters, scripts and integrations intact, deployed from Builder kits. Scope: CORE, WF, QRY, AGL, RPT, NTF, API, IMP, IAM, OPS (Builder), NFR, AI v1, time entries. Gate: query conformance 100%; compat API suite 100% for in-scope endpoints and 3 client libraries pass; synthetic 1M-issue DC backup imported at ≥ 99.9% entity fidelity in < 4 h; query p95 < 300 ms at 1M tickets, with 10M and 30M documented as estimates (the user's decision of 2026-11-01: no 10M machine for 1.0); ticket open < 100 ms warm; 5,000-card board < 1 s; the Builder emits both kits, `install.sh` brings the backend kit up on a fresh VM, and the frontend zip on a plain static server at another origin passes the full e2e suite (login, create ticket, board, query search, realtime update) with zero manual configuration; fresh VM to working app < 15 min; an N-1 bundle still works; 3-minor upgrade with 0 manual steps; AI evals met (NL to query ≥ 85% exact-result match) and AI hidden with no key; axe 0 serious; ASVS L2 complete; 0 high or critical findings. User provides: Docker or a VPS, test domain and static host, AI key with spend cap, design partners, signing keys, counsel review of shim and importer. Acceptance: the user deploys from the Builder and starts using it at a new company of their own (design partners dropped on 2026-11-01).

**M2 Enterprise, automation and service-desk core (2.0).** Scope: AUT, PLN, TIM, EXT, OData, DEV, AI v2 and agents, SD, KB basics, HA, sandbox, BYOK, SIEM, offline PWA, single-binary backend, other importers. Gate: automation and SLA suites 100%; roadmaps golden tests; HA chaos recovery < 60 s with 0 lost writes; WASM sandbox suite clean; injection red-team 0 unauthorised writes; budgets at 30M tickets; pen test findings closed. Acceptance: a service-desk pilot.

**M3 ITSM, operations and CMDB (3.0).** Scope: ITSM, ONC, STS, CMDB, KB, AI (virtual agent, incident summaries, alert grouping), MOB. Gate: alert-to-page p95 < 30 s via provider sandboxes; escalation suite incl. DST 100%; CMDB 1M-object query p95 < 500 ms; status page 10k requests/s from cache; store builds approved; chaos and restore drills pass. Acceptance: an on-call rota trial.

**M4 Discovery, portfolio, quality and ecosystem (4.0).** Scope: DSC, PRT, QA, OLAP, whiteboards, customer service, extension registry, compliance builds. Gate: traceability shows 100% of parity requirements covered by passing tests; FIPS-mode self-tests pass; registry rejects unsigned packages. Acceptance: a parity walk-through.

## 7. Verification without human developers

CI decides "done"; tests come from the spec, not the code.

| Check | Proves | When |
|---|---|---|
| Spec-derived tests citing requirement IDs | Behaviour matches spec | every PR |
| Query conformance suite (1,500+ cases, own words) | JQL compatibility | every PR |
| Jira-compatible API contract tests, client libraries | Scripts keep working | every PR |
| Importer golden fixtures: synthetic DC XML and Cloud API recordings from public format docs; design-partner fidelity reports | Migration fidelity | nightly; beta |
| Property tests and fuzzing (parsers, permissions, formulas, WASM host) | Invariants, no crashes | nightly |
| Mutation testing on core modules | Tests catch faults | weekly |
| Benchmarks at 1M, 10M, 30M tickets | Performance budgets | nightly, weekly |
| Upgrades N-3 to N with data; N-1 frontend against N backend | Zero manual steps, no skew breakage | every release |
| Fresh-VM installs (Ubuntu, Debian, RHEL, arm64), air-gap | < 10 min, no egress | nightly |
| Cross-origin harness: Builder kits, fresh VM, static host on another origin | Zero-config deployment, < 15 min | nightly |
| Playwright e2e; axe, keyboard, pseudo-locale, RTL | Journeys, WCAG 2.1 AA, i18n | every PR |
| SAST, dependency, licence, secret, container scans; DAST; bundle secret scan | Known weaknesses | every PR, nightly |
| AI evals and prompt-injection corpus | Quality and safety | nightly |
| Chaos and backup-restore drills; external pen test (user-procured) | Recovery; independent assurance | weekly from M2; before 1.0 and 2.0 |

A separate subagent writes conformance tests from the spec before implementation; the implementing session may change them only with a spec change. No fixture comes from an Atlassian account.

## 8. Clean-room and legal protocol

Contracts and trademarks, not API copyright, set the perimeter. Claude follows these rules, and CI checks what it can.

1. **No Atlassian accounts** for development, testing or benchmarks. Customer Agreement §2.2(d) bars using the products "to develop a similar or competing product" ([Atlassian](https://www.atlassian.com/legal/atlassian-customer-agreement)); Developer Terms §6(f) bar building a competitive product on the platform and §6(i) bar competitive analysis and publishing benchmarks ([Atlassian](https://developer.atlassian.com/platform/marketplace/atlassian-developer-terms/)). If credentials appear, Claude stops and reports.
2. **No Atlassian code or assets:** no decompiling (§2.2(e)), no copied code, UI assets or icons, no use of Atlassian's JQL parser package.
3. **Public docs only, in Claude's words,** with source URL and access date per spec; no copied text, examples or screenshots; Claude writes its own OpenAPI file for the shim.
4. **Memory is not a source:** recollections of Jira need a public source or an "unverified" tag checked against design-partner data.
5. **Separable compatibility layer:** *SAS v. World Programming* protects manuals and possibly keyword selection ([Wikipedia](https://en.wikipedia.org/wiki/SAS_Institute_Inc_v_World_Programming_Ltd)); *Google v. Oracle* found reimplementing declaring code fair use ([Jones Day](https://jonesday.com/de/insights/2021/04/supreme-court-google-wins-copyright-battle)). JQL and the Jira-shaped REST API are optional modules over a native language and API.
6. **Trademark:** no "Jira" or "Atlassian" in the name, repo, domains, packages or logo; "compatible with Jira" with a non-affiliation note is allowed ([Atlassian](https://www.atlassian.com/legal/trademark)). The codename Tracksmith also needs screening before public release.
7. **Importer** ships inside the product, run by customers with their own backups or tokens; never a Marketplace, Forge or Connect app.
8. **Real data** only from its owners under written permission; by default Claude sees fidelity reports, not content.
9. **Licence:** AGPL-3.0 with DCO sign-off, as GitLab chose over a CLA ([GitLab](https://about.gitlab.com/blog/gitlab-switches-to-dco-license/)), plus an always-free charter. Confirmed by the user on 2026-10-12. The GitHub account stays on the free plan, so DCO is enforced by a CI check and local git hooks instead of branch protection.
10. **Patents:** freedom-to-operate review before source-control integration and chat-to-ticket AI ([Google Patents](https://patents.google.com/patent/US12032954)).
11. **Contamination:** remove, rewrite from clean sources, log.

**Lawyer sign-off (Claude prepares each brief):** clean-room protocol and licence (M0); public name clearance (before public release); compatibility shim, use of Atlassian's API descriptions, importer distribution and design-partner data agreements (before the M1 beta); AI data notice (M1); patent FTO (before M2 integrations); hosted-service terms (if any); export-control and FIPS claims (M4). This plan is not legal advice.

## 9. What Claude needs from the user

| Item | Why | Needed by |
|---|---|---|
| Repo `github.com/Rockersands/tracksmith` created, or access authorised (install GitHub CLI and log in, or a token) | Push code, run CI | M0 |
| Google Drive folder with connector access, or a synced local folder | Reports, docs, release packages | M0 |
| Benchmark runner (16+ vCPU, 64 GB RAM, 1 TB NVMe) and cloud VM access | 10M-ticket benchmarks, install matrix | M0 |
| Budget for Claude usage and CI; lane count and scheduled hours | Sets the pace | M0 |
| Licence confirmation (AGPL-3.0, DCO, charter) | LICENSE file | Done (2026-10-12) |
| Lawyer sign-offs (section 8) | Legal safety | M0, M1 beta, M2 |
| Workflow tool opt-in | Fan-out batches | M1 |
| Docker Desktop or a Linux VM/VPS | Install and cross-origin gates | M1 |
| Test domain with DNS control (app. and api.) and a plain static host | Builder e2e, demo | M1 |
| AI key or cloud account (Anthropic API, Bedrock, Vertex or Foundry) with a test spend cap | Build and test AI | M1 |
| Design partners or Jira exports from their owners | Real-data fidelity | M1 beta |
| Signing keys (or keyless signing approval) and a container registry | Signed releases | M1 |
| Email-sending account; security contact for vulnerability reports | Demo; a human must answer | M1 |
| Translation reviewers; external pen test vendor | i18n; assurance | M1, before 1.0 and 2.0 |
| Test tenants (GitHub, GitLab, Microsoft 365, Google Workspace); optional GPU host | Integration, email and local AI tests | M2 |
| SMS and voice accounts; Apple and Google developer accounts | On-call, mobile | M3 |
| SOC 2 auditor, if a hosted service is offered | Hosted compliance | M2–M3 |
| Final public name decision after screening | Public release | before public release |
| Acceptance time (about half a day per gate) and answers in decisions.csv | Gates, unblocking | ongoing |

## 10. What Claude cannot do alone

Sign contracts or legal documents; register trademarks; own accounts, buy domains or create DNS records (Claude acts only through access the user grants); hold signing keys securely long-term; publish to app stores; obtain certifications or be the accountable security contact; guarantee security without an external audit; work while no session runs; remember anything not written to the repo, Drive or memory; use real customer data without permission or recruit design partners; judge product fit, which the user's acceptance does.

## 11. Effort and timeline

**Scale (human-equivalent, for sizing only):** the exit core is about 100K lines of application code, about 25 person-years; full parity is about 700K lines plus roughly as much test code, about 230 person-years, from COCOMO on measured Plane and OpenProject code ([Plane](https://github.com/makeplane/plane); [OpenProject](https://github.com/opf/openproject)). These figures size the work; they are not a staffing plan.

**Agent terms (estimate):** about 2,512 tasks and 3,000–3,800 sessions (section 6).

| Scenario | Setup | Tasks/week | 1.0 | Full parity |
|---|---|---|---|---|
| A Single lane | 1 lane, mostly user-started sessions | ~10 | ~Nov 2027 | ~end 2031 |
| B Recommended | 3 lanes, scheduled runs day and night | ~30 | ~Apr 2027 | ~Nov 2028 |
| C Maximum | 6+ lanes, Workflow fan-out | ~50 | ~Apr 2027 | ~Apr 2028 |

Assumptions: start November 2026; floors of 6 weeks for M0 (legal review, accounts) and 16 weeks for M1 (design-partner beta); 2–6 weeks per gate. Releases 2.0 and 3.0 land about Jan 2029 and Aug 2030 in A, Oct 2027 and May 2028 in B, Jul 2027 and Dec 2027 in C. Speed is wasted if gates wait on the user.

**Deadlines:** every scenario ships 1.0 before DC expansions end on 30 March 2028 and the service desk before DC turns read-only on 28 March 2029 ([Atlassian](https://www.atlassian.com/licensing/data-center-end-of-life)); scenario A leaves only about 10 weeks of margin. On-call (M3) arrives after Opsgenie's 5 April 2027 end of support in every scenario ([Atlassian](https://support.atlassian.com/jira-service-management-cloud/docs/should-i-merge-opsgenie-with-jira-service-management/)), so it is not a launch market. Claude re-forecasts from measured throughput after M0 and every 100 tasks.

## 12. Risks

The full register is risks.csv (22 rows). The most serious:

- **Security bugs** (authorization, query compiler, SAML, CORS, WASM): security review on sensitive changes, property tests, fuzzing, external pen tests.
- **Drift across sessions and lanes:** ADRs, boundary lint, fitness tests, contract snapshots, architecture reviews.
- **Tests that mirror code; invented Jira behaviour:** spec-first tests by a separate subagent, mutation testing, sourced specs, design-partner data.
- **AI leaks, injection and cost:** strict mode, redaction, content treated as data, confirmation before writes, spend caps, red-team suite.
- **Deployment misconfiguration and version skew:** one Builder form for both kits, signed manifest, install checks for DNS and HTTPS, N-1 compatibility, update banner.
- **Missing the DC window, scope sprawl, performance at scale:** importer-first scope, hard gates, nightly 10M-ticket benchmarks.

## 13. First steps (M0, in order)

1. M0-001 Init the Taskmoor repo, push to `github.com/Rockersands/tracksmith`, DCO check (CI and hooks; no branch protection on the free plan).
2. M0-002 Write CLAUDE.md, HANDOFF.md and STATUS.md.
3. M0-003 Add the CSVs and `tools/next-task`.
4. M0-004 ADR process plus ADR-001 to 003.
5. M0-005 Clean-room protocol; request counsel review.
6. M0-006 Provenance check in CI.
7. M0-007 Public-name screening of Taskmoor and alternatives.
8. M0-008 Monorepo scaffold with `@taskmoor/*` packages.
9. M0-009 Embedded-Postgres test harness for Docker-free local work.
10. M0-010 Module boundary rules and fitness tests.
11. M0-011 GitHub Actions pipeline.
12. M0-012 Security and licence gates, SBOM, Dependabot.
13. M0-013 Import the requirements spec with IDs.
14. M0-014 Traceability tool.
15. M0-015 Synthetic data generator up to 30M tickets.
