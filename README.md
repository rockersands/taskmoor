# Taskmoor

Open-source, self-hostable work tracking: Jira-class projects, boards, workflows, queries, service
desk and planning, with every premium feature included and AI that runs on the administrator's
own key.

**Status:** M0 (foundation) accepted; M1 (release 1.0) in progress. Nothing here is ready for production use.

## Develop

Requirements: Node.js 22.12 or newer. Docker is not needed for development or tests.

```bash
corepack pnpm install
corepack pnpm verify
```

`pnpm verify` runs lint, typecheck and all tests and prints a one-line summary. Add `--e2e` to
include the browser tests on desktop and mobile viewports. Postgres binaries come with the npm
dependencies; the first run creates a local test cluster in `.cache/pg-test`.

Browser tests need Playwright's Chromium once:

```bash
corepack pnpm --filter @taskmoor/web exec playwright install chromium
```

## Documentation

- [Build plan](docs/plan/build-plan.md), with the [backlog](docs/plan/backlog.csv) and
  [milestones](docs/plan/milestones.csv)
- [Requirements spec](docs/specs/)
- [Architecture decisions](docs/adr/)
- [Contributor and agent guide](CLAUDE.md)

## Licence

Taskmoor is free software under the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`). Contributions are accepted under the Developer Certificate of Origin; see
[CONTRIBUTING.md](CONTRIBUTING.md) and [ADR-002](docs/adr/0002-licence-and-contributions.md).
