# Status

Updated 2026-10-12. The task list lives in [docs/plan/backlog.csv](docs/plan/backlog.csv).

## Milestones

| Milestone | Scope | State |
|---|---|---|
| M0 Foundation | Repo, test backbone, CI, ADRs, spikes, install skeleton | In progress |
| M1 Release 1.0 | Jira Software parity, query language, importer, SSO, Builder, AI gateway | Not started |
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
| M0-005 Clean-room protocol | Done | `docs/legal/clean-room.md`; counsel review requested |
| M0-006 Provenance check | Done | Spec front matter checked in `pnpm verify` |
| M0-007 Public name screening | Waiting on the user | Shortlist in `docs/decisions/name.md` |
| M0-008 Monorepo scaffold | Done | Biome instead of ESLint and Prettier (ADR-004) |
| M0-009 Embedded Postgres harness | Done | CI runs the same suites on Postgres 16 and 18 |
| M0-010 Module boundaries | Done | dependency-cruiser rules with a failing fixture |
| M0-012 Security and licence gates | Done | Licence allowlist and secret scan in `pnpm verify`; SBOM and Trivy in CI (ADR-029) |
| M0-013 Spec import and IDs | Done | 347 requirements; spec lint in `pnpm verify` |
| M0-014 Traceability | Done | `pnpm trace`; unknown IDs cited by tests fail |
| M0-015 Synthetic data generator | Done | `pnpm gen --items N`; deterministic; COPY loader with verified counts |
| M0-016 Field storage spike | In progress | 1M run done: side tables win; 10M run pending for ADR-008 |
| M0-017 Query compiler spike | In progress | `@tracksmith/query` parser, resolver, compiler; 10M timing pending for ADR-010 |
| M0-020 Rich text spike | Done | `@tracksmith/richtext`, Yjs and Hocuspocus verified (ADR-014) |
| M0-021 Queue spike | Done | In-house SKIP LOCKED queue chosen (ADR-015) |
| M0-023 AI gateway skeleton | Done | `@tracksmith/ai` with contract tests (ADR-028) |
| M0-018 Permission engine spike | Done | In-process evaluator 1.5 ms p95 vs OpenFGA 15.9 ms; pre-filter overhead measured (ADR-012) |
| M0-019 Sync engine spike | Done | In-house change log: 52k-item bootstrap in 2.6 s, delta p95 1 ms, idempotent outbox (ADR-013) |
| M0-022 XML parser spike | Done | 5 GB parsed in 2.6 min at 303 MB RSS, lossless after cleaning (ADR-025) |
| M0-024 Remaining ADRs | In progress | 31 of 33 accepted; 008 and 010 wait for the 10M run |
| M0-033 Nightly benchmarks and weekly report | Done | bench:check with budgets and a 20% regression check; status-report; nightly job green on main with its results as the CI baseline |
| M0-011 GitHub Actions | Done | Lint, types, tests, e2e, Postgres 16 and 18, weekly Windows, security scan, multi-arch image build, nightly benchmarks |
| M0-026 All-in-one image and Compose kits | Done | deploy/allinone and deploy/compose; smoke-kits.sh green locally and in CI |
| M0-027 First-run setup | Done | Setup link with a one-time token, admin creation, cookie sessions and sign-in; e2e on the real backend |
| M0-025 Single image | Done | Roles by TRACKSMITH_ROLE, esbuild bundle, multi-arch Dockerfile; smoke test green on amd64 and arm64; CI builds both |
| M0-031 Design system | Done | Tokens, shell components, Storybook with axe on every story (ADR-024) |
| M0-032 App shell | Done | Hash routing, session guard stub, command palette, ICU i18n, pseudo-locale checks |
| M0-035 DCO enforcement | Done | Git hooks, `pnpm dco` and CI; no branch protection on the free plan |
| M0-029 Migrations and upgrade harness | Done | Forward-only migrations, upgrade tests from the last three releases' schemas, `node cli.mjs check-upgrade`, `migrate` and `status` in the image |
| M0-030 Backup and restore | Done | `node cli.mjs backup`, `restore --yes` and `checksum`; drill (back up, wipe, restore, compare) green locally and in CI |
| M0-028 Install matrix | Done | Nightly workflow green on five images: 17 to 18 s to /ready on Ubuntu 22.04, 24.04 and arm64; 36 s in Debian 12 and Rocky 9 containers with prerequisites |
| M0-034 M0 gate | In progress | pnpm gate M0 prints the exit checklist; waits on the 10M run, Docker items, counsel and user acceptance |
| All other M0 tasks | Not started | |

## M1 tasks started early

| Task | State | Notes |
|---|---|---|
| M1-022 Workflow behaviour spec and conformance suite | Done | `@tracksmith/workflow`: 374 data cases for WF-001 to WF-012, `pnpm conformance` reports per section; reference model passes all |
| M1-033 Query conformance suite | Done | 2,220 data cases for QRY-001 to QRY-013 in `@tracksmith/query`; `pnpm conformance query` reports the pass rate per section (grammar 100%, 76% overall); the rates are a golden |
| M1-034 Native grammar and parser | In progress | Grammar spec (file 06), error recovery with line, column and hints, nesting limit, 1,000+ parser tests; the one-hour fuzz run is in progress |
| M1-035 Jira-compatible dialect | In progress | `toNative` and `toJira` rename fields and functions between the vocabularies on the shared tree; parse cases 100% green |
| M1-103 Health page, metrics, traces | Done | /metrics on port 9464, OTLP traces when configured, admin System status page, example alerts and dashboard; CI green |
| M1-099 Helm chart | In progress | Chart, lint and render tests, kind test and workflow; install and helm test pass on kind, rolling-upgrade run pending |
