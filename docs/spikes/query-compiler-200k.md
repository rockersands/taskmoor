# Query compiler spike: 200,000 items

Generated 2026-10-12 10:38 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads), PostgreSQL 16.14, 10 timed runs per query after warm-up, LIMIT 50, latency from the client.

Budget: p95 under 300 ms. Every query meets it.

| Query | Text | Rows | p50 ms | p95 ms | Max ms |
|---|---|---:|---:|---:|---:|
| space-newest | `space = AA ORDER BY created DESC` | 50 | 0.5 | 0.64 | 0.64 |
| space-status | `space = AA AND status = "In Progress" ORDER BY updated DESC` | 50 | 1.27 | 1.93 | 1.93 |
| mine-open | `assignee = currentUser() AND statusCategory != done ORDER BY priority DESC, created DESC` | 50 | 0.52 | 0.81 | 0.81 |
| status-priority-in | `status IN (Backlog, "To Do") AND priority IN (High, Highest) ORDER BY created DESC` | 50 | 0.67 | 0.94 | 0.94 |
| labels-in | `labels IN (security, regression) ORDER BY created DESC` | 50 | 0.65 | 1.06 | 1.06 |
| summary-contains | `summary ~ "login" ORDER BY created DESC` | 50 | 5.56 | 5.62 | 5.62 |
| recent-bugs | `created >= -30d AND type = Bug ORDER BY created DESC` | 50 | 0.41 | 0.48 | 0.48 |
| stale-unresolved | `resolved IS EMPTY AND updated < -90d ORDER BY updated ASC` | 50 | 0.39 | 0.66 | 0.66 |
| number-gt-sorted | `"Ethhal number 8" > 500 AND space = AA ORDER BY "Ethhal number 8" DESC` | 50 | 8.79 | 9.49 | 9.49 |
| option-eq | `"Xanpir select 2" = "Hintor 3" AND statusCategory = todo ORDER BY created DESC` | 50 | 1.12 | 1.68 | 1.68 |
| date-window | `"Ismor date 5" <= endOfMonth() AND "Ismor date 5" >= startOfMonth() ORDER BY "Ismor date 5" ASC` | 50 | 2.56 | 2.95 | 2.95 |
| user-field-mine | `"Juneth user 11" = currentUser() ORDER BY updated DESC` | 6 | 3.54 | 3.95 | 3.95 |
| multi-in | `"Wenvin multiselect 20" IN ("Jungor 1", "Xanvel 2") AND status != Done ORDER BY created DESC` | 50 | 2.71 | 3.81 | 3.81 |
| number-empty | `"Ethhal number 8" IS EMPTY AND type IN (Story, Task) AND space = AA ORDER BY created DESC` | 50 | 0.63 | 0.74 | 0.74 |
| children | `parent = 1 ORDER BY created ASC` | 37 | 0.34 | 0.41 | 0.41 |
| mine-or-reported | `(assignee = currentUser() OR reporter = currentUser()) AND statusCategory != done ORDER BY updated DESC` | 50 | 0.56 | 0.65 | 0.65 |
| was-status | `status WAS "In Review" ORDER BY updated DESC` | 50 | 2.6 | 2.84 | 2.84 |
| changed-to-after | `status CHANGED TO Done AFTER -7d ORDER BY updated DESC` | 50 | 0.77 | 1.25 | 1.25 |
| changed-by-during | `assignee CHANGED BY 105 DURING (2024-01-01, 2024-02-01) ORDER BY created DESC` | 7 | 0.53 | 0.66 | 0.66 |
| not-or-spaces | `NOT (labels IN (infra) OR type = Subtask) AND space IN (AA, AB) ORDER BY created DESC` | 50 | 0.45 | 0.51 | 0.51 |
| was-rare | `status WAS Cancelled AND status = Done ORDER BY updated DESC` | 0 | 0.52 | 0.65 | 0.65 |
| permitted-half | `status = Done ORDER BY created DESC` | 50 | 0.48 | 0.76 | 0.76 |

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
