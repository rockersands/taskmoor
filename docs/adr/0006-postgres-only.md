# ADR-006: PostgreSQL 16+ as the only required service

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

Every extra stateful service multiplies the install matrix, the backup story and the support
burden for self-hosters; the research report found Sentry's twenty containers and Huly's manual
migration steps to be the main reasons people give up on self-hosting. The user confirmed
"PostgreSQL only" in `docs/plan/decisions.csv` ("Data stores"). The scale envelope is 10M to
30M tickets, 30,000 tracks and 100,000 users (NFR-002).

## Decision

- **PostgreSQL 16 or newer is the only required service.** Queue (ADR-015), search (ADR-011),
  sessions, change log (ADR-013), analytics (ADR-027) and extension storage all live in it.
  Managed offerings (RDS, Cloud SQL, Azure, Neon, Supabase) are supported because nothing
  outside the standard `contrib` set is required. `pgvector` is optional: the bundled image
  ships it and semantic features switch off without it.
- **`workspace_id` on every table** (enforced since M1-001 by `packages/db/src/workspace-scope.test.ts`,
  which lists the few instance-wide tables and why), so one database can
  serve several workspaces and every query is scoped by construction.
- **History, audit, change log and analytics tables are range-partitioned by month**; a
  scheduled job creates partitions ahead and detaches those past retention.
- **Transactions are the consistency boundary**: a business change, its history rows, its
  search index update and its outbox rows commit together. There is no cache that can disagree
  with the database; caches (ADR-012) are invalidated by the change log.
- **Local development and tests use an embedded Postgres** (ADR-030) started from npm
  binaries, so no Docker is needed on the development machine; CI also runs the suite on the
  newest release.
- **Compatibility floor:** the oldest supported major is tested in CI and dropped one year
  after its upstream end of life.

## Options considered

| Option | For | Against |
|---|---|---|
| PostgreSQL only (chosen) | One backup, one restore drill, one performance model; partitioning, JSONB, full-text, SKIP LOCKED and logical replication cover every need found so far | Very large sites may want external search (optional adapter, ADR-011) |
| Postgres plus MySQL and SQL Server | Reaches shops standardised on them | Doubles the test matrix; loses JSONB operators, partial indexes and SKIP LOCKED semantics the design relies on |
| SQLite for small installs | Zero-setup trials | A second storage engine with different locking; the all-in-one image with bundled Postgres gives the same trial experience |

## Consequences

Features are designed around what Postgres does well (indexes per field type, partitions,
transactional outbox) and benchmarked on it (M0-033). Adding a second database engine would be
a superseding ADR, not a configuration flag.
