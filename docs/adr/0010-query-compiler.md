# ADR-010: Query language: own grammar, AST, resolver and SQL compiler with a permission pre-filter

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-017

## Context

The query language is the product's spine: search, boards, saved searches, subscriptions, webhooks,
automation and OData all run through it (QRY-001 to QRY-014). No open-source JQL compiler
exists and Atlassian's parser is for its own use; users arrive with thousands of saved
filters written in both the old vocabulary (`project`, `issuetype`) and the new one. The
budget is a p95 under 300 ms for the 20 representative queries at 10M tickets, with browse
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
  ticket table; each custom-field condition is an `EXISTS` on its side table (ADR-008); labels
  use array containment; text search uses the full-text index (ADR-011); `WAS` and `CHANGED`
  are one `EXISTS` on the change history, which holds the creation values too, so a rare
  value starts from the history index instead of scanning tickets; `ORDER BY` adds the id as a
  tiebreaker (stable cursors, QRY-009) and puts `NULLS LAST` only on nullable columns, so
  newest-first lists walk the `(…, created_at DESC, id DESC)` indexes. When the order is by
  creation date or by a custom field the query also filters, the statement is **driven from
  that field's side table**: side rows carry the ticket's `created_at` and `space_id`
  (ADR-008), so the side index yields the page in order; other conditions on the same field,
  `track` and the permission pre-filter apply to the side row, the rest to the joined ticket
  (left out when nothing needs it); a multi-select condition that can match several rows of one
  ticket keeps only the ticket's lowest matching value. Side-table comparisons are cast to the
  value column's type (a user field compared as `numeric` against an `int` column could not
  use its index). Values are always parameters; the compiler never interpolates text.
- **The permission pre-filter** (ADR-012) is part of the statement: `space_id = ANY($allowed)`
  for ordinary users, inverted or omitted for users who see most or all tracks, plus the
  visibility-level predicate.
- **JQL is a dialect**, not the native language: the same AST, with aliases and legacy
  functions accepted on input and the native names printed on output (QRY-003).
- **Explain** (QRY-010): the compiled statement is available to admins with `EXPLAIN`, and a
  statement timeout (default 30 s) bounds every query.

## Measurements (spike, 2026-10-12)

The 20 representative queries plus a permission-filtered one and a rare-history worst case,
on the ADR-008 schema with the product's extra indexes (newest-first with id, requester,
labels GIN, summary full-text, history by ticket and field, by value and by actor), LIMIT 50,
10 to 20 timed runs after warm-up, latency from the client.

200,000 tickets ([report](../spikes/query-compiler-200k.md)): every query under 10 ms; the
slowest is `"{number}" > 500 AND track = X ORDER BY "{number}" DESC` at 9.5 ms p95, the
rare-history worst case 0.65 ms, the permission-filtered query 0.76 ms.

Two compiler changes came out of the spike: the id tiebreaker needs to be in the index and
`NULLS LAST` must not be emitted on `NOT NULL` columns, or the planner sorts a whole track
(41.7 ms down to 0.65 ms for the newest-first list at 200k tickets); and `WAS` must be one
`EXISTS` so a value that never occurred (0 rows) does not walk the table (1.9 s down to
0.65 ms at 1M).

**1,000,000 and 10,000,000 tickets** (M0-017 gate; NVMe, 64 GB RAM, `shared_buffers` 1 GB, 20
runs; reports [1M](../spikes/query-compiler-1m.md), [10M](../spikes/query-compiler-10m.md)).
Every query meets the 300 ms budget at both sizes:

| Query | 1M p95 ms | 10M p95 ms |
|---|---:|---:|
| `track = X ORDER BY created DESC` | 0.59 | 0.62 |
| `track = X AND status = "In Progress" ORDER BY updated DESC` | 1.68 | 2.44 |
| `assignee = currentUser() AND stage != closed ORDER BY priority DESC, created DESC` | 0.72 | 0.89 |
| `status IN (…) AND priority IN (…) ORDER BY created DESC` | 0.90 | 0.59 |
| `labels IN (…) ORDER BY created DESC` | 0.80 | 0.88 |
| `summary ~ "login" ORDER BY created DESC` | 7.02 | 6.62 |
| `created >= -30d AND type = Bug ORDER BY created DESC` | 0.74 | 0.65 |
| `closed IS EMPTY AND updated < -90d ORDER BY updated ASC` | 0.59 | 0.95 |
| `"{number}" > 500 AND track = X ORDER BY "{number}" DESC` | 0.84 | 0.81 |
| `"{select}" = "{option}" AND stage = new ORDER BY created DESC` | 4.89 | 5.19 |
| `"{date}" <= endOfMonth() AND "{date}" >= startOfMonth() ORDER BY "{date}" ASC` | 2.34 | 2.05 |
| `"{user}" = currentUser() ORDER BY updated DESC` | 2.61 | 2.86 |
| `"{multi}" IN (A, B) AND status != Done ORDER BY created DESC` | 8.72 | 10.31 |
| `"{number}" IS EMPTY AND type IN (…) AND track = X ORDER BY created DESC` | 0.89 | 0.96 |
| `parent = N ORDER BY created ASC` | 0.41 | 0.55 |
| `(assignee = currentUser() OR requester = currentUser()) AND … ORDER BY updated DESC` | 0.87 | 1.15 |
| `status WAS "In Review" ORDER BY updated DESC` | 3.64 | 5.17 |
| `status CHANGED TO Done AFTER -7d ORDER BY updated DESC` | 2.38 | 17.39 |
| `assignee CHANGED BY u DURING (…) ORDER BY created DESC` | 0.70 | 0.70 |
| `NOT (labels IN (…) OR type = Subticket) AND track IN (…) ORDER BY created DESC` | 0.83 | 0.91 |
| `status WAS Cancelled AND status = Done ORDER BY updated DESC` (no rows) | 0.83 | 0.83 |
| `status = Done ORDER BY created DESC`, permitted to half the tracks | 1.14 | 2.33 |

The first 10M run, before driving from the side table, missed the budget on the four
custom-field queries ordered by a ticket column: three timed out at 60 s and the user-field
query took 4.5 s, because the planner either probed the side table for every ticket in date
order or fetched every match and sorted. Driving from the side table fixed three; the
multi-select one also needed the planner statistics of ADR-008 (its estimate was 121 rows for
37,000 matches). An equivalence test runs every query of the set and fourteen aimed at the
side-table paths in both forms, with and without the permission filter, and requires identical
rows in identical order.

The permission pre-filter (ADR-012) adds at most 3.6 ms at 10M tickets (filtered queries all
under 4.5 ms; [report](../spikes/authz-overhead-10m.md)), within its budget of at most 10 ms
added (absolute since 2026-10-12, `docs/plan/decisions.csv`).

## Implementation (M1-036: the resolver)

- **The catalogue is spec 01b section 1.5**: every system field under its native name, its
  Jira-compatible names and a display name (`"Due date"`), each with a type
  (`packages/query/src/fields.ts`). Fields of modules not built yet (sprints, service,
  journeys, saved searches, visibility) resolve; the compiler (M1-037) names the module when a
  query needs one. Custom fields come from the workspace's field catalogue
  (`apps/server/src/search/catalogue.ts`): shared ones and the local ones of tracks the person
  may browse, by name or `cf[id]`; the server's field types map onto the query types (text
  types to `text`, single and multiple selects to `option` and `multi`, cascades, people,
  groups, labels, releases, areas, dates and date-times).
- **One operator table** (`OPERATORS_BY_TYPE`): ordering comparisons for numbers, dates and
  date-times, releases and priorities; `~` and `!~` for text, which takes no equality or list
  operators; attachments only `IS [NOT] EMPTY`; `= EMPTY`, `!= EMPTY` and `IS [NOT] EMPTY`
  everywhere else; the history operators on every field that changes over time (not on
  counts such as `votes`, nor `lastViewed`). A refusal names the field and the operator
  (QRY-002 (1)); a matrix test checks all 17 operators on every field.
- **Names:** a system field wins over a custom field of the same name; two custom fields of
  one name are refused with their ids (QRY-003 (2)). Track keys include the old keys a track
  had, so saved queries survive renames. People are named by id, `currentUser()` or a name or
  email the compiler looks up; history predicates are kept in a fixed order, so their order in
  the text does not matter; dates read with dashes or slashes (section 1.4).
- **Checking without running:** `GET /api/v1/search/check?q=` answers what a query uses or
  where and why it is wrong, for the query editor (M1-041).
- **Conformance:** grammar, operators, history, dates, text, ordering and saved searches pass
  in full, fields at 99%; 94% overall (from 76%). Functions (M1-038, M1-045) and sprint tokens
  (M1-045) are the rest.

## Implementation (M1-037: the compiler)

- **Where:** `apps/server/src/search/`. A resolved plan is **bound** (`bind.ts`: names become
  ids, `NOT` is pushed down, each clause is matched with the table that answers it, and what
  the product cannot answer yet is refused) and **compiled** (`compile.ts`: pure, Kysely `sql`
  fragments, no database at hand, so its SQL is a reviewed golden file,
  `search/__golden__/compile.json`); `run.ts` runs it. The M0 spike compiler stays in
  `packages/query/src/compile.ts` for the spike benchmarks only. Started from an earlier
  agent's uncommitted draft (`work/m1-037-sql-compiler`), ported onto M1-028 and finished.
- **Values are parameters**, cast to the column's type; the compiler writes only its own text.
  A fuzz test (10,000 generated queries per run, `SEARCH_FUZZ_RUNS` to change it; comments
  and value branches included) checks that a statement's text never depends on the values in
  it and that every value is a parameter (QRY-010 (1)).
- **The permission pre-filter is in every statement** (QRY-008): workspace, "not in the trash"
  and `request.authz.ticketFilter()` (track browsing, ticket-level grants, visibility levels;
  ADR-012) on `ticket k`, in the side-table walks and in every value branch too; side-table
  walks also limit the side rows to the viewer's tracks so the index does it. Counts use the
  same conditions. Archived tracks are left out unless a site administrator asks
  (`archived=true`; `ticketFilter({ includeArchived })`). The ticket views of a page are read
  with the filter again, so a ticket hidden between the two statements stays hidden.
  - A **property test** (`search/authz.test.ts`, the random worlds of the M1-020 test: level
    members of every grantee kind, ticket-level browse grants, eight tickets, thirty worlds)
    runs a plain query, a side-table walk, value branches, a subquery order and a level query
    for five people and requires exactly the tickets an unrestricted run returns that
    `ticketPermissions` lets the person browse, in the same order, and the same count. Dropping
    the filter from the branches makes it fail (checked).
  - A **matrix test** (`routes/search.visibility.test.ts`, QRY-008 (2)): five levels (a user, a
    nested group, a track role, the requester, a user field) and four people plus the
    administrator, through every form of statement, counts and cursor pages; the explain view
    shows the level predicate (QRY-008 (3)).
- **Comments (M1-018):** `comment ~`, `comment !~`, `comment IS [NOT] EMPTY` and `text ~` see a
  comment only where `commentReadableSql` (`tickets/comments.ts`) lets the viewer read it:
  open comments, their own, and those for a group they are in or a role they hold in the
  track; never a deleted one, for site administrators neither. `!~` on comments means "has
  comments the viewer reads and none matches".
- **Empty values (spec 01b 1.1):** a clause never matches an empty field unless it says so.
  `NOT` is pushed down by De Morgan and turns each clause around by its operator (`NOT a = x`
  reads `a != x`), so it never brings empties back either. On fields with several values
  (multiple selects, people, labels, areas, releases, followers) `=` and `IN` mean "one of its
  values", `!=` and `NOT IN` "it has values and none of them".
- **Names to ids:** statuses, priorities, types, close reasons, levels, groups, areas,
  releases, link types (by name or either description) and options (any level of a cascade)
  by name in any case or by id; a name that matches nothing is refused naming the field. People
  by id, `currentUser()`, email or name. Ticket keys (old ones too) of tickets the person cannot
  see, or that do not exist, match nothing and come back as a warning, so a key reveals
  nothing. `stage` takes `new`, `active`, `closed` and the Jira-compatible `To Do`,
  `In Progress`, `Done`. Ordering comparisons on priorities mean "more urgent" (`priority >
  High`), on releases the track's release order; `hierarchyLevel` compares level numbers.
  Formula fields (M1-013) search as their output, through the side table it is kept in.
- **Text (`~`, `!~`) until M1-040** (replaced since, see "Text search (M1-040)"): every word
  of the value must occur, in any order, case folded, without stemming (`simple`
  configuration): the summary, the text of description and environment documents and comment
  bodies through word indexes (GIN on the compiler's own expressions, so the planner matches
  them), custom text fields through their side rows; `text ~` covers all of those.
- **Refused for now, with a message that says why:** `WAS` and `CHANGED` (M1-039; built since, see "History operators (M1-039)"),
  `lastViewed` (not recorded yet), fields of modules not built (boards and sprints, service
  tracks, journeys, saved searches), functions other than `currentUser()` and the date
  functions (the resolver already refuses those; M1-038), and ordering by a field the catalogue
  does not mark sortable. Time entry comments and dates search only entries shown to everyone.
  `parentTrack` reads as the track of the ticket's parent (the spec leaves it open).
- **Order (QRY-009):** the keys asked for (default: created, newest first), empties last
  (`NULLS LAST` only where a value can be empty), then the ticket id in the direction of the
  last key, so the order is total. Spec 01b 1.7 breaks ties by key; the id gives the same order
  within a track except for moved tickets and keeps pages on an index. Option fields sort by
  option order, people by name, releases by release order, text by its folded sort key,
  priorities by rank, statuses by the workspace's status order, keys by track key and number.
  The page orders by its output columns, so a subquery key is computed once.
- **Keyset pages:** a cursor is the last row's order values and id plus a signature of the
  order (base64url JSON), refused for any other order. One direction and no empty values: a
  row comparison `(k.created_at, k.id) < ($1, $2)` the index serves; otherwise the expanded
  form. Instants travel as Postgres text, so microseconds survive. The first page also counts
  matches up to 10,000 (`total: { count, exact }`); beyond it an estimate since M1-040 (ADR-069).
- **Driving from a side table** works as the spike found (created order, or the value order of
  a number, date or date-time field the query also filters), with two production details: one
  value is an equality, not `= ANY(array)`, so `(field_id, value, created_at)` still yields
  rows in order; and option, person and release fields never drive by value, because their
  ids do not sort as they display.
- **Value branches** (not in the spike): when the first order
  key reads one ticket column with few values (priority, status, type, hierarchy level, close
  reason, track key), the binder reads that column's values with the query and the compiler
  writes a `UNION ALL` of one branch per value (at most 40, the empty one last), each with the
  query's conditions, ordered by the remaining keys and cut at the page size, merged by the
  outer `ORDER BY`. Each branch walks an index in the remaining order instead of sorting all
  matches: `track = X ORDER BY key` walks `(track_id, number)`, `priority > Normal AND track =
  X ORDER BY priority DESC, updated DESC` walks `(track_id, updated_at)` once per priority, and
  `ORDER BY priority DESC, created ASC` walks the new `(priority_id, created_at)`. Top-level
  conditions on the column leave values out and are not repeated inside the branches (so the
  planner does not count them twice); for track keys, so do the viewer's tracks. A cursor's
  first value decides each branch in SQL (`$v < $cursor OR ($v = $cursor AND rest after)`),
  so text values compare in the database's collation exactly as the plain form sorts them. A
  test pages through eight orders in both forms from cursors anywhere (an empty-priority row
  included) and requires identical pages; `branches: false` keeps the single statement.
- **Timeout and explain (QRY-010):** statements run in a read-only transaction with
  `statement_timeout` from `TASKMOOR_QUERY_TIMEOUT_MS` (default 30 s, 100 ms to 10 min); a query
  over it answers 503 `query_timeout`. `GET /api/v1/admin/search/explain?q=` shows a site
  administrator the SQL, its parameters, whether it walks a side table or merges branches, and
  the plan with its estimated costs (`analyze=true` runs it).
- **API:** `GET` and `POST /api/v1/search` (`q`, `limit` up to 200, `cursor`, `fields`,
  `count`, `archived`) answer ticket views as `GET /api/v1/tickets` does; POST only reads, so
  read tokens reach it and it emits no event. Bulk changes take `query` instead of `tickets`
  (ADR-043 "Selection by query").
- **Indexes (migration 0043):** newest first site-wide and by track, recently updated
  site-wide and by track (`... DESC, id DESC`, partial on live tickets), closed, due,
  requester, `(priority_id, created_at DESC, id DESC)` in place of the plain priority index,
  and word indexes (GIN) on the summary, description and environment documents and comment
  bodies.
- **Plan regression (`search/plans.test.ts`):** 28 representative queries over 20,000
  synthetic tickets (with descriptions and comments), planned as an ordinary member with a
  visibility level in play; each plan's shape (node types, indexes, scan direction, no costs)
  is a golden file per Postgres major version (`plans-pg16.json`), and every version checks
  the indexes each query must use (one of several where the planner may pick any index on the
  track) and that no plan reads the ticket table whole. The data is arithmetic, under
  ANALYZE's sample size and vacuumed, and the planner settings are fixed, so plans are the same
  everywhere. The same file checks that side-table walks and value branches return the same
  pages as the plain statement.

**Measurements (M1-037, 2026-10-29).** The 50-query perf set (`search/bench/perf.ts`; `pnpm
bench:search --database-url <url>` on a database where `pnpm gen` loaded its dataset; the bench
sets `random_page_cost = 1.1` and `effective_cache_size` on the database as deploy/README.md
recommends) at 1M tickets (1,500 fields, about 25 values per ticket, 29M side rows; cloud container,
4 cores, 16 GB, Postgres 16, other sessions' tests running alongside), as an ordinary member
(100 of 200 tracks, one ticket in a hundred at a level they are not in) and as a site
administrator; [report](../spikes/search-1m.md):

| | Statement p95, member | Statement p95, administrator | Request p95 (`count=false`) |
|---|---:|---:|---:|
| Median of the 50 queries | 2.3 ms | 1.5 ms | 34.5 ms |
| Slowest | 116 ms (`summary ~ "audit safari"`) | 38 ms | 179 ms |

All 50 are under 300 ms at 1M. Before value branches, the new indexes and ANALYZE of the word
indexes, the draft compiler on the same data had five over 300 ms: `track = X ORDER BY key`
(p50 442 ms, now 1.1 ms), `priority > Normal AND track = X ORDER BY priority DESC, updated
DESC` (438 ms, now 2.6 ms), `type = Bug AND priority IN (Urgent, High) AND stage != closed
ORDER BY priority DESC, created ASC` (432 ms, now 4.4 ms), `description ~ audit AND track = Y`
(874 ms, now 1.0 ms) and `summary ~ audit` (463 ms, now 3.4 ms). Capped counts take up to 396
ms (`bugs-urgent`, 10,001 matches); the first page asks for one by default.

**10M is not measured here.** The 1M database takes 11 GB (25 values per ticket); 10M at the
same shape needs about 110 GB of disk and about two hours to generate and load (`pnpm gen`
loads 3,500 tickets/s; `--fields-per-item 5 --fields 300` keeps each field as dense in about a
third of the space). The container had 17 GB free and shared it. What to watch at 10M: plans
that walk an index stay flat; those that read every match grow with the data: two-word
summary searches (the planner's estimate for two words assumes they are independent, so it
reads 3,473 matches and sorts them instead of walking `created`), custom text fields (no word
index on side rows until M1-040), and capped counts. Run `pnpm gen --items 10000000
--database-url <url>` then `pnpm bench:search --database-url <url>` on a machine with the disk
(M1-117 owns the 10M nightly).

## Functions (M1-038: batch 1)

- **Signatures in one table** (`packages/query/src/functions.ts`): every function of spec 01b
  section 1.6 with what it returns (people, a date, tickets, tracks, areas, ticket types,
  options, releases, sprints, approvals, SLA states, customer groups), its arguments by kind
  and whether it returns several values. The resolver checks a call against it: an unknown
  name is refused by name; a field that does not take the result is refused naming both
  (`membersOf() returns people, which "status" does not take`); a missing or extra argument is
  refused naming it (`membersOf() needs its group (the first argument)`, QRY-004 (3)); a
  function returning several values takes only `IN` and `NOT IN`. Names come through the
  dialect (`nativeFunctionName`), so every Jira-compatible name is the same function.
- **The resolver evaluates what needs no database:** `currentUser()` (an id, as before) and the
  date functions. Everything else becomes a call value, `{ type: 'call', fn, args }`, with its
  arguments typed (people as ids or names, dates as instants, keys upper-cased, tracks as ids),
  for the server's binder. Functions of modules not built yet (sprints and releases: M1-045;
  service tracks: M2) resolve too, as fields of those modules do (M1-036), and the binder
  names the module. The M0 spike compiler refuses call values.
- **Dates on the person's clock (QRY-006):** absolute dates and the date functions are read in
  the person's time zone (`app_user.time_zone`; UTC when unset or unknown to the platform), by
  calendar arithmetic over `Intl` (`packages/query/src/dates.ts`). A date field compares with
  the person's calendar date. Weeks start on Sunday and end on Saturday (spec 01b 1.4; M1-036
  started them on Monday); the resolver takes another first day (`weekStart`), but the site
  setting itself is not built yet. An increment moves the period's edge on the calendar
  (`startOfMonth(+14d)` is the 15th; `endOfMonth(+1M)` is the next period's start moved a
  month, less a millisecond, so the end of next month whatever its length). Days stay whole
  across clock changes (a 23-hour day ends at its own 23:59:59.999); a time the clock skips
  reads past the gap, a repeated one as its first occurrence. `now()` takes an increment too
  (`now(-30m)`). `currentLogin()` is the start of the person's session (with an API token, of
  their latest session or sign-in); `lastLogin()` the start of the latest session before it,
  or the current one when there is none (sessions removed at sign-out take theirs along).
- **What the binder makes of each function** (`apps/server/src/search/bind.ts`):

| Function | Becomes |
|---|---|
| `membersOf(group)` | The ids of the group's members, nested groups' included; `"id:<team>"` is refused until teams exist |
| `tracksOwnedByUser(user?)`, `areasOwnedByUser(user?)` | Ids of the tracks or areas the person (by default the one searching) owns |
| `tracksWhereUserHasPermission(permission)` | The authorizer's `allowedTracks` for the person; a permission by its code or Jira-compatible key (`BROWSE_PROJECTS`, `Browse projects`, `browse_track`; dialect `PERMISSION_NAMES`) |
| `tracksWhereUserHasRole(role)` | Tracks where the person, or a group they are in (nesting included), acts in the role |
| `standardTicketTypes()`, `subticketTypes()` | Ticket types by level kind |
| `choiceOption(options...)`, `cascadeOption(parent, child?)` | Options of the field by id or value; `cascadeOption(parent, none)` is not built |
| `followedTickets()`, `votedTickets()`, `ticketHistory()` | A ticket set: the person's rows in `ticket_follower`, `ticket_vote`, `ticket_visit` (the home page's visits, the latest 50 kept) |
| `updatedBy(user, from?, to?)` | A ticket set: a change by the person (`ticket_change`; a ticket's creation is there too, as every first value by its creator) or a comment of theirs that the viewer reads, at or after `from` and at or before `to`, to the minute |
| `linkedTickets(key, linkType...)` | A ticket set over `ticket_link`. A description reads from the given ticket's side (`"blocks"`: tickets it blocks); a type's name, when no description matches, takes its links either way |
| `ticketsWithWebLinksByGlobalId(ids...)` | A ticket set over `ticket_web_link.global_id`, any number of ids |
| Sprint, release and service functions | Refused, naming the module (`shippedReleases() belongs to release functions, which this version does not have yet`) |

- **Ticket sets are joined, never listed** (model `TicketSet`, condition `ticketSet`): `key IN
  followedTickets()` is an `EXISTS` on the person's rows, which the planner starts from (plan
  goldens: `ticket_follower_user_idx`, then the ticket's primary key), so there is no cap
  (Jira caps at 32,000) and a list of keys and functions mixes freely (`key IN (ABC-1,
  followedTickets())`). Sets read from two places (`linkedTickets()`: both ends of a link;
  `updatedBy()`: changes and comments) are one `k.id IN (... UNION ALL ...)`, which the
  planner joins from the actor or link indexes; an `OR` of two `EXISTS` was checked row by row
  (measured: `linkedTickets(X)` 71 ms with the `OR` at 200,000 tickets). `key` and `parent`
  take ticket functions; other key fields (`ticketLink`) refuse them for now.
- **A function never widens what a person sees (QRY-008):** a ticket set is a condition inside
  the statement, which carries the viewer's filter; `parent IN f()` rebinds `k` in a subquery
  that carries the filter again, so a parent the person may not see never counts; the ticket
  given to `linkedTickets()` must be one the person sees (otherwise nothing, with the warning an
  unknown key gives); `updatedBy()` counts a comment only where `commentReadableSql` lets the
  viewer read it. A property test (`search/functions.test.ts`: twenty random worlds of eight
  tickets with levels, parents, follows, votes, visits, links, changes, comments shown to a
  group, web links; four people; up to seventeen function queries) requires exactly what a
  model of the world names among the tickets `ticketPermissions` lets the person browse, page
  and count. Dropping the filter from the parent subquery, or the visibility check of the
  `linkedTickets()` ticket, makes it fail (checked).
- **Conformance:** functions from 53% to 96% (298 of 312), fields 99% to 100%, all sections
  99% (2,392 of 2,408). The functions left are the seven SLA functions, on an SLA field
  ("Time to resolution") that service tracks bring (M2-013); the sprint tokens are M1-045's.
- **Measured** (`search/functions.large.test.ts`, `TASKMOOR_LARGE_FUNCTIONS=1`: 200,000 tickets,
  400,000 changes, 100,000 links, a member in half the tracks who follows 20,000 tickets;
  binding and the first page as that member, p95 of 20, on this shared 4-core container):
  `key IN followedTickets()` 13.9 ms, `votedTickets()` 12.4 ms, `ticketHistory()` 6.3 ms,
  `key NOT IN followedTickets()` 5.2 ms, `parent IN watchedIssues()` 81 ms (each of the 20,000
  follows judged as a parent; the slowest), `updatedBy(user)` 15.2 ms (159 ms in the `OR` form),
  with a date range 3.6 ms, `linkedTickets(X)` 6.1 ms (71 ms in the `OR` form), with a
  description 5.3 ms, `membersOf()` of 667 people 8.1 ms, a web link's global id 3.1 ms,
  `tracksWhereUserHasRole()` 8.0 ms. `membersOf()` on a group of 50,000 people binds and
  returns its first page in 91 ms (QRY-004 (2), `search/functions.test.ts`). Not run at 1M:
  the 1M database of M1-037 belongs to another session and stops at migration 0043.
- **Not built:** `cascadeOption(parent, none)`, ticket functions on
  `ticketLink`, the site setting for the first day of the week, functions in history
  predicates (`WAS ... BY membersOf(x)`: M1-039 binds them; the resolver already types them).

## Functions (M1-045: sprints and releases)

- **The sprint field** runs over `sprint_ticket` joined to `sprint` (ADR-054): a ticket's
  sprints are every sprint it is or was in, so `sprint = <a closed sprint>` finds the tickets
  that passed through it; deleted sprints never match and do not count for `IS EMPTY`. Values
  are names (any case) or ids, looked up by one query (no table scan into memory, whatever the
  number of sprints); a value no sprint has is refused. `ORDER BY sprint` uses the ticket's
  latest sprint in its board's order (`max(sequence)`), tickets in none last.
- **Sprint functions** compile to a condition on the sprint's state inside the same `EXISTS`,
  never to a list of ids, so 60,000 sprints and more cost nothing extra (spec 01b section 1.6;
  `search/sprints.run.test.ts` explains the statement). `openSprints()` is started and not
  completed (active), `futureSprints()` not started, `closedSprints()` completed.
- **Relative tokens** (QRY-013): `@current`, `@next` and `@previous` are typed by the resolver
  (`{ type: 'token' }`); it refuses an unknown token and a token on any field but sprint, and a
  quoted `"@current"` is a plain name. The binder makes them sprint matches answered in the
  statement: the active sprint, the first future one in its board's order, the last completed
  one. On a board's queries (`compileBoard` passes the board) they are that board's sprints; in
  a search, each board's on its own. Teams do not exist yet; when they do, a team's board is
  the reference.
- **Release functions** resolve to release ids in the binder (a workspace has few releases):
  `shippedReleases(track?)` the shipped ones (archived or not), `upcomingReleases(track?)` the
  unshipped, unarchived ones, `latestShippedRelease(track)` and `earliestUpcomingRelease(track)`
  the last shipped and first upcoming one in each named track's manual order (`sort_order`,
  never dates). Their Jira-compatible names are the same functions.
- **Still waiting**: the SLA functions (`breached()` and the rest) come with SLAs in M2-013;
  they are the 14 cases the conformance suite's function section still fails.

## History operators (M1-039)

- **Scope:** `WAS`, `WAS NOT`, `WAS IN`, `WAS NOT IN` and `CHANGED` with `FROM`, `TO`, `BY`,
  `AFTER`, `BEFORE`, `ON` and `DURING` on every field the change history records
  (`ticket_change`, M1-009: system fields under their history names, custom fields as
  `cf[<id>]`, links as `link`), over the whole history (no 10,000-change window), inside the
  same statement as the rest of the query: the viewer's filter stays in it (QRY-008) and values
  are parameters (the fuzz property now has history templates).
- **Stretches.** A value is held from the row that set it until the field's next row (`state`
  fields: each row holds the whole new value) or, for links, until the row that removes that
  link (`delta`). A ticket's first values are history rows too (no `from`, written with the
  ticket, by its creator); a field without one was empty from the ticket's creation until its
  first row, as its creator left it.
- **WAS** asks for a stretch with one of the values (`EMPTY`: none), begun `BY` one of the
  people, that overlaps the window: `AFTER a` lasts past `a`; `BEFORE b` began before `b`; `ON d`
  overlaps the day from `d`'s first instant to the next day's on the person's calendar
  (QRY-006, the resolver turns the day into those two instants); `DURING (a, b)` overlaps `a` to
  `b`, both ends included. Several time predicates narrow to their overlap (`AFTER a BEFORE b`).
  `WAS NOT` and `WAS NOT IN` are the negation, so a ticket that never had a value matches them
  (they are not `!=`), and `NOT x WAS v` is `x WAS NOT v`.
- **CHANGED** asks for a row after the ticket's creation (its first values are history, not
  changes): `FROM` the value it took away, `TO` the value it brought (on lists, an item that
  left or arrived: `labels CHANGED TO urgent` is a change that added it), `BY`, and the change's
  instant in the window. `FROM EMPTY` and `TO EMPTY` name changes from and to no value. A
  creation row is one without `from` at or before the ticket's `created_at`; creates write both
  in one transaction (the same `now()`), the importer at the source's creation time.
- **Values** become what history stores: ids as text for references, `String(n)` for numbers,
  ISO days and instants, keys; labels, releases, areas and multiple custom values are lists in
  one row (by spaces, commas, a cascade's levels by colons) and match by item. Text fields take
  no `=`, so `WAS` and `FROM`/`TO` on them match words as `~` does (summary and text fields by
  their words, description, environment and paragraph fields by the words of the document).
- **Names at the time (QRY-005 (2)):** a name no value has now (a status renamed, an option
  removed, a person renamed) is matched against the name the value had when each row was
  written (`to_display`, `from_display`, lower case), so `status WAS "In Review"` still matches
  after the status is renamed; under its new name it matches by id. A name nothing ever had
  matches nothing and is not refused (it may be an old name). Keys and tickets are ids of
  tickets the viewer sees, as in `parent = KEY`, so history never confirms a hidden ticket.
- **Derived and fixed fields:** `stage` reads the status history (the statuses in the stage
  now), `hierarchyLevel` the type history, `trackType` and `trackCategory` the track history.
  `creator` and `created` never change: `WAS` is the ticket's own value, held from its creation
  and set by its creator; `CHANGED` never matches. The resolver now refuses history on
  `updated`, `closed` and `parentTrack`, which have none of their own ("keeps no change
  history"), and refuses `FROM`/`TO` with `WAS`, a predicate given twice, `AFTER`, `BEFORE` or
  `ON` with other than one date, `DURING` with other than two or ending before it starts.
- **Not built:** sprint history (its changes live in `sprint_change`, M1-044; `sprint = X`
  already matches every sprint a ticket is or was in), `WAS EMPTY` and `FROM`/`TO EMPTY` on
  links, ticket functions as history values (`parent WAS IN watchedIssues()`), saved searches
  (no history). Each is refused with a message that says so.
- **SQL** (`compile.ts` `historyCond`; goldens in `search/__golden__/compile.json`): one
  `EXISTS (SELECT 1 FROM ticket_change h WHERE h.ticket_id = k.id AND h.field = $f AND ...)`
  per clause, so the planner can turn it into a semi-join started from whichever side is
  rarer. Single values compare as `left(h.to_value, 200) = $v`, the expression the value
  indexes hold (a whole value, a rich-text document, can be longer than an index entry; the
  values a query names there are shorter, so it is exact). `AFTER`, `ON` and `DURING` add
  "no later row of the field (or none removing the link) at or before the window's start"
  (`NOT EXISTS ... (n.at, n.id) > (h.at, h.id)`); `WAS EMPTY` adds the stretch before the
  field's first row (`NOT EXISTS` a row at or before `greatest(k.created_at, start)`), except on
  the fields every ticket is created with (track, key, type, status, summary and what derives
  from them), where it stays one `EXISTS` (elsewhere the stretches become a set of tickets,
  below); names at the time compare as
  `lower(left(h.to_display, 200))`; `CHANGED`
  adds `(h.from_value IS NOT NULL OR h.at > k.created_at)`. Lists use `string_to_array`; what a
  change brought or took away is an `EXISTS` over `unnest` of the values.
- **Indexes (migration 0056; five),** each built per partition under a plain name
  (`ticket_change_p03_to_idx`) so plans can be read:
  `ticket_change_to_idx (field, left(to_value, 200), at)` for `WAS v`, `CHANGED TO v` and
  `TO v AFTER d`; `ticket_change_from_idx (field, left(from_value, 200), at)` for `CHANGED FROM
  v`; `ticket_change_to_name_idx (field, lower(left(to_display, 200)), at)` for a value named by
  a name it no longer has; `ticket_change_field_at_idx (field, at)` for `CHANGED AFTER d` and the
  end of a stretch across tickets; `ticket_change_ticket_field_idx (ticket_id, field, at, id)`
  for the probe per ticket and the next row after one (a ticket with 12,000 status changes
  answers in milliseconds, QRY-005 (3)); `BY` uses `ticket_change_actor_idx (actor_id, at)` from
  0015. Plan goldens (`search/__golden__/plans-history-pg16.json`, `search/plans.test.ts`): a
  rare value, an old name, a recent change, a person and `FROM` start from these indexes and
  join tickets by primary key; a common value and `WAS NOT` walk the order and probe each
  ticket's rows; the history table is never read whole. Lists, words and links have no value
  index: they are checked per ticket (or across the field's rows by time), so they are best
  combined with another condition at size. `WAS EMPTY` on a field a ticket can start without
  has two branches: the stretches without a value are one uncorrelated set of tickets
  (`k.id IN (SELECT h.ticket_id ...)`, read once and hashed; as a correlated `EXISTS` beside
  the other branch it was probed per ticket, and its capped count took 2.8 s at 200,000 tickets
  instead of 0.28 s), the empty start a probe per ticket. The test template's fingerprint is the
  text of each migration's `up`, so the index list lives inside it (a list outside `up` changes
  nothing the fingerprint sees, and the cached template keeps the old indexes).
- **Tests:** a model of history (`search/history.test.ts`: random worlds of six tickets whose
  status, assignee, labels and links change at random instants, some at the same instant, by
  three people; 44 queries for two people with different tracks, compared with the model
  within `ticketPermissions`; dropping the stretch end, the creation rule or the empty start
  makes it fail, checked), the API (`search/history.run.test.ts`: QRY-005 (1) on a custom
  field with history written by the routes and moved back in time, (2) after renaming a
  status, (3) on a ticket with 12,001 status changes, every kind of field, the refusals), and
  every history case of the conformance suite run on the server.
- **Measured** (`search/history.large.test.ts`, `TASKMOOR_LARGE_HISTORY=1`; 200,000 tickets
  over 20 tracks, 1,159,066 history rows, a member who sees half the tracks; binding, the first
  page of 50 and the count to 10,001 as the search route runs them, p95 of 20, on this Mac with
  other sessions' tests running, load average 8 to 16): first page 1.3 to 78 ms, page and count
  1.9 to 264 ms over fourteen queries (rare and common values, `WAS NOT`, `DURING`, `AFTER ..
  BEFORE ..`, `CHANGED TO .. AFTER`, `BY`, `FROM .. TO`, `WAS EMPTY AFTER`, a custom field, an
  old name, the ticket with 12,000 changes). **10M is not measured** (done-when: p95 under 800
  ms at 10M): the 10M dataset is not on this machine and the bench loader writes no history;
  M1-117 should load about nine history rows a ticket, as the large test does, and run the same
  queries. The forms that read per ticket (lists, words, links, `WAS EMPTY`'s empty start) are
  the ones to watch there.
- **Conformance:** history 239 to 254 cases, all passing (new: `FROM`/`TO EMPTY`, `BY
  membersOf()`, the refusals above); the parser and resolver suite 2,409 of 2,423. On the
  server every history case runs except the ten on `sprint` and `savedSearch`.

## Text search (M1-040)

Decided in ADR-069; what changed here: `~` and `!~` read the search syntax of spec 01b section
1.8 (`packages/query/src/text.ts`; the resolver refuses a search that cannot run at the value's
position), and compile to `@@ to_tsquery('taskmoor_search', $n)` over stored word columns
(`summary_words`, `description_words`, `environment_words`, `body_words`; migration 0057) and an
expression index on custom text values, with `ILIKE` for patterns on summaries and text fields
(trigram indexes). The tsquery is one parameter whose operands the server quotes; the fuzz
property now compares a text search's statement with that of a value of the same shape (its
letters and digits changed), since patterns add conditions. `?` and fuzzy words expand into the
words they stand for, pruned at bind time to the words that occur. `text ~` takes one of two
forms by the planner's estimate of its matches: a set of ids (`k.id IN (... UNION ALL ...)`)
for few, an OR tested per row for many. `ORDER BY relevance` is a key like any other (a negated
`float8` rank, so cursors carry it); counts beyond 10,000 are estimated from block samples
(`search/count.ts`). Plan goldens: `search/__golden__/plans-text-pg16.json`.

## Read-only info fields (M1-125)

CORE-012's computed fields are searchable and sortable, which Jira's are not. Three join the
system fields:

- `firstResponse` ("Date of first response"): a datetime, the first comment by someone other
  than the requester.
- `daysSinceLastComment` ("Days since last comment"): whole days since the latest comment,
  empty without one.
- `participants` ("Participants"): a person field matching the requester, the assignee and
  the authors of comments.

Only comments everyone who sees the ticket may read count (not restricted to a role or group,
not in the trash), so neither a value nor a match tells anyone of a comment they cannot read.
The two times are ticket columns (`first_response_at`, `last_comment_at`; migration 0058)
that triggers keep from `ticket_comment` and from requester changes, so filtering and ordering
read a column like `created` and use its index. `daysSinceLastComment` compares
`floor(epoch of now() - last_comment_at / 1 day)`; ordering by it orders by the column the
other way round (more days is an earlier comment), empties last either way, so the order
stays stable while time passes and the index serves it. Participants compile to an OR of the
two columns and an `EXISTS` over counted comments.

Time in status is not a query field: it is a list per ticket, answered by
`GET /api/v1/tickets/:id/info` (`tickets/info.ts`) from the status changes in the history,
each status's intervals from creation to now summed.

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

## Query editor (M1-041)

- The web app parses queries itself with `@taskmoor/query` (the same parser, no dependencies),
  for suggestions at the caret (`apps/web/src/search/suggest.ts`: fields where a clause starts,
  common ones first, then operators, values for tracks, stages and people, connectives, the
  order) and for the basic mode. The backend's `GET /api/v1/search/check` stays the judge of a
  query (field names the person may see, operators, values): its error, with its column, shows
  under the editor as it is typed.
- The basic mode is a subset of the language, not a second one: tracks, stages, assignment (me
  or nobody) and words, joined with AND and ordered by the latest change. Basic choices become a
  query (`basicToQuery`); a query within the subset reads back as its choices (`queryToBasic`),
  in any spelling the parser accepts (aliases, case); anything else stays in the advanced mode
  with a note. A property test checks basic to query and back is the identity.
- The page keeps the query in the address (`#/search?q=`), so a search can be shared and a reload
  runs it again. Results come from `POST /api/v1/search`, a page at a time.
- Results show as a table in the person's columns, edit in place and export as CSV or JSON
  (M1-042, ADR-052).

## Teams (M1-123)

- `membersOf("id:<teamId>")` binds to the team's members (`team_member`, ADR-076); an id no
  team has is refused as an unknown value. A name still names a group.
- The Team field (custom type `team`) is read from `v_option` like group fields: names (any
  case) or ids, lists, emptiness and the history operators; it orders by the team's name
  (`teamName`).
