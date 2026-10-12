# Tracksmith

Open-source, self-hostable work tracking: Jira-class projects, boards, workflows, queries, service
desk and planning, with every premium feature included and AI that runs on the administrator's
own key. *Tracksmith is a working name.*

**Status:** M0 (foundation). Nothing here is ready for production use.

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
corepack pnpm --filter @tracksmith/web exec playwright install chromium
```

## Documentation

- [Build plan](docs/plan/build-plan.md), with the [backlog](docs/plan/backlog.csv) and
  [milestones](docs/plan/milestones.csv)
- [Requirements spec](docs/specs/)
- [Architecture decisions](docs/adr/)
- [Contributor and agent guide](CLAUDE.md)

## Licence

Not yet chosen; see [ADR-002](docs/adr/0002-licence-and-contributions.md). Until a licence is
added, all rights are reserved.
