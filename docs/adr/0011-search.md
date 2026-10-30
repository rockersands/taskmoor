# ADR-011: Search in Postgres, with an optional OpenSearch adapter

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

Text search (`summary ~ "login"`, the master `text` field, QRY-007) must find a ticket within one
second of saving it and must respect browse permissions inside the query (QRY-008). Atlassian
moved Jira Cloud search to OpenSearch and cut Data Center p95 from 813 to 500 ms with it, but a
required search cluster contradicts ADR-006 and the self-hosting targets.

## Decision

- **Default: Postgres full-text.** Each ticket row keeps a `tsvector` of summary, description and
  comments (weighted), updated in the same transaction as the write, indexed with GIN; `pg_trgm`
  serves substring and "contains" matches on short text fields and autocomplete. Query text
  follows the spec's syntax (phrases, prefixes, AND/OR/NOT) and compiles to `tsquery`.
- **One search interface.** `packages/core` exposes `index(ticket)` and a predicate the query
  compiler (ADR-010) embeds in SQL. The default implementation is the Postgres one.
- **Optional OpenSearch adapter (M2)** for very large sites: an outbox consumer (ADR-015)
  mirrors tickets into an index; the compiler then resolves the text predicate to an id set from
  OpenSearch and the rest of the query still runs in Postgres with the permission pre-filter.
  Consistency is eventual and shown in the admin page (index lag).
- **Language support:** the text search configuration is chosen per instance (default
  `simple` plus `english` stemming when the locale is English); per-track language is an M2
  item.

## Options considered

| Option | For | Against |
|---|---|---|
| Postgres full-text by default, OpenSearch optional (chosen) | No extra service; transactional; permissions in SQL; a path for the largest sites | Relevance ranking and fuzzy matching are weaker than a dedicated engine |
| Required OpenSearch or Elasticsearch | Best relevance and scale | A JVM cluster for every install; eventual consistency for every search |
| Meilisearch, Typesense | Light, fast | Another service; no permission joins |
| ParadeDB, pgroonga | Better ranking inside Postgres | Extensions absent from managed Postgres offerings |

## Consequences

Relevance is tuned with weights and `ts_rank_cd`, and measured on the synthetic dataset in the
query benchmark. The adapter boundary is set now so the M2 work changes one package.

## Changes (M1-040)

Built as ADR-068 describes, with three departures: the words are kept per text in stored
columns (summary, description, environment, each comment), not one weighted vector per ticket,
so a field's search is exact in the index and a phrase stays inside its field; comments cannot
share the ticket's vector because some are restricted to a role or group; and the configuration
is English stemming without stop words (`taskmoor_search`), the only language the product
ships. `pg_trgm` serves patterns (`*Exception`) on summaries and custom text values; autocomplete
does not use it yet.
