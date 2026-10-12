# Query compiler spike: 10,000,000 items

Generated 2026-10-12 21:01 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads), PostgreSQL 16.14, 20 timed runs per query after warm-up, LIMIT 50, latency from the client.

Budget: p95 under 300 ms. Every query meets it.

| Query | Text | Rows | p50 ms | p95 ms | Max ms |
|---|---|---:|---:|---:|---:|
| space-newest | `space = AA ORDER BY created DESC` | 50 | 0.37 | 0.62 | 0.71 |
| space-status | `space = AA AND status = "In Progress" ORDER BY updated DESC` | 50 | 1.63 | 2.44 | 2.93 |
| mine-open | `assignee = currentUser() AND statusCategory != done ORDER BY priority DESC, created DESC` | 50 | 0.38 | 0.89 | 0.92 |
| status-priority-in | `status IN (Backlog, "To Do") AND priority IN (High, Highest) ORDER BY created DESC` | 50 | 0.5 | 0.59 | 0.62 |
| labels-in | `labels IN (security, regression) ORDER BY created DESC` | 50 | 0.52 | 0.88 | 0.94 |
| summary-contains | `summary ~ "login" ORDER BY created DESC` | 50 | 6.28 | 6.62 | 6.71 |
| recent-bugs | `created >= -30d AND type = Bug ORDER BY created DESC` | 50 | 0.38 | 0.65 | 0.78 |
| stale-unresolved | `resolved IS EMPTY AND updated < -90d ORDER BY updated ASC` | 50 | 0.39 | 0.95 | 1.04 |
| number-gt-sorted | `"Ethhal number 8" > 500 AND space = AA ORDER BY "Ethhal number 8" DESC` | 50 | 0.43 | 0.81 | 0.86 |
| option-eq | `"Xanpir select 2" = "Hintor 3" AND statusCategory = todo ORDER BY created DESC` | 50 | 4.43 | 5.19 | 5.29 |
| date-window | `"Ismor date 5" <= endOfMonth() AND "Ismor date 5" >= startOfMonth() ORDER BY "Ismor date 5" ASC` | 50 | 1.72 | 2.05 | 2.17 |
| user-field-mine | `"Juneth user 11" = currentUser() ORDER BY updated DESC` | 5 | 2.31 | 2.86 | 3.18 |
| multi-in | `"Wenvin multiselect 20" IN ("Jungor 1", "Xanvel 2") AND status != Done ORDER BY created DESC` | 50 | 9.02 | 10.31 | 10.64 |
| number-empty | `"Ethhal number 8" IS EMPTY AND type IN (Story, Task) AND space = AA ORDER BY created DESC` | 50 | 0.67 | 0.96 | 1.18 |
| children | `parent = 1 ORDER BY created ASC` | 37 | 0.32 | 0.55 | 0.63 |
| mine-or-reported | `(assignee = currentUser() OR reporter = currentUser()) AND statusCategory != done ORDER BY updated DESC` | 50 | 0.48 | 1.15 | 1.35 |
| was-status | `status WAS "In Review" ORDER BY updated DESC` | 50 | 4.17 | 5.17 | 5.29 |
| changed-to-after | `status CHANGED TO Done AFTER -7d ORDER BY updated DESC` | 50 | 15.14 | 17.39 | 17.41 |
| changed-by-during | `assignee CHANGED BY 4587 DURING (2024-01-01, 2024-02-01) ORDER BY created DESC` | 1 | 0.47 | 0.7 | 0.99 |
| not-or-spaces | `NOT (labels IN (infra) OR type = Subtask) AND space IN (AA, AB) ORDER BY created DESC` | 50 | 0.46 | 0.91 | 0.96 |
| was-rare | `status WAS Cancelled AND status = Done ORDER BY updated DESC` | 0 | 0.51 | 0.83 | 0.99 |
| permitted-half | `status = Done ORDER BY created DESC` | 50 | 1.82 | 2.33 | 2.74 |

## Indexes added for the query set

Built in 0s on top of the side-table indexes (skipped when present).

| Index | Definition |
|---|---|
| item_created_id | `ON fs_side.item (created_at DESC, id DESC)` |
| item_space_created_id | `ON fs_side.item (space_id, created_at DESC, id DESC)` |
| item_updated_id | `ON fs_side.item (updated_at DESC, id DESC)` |
| item_reporter | `ON fs_side.item (reporter_id)` |
| item_labels | `ON fs_side.item USING GIN (labels)` |
| item_summary_fts | `ON fs_side.item USING GIN (to_tsvector('simple', summary))` |
| history_item_field | `ON gen.history (item_id, field)` |
| history_field_to | `ON gen.history (field, to_value, at) INCLUDE (item_id)` |
| history_field_from | `ON gen.history (field, from_value, at) INCLUDE (item_id)` |
| history_actor_at | `ON gen.history (actor_id, at) INCLUDE (item_id)` |
