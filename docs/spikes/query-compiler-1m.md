# Query compiler spike: 1,000,000 items

Generated 2026-10-12 21:03 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads), PostgreSQL 16.14, 20 timed runs per query after warm-up, LIMIT 50, latency from the client.

Budget: p95 under 300 ms. Every query meets it.

| Query | Text | Rows | p50 ms | p95 ms | Max ms |
|---|---|---:|---:|---:|---:|
| space-newest | `space = AA ORDER BY created DESC` | 50 | 0.38 | 0.59 | 0.78 |
| space-status | `space = AA AND status = "In Progress" ORDER BY updated DESC` | 50 | 1.01 | 1.68 | 1.73 |
| mine-open | `assignee = currentUser() AND statusCategory != done ORDER BY priority DESC, created DESC` | 50 | 0.47 | 0.72 | 0.73 |
| status-priority-in | `status IN (Backlog, "To Do") AND priority IN (High, Highest) ORDER BY created DESC` | 50 | 0.52 | 0.9 | 1.01 |
| labels-in | `labels IN (security, regression) ORDER BY created DESC` | 50 | 0.5 | 0.8 | 0.92 |
| summary-contains | `summary ~ "login" ORDER BY created DESC` | 50 | 6.38 | 7.02 | 7.13 |
| recent-bugs | `created >= -30d AND type = Bug ORDER BY created DESC` | 50 | 0.36 | 0.74 | 0.98 |
| stale-unresolved | `resolved IS EMPTY AND updated < -90d ORDER BY updated ASC` | 50 | 0.39 | 0.59 | 0.71 |
| number-gt-sorted | `"Ethhal number 8" > 500 AND space = AA ORDER BY "Ethhal number 8" DESC` | 50 | 0.62 | 0.84 | 0.91 |
| option-eq | `"Xanpir select 2" = "Hintor 3" AND statusCategory = todo ORDER BY created DESC` | 50 | 4.57 | 4.89 | 5.03 |
| date-window | `"Ismor date 5" <= endOfMonth() AND "Ismor date 5" >= startOfMonth() ORDER BY "Ismor date 5" ASC` | 50 | 1.93 | 2.34 | 2.44 |
| user-field-mine | `"Juneth user 11" = currentUser() ORDER BY updated DESC` | 7 | 2.2 | 2.61 | 2.64 |
| multi-in | `"Wenvin multiselect 20" IN ("Jungor 1", "Xanvel 2") AND status != Done ORDER BY created DESC` | 50 | 8.27 | 8.72 | 8.92 |
| number-empty | `"Ethhal number 8" IS EMPTY AND type IN (Story, Task) AND space = AA ORDER BY created DESC` | 50 | 0.65 | 0.89 | 0.98 |
| children | `parent = 1 ORDER BY created ASC` | 33 | 0.31 | 0.41 | 0.48 |
| mine-or-reported | `(assignee = currentUser() OR reporter = currentUser()) AND statusCategory != done ORDER BY updated DESC` | 50 | 0.54 | 0.87 | 1.07 |
| was-status | `status WAS "In Review" ORDER BY updated DESC` | 50 | 3.03 | 3.64 | 3.82 |
| changed-to-after | `status CHANGED TO Done AFTER -7d ORDER BY updated DESC` | 50 | 1.67 | 2.38 | 2.4 |
| changed-by-during | `assignee CHANGED BY 516 DURING (2024-01-01, 2024-02-01) ORDER BY created DESC` | 2 | 0.48 | 0.7 | 1 |
| not-or-spaces | `NOT (labels IN (infra) OR type = Subtask) AND space IN (AA, AB) ORDER BY created DESC` | 50 | 0.42 | 0.83 | 1.08 |
| was-rare | `status WAS Cancelled AND status = Done ORDER BY updated DESC` | 0 | 0.47 | 0.83 | 0.86 |
| permitted-half | `status = Done ORDER BY created DESC` | 50 | 0.56 | 1.14 | 1.45 |

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
