# Query compiler spike: 200,000 items

Generated 2026-10-12 10:34 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads), PostgreSQL 16.14, 10 timed runs per query after warm-up, LIMIT 50, latency from the client.

Budget: p95 under 300 ms. Every query meets it.

| Query | Text | Rows | p50 ms | p95 ms | Max ms |
|---|---|---:|---:|---:|---:|
| space-newest | `space = AA ORDER BY created DESC` | 50 | 0.45 | 0.69 | 0.69 |
| space-status | `space = AA AND status = "In Progress" ORDER BY updated DESC` | 50 | 1.28 | 1.61 | 1.61 |
| mine-open | `assignee = currentUser() AND statusCategory != done ORDER BY priority DESC, created DESC` | 50 | 26.64 | 28.76 | 28.76 |
| status-priority-in | `status IN (Backlog, "To Do") AND priority IN (High, Highest) ORDER BY created DESC` | 50 | 0.64 | 0.95 | 0.95 |
| labels-in | `labels IN (security, regression) ORDER BY created DESC` | 50 | 0.61 | 0.78 | 0.78 |
| summary-contains | `summary ~ "login" ORDER BY created DESC` | 50 | 5.69 | 5.86 | 5.86 |
| recent-bugs | `created >= -30d AND type = Bug ORDER BY created DESC` | 50 | 0.4 | 0.63 | 0.63 |
| stale-unresolved | `resolved IS EMPTY AND updated < -90d ORDER BY updated ASC` | 50 | 0.41 | 0.71 | 0.71 |
| number-gt-sorted | `"Ethhal number 8" > 500 AND space = AA ORDER BY "Ethhal number 8" DESC` | 50 | 9.09 | 9.46 | 9.46 |
| option-eq | `"Xanpir select 2" = "Hintor 3" AND statusCategory = todo ORDER BY created DESC` | 50 | 1.24 | 1.93 | 1.93 |
| date-window | `"Ismor date 5" <= endOfMonth() AND "Ismor date 5" >= startOfMonth() ORDER BY "Ismor date 5" ASC` | 50 | 2.4 | 3.06 | 3.06 |
| user-field-mine | `"Juneth user 11" = currentUser() ORDER BY updated DESC` | 50 | 5.97 | 6.58 | 6.58 |
| multi-in | `"Wenvin multiselect 20" IN ("Jungor 1", "Xanvel 2") AND status != Done ORDER BY created DESC` | 50 | 2.67 | 3.44 | 3.44 |
| number-empty | `"Ethhal number 8" IS EMPTY AND type IN (Story, Task) AND space = AA ORDER BY created DESC` | 50 | 0.67 | 0.8 | 0.8 |
| children | `parent = 1 ORDER BY created ASC` | 37 | 0.35 | 0.46 | 0.46 |
| mine-or-reported | `(assignee = currentUser() OR reporter = currentUser()) AND statusCategory != done ORDER BY updated DESC` | 50 | 0.4 | 2.94 | 2.94 |
| was-status | `status WAS "In Review" ORDER BY updated DESC` | 50 | 2.63 | 2.84 | 2.84 |
| changed-to-after | `status CHANGED TO Done AFTER -7d ORDER BY updated DESC` | 50 | 0.74 | 1.39 | 1.39 |
| changed-by-during | `assignee CHANGED BY 1 DURING (2024-01-01, 2024-02-01) ORDER BY created DESC` | 50 | 1.87 | 2.3 | 2.3 |
| not-or-spaces | `NOT (labels IN (infra) OR type = Subtask) AND space IN (AA, AB) ORDER BY created DESC` | 50 | 0.44 | 0.56 | 0.56 |
| was-rare | `status WAS Cancelled AND status = Done ORDER BY updated DESC` | 0 | 0.66 | 0.79 | 0.79 |
| permitted-half | `status = Done ORDER BY created DESC` | 50 | 0.5 | 0.63 | 0.63 |

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
