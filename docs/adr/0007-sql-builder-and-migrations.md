# ADR-007: Typed SQL builder and SQL migrations

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

The data model has hundreds of tables, hot queries that must stay within budget at 10M tickets,
and a query compiler (ADR-010) that emits SQL directly. Sessions need generated SQL they can
read in an `EXPLAIN`, and a schema whose every change is reviewed.

## Decision

- **Kysely** is the query builder: typed against a `Database` interface in `@taskmoor/db`,
  no runtime schema, no lazy loading, and the SQL it produces is the SQL that runs. Raw SQL
  through `sql` tagged templates is allowed where the builder gets in the way (window
  functions, partition DDL, the query compiler's output).
- **Migrations are plain SQL in TypeScript files**, numbered, forward-only and idempotent where
  possible, applied by the in-house migrator (`packages/db/src/migrate.ts`) inside one
  transaction each, with a registry test that fails when a file is missing from the index.
  Large-table changes follow expand and contract (ADR-022).
- **The schema is a golden file** (`packages/db/src/__golden__/schema.json`): a migrated
  database is introspected in tests and compared, so a schema change without a reviewed golden
  update fails `pnpm verify`.
- **No ORM**: entities are plain rows and typed mappers; relations are explicit joins.

## Options considered

| Option | For | Against |
|---|---|---|
| Kysely plus SQL migrations (chosen) | Predictable SQL; small runtime; types without codegen magic; easy raw escape hatch | Hand-maintained `Database` types (checked by the schema golden) |
| Drizzle | Schema-as-code with migrations generated | Generated migrations need review anyway; its query API hides joins the budgets depend on |
| Prisma | Popular; schema language | Its own engine and query shape; weak partition and advanced index support; heavy in the image |
| Raw SQL only | Full control | Stringly typed; mistakes found at runtime |

## Consequences

Every table change is three edits: a migration, the `Database` interface, and the schema
golden. That is deliberate friction. The upgrade harness (M0-029) replays migrations from N-3
on fixture databases before a release.
