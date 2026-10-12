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
| M0-001 Repo and governance | Partial | Repo, remote, SECURITY.md done. DCO and branch protection wait on the licence decision |
| M0-002 CLAUDE.md, HANDOFF.md, STATUS.md | Partial | Files written; governance check tool still to do |
| M0-003 Backlog CSVs and next-task | Partial | CSVs imported; tool still to do |
| M0-004 ADR process, ADR-001 to 003 | Partial | Written; markdown lint and link check still to do |
| M0-008 Monorepo scaffold | Done | Biome instead of ESLint and Prettier (ADR-004) |
| M0-009 Embedded Postgres harness | Done | CI runs the same suites on Postgres 16 and 18 |
| M0-011 GitHub Actions | Partial | Lint, types, tests, e2e; image build comes with M0-025 |
| M0-031 and M0-032 Design system and shell | Started | Tokens and responsive shell; Storybook, axe and i18n still to do |
| All other M0 tasks | Not started | |
