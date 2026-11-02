# Search perf set: 1,000,491 tickets

Generated 2026-11-02 00:25 UTC on Intel(R) Xeon(R) Processor @ 2.10GHz (4 cores, 16 GB), PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1). 20 timed runs of each statement after 2 warm-up runs, 10 of each request; latency from the client. The 50 queries of `apps/server/src/search/bench/perf.ts`, compiled by the production compiler (M1-037) and run as an ordinary member (the person at the tenth percentile of assignments, a member of every other track, one ticket in a hundred at a visibility level they are not in) and as a site administrator.

Budget: p95 under 300 ms at 1M tickets (10M is an estimate from these runs: decisions.csv, 2026-11-01). Slowest statement p95 here: 90.11 ms (member), 96.24 ms (administrator); slowest request p95: 155.15 ms.

| Query | Text | Rows | Walk | Member p50 | Member p95 | Admin p95 | Request p95 | Count (capped 10,000) |
|---|---|---:|---|---:|---:|---:|---:|---:|
| all-newest | `(all)` | 50 | ticket | 1.38 | 1.81 | 0.9 | 50.2 | 10001 in 49.91 ms |
| all-newest-p2 | `(all)` | 50 | ticket | 1.38 | 1.56 | 2.6 | 45.62 | 10001 in 14.82 ms |
| all-updated | `ORDER BY updated DESC` | 50 | ticket | 1.41 | 1.62 | 1.04 | 46.29 | 10001 in 13.82 ms |
| track-newest | `track = AA` | 50 | ticket | 1.33 | 1.74 | 1.02 | 55.5 | 10001 in 13.89 ms |
| track-newest-p2 | `track = AA` | 50 | ticket | 1.2 | 1.4 | 1.22 | 40.98 | 10001 in 22.24 ms |
| track-oldest | `track = AA ORDER BY created ASC` | 50 | ticket | 1.54 | 3.41 | 1.22 | 47.02 | 10001 in 14.56 ms |
| track-status | `track = AA AND status = "In Progress" ORDER BY updated DESC` | 50 | ticket | 2.18 | 3.43 | 1.38 | 48.61 | 10001 in 194.28 ms |
| tracks-bugs | `track IN (AA, AC) AND type = Bug ORDER BY created DESC` | 50 | ticket | 1.97 | 2.79 | 2.09 | 45.56 | 10001 in 195.6 ms |
| track-by-key | `track = AC ORDER BY key ASC` | 50 | ticket | 1.43 | 1.61 | 1.4 | 47.6 | 10001 in 28.1 ms |
| mine-open | `assignee = currentUser() AND stage != closed ORDER BY priority DESC, created DESC` | 50 | ticket | 4.57 | 5.21 | 2.03 | 44.82 | 65 in 1.68 ms |
| mine-open-p2 | `assignee = currentUser() AND stage != closed ORDER BY priority DESC, created DESC` | 15 | ticket | 2.62 | 4.08 | 2.85 | 39.73 | 65 in 1.45 ms |
| mine-updated | `assignee = currentUser() ORDER BY updated DESC` | 50 | ticket | 1.64 | 2.03 | 1 | 37.68 | 122 in 1.35 ms |
| requested-by-me | `requester = currentUser() ORDER BY created DESC` | 50 | ticket | 1.37 | 1.47 | 0.94 | 53.18 | 152 in 1.12 ms |
| mine-or-requested | `(assignee = currentUser() OR requester = currentUser()) AND stage != closed ORDER BY updated DESC` | 50 | ticket | 1.88 | 5.73 | 2.05 | 42.94 | 134 in 4.16 ms |
| unassigned-new | `assignee IS EMPTY AND stage = new ORDER BY created DESC` | 50 | ticket | 1.51 | 2.12 | 1.48 | 43.53 | 10001 in 381.58 ms |
| someone-else | `assignee = 1 AND stage = active ORDER BY updated DESC` | 50 | ticket | 2.24 | 2.89 | 2.48 | 41.31 | 10001 in 297.03 ms |
| status-priority-in | `status IN (Backlog, "To Do") AND priority IN (High, Urgent) ORDER BY created DESC` | 50 | ticket | 1.72 | 2.71 | 1.45 | 41.26 | 10001 in 304.96 ms |
| active | `stage = active ORDER BY updated DESC` | 50 | ticket | 1.57 | 1.74 | 0.94 | 49 | 10001 in 67.4 ms |
| urgent-open | `priority = Urgent AND stage != closed ORDER BY created DESC` | 50 | ticket | 1.22 | 1.83 | 1.32 | 47.72 | 8003 in 170.22 ms |
| priority-above | `priority > Normal AND track = AA ORDER BY priority DESC, updated DESC` | 50 | ticket | 3.56 | 5.55 | 4.27 | 44.46 | 10001 in 198.24 ms |
| bugs-urgent | `type = Bug AND priority IN (Urgent, High) AND stage != closed ORDER BY priority DESC, created ASC` | 50 | ticket | 3.95 | 5.34 | 3.04 | 40.01 | 10001 in 454.31 ms |
| labels-in | `labels IN (search, docs) ORDER BY created DESC` | 50 | ticket | 1.65 | 2.51 | 1.44 | 42.64 | 10001 in 173.98 ms |
| label-track | `labels = search AND track = AA` | 50 | ticket | 2.34 | 2.93 | 3.14 | 35.79 | 8125 in 125.3 ms |
| unlabelled-track | `labels IS EMPTY AND track = AA` | 50 | ticket | 0.89 | 1.26 | 0.95 | 32.89 | 10001 in 56.15 ms |
| summary-word | `summary ~ audit ORDER BY created DESC` | 50 | ticket | 1.57 | 1.94 | 1.31 | 37.06 | 10001 in 158.76 ms |
| summary-two-words | `summary ~ "audit after" ORDER BY created DESC` | 50 | ticket | 79.39 | 90.11 | 25.07 | 155.15 | 3387 in 79.57 ms |
| summary-rare | `summary ~ flow ORDER BY created DESC` | 50 | ticket | 2.45 | 5.3 | 2.92 | 32.4 | 10001 in 144.35 ms |
| description-track | `description ~ audit AND track = AC` | 0 | ticket | 1.05 | 1.35 | 1.6 | 15.07 | 0 in 1.24 ms |
| recent-bugs | `created >= -30d AND type = Bug ORDER BY created DESC` | 50 | ticket | 1.31 | 1.97 | 1.37 | 13.65 | 1146 in 45.66 ms |
| created-week | `created >= -7d ORDER BY created DESC` | 50 | ticket | 0.85 | 1.46 | 1.29 | 10.72 | 1235 in 2.34 ms |
| updated-today | `updated >= -1d ORDER BY updated DESC` | 50 | ticket | 1.02 | 1.24 | 0.84 | 15.92 | 3708 in 9.62 ms |
| stale-unresolved | `closed IS EMPTY AND updated < -90d ORDER BY updated ASC` | 50 | ticket | 1.49 | 2.2 | 1.21 | 35.2 | 10001 in 45.71 ms |
| closed-recently | `closed >= -7d ORDER BY closed DESC` | 50 | ticket | 3.87 | 4.73 | 4.26 | 12.11 | 1402 in 2.34 ms |
| due-soon | `due >= startOfWeek() AND due <= endOfWeek(1w) AND stage != closed ORDER BY due ASC` | 50 | ticket | 1.09 | 1.38 | 1.17 | 31.54 | 331 in 3.09 ms |
| number-gt-sorted | `"Ethhal number 8" > 500 AND track = AA ORDER BY "Ethhal number 8" DESC` | 50 | side table | 1.75 | 2.02 | 2.81 | 38.64 | 2138 in 100.03 ms |
| number-empty | `"Ethhal number 8" IS EMPTY AND type IN (Feature, Chore) AND track = AA ORDER BY created DESC` | 50 | ticket | 1.95 | 2.3 | 1.57 | 42.43 | 10001 in 166.63 ms |
| number-range | `"Ethhal number 8" >= 100 AND "Ethhal number 8" < 120 ORDER BY "Ethhal number 8" ASC` | 50 | side table | 2.09 | 2.34 | 2.19 | 42.88 | 272 in 12.31 ms |
| option-eq | `"Lovin select 53" = "Darsol 3" AND stage = new ORDER BY created DESC` | 50 | side table | 6.61 | 8.72 | 7.21 | 48.56 | 132 in 10.98 ms |
| option-in-updated | `"Lovin select 53" IN ("Darsol 3", "Senlin 2") ORDER BY updated DESC` | 50 | ticket | 11.03 | 11.37 | 12.99 | 54.07 | 838 in 10.63 ms |
| date-window | `"Ismor date 5" <= endOfMonth() AND "Ismor date 5" >= startOfMonth() ORDER BY "Ismor date 5" ASC` | 50 | side table | 4.16 | 4.83 | 5.56 | 13.9 | 658 in 16.54 ms |
| user-field-mine | `"Juneth user 11" = currentUser() ORDER BY updated DESC` | 3 | ticket | 3.76 | 5.18 | 5.59 | 24.33 | 3 in 3.23 ms |
| multi-in | `"Gorjun multiselect 381" IN ("Kaor 1", "Fenwen 2") AND status != Done ORDER BY created DESC` | 50 | side table | 10.91 | 13.86 | 14.9 | 46.58 | 1383 in 36.63 ms |
| multi-track | `"Gorjun multiselect 381" = "Kaor 1" AND track = AA ORDER BY created DESC` | 50 | side table | 6.3 | 7.26 | 8.3 | 47.78 | 286 in 12.07 ms |
| labels-field | `"Tamtor labels 15" = "tech-debt" ORDER BY created DESC` | 50 | side table | 3.52 | 4.57 | 3.2 | 45.89 | 1477 in 26.17 ms |
| text-field | `"Piris text 6" ~ limit ORDER BY created DESC` | 50 | ticket | 57.43 | 78.6 | 96.24 | 117.66 | 362 in 55.7 ms |
| children | `parent = BK-5 ORDER BY created ASC` | 50 | ticket | 1.37 | 1.56 | 1.89 | 43.27 | 67 in 1.37 ms |
| by-keys | `key IN (CG-7, AC-234, BC-37)` | 3 | ticket | 1.33 | 1.43 | 1.12 | 32.26 | 3 in 1.38 ms |
| outcomes | `parent IS EMPTY AND type = Outcome AND track = AA ORDER BY created DESC` | 50 | ticket | 2.01 | 2.31 | 2.37 | 31.42 | 7808 in 146.04 ms |
| following | `watcher = currentUser() ORDER BY updated DESC` | 50 | ticket | 3 | 3.76 | 0.94 | 64.98 | 194 in 2.8 ms |
| not-or-tracks | `NOT (labels IN (search) OR type = Subticket) AND track IN (AA, AC) ORDER BY created DESC` | 50 | ticket | 1.89 | 2 | 1.59 | 42.83 | 10001 in 108.51 ms |

## Opening a ticket (member)

Budget: under 100 ms p95, warm. 20 tickets the member may see, each opened once to warm and then timed: the ticket by its key alone, and the page's reads: the ticket by key, then the 5 it sends together once it has the ticket (info, comments, history, transitions, links).

| Request | p50 | p95 | Max |
|---|---:|---:|---:|
| The ticket | 11.56 | 15.52 | 21.07 |
| The ticket page's 6 requests | 36.56 | 42.11 | 46.91 |

## Plans (member)

- **all-newest**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **all-newest-p2**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **all-updated**: Limit / ->  Index Scan using ticket_updated_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **track-newest**: Limit / ->  Index Scan using ticket_track_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **track-newest-p2**: Limit / ->  Index Scan using ticket_track_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **track-oldest**: Limit / ->  Index Scan Backward using ticket_track_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **track-status**: Limit / ->  Index Scan using ticket_track_updated_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **tracks-bugs**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **track-by-key**: Limit / ->  Sort / Sort Key: / ->  Limit / ->  Incremental Sort / Sort Key: k.number, k.id / ->  Index Scan using ticket_track_number_key on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **mine-open**: Limit / ->  Sort / Sort Key: / ->  Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a / ->  Limit / ->  Sort / Sort Key: k_1.created_at DESC, k_1.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k_1 / ->  Bitmap Heap Scan on track_role_actor a_1 / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx / ->  Limit / ->  Sort / Sort Key: k_2.created_at DESC, k_2.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k_2 / ->  Bitmap Heap Scan on track_role_actor a_2 / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx / ->  Limit / ->  Sort / Sort Key: k_3.created_at DESC, k_3.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k_3 / ->  Bitmap Heap Scan on track_role_actor a_3 / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx / ->  Limit / ->  Sort / Sort Key: k_4.created_at DESC, k_4.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k_4 / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a_4
- **mine-open-p2**: Limit / ->  Sort / Sort Key: / ->  Limit / ->  Sort / Sort Key: created_at DESC, id DESC / ->  Limit / ->  Sort / Sort Key: created_at DESC, id DESC / ->  Limit / ->  Sort / Sort Key: created_at DESC, id DESC / ->  Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx / ->  Limit / ->  Sort / Sort Key: k_1.created_at DESC, k_1.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k_1 / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a_1
- **mine-updated**: Limit / ->  Sort / Sort Key: k.updated_at DESC, k.id DESC / ->  Index Scan using ticket_assignee_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **requested-by-me**: Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Index Scan using ticket_requester_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **mine-or-requested**: Limit / ->  Sort / Sort Key: k.updated_at DESC, k.id DESC / ->  Bitmap Heap Scan on ticket k / ->  Bitmap Index Scan on ticket_assignee_idx / ->  Bitmap Index Scan on ticket_requester_idx / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **unassigned-new**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **someone-else**: Limit / ->  Index Scan using ticket_updated_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **status-priority-in**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **active**: Limit / ->  Index Scan using ticket_updated_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **urgent-open**: Limit / ->  Index Scan using ticket_priority_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **priority-above**: Limit / ->  Sort / Sort Key: / ->  Limit / ->  Index Scan using ticket_track_updated_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx / ->  Limit / ->  Index Scan using ticket_track_updated_idx on ticket k_1 / ->  Bitmap Heap Scan on track_role_actor a_1 / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **bugs-urgent**: Limit / ->  Sort / Sort Key: / ->  Limit / ->  Index Scan Backward using ticket_priority_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx / ->  Limit / ->  Index Scan Backward using ticket_priority_created_idx on ticket k_1 / ->  Bitmap Heap Scan on track_role_actor a_1 / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **labels-in**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **label-track**: Limit / ->  Index Scan using ticket_track_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **unlabelled-track**: Limit / ->  Index Scan using ticket_track_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **summary-word**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **summary-two-words**: Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Bitmap Heap Scan on ticket k / ->  Bitmap Index Scan on ticket_summary_words_idx / ->  Bitmap Index Scan on ticket_track_number_key / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **summary-rare**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **description-track**: Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Bitmap Heap Scan on ticket k / ->  Bitmap Index Scan on ticket_description_words_idx / ->  Bitmap Index Scan on ticket_track_number_key / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **recent-bugs**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **created-week**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **updated-today**: Limit / ->  Index Scan using ticket_updated_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **stale-unresolved**: Limit / ->  Index Scan Backward using ticket_updated_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **closed-recently**: Limit / ->  Sort / Sort Key: k.closed_at DESC NULLS LAST, k.id DESC / ->  Index Scan using ticket_closed_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **due-soon**: Limit / ->  Index Scan using ticket_due_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **number-gt-sorted**: Limit / ->  Incremental Sort / Sort Key: a.value DESC, a.ticket_id DESC / ->  Nested Loop / ->  Index Only Scan Backward using v_number_track_field_value_idx on v_number a / ->  Index Scan using ticket_pkey on ticket k / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a_1
- **number-empty**: Limit / ->  Nested Loop Anti Join / ->  Index Scan using ticket_track_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx / ->  Index Only Scan using v_number_pkey on v_number v
- **number-range**: Limit / ->  Incremental Sort / Sort Key: a.value, a.ticket_id / ->  Nested Loop / ->  Index Scan using v_number_field_value_idx on v_number a / ->  Index Scan using ticket_pkey on ticket k / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a_1
- **option-eq**: Limit / ->  Incremental Sort / Sort Key: a.created_at DESC, a.ticket_id DESC / ->  Nested Loop / ->  Index Scan using v_option_field_value_idx on v_option a / ->  Index Scan using ticket_pkey on ticket k / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a_1
- **option-in-updated**: Limit / ->  Sort / Sort Key: k.updated_at DESC, k.id DESC / ->  Nested Loop / ->  Sort / Sort Key: v.ticket_id / ->  Index Only Scan using v_option_field_value_idx on v_option v / ->  Index Scan using ticket_pkey on ticket k / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a
- **date-window**: Limit / ->  Incremental Sort / Sort Key: a.value, a.ticket_id / ->  Nested Loop / ->  Index Scan using v_date_field_value_idx on v_date a / ->  Index Scan using ticket_pkey on ticket k / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a_1
- **user-field-mine**: Limit / ->  Sort / Sort Key: k.updated_at DESC, k.id DESC / ->  Nested Loop / ->  Index Only Scan using v_user_field_value_idx on v_user v / ->  Index Scan using ticket_pkey on ticket k / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a
- **multi-in**: Limit / ->  Incremental Sort / Sort Key: a.created_at DESC, a.ticket_id DESC / ->  Nested Loop Anti Join / ->  Nested Loop / ->  Index Scan using v_option_field_created_idx on v_option a / ->  Index Scan using ticket_pkey on ticket k / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a_1 / ->  Index Only Scan using v_option_pkey on v_option b
- **multi-track**: Limit / ->  Incremental Sort / Sort Key: a.created_at DESC, a.ticket_id DESC / ->  Nested Loop / ->  Index Only Scan using v_option_track_field_value_idx on v_option a / ->  Index Scan using ticket_pkey on ticket k / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a_1
- **labels-field**: Limit / ->  Incremental Sort / Sort Key: a.created_at DESC, a.ticket_id DESC / ->  Nested Loop / ->  Index Scan using v_text_field_value_idx on v_text a / ->  Index Scan using ticket_pkey on ticket k / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a_1
- **text-field**: Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Nested Loop / ->  HashAggregate / ->  Bitmap Heap Scan on v_text v / ->  Bitmap Index Scan on v_text_field_sort_idx / ->  Bitmap Index Scan on v_text_words_idx / ->  Index Scan using ticket_pkey on ticket k / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a
- **children**: Limit / ->  Sort / Sort Key: k.created_at, k.id / ->  Index Scan using ticket_parent_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **by-keys**: Limit / ->  Sort / Sort Key: k.created_at DESC, k.id DESC / ->  Index Scan using ticket_pkey on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **outcomes**: Limit / ->  Index Scan using ticket_track_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
- **following**: Limit / ->  Sort / Sort Key: k.updated_at DESC, k.id DESC / ->  Nested Loop / ->  HashAggregate / ->  Index Scan using ticket_follower_user_idx on ticket_follower r / ->  Index Scan using ticket_pkey on ticket k / ->  Index Scan using track_role_actor_unique_idx on track_role_actor a
- **not-or-tracks**: Limit / ->  Index Scan using ticket_created_idx on ticket k / ->  Bitmap Heap Scan on track_role_actor a / ->  Bitmap Index Scan on track_role_actor_user_idx / ->  Bitmap Index Scan on track_role_actor_group_idx
