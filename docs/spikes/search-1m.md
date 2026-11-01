# Search perf set: 1,000,491 tickets

Generated 2026-11-01 23:54 UTC on Intel(R) Xeon(R) Processor @ 2.10GHz (4 cores, 16 GB), PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1). 20 timed runs of each statement after 2 warm-up runs, 10 of each request; latency from the client. The 50 queries of `apps/server/src/search/bench/perf.ts`, compiled by the production compiler (M1-037) and run as an ordinary member (the person at the tenth percentile of assignments, a member of every other track, one ticket in a hundred at a visibility level they are not in) and as a site administrator.

Budget: p95 under 300 ms at 10M tickets. Slowest statement p95 here: 113.08 ms (member), 91.83 ms (administrator); slowest request p95: 170.58 ms.

| Query | Text | Rows | Walk | Member p50 | Member p95 | Admin p95 | Request p95 | Count (capped 10,000) |
|---|---|---:|---|---:|---:|---:|---:|---:|
| all-newest | `(all)` | 50 | ticket | 1.38 | 1.64 | 1.06 | 63.39 | 10001 in 38.98 ms |
| all-newest-p2 | `(all)` | 50 | ticket | 1.85 | 2.01 | 1.07 | 47.41 | 10001 in 16.03 ms |
| all-updated | `ORDER BY updated DESC` | 50 | ticket | 1.25 | 1.59 | 0.82 | 41.21 | 10001 in 14.82 ms |
| track-newest | `track = AA` | 50 | ticket | 1.32 | 1.47 | 1.11 | 38.61 | 10001 in 15.58 ms |
| track-newest-p2 | `track = AA` | 50 | ticket | 1.17 | 1.5 | 1.61 | 41.73 | 10001 in 10.77 ms |
| track-oldest | `track = AA ORDER BY created ASC` | 50 | ticket | 1.42 | 1.76 | 1.16 | 43.13 | 10001 in 14.3 ms |
| track-status | `track = AA AND status = "In Progress" ORDER BY updated DESC` | 50 | ticket | 1.62 | 1.98 | 1.6 | 40.11 | 10001 in 173.62 ms |
| tracks-bugs | `track IN (AA, AC) AND type = Bug ORDER BY created DESC` | 50 | ticket | 1.62 | 2.39 | 1.91 | 42.8 | 10001 in 173.18 ms |
| track-by-key | `track = AC ORDER BY key ASC` | 50 | ticket | 1.79 | 2.08 | 1.12 | 50.69 | 10001 in 28.27 ms |
| mine-open | `assignee = currentUser() AND stage != closed ORDER BY priority DESC, created DESC` | 50 | ticket | 3.74 | 4.9 | 4.05 | 54.65 | 53 in 1.42 ms |
| mine-open-p2 | `assignee = currentUser() AND stage != closed ORDER BY priority DESC, created DESC` | 3 | ticket | 2.54 | 2.84 | 3.17 | 33.1 | 53 in 1.68 ms |
| mine-updated | `assignee = currentUser() ORDER BY updated DESC` | 50 | ticket | 1.65 | 1.95 | 0.76 | 47.49 | 110 in 1.6 ms |
| requested-by-me | `requester = currentUser() ORDER BY created DESC` | 50 | ticket | 1.36 | 1.61 | 4.36 | 44.19 | 139 in 1.55 ms |
| mine-or-requested | `(assignee = currentUser() OR requester = currentUser()) AND stage != closed ORDER BY updated DESC` | 50 | ticket | 1.7 | 2.78 | 1.12 | 49.57 | 123 in 2.53 ms |
| unassigned-new | `assignee IS EMPTY AND stage = new ORDER BY created DESC` | 50 | ticket | 1.77 | 2.04 | 1.34 | 46.93 | 10001 in 369.05 ms |
| someone-else | `assignee = 1 AND stage = active ORDER BY updated DESC` | 50 | ticket | 2.6 | 3.41 | 1.89 | 56.44 | 10001 in 332.04 ms |
| status-priority-in | `status IN (Backlog, "To Do") AND priority IN (High, Urgent) ORDER BY created DESC` | 50 | ticket | 1.94 | 3.78 | 1.37 | 52.97 | 10001 in 372.82 ms |
| active | `stage = active ORDER BY updated DESC` | 50 | ticket | 1.4 | 1.62 | 1.12 | 48.43 | 10001 in 66.61 ms |
| urgent-open | `priority = Urgent AND stage != closed ORDER BY created DESC` | 50 | ticket | 1.78 | 2.01 | 1.25 | 52.99 | 8003 in 209.07 ms |
| priority-above | `priority > Normal AND track = AA ORDER BY priority DESC, updated DESC` | 50 | ticket | 3.74 | 5.69 | 3.19 | 42.73 | 10001 in 206.75 ms |
| bugs-urgent | `type = Bug AND priority IN (Urgent, High) AND stage != closed ORDER BY priority DESC, created ASC` | 50 | ticket | 4.29 | 6.32 | 3.57 | 54.08 | 10001 in 537.08 ms |
| labels-in | `labels IN (tech-debt, a11y) ORDER BY created DESC` | 50 | ticket | 1.53 | 2.04 | 1.48 | 37.64 | 10001 in 190.9 ms |
| label-track | `labels = tech-debt AND track = AA` | 50 | ticket | 2.05 | 2.43 | 1.89 | 42.55 | 8150 in 135.2 ms |
| unlabelled-track | `labels IS EMPTY AND track = AA` | 50 | ticket | 1.19 | 1.39 | 1.09 | 42.93 | 10001 in 57.38 ms |
| summary-word | `summary ~ audit ORDER BY created DESC` | 50 | ticket | 1.65 | 2.01 | 1.32 | 35.61 | 10001 in 164.8 ms |
| summary-two-words | `summary ~ "audit upgrade" ORDER BY created DESC` | 50 | ticket | 84.94 | 113.08 | 9.92 | 170.58 | 3387 in 84.66 ms |
| summary-rare | `summary ~ script ORDER BY created DESC` | 50 | ticket | 2.45 | 2.68 | 1.83 | 38.72 | 10001 in 144.55 ms |
| description-track | `description ~ audit AND track = AC` | 0 | ticket | 0.95 | 1.2 | 0.83 | 12.7 | 0 in 1.08 ms |
| recent-bugs | `created >= -30d AND type = Bug ORDER BY created DESC` | 50 | ticket | 1.22 | 1.48 | 1.32 | 13.87 | 1146 in 43.87 ms |
| created-week | `created >= -7d ORDER BY created DESC` | 50 | ticket | 0.96 | 1.26 | 1.15 | 13.86 | 1235 in 2.39 ms |
| updated-today | `updated >= -1d ORDER BY updated DESC` | 50 | ticket | 1.06 | 1.39 | 1.08 | 15.93 | 3708 in 10.85 ms |
| stale-unresolved | `closed IS EMPTY AND updated < -90d ORDER BY updated ASC` | 50 | ticket | 1.6 | 1.9 | 1.35 | 38.75 | 10001 in 54.17 ms |
| closed-recently | `closed >= -7d ORDER BY closed DESC` | 50 | ticket | 4.38 | 5.63 | 4.77 | 12.56 | 1402 in 3.83 ms |
| due-soon | `due >= startOfWeek() AND due <= endOfWeek(1w) AND stage != closed ORDER BY due ASC` | 50 | ticket | 1.4 | 1.5 | 1.3 | 46.47 | 331 in 3.71 ms |
| number-gt-sorted | `"Ethhal number 8" > 500 AND track = AA ORDER BY "Ethhal number 8" DESC` | 50 | side table | 1.82 | 2.12 | 2.53 | 40.13 | 2138 in 99.07 ms |
| number-empty | `"Ethhal number 8" IS EMPTY AND type IN (Feature, Chore) AND track = AA ORDER BY created DESC` | 50 | ticket | 1.64 | 1.88 | 1.71 | 40.28 | 10001 in 147.69 ms |
| number-range | `"Ethhal number 8" >= 100 AND "Ethhal number 8" < 120 ORDER BY "Ethhal number 8" ASC` | 50 | side table | 2.39 | 3.16 | 2.16 | 41.01 | 272 in 11.57 ms |
| option-eq | `"Lovin select 53" = "Darsol 3" AND stage = new ORDER BY created DESC` | 50 | side table | 7.24 | 9.8 | 6.4 | 51.18 | 132 in 11.93 ms |
| option-in-updated | `"Lovin select 53" IN ("Darsol 3", "Senlin 2") ORDER BY updated DESC` | 50 | ticket | 12.67 | 16.83 | 16.09 | 45.97 | 838 in 12.17 ms |
| date-window | `"Ismor date 5" <= endOfMonth() AND "Ismor date 5" >= startOfMonth() ORDER BY "Ismor date 5" ASC` | 50 | side table | 7.29 | 7.99 | 5.13 | 21.73 | 658 in 30.3 ms |
| user-field-mine | `"Juneth user 11" = currentUser() ORDER BY updated DESC` | 4 | ticket | 6.45 | 7.4 | 4.15 | 28.35 | 4 in 3.65 ms |
| multi-in | `"Gorjun multiselect 381" IN ("Kaor 1", "Fenwen 2") AND status != Done ORDER BY created DESC` | 50 | side table | 11.35 | 12.51 | 9.37 | 43.6 | 1383 in 32.47 ms |
| multi-track | `"Gorjun multiselect 381" = "Kaor 1" AND track = AA ORDER BY created DESC` | 50 | side table | 8.58 | 10.76 | 6.95 | 44.52 | 286 in 10.88 ms |
| labels-field | `"Tamtor labels 15" = "tech-debt" ORDER BY created DESC` | 50 | side table | 2.69 | 3.14 | 2.96 | 42.32 | 1477 in 22.27 ms |
| text-field | `"Piris text 6" ~ limit ORDER BY created DESC` | 50 | ticket | 59.54 | 78.12 | 91.83 | 141.37 | 362 in 58.88 ms |
| children | `parent = BK-5 ORDER BY created ASC` | 50 | ticket | 1.63 | 1.86 | 1.43 | 43.66 | 67 in 1.4 ms |
| by-keys | `key IN (CG-7, AC-234, BC-37)` | 3 | ticket | 1.09 | 1.57 | 1.01 | 37.39 | 3 in 1.76 ms |
| outcomes | `parent IS EMPTY AND type = Outcome AND track = AA ORDER BY created DESC` | 50 | ticket | 2.15 | 3.64 | 2.67 | 34.41 | 7808 in 150.96 ms |
| following | `watcher = currentUser() ORDER BY updated DESC` | 50 | ticket | 2.34 | 2.71 | 1.4 | 30.72 | 180 in 1.83 ms |
| not-or-tracks | `NOT (labels IN (tech-debt) OR type = Subticket) AND track IN (AA, AC) ORDER BY created DESC` | 50 | ticket | 1.43 | 1.86 | 2.33 | 31.22 | 10001 in 74.84 ms |

## Plans (member)

- **all-newest**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **all-newest-p2**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **all-updated**: Limit / ->  Index Scan using ticket_updated_idx on ticket k / ->  Seq Scan on track_role_actor a
- **track-newest**: Limit / ->  Index Scan using ticket_track_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **track-newest-p2**: Limit / ->  Index Scan using ticket_track_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **track-oldest**: Limit / ->  Index Scan Backward using ticket_track_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **track-status**: Limit / ->  Index Scan using ticket_track_updated_idx on ticket k / ->  Seq Scan on track_role_actor a
- **tracks-bugs**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **track-by-key**: Limit / ->  Sort / Sort Key: / ->  Limit / ->  Incremental Sort / Sort Key: k.number, k.id / ->  Index Scan using ticket_track_number_key on ticket k / ->  Seq Scan on track_role_actor a
- **mine-open**: Limit / ->  Sort / Sort Key: / ->  Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k / ->  Seq Scan on track_role_actor a / ->  Limit / ->  Sort / Sort Key: k_1.created_at DESC, k_1.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k_1 / ->  Seq Scan on track_role_actor a_1 / ->  Limit / ->  Sort / Sort Key: k_2.created_at DESC, k_2.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k_2 / ->  Seq Scan on track_role_actor a_2 / ->  Limit / ->  Sort / Sort Key: k_3.created_at DESC, k_3.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k_3 / ->  Seq Scan on track_role_actor a_3 / ->  Limit / ->  Sort / Sort Key: k_4.created_at DESC, k_4.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k_4 / ->  Seq Scan on track_role_actor a_4
- **mine-open-p2**: Limit / ->  Sort / Sort Key: / ->  Limit / ->  Sort / Sort Key: created_at DESC, id DESC / ->  Limit / ->  Sort / Sort Key: created_at DESC, id DESC / ->  Limit / ->  Sort / Sort Key: created_at DESC, id DESC / ->  Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k / ->  Seq Scan on track_role_actor a / ->  Limit / ->  Sort / Sort Key: k_1.created_at DESC, k_1.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k_1 / ->  Seq Scan on track_role_actor a_1
- **mine-updated**: Limit / ->  Sort / Sort Key: k.updated_at DESC, k.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k / ->  Seq Scan on track_role_actor a
- **requested-by-me**: Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Index Scan using ticket_requester_idx on ticket k / ->  Seq Scan on track_role_actor a
- **mine-or-requested**: Limit / ->  Sort / Sort Key: k.updated_at DESC, k.id DESC / ->  Bitmap Heap Scan on ticket k / ->  Bitmap Index Scan on ticket_assignee_idx / ->  Bitmap Index Scan on ticket_requester_idx / ->  Seq Scan on track_role_actor a
- **unassigned-new**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **someone-else**: Limit / ->  Index Scan using ticket_updated_idx on ticket k / ->  Seq Scan on track_role_actor a
- **status-priority-in**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **active**: Limit / ->  Index Scan using ticket_updated_idx on ticket k / ->  Seq Scan on track_role_actor a
- **urgent-open**: Limit / ->  Index Scan using ticket_priority_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **priority-above**: Limit / ->  Sort / Sort Key: / ->  Limit / ->  Index Scan using ticket_track_updated_idx on ticket k / ->  Seq Scan on track_role_actor a / ->  Limit / ->  Index Scan using ticket_track_updated_idx on ticket k_1 / ->  Seq Scan on track_role_actor a_1
- **bugs-urgent**: Limit / ->  Sort / Sort Key: / ->  Limit / ->  Index Scan Backward using ticket_priority_created_idx on ticket k / ->  Seq Scan on track_role_actor a / ->  Limit / ->  Index Scan Backward using ticket_priority_created_idx on ticket k_1 / ->  Seq Scan on track_role_actor a_1
- **labels-in**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **label-track**: Limit / ->  Index Scan using ticket_track_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **unlabelled-track**: Limit / ->  Index Scan using ticket_track_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **summary-word**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **summary-two-words**: Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Bitmap Heap Scan on ticket k / ->  Bitmap Index Scan on ticket_summary_words_idx / ->  Bitmap Index Scan on ticket_track_number_key / ->  Seq Scan on track_role_actor a
- **summary-rare**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **description-track**: Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Bitmap Heap Scan on ticket k / ->  Bitmap Index Scan on ticket_description_words_idx / ->  Bitmap Index Scan on ticket_track_number_key / ->  Seq Scan on track_role_actor a
- **recent-bugs**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **created-week**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **updated-today**: Limit / ->  Index Scan using ticket_updated_idx on ticket k / ->  Seq Scan on track_role_actor a
- **stale-unresolved**: Limit / ->  Index Scan Backward using ticket_updated_idx on ticket k / ->  Seq Scan on track_role_actor a
- **closed-recently**: Limit / ->  Sort / Sort Key: k.closed_at DESC NULLS LAST, k.id DESC / ->  Index Scan using ticket_closed_idx on ticket k / ->  Seq Scan on track_role_actor a
- **due-soon**: Limit / ->  Index Scan using ticket_due_idx on ticket k / ->  Seq Scan on track_role_actor a
- **number-gt-sorted**: Limit / ->  Incremental Sort / Sort Key: a.value DESC, a.ticket_id DESC / ->  Nested Loop / ->  Index Only Scan Backward using v_number_track_field_value_idx on v_number a / ->  Index Scan using ticket_pkey on ticket k / ->  Seq Scan on track_role_actor a_1
- **number-empty**: Limit / ->  Nested Loop Anti Join / ->  Index Scan using ticket_track_created_idx on ticket k / ->  Seq Scan on track_role_actor a / ->  Index Only Scan using v_number_pkey on v_number v
- **number-range**: Limit / ->  Incremental Sort / Sort Key: a.value, a.ticket_id / ->  Nested Loop / ->  Index Scan using v_number_field_value_idx on v_number a / ->  Index Scan using ticket_pkey on ticket k / ->  Seq Scan on track_role_actor a_1
- **option-eq**: Limit / ->  Incremental Sort / Sort Key: a.created_at DESC, a.ticket_id DESC / ->  Nested Loop / ->  Index Scan using v_option_field_value_idx on v_option a / ->  Index Scan using ticket_pkey on ticket k / ->  Seq Scan on track_role_actor a_1
- **option-in-updated**: Limit / ->  Sort / Sort Key: k.updated_at DESC, k.id DESC / ->  Nested Loop / ->  Sort / Sort Key: v.ticket_id / ->  Index Only Scan using v_option_field_value_idx on v_option v / ->  Index Scan using ticket_pkey on ticket k / ->  Seq Scan on track_role_actor a
- **date-window**: Limit / ->  Incremental Sort / Sort Key: a.value, a.ticket_id / ->  Nested Loop / ->  Index Scan using v_date_field_value_idx on v_date a / ->  Index Scan using ticket_pkey on ticket k / ->  Seq Scan on track_role_actor a_1
- **user-field-mine**: Limit / ->  Sort / Sort Key: k.updated_at DESC, k.id DESC / ->  Nested Loop / ->  Index Only Scan using v_user_field_value_idx on v_user v / ->  Index Scan using ticket_pkey on ticket k / ->  Seq Scan on track_role_actor a
- **multi-in**: Limit / ->  Incremental Sort / Sort Key: a.created_at DESC, a.ticket_id DESC / ->  Nested Loop Anti Join / ->  Nested Loop / ->  Index Scan using v_option_field_created_idx on v_option a / ->  Index Scan using ticket_pkey on ticket k / ->  Seq Scan on track_role_actor a_1 / ->  Index Only Scan using v_option_pkey on v_option b
- **multi-track**: Limit / ->  Incremental Sort / Sort Key: a.created_at DESC, a.ticket_id DESC / ->  Nested Loop / ->  Index Only Scan using v_option_track_field_value_idx on v_option a / ->  Index Scan using ticket_pkey on ticket k / ->  Seq Scan on track_role_actor a_1
- **labels-field**: Limit / ->  Incremental Sort / Sort Key: a.created_at DESC, a.ticket_id DESC / ->  Nested Loop / ->  Index Scan using v_text_field_value_idx on v_text a / ->  Index Scan using ticket_pkey on ticket k / ->  Seq Scan on track_role_actor a_1
- **text-field**: Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Nested Loop / ->  HashAggregate / ->  Bitmap Heap Scan on v_text v / ->  Bitmap Index Scan on v_text_field_sort_idx / ->  Bitmap Index Scan on v_text_words_idx / ->  Index Scan using ticket_pkey on ticket k / ->  Seq Scan on track_role_actor a
- **children**: Limit / ->  Sort / Sort Key: k.created_at, k.id / ->  Index Scan using ticket_parent_idx on ticket k / ->  Seq Scan on track_role_actor a
- **by-keys**: Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Index Scan using ticket_pkey on ticket k / ->  Seq Scan on track_role_actor a
- **outcomes**: Limit / ->  Index Scan using ticket_track_created_idx on ticket k / ->  Seq Scan on track_role_actor a
- **following**: Limit / ->  Sort / Sort Key: k.updated_at DESC, k.id DESC / ->  Nested Loop / ->  HashAggregate / ->  Index Scan using ticket_follower_user_idx on ticket_follower r / ->  Index Scan using ticket_pkey on ticket k / ->  Seq Scan on track_role_actor a
- **not-or-tracks**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Seq Scan on track_role_actor a
