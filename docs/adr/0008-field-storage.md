# ADR-008: Custom field storage: JSONB on the ticket plus typed side tables

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-016

## Context

Jira's slowest sites are the ones with the most custom fields; Atlassian documents field count
as the main latency driver and caps Data Center at 1,200 fields. Taskmoor must hold 1,500
fields over 10M tickets (NFR-002) with a field edit p95 under 50 ms, ticket open under 100 ms and
every query p95 under 300 ms (NFR-001, ADR-010). Fields have contexts per track and ticket
type (CORE-009) and every type in the catalogue must filter, sort and count (CORE-010).

## Decision

- **Definitions** live in a `field` table (type, name, contexts, options, validation).
- **Values for reading** live in one JSONB column on the ticket row (`fields`), keyed by field
  id, so opening a ticket is one row and the API serialises it without joins.
- **Values for filtering, sorting and counting** live in typed side tables, one per value
  type (`v_text`, `v_number`, `v_date`, `v_user`, `v_option`; multi-selects and labels are
  several `v_option` rows): `(item_id, space_id, field_id, value, created_at)`. `space_id` and
  `created_at` are copied from the ticket because they never change, so a track-scoped,
  newest-first list is served by one index on the side table without touching the ticket table.
  Indexes: primary key `(item_id, field_id[, value])`, `(field_id, value, created_at DESC)
  INCLUDE (item_id)`, `(space_id, field_id, value, created_at DESC) INCLUDE (item_id)` and
  `(field_id, created_at DESC) INCLUDE (value, item_id)`, the last for "any condition on this
  field, newest first" (ranges, several values), which the 10M run showed is needed.
- **Planner statistics**: each side table carries extended statistics on `(field_id, value)`
  and a statistics target of 5,000 on both columns. Values belong to their field, so the
  default independent estimates were off by a factor of 300 at 10M tickets (121 rows expected,
  37,000 matched) and the planner fetched and sorted every match; with these it walks the
  newest-first index and stops after one page. ANALYZE of the largest side table (147M rows)
  takes 40 s on NVMe.
- **Writes** update the JSONB column and the side rows in the same transaction; a property
  test (M1-011) keeps the two in step, and a repair job rebuilds side rows from JSONB.
- **Query shape** (ADR-010): a custom-field condition is an `EXISTS` on its side table, so
  the planner intersects by ticket id and uses the `(field, value)` indexes; when the order is by
  creation date or by that field, the statement is driven from the side table instead (its
  `created_at` copy and value give the order), and a status or other ticket condition becomes a
  semi-join to the ticket.

## Measurements (spike, 2026-10-12)

1,000,000 tickets, 1,500 fields, 25 values per ticket, 20 timed runs, p95 in ms
([report](../spikes/field-storage-1m.md)):

| Query | JSONB only | JSONB plus side tables | EAV |
|---|---:|---:|---:|
| Open one ticket with all values | 0.86 | 0.47 | 0.75 |
| Select field = option in a track, newest 50 | 17.97 | 0.75 | 0.71 |
| Number > x site-wide, newest 50 | 5.81 | 36.29 | 53.37 |
| Date in a 30-day window and a stage | 554.89 | 11.40 | 21.35 |
| Option = x and number > y | 5.41 | 35.20 | 53.71 |
| Track sorted by a number field, top 50 | 240.25 | 0.59 | 3,789.61 |
| Count per option in a track | 230.89 | 6.95 | 3,766.75 |
| User field = person site-wide | 11.38 | 0.61 | 0.86 |
| Count site-wide with number > x | 616.17 | 21.35 | 27.42 |
| Set a number field on one ticket | 0.80 | 0.74 | 0.50 |
| Storage (ticket plus values) | 1.6 GB | 6.8 GB | 6.3 GB |

JSONB alone misses the budget on date windows, sorts and counts; EAV collapses on sorting and
counting (seconds); the side tables keep every query under 40 ms. A first run without the
denormalised `space_id` and `created_at` lost to JSONB on track-scoped queries
([v1 report](../spikes/field-storage-1m-v1.md)), which is why both columns are on every side
row.

At 200,000 tickets the same queries run in under 7 ms
([report](../spikes/field-storage-200k.md)). The table above is the second 1M run, with all
three candidates ([report](../spikes/field-storage-1m-v2.md)).

**10,000,000 tickets** (M0-016 gate; 147M option rows and 291M side rows in all, 115 GB with history; NVMe,
64 GB RAM, `shared_buffers` 1 GB, 20 runs; [report](../spikes/field-storage-10m.md)). Only the
chosen candidate was built at this size: JSONB alone and EAV had already failed at 1M.

| Query | p95 ms | Budget |
|---|---:|---:|
| Open one ticket with all values | 1.35 | 100 |
| Select field = option in a track, newest 50 | 6.28 | 300 |
| Number > x site-wide, newest 50 | 0.93 | 300 |
| Date in a 30-day window and a stage | 123.36 | 300 |
| Option = x and number > y | 95.30 | 300 |
| Track sorted by a number field, top 50 | 1.71 | 300 |
| Count per option in a track | 7.29 | 300 |
| User field = person site-wide | 2.89 | 300 |
| Count site-wide with number > x | 60.27 | 300 |
| Set a number field on one ticket | 1.72 | 50 |
| Storage (ticket plus side tables) | 89 GB | |

Every query meets its budget. Three findings came from this size and are now part of the
decision: the date-window and two-field queries need a semi-join to the ticket and the
newest-first side index (the plain join took 57 s and 13 s); the planner needs the extended
statistics above; and a bulk-loaded table needs `VACUUM` before index-only scans avoid the heap.
The first 10M runs were taken on a 5,400 rpm hard disk by mistake: random reads there cost
13 ms, which made single-ticket reads 30 ms and hid the plan problems behind the disk; the
figures above are from NVMe.
