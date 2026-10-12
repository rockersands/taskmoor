# ADR-010: Query language: own grammar, AST, resolver and SQL compiler with a permission pre-filter

- Status: Proposed
- Date: 2026-10-12
- Backlog: M0-017

## Context

The query language is the product's spine: search, boards, filters, subscriptions, webhooks,
automation and OData all run through it (QRY-001 to QRY-014). No open-source JQL compiler
exists and Atlassian's parser is for its own use; users arrive with thousands of saved
filters written in both the old vocabulary (`project`, `issuetype`) and the new one. The
budget is a p95 under 300 ms for the 20 representative queries at 10M items, with browse
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
  item table; each custom-field condition is an `EXISTS` on its side table (ADR-008); labels
  use array containment; text search uses the full-text index (ADR-011); `WAS` and `CHANGED`
  are one `EXISTS` on the change history, which holds the creation values too, so a rare
  value starts from the history index instead of scanning items; `ORDER BY` adds the id as a
  tiebreaker (stable cursors, QRY-009) and puts `NULLS LAST` only on nullable columns, so
  newest-first lists walk the `(…, created_at DESC, id DESC)` indexes. Values are always
  parameters; the compiler never interpolates text.
- **The permission pre-filter** (ADR-012) is part of the statement: `space_id = ANY($allowed)`
  for ordinary users, inverted or omitted for users who see most or all spaces, plus the
  security-level predicate.
- **JQL is a dialect**, not the native language: the same AST, with aliases and legacy
  functions accepted on input and the native names printed on output (QRY-003).
- **Explain** (QRY-010): the compiled statement is available to admins with `EXPLAIN`, and a
  statement timeout (default 30 s) bounds every query.

## Measurements (spike, 2026-10-12)

The 20 representative queries plus a permission-filtered one and a rare-history worst case,
on the ADR-008 schema with the product's extra indexes (newest-first with id, reporter,
labels GIN, summary full-text, history by item and field, by value and by actor), LIMIT 50,
10 to 20 timed runs after warm-up, latency from the client.

200,000 items ([report](../spikes/query-compiler-200k.md)): every query under 10 ms; the
slowest is `"{number}" > 500 AND space = X ORDER BY "{number}" DESC` at 9.5 ms p95, the
rare-history worst case 0.65 ms, the permission-filtered query 0.76 ms.

Two compiler changes came out of the spike: the id tiebreaker needs to be in the index and
`NULLS LAST` must not be emitted on `NOT NULL` columns, or the planner sorts a whole space
(41.7 ms down to 0.65 ms for the newest-first list at 200k items); and `WAS` must be one
`EXISTS` so a value that never occurred (0 rows) does not walk the table (1.9 s down to
0.65 ms at 1M).

The 1,000,000- and 10,000,000-item runs (M0-017 gate) are recorded in
`docs/spikes/query-compiler-1m.md` and `query-compiler-10m.md` and summarised here when they
complete.

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
