# ADR-008: Custom field storage: JSONB on the item plus typed side tables

- Status: Proposed
- Date: 2026-10-12
- Backlog: M0-016

## Context

Jira's slowest sites are the ones with the most custom fields; Atlassian documents field count
as the main latency driver and caps Data Center at 1,200 fields. Tracksmith must hold 1,500
fields over 10M items (NFR-002) with a field edit p95 under 50 ms, item open under 100 ms and
every query p95 under 300 ms (NFR-001, ADR-010). Fields have contexts per space and type
(CORE-009) and every type in the catalogue must filter, sort and count (CORE-010).

## Decision

- **Definitions** live in a `field` table (type, name, contexts, options, validation).
- **Values for reading** live in one JSONB column on the item row (`fields`), keyed by field
  id, so opening an item is one row and the API serialises it without joins.
- **Values for filtering, sorting and counting** live in typed side tables, one per value
  type (`v_text`, `v_number`, `v_date`, `v_user`, `v_option`; multi-selects and labels are
  several `v_option` rows): `(item_id, space_id, field_id, value, created_at)`. `space_id` and
  `created_at` are copied from the item because they never change, so a space-scoped,
  newest-first list is served by one index on the side table without touching the item table.
  Indexes: primary key `(item_id, field_id[, value])`, `(field_id, value, created_at DESC)
  INCLUDE (item_id)` and `(space_id, field_id, value, created_at DESC) INCLUDE (item_id)`.
- **Writes** update the JSONB column and the side rows in the same transaction; a property
  test (M1-011) keeps the two in step, and a repair job rebuilds side rows from JSONB.
- **Query shape** (ADR-010): each custom-field condition is an `EXISTS` on its side table, so
  the planner intersects by item id and uses the `(field, value)` indexes; sorting by a custom
  field reads one side row per item.

## Measurements (spike, 2026-10-12)

1,000,000 items, 1,500 fields, 25 values per item, 20 timed runs, p95 in ms
([report](../spikes/field-storage-1m.md)):

| Query | JSONB only | JSONB plus side tables | EAV |
|---|---:|---:|---:|
| Open one item with all values | 0.86 | 0.47 | 0.75 |
| Select field = option in a space, newest 50 | 17.97 | 0.75 | 0.71 |
| Number > x site-wide, newest 50 | 5.81 | 36.29 | 53.37 |
| Date in a 30-day window and a status category | 554.89 | 11.40 | 21.35 |
| Option = x and number > y | 5.41 | 35.20 | 53.71 |
| Space sorted by a number field, top 50 | 240.25 | 0.59 | 3,789.61 |
| Count per option in a space | 230.89 | 6.95 | 3,766.75 |
| User field = person site-wide | 11.38 | 0.61 | 0.86 |
| Count site-wide with number > x | 616.17 | 21.35 | 27.42 |
| Set a number field on one item | 0.80 | 0.74 | 0.50 |
| Storage (item plus values) | 1.6 GB | 6.8 GB | 6.3 GB |

JSONB alone misses the budget on date windows, sorts and counts; EAV collapses on sorting and
counting (seconds); the side tables keep every query under 40 ms. A first run without the
denormalised `space_id` and `created_at` lost to JSONB on space-scoped queries
([v1 report](../spikes/field-storage-1m-v1.md)), which is why both columns are on every side
row.

At 200,000 items the same queries run in under 7 ms
([report](../spikes/field-storage-200k.md)). The 10,000,000-item run (M0-016 gate) is recorded
in `docs/spikes/field-storage-10m.md` and summarised here when it completes.

## Options considered

| Option | For | Against |
|---|---|---|
| JSONB plus typed side tables (chosen) | Fast reads and fast typed filters, sorts and counts; indexes per field type | About 4x the storage of JSONB alone; two writes per edit (one transaction) |
| JSONB with GIN and expression indexes only | Simplest; smallest | Range, sort and count queries scan; 555 ms date window at 1M, worse at 10M |
| One EAV table with typed columns | One value table | Sorting and counting by a field take seconds at 1M; the hottest index is the largest |
| One column per field (wide table) | Native SQL | 1,500 columns exceed Postgres limits; schema changes per field |

## Consequences

Storage grows with values, not with fields: an empty field costs nothing. Field deletion is a
side-table delete plus a JSONB key removal, both batched. The importer (ADR-025) loads side
tables with COPY after the items.
