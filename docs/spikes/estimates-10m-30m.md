# Estimates at 10M and 30M tickets (M1-117)

Written 2026-11-02 from the runs at 1M, by the user's decision of 2026-11-01: M1 is measured at
1M tickets, and 10M and 30M are estimates, not runs (no machine here holds 10M: the 1M product
schema is 9.5 GB, so 10M needs about 100 GB and 30M about 300 GB, with indexes). M2's gate
measures at 30M (milestones.csv).

## What was measured

| Run | Size | Where | Result |
|---|---|---|---|
| Search perf set (`docs/spikes/search-1m.md`) | 1,000,491 tickets | this container: 4 shared vCPUs (Xeon 2.1 GHz), 16 GB, PostgreSQL 16 | 50 queries as a member and an administrator; slowest statement p95 113 ms, slowest request p95 171 ms; budget 300 ms |
| Opening a ticket (same report) | 1M | same | the ticket by key, and the page's reads; budget 100 ms p95 |
| Design spikes (`query-compiler-*`, `field-storage-*`, `authz-overhead-*`) | 200k, 1M and **10M** | Ryzen 7 3700X, 64 GB (2026-10-12) | the same query shapes on the spike schema at three sizes: how each shape grows |
| Load test (`docs/ops/load-tests.md`) | 100k | Apple M3 Pro | 50 to 2,000 people; sizing per request |
| `pnpm bench:check --size 1m --e2e` | 1M spikes, tests enforced | this container | budgets met; two misses fixed (similar tickets without statistics, the 5,000-card board) |

## How each kind of query grows

The spikes ran the same shapes at 1M and 10M on one machine. Their growth sorts the 50 queries
into four kinds, and each kind is estimated from its own growth, not from a straight line.

| Kind | Queries in the perf set | 1M to 10M in the spikes | Measured at 1M (member p95) | Estimate at 10M | Estimate at 30M |
|---|---|---|---|---|---|
| **Index walks with a limit**: an order the index holds, a filter that keeps many rows | 35 of 50 (track, status, priority, stage, assignee, dates, labels, children, keys) | flat: 0.59 to 0.62 ms, 0.72 to 0.89, 0.41 to 0.55 | 1 to 7 ms | 1 to 10 ms | 2 to 15 ms |
| **Side-table walks**: a custom field value, then the ticket | option, multi-select, number, date, user fields (10) | flat to 1.2x: 4.9 to 5.2 ms, 8.7 to 10.3 | 2 to 17 ms | 3 to 25 ms | 5 to 40 ms |
| **History**: "was", "changed" | spike only | 1.4x to 7x: was-status 3.6 to 5.2 ms, changed-to-after 2.4 to 17.4 | not in the 50 | under 30 ms | under 60 ms |
| **Word searches**: every ticket holding the words is read, then ordered | `summary ~ "two words"`, a custom text field `~` (2) | linear in the matches (GIN posting lists grow with the data) | 113 ms and 78 ms | **0.8 to 1.2 s** | **2.5 to 3.5 s** |

The request adds the app's own work to the statement: 25 to 55 ms at 1M (views, fields,
permissions as JSON), which does not grow with the dataset.

**At 10M, 48 of the 50 queries stay under 300 ms** by these estimates, most of them under 60 ms
with the request. The two word searches miss: their cost is the number of tickets holding the
words. Two levers exist and neither is needed at 1M:

1. Walk the order's index and test the words per row, stopping at the page (the planner already
   does this when the words are common; the risk is a rare pair in a common order).
2. Rank within the most recent tickets first, as `ORDER BY relevance` already does since the
   user's decision 4 (capped at the 10,000 most recently updated).

At 30M a dedicated search index is the safer answer (an M2 decision with the 30M gate).

## Counts

A search's count is exact up to 10,000 and an estimate beyond, from a sample of blocks, kept
for 60 s (M1-040, ADR-069). The exact part reads at most 10,001 matches, so it does not grow with
the dataset: 1 to 540 ms at 1M (the slowest a three-condition filter that matches more than 10,000
tickets), about the same at 10M and 30M. The sample grows with the table's blocks, up to its row
cap, and then stops growing.

## Opening a ticket, boards, editing

- **Opening a ticket** reads one ticket by its key and its partition of history, comments and
  links by the ticket's id: all key lookups, flat in the dataset's size (the spike's "open one
  item" was 1.83 ms at 1M and 1.35 ms at 10M). The estimate at 10M and 30M is the 1M figure.
- **Boards** read their columns' cards (at most the board's limit per column) through the same
  index walks: flat. The 5,000-card board is a browser budget, independent of the dataset.
- **Field edits** write one row per side table (ADR-008): 1.7 ms at 1M, 2 ms at 10M in the spike.
- **Permission filtering** adds at most 3.5 ms at 10M (budget 10 ms; `authz-overhead-10m.md`).

## Disk, memory and import

| | 1M (measured) | 10M (estimate) | 30M (estimate) |
|---|---|---|---|
| Product schema with indexes | 9.5 GB | 95 to 110 GB | 290 to 330 GB |
| PostgreSQL memory for a warm working set (recent tickets and the indexes walked) | 2 to 4 GB | 8 to 16 GB | 24 to 48 GB |
| DC import (M1-091: 2.9 ms a record, 5.7 records an issue, one worker) | 4.6 h | 46 h | 6 days |

The import's figure is one worker on four shared CPUs; M1-091 records that the 1M-issue run
needs a bigger machine and parallel loading to meet its 4 h bar.

## What to measure when a bigger machine exists

1. `pnpm gen --items 10000000`, `pnpm bench:search --label 10m`, `pnpm bench:check --size 10m`.
2. The two word searches with both levers above.
3. `pnpm load --items 10000000` on separate server and database machines, for the sizing table.
