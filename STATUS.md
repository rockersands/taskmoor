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
| M0-001 Repo and governance | Partial | Repo, remote, SECURITY.md done; first push waits on the GitHub sign-in |
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
| M0-011 GitHub Actions | Partial | Lint, types, tests, e2e; image build comes with M0-025 |
| M0-031 Design system | Done | Tokens, shell components, Storybook with axe on every story (ADR-024) |
| M0-032 App shell | Done | Hash routing, session guard stub, command palette, ICU i18n, pseudo-locale checks |
| M0-035 DCO enforcement | Done | Git hooks, `pnpm dco` and CI; no branch protection on the free plan |
| All other M0 tasks | Not started | |
