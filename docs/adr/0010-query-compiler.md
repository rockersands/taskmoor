# ADR-010: Query language: own grammar, AST, resolver and SQL compiler with a permission pre-filter

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-017

## Context

The query language is the product's spine: search, boards, saved searches, subscriptions, webhooks,
automation and OData all run through it (QRY-001 to QRY-014). No open-source JQL compiler
exists and Atlassian's parser is for its own use; users arrive with thousands of saved
filters written in both the old vocabulary (`project`, `issuetype`) and the new one. The
budget is a p95 under 300 ms for the 20 representative queries at 10M tickets, with browse
permission applied inside the query (QRY-008), history operators on every field (QRY-005) and
no injection possible (QRY-010).

## Decision

- **A hand-written Pratt parser** (`packages/query`) over our own grammar: clauses with
  `AND`, `OR`, `NOT`, comparison, `IN`, `IS EMPTY`, `WAS`, `CHANGED` with `FROM`, `TO`, `BY`,
  `BEFORE`, `AFTER`, `ON`, `DURING`, functions such as `currentUser()` and `startOfMonth()`,
  relative dates (`-30d`), and `ORDER BY`. Errors carry line, column and an expected-token
  hint; a printer reproduces an equivalent query from the AST (golden tests).
- **A resolver** maps names in both vocabularies and custom fields by name or id to typed
  fields from a catalogue, checks every operator against the field type (QRY-002) and turns
  values into typed literals; ambiguity and unknown names are errors naming the candidates.
- **A compiler** emits one parameterised SQL statement per query: system fields filter the
  ticket table; each custom-field condition is an `EXISTS` on its side table (ADR-008); labels
  use array containment; text search uses the full-text index (ADR-011); `WAS` and `CHANGED`
  are one `EXISTS` on the change history, which holds the creation values too, so a rare
  value starts from the history index instead of scanning tickets; `ORDER BY` adds the id as a
  tiebreaker (stable cursors, QRY-009) and puts `NULLS LAST` only on nullable columns, so
  newest-first lists walk the `(…, created_at DESC, id DESC)` indexes. When the order is by
  creation date or by a custom field the query also filters, the statement is **driven from
  that field's side table**: side rows carry the ticket's `created_at` and `space_id`
  (ADR-008), so the side index yields the page in order; other conditions on the same field,
  `track` and the permission pre-filter apply to the side row, the rest to the joined ticket
  (left out when nothing needs it); a multi-select condition that can match several rows of one
  ticket keeps only the ticket's lowest matching value. Side-table comparisons are cast to the
  value column's type (a user field compared as `numeric` against an `int` column could not
  use its index). Values are always parameters; the compiler never interpolates text.
- **The permission pre-filter** (ADR-012) is part of the statement: `space_id = ANY($allowed)`
  for ordinary users, inverted or omitted for users who see most or all tracks, plus the
  visibility-level predicate.
- **JQL is a dialect**, not the native language: the same AST, with aliases and legacy
  functions accepted on input and the native names printed on output (QRY-003).
- **Explain** (QRY-010): the compiled statement is available to admins with `EXPLAIN`, and a
  statement timeout (default 30 s) bounds every query.

## Measurements (spike, 2026-10-12)

The 20 representative queries plus a permission-filtered one and a rare-history worst case,
on the ADR-008 schema with the product's extra indexes (newest-first with id, requester,
labels GIN, summary full-text, history by ticket and field, by value and by actor), LIMIT 50,
10 to 20 timed runs after warm-up, latency from the client.

200,000 tickets ([report](../spikes/query-compiler-200k.md)): every query under 10 ms; the
slowest is `"{number}" > 500 AND track = X ORDER BY "{number}" DESC` at 9.5 ms p95, the
rare-history worst case 0.65 ms, the permission-filtered query 0.76 ms.

Two compiler changes came out of the spike: the id tiebreaker needs to be in the index and
`NULLS LAST` must not be emitted on `NOT NULL` columns, or the planner sorts a whole track
(41.7 ms down to 0.65 ms for the newest-first list at 200k tickets); and `WAS` must be one
`EXISTS` so a value that never occurred (0 rows) does not walk the table (1.9 s down to
0.65 ms at 1M).

**1,000,000 and 10,000,000 tickets** (M0-017 gate; NVMe, 64 GB RAM, `shared_buffers` 1 GB, 20
runs; reports [1M](../spikes/query-compiler-1m.md), [10M](../spikes/query-compiler-10m.md)).
Every query meets the 300 ms budget at both sizes:

| Query | 1M p95 ms | 10M p95 ms |
|---|---:|---:|
| `track = X ORDER BY created DESC` | 0.59 | 0.62 |
| `track = X AND status = "In Progress" ORDER BY updated DESC` | 1.68 | 2.44 |
| `assignee = currentUser() AND stage != closed ORDER BY priority DESC, created DESC` | 0.72 | 0.89 |
| `status IN (…) AND priority IN (…) ORDER BY created DESC` | 0.90 | 0.59 |
| `labels IN (…) ORDER BY created DESC` | 0.80 | 0.88 |
| `summary ~ "login" ORDER BY created DESC` | 7.02 | 6.62 |
| `created >= -30d AND type = Bug ORDER BY created DESC` | 0.74 | 0.65 |
| `closed IS EMPTY AND updated < -90d ORDER BY updated ASC` | 0.59 | 0.95 |
| `"{number}" > 500 AND track = X ORDER BY "{number}" DESC` | 0.84 | 0.81 |
| `"{select}" = "{option}" AND stage = new ORDER BY created DESC` | 4.89 | 5.19 |
| `"{date}" <= endOfMonth() AND "{date}" >= startOfMonth() ORDER BY "{date}" ASC` | 2.34 | 2.05 |
| `"{user}" = currentUser() ORDER BY updated DESC` | 2.61 | 2.86 |
| `"{multi}" IN (A, B) AND status != Done ORDER BY created DESC` | 8.72 | 10.31 |
| `"{number}" IS EMPTY AND type IN (…) AND track = X ORDER BY created DESC` | 0.89 | 0.96 |
| `parent = N ORDER BY created ASC` | 0.41 | 0.55 |
| `(assignee = currentUser() OR requester = currentUser()) AND … ORDER BY updated DESC` | 0.87 | 1.15 |
| `status WAS "In Review" ORDER BY updated DESC` | 3.64 | 5.17 |
| `status CHANGED TO Done AFTER -7d ORDER BY updated DESC` | 2.38 | 17.39 |
| `assignee CHANGED BY u DURING (…) ORDER BY created DESC` | 0.70 | 0.70 |
| `NOT (labels IN (…) OR type = Subticket) AND track IN (…) ORDER BY created DESC` | 0.83 | 0.91 |
| `status WAS Cancelled AND status = Done ORDER BY updated DESC` (no rows) | 0.83 | 0.83 |
| `status = Done ORDER BY created DESC`, permitted to half the tracks | 1.14 | 2.33 |

The first 10M run, before driving from the side table, missed the budget on the four
custom-field queries ordered by a ticket column: three timed out at 60 s and the user-field
query took 4.5 s, because the planner either probed the side table for every ticket in date
order or fetched every match and sorted. Driving from the side table fixed three; the
multi-select one also needed the planner statistics of ADR-008 (its estimate was 121 rows for
37,000 matches). An equivalence test runs every query of the set and fourteen aimed at the
side-table paths in both forms, with and without the permission filter, and requires identical
rows in identical order.

The permission pre-filter (ADR-012) adds at most 3.6 ms at 10M tickets (filtered queries all
under 4.5 ms; [report](../spikes/authz-overhead-10m.md)), within its budget of at most 10 ms
added (absolute since 2026-10-12, `docs/plan/decisions.csv`).

## Options considered

| Option | For | Against |
|---|---|---|
| Own grammar, AST, resolver, SQL compiler (chosen) | Full control of semantics, errors and SQL shape; JQL compatibility as a dialect; measured within budget | We maintain a parser (about 400 lines) and its conformance suite (M1-033) |
| ANTLR grammar | Generated parser | A build step and runtime for little gain at this grammar size; error messages are harder to shape |
| Translate to a search engine query | Fast text search | Permission joins and history predicates would leave Postgres; two engines to keep consistent |
| Expose SQL directly | No compiler | Unsafe; no vocabulary mapping; no permission pre-filter |

## Consequences

Every new field type or function is a resolver entry plus a compiler case plus golden SQL.
Sorting by priority uses a rank column in the product (the spike sorted the name). The
conformance suite (M1-033) is the behaviour contract; the compiler goldens are the SQL
contract, reviewed on every change.
