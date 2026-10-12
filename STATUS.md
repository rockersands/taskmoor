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
| M0-004 ADR process, ADR-001 to 003 | Done | ADR-002 stays Proposed until the licence is confirmed |
| M0-005 Clean-room protocol | Done | `docs/legal/clean-room.md`; counsel review requested |
| M0-006 Provenance check | Done | Spec front matter checked in `pnpm verify` |
| M0-008 Monorepo scaffold | Done | Biome instead of ESLint and Prettier (ADR-004) |
| M0-009 Embedded Postgres harness | Done | CI runs the same suites on Postgres 16 and 18 |
| M0-010 Module boundaries | Done | dependency-cruiser rules with a failing fixture |
| M0-012 Security and licence gates | Done | Licence allowlist and secret scan in `pnpm verify`; SBOM and Trivy in CI (ADR-029) |
| M0-013 Spec import and IDs | Done | 347 requirements; spec lint in `pnpm verify` |
| M0-014 Traceability | Done | `pnpm trace`; unknown IDs cited by tests fail |
| M0-011 GitHub Actions | Partial | Lint, types, tests, e2e; image build comes with M0-025 |
| M0-031 and M0-032 Design system and shell | Started | Tokens and responsive shell; Storybook, axe and i18n still to do |
| M0-035 DCO and branch protection | Waiting on the user | Needs the licence decision |
| All other M0 tasks | Not started | |
