# Handoff

Read this first in every session, then update it before you stop.

## Moved to a Mac (2026-10-15)

Development resumed on a Mac (Apple silicon, macOS). The repository lives in
`~/Documents/claude` (not a folder named tracksmith). The Windows notes below (drives E: and
G:, MSYS, CRLF, `pg_ctl` pipes) are history for this machine; see "On the Mac" under Notes.

No branch holds unfinished work any more. `wip/m1-083-scim` was finished as M1-083 (below) and,
like `wip/m1-007-ticket-types`, can be deleted from GitHub. Migration numbers 0011 to 0014 are
all on the branch now; a long-lived development database that ran 0013 or 0014 before 0012
existed refuses it ("corrupted migrations", Kysely applies migrations in name order): recreate
it. The local demo is such a database (`docker compose down -v`, then `bash install.sh`).

## Last session: 2026-10-29 (cloud container)

### Resume here (overnight run, 2026-10-29, 01:13 to 08:00 the user's time)

The user asked for as much as possible until 8 am (14:00 UTC) and approved merging to main at
will ("i allow you to merge into main all you want"). Main moves by fast-forward once CI is
green on the branch head (`git push origin <sha>:main`); the CI workflow cancels an older run
on the same branch when a new one starts, so dispatch once per head. The branch is
`claude/api-key-upload-prevention-9ucz4x`.

Done tonight, newest first (details under Done): M1-038 query functions, M1-043 boards, M1-055
guardrails, M1-041 query editor, M1-052 home, create dialog and palette, M1-086 importer,
M1-058 inbox, M1-037 SQL compiler, M1-053 admin UI, M1-051 ticket view, Windows CI fixes.
M1-037, M1-058, M1-086, M1-043 and M1-038 were built by background agents in worktrees and
merged here; their worktrees are removed, the local `work/*` branches stay.

Also fixed tonight:
- A query leak (M1-037): a hidden ticket named by key or id in `key`, `parent` or `ticketLink`
  confirmed it existed and showed what hangs off it; it now reads like an unknown key.
- The top bar overflowed a 360px phone with CI's fonts: New ticket is a plus on phones.
- Stray "terminating connection due to administrator command" errors failed some gates. The
  verify summary now names the test file of an unhandled error (`tools/verify/reporter.mjs`),
  which traced them to the Graphile Worker spike test; its teardown now waits for the pool.

Numbering: migrations 0043 search indexes, 0044 inbox, 0045 imports, 0046 ticket visits, 0047
boards, 0050 guardrails (0048 and 0049 unused). ADRs 046 (home, create dialog, palette), 047
(inbox), 048 (importer), 049 (boards), 050 unused, 051 (guardrails). A long-lived database that
ran a later number before an earlier one refuses the earlier (Kysely): recreate it.

Watch, under load only (they pass alone and in CI): the 1,500-field edit p95
(`fields/storage.test.ts`, 50 ms), the authorizer p95 (`authz/authorizer.test.ts`, 10 ms),
`routes/identity.test.ts` "limits one address to 50 failures" (20 s timeout) and the NTF-008
ticket-open timing e2e. With two agents and a gate running, the load average here was 10 to 25.

Left in the container (lost with it): `/home/user/wt-compiler` (an older M1-037 draft) and the
11 GB `m1037_bench_1m` database on the system Postgres (migrated only to 0043).

### Done (newest first)

- **M1-042 search results** (built by a background agent on `work/m1-042-results`; no
  migration; ADR-052). Server: `GET /api/v1/search/export?q=&format=csv|json&columns=`
  (`routes/search-export.ts`, registered in `app.ts`) streams every match through
  `prepareSearch` and `compiled.page` by keyset (500 per page, each page read again under the
  permission filter by `searchViews`, now exported from `routes/search.ts` with `projection`
  and `project`; the compiler is untouched). CSV uses the audit export's `csvField` (RFC 4180,
  formula guard); JSON is an array of tickets as search shows them. 100,000 tickets: CSV
  5.4 to 8.7 s, JSON 5.0 to 14.8 s over three runs under load, live heap growth about 2 MB
  (`search-export.large.test.ts`, `TASKMOOR_LARGE_EXPORT=1`). Web: `search/ResultTable.tsx` (table in a focusable scroll
  region, cells edited in place through `PATCH /api/v1/tickets/:id` with `version`),
  `search/ColumnPicker.tsx`, `search/columns.ts` (column ids, localStorage per person, cell
  editors and PATCH bodies), `styles/search.css`, export links; e2e
  `apps/web/e2e/search-results.spec.ts`; `search.spec.ts` now finds result links by key.
  - The export prepares the query with `...searchPerson(request)` as the search route does
    (M1-038: time zone, session, allowed tracks), so functions read the same in both.
  - Not yet: export as a background job (500,000 rows, QRY-015 (1)), Excel, Word and XML,
    all-fields export, the CSV importer round trip (QRY-015 (2)), server-side column sets
    (with saved searches, M1-063), column widths, a people picker for the assignee cell,
    editing select, user and other reference custom fields in place.
  - `search/basic.test.ts` (M1-041) can fail on a random seed: `basicToQuery` leaves a track
    key that is a query keyword (`ON`, `IN`, `TO`, `OR`, ...) unquoted, so `track = ON` does not
    parse back. A real bug of the basic mode, not changed here.
- **M1-038 query functions, batch 1** (built on `work/m1-038-functions`; no migration; ADR-010
  "Functions (M1-038)"). `packages/query`: `functions.ts` (the signature of every function of
  spec 01b 1.6), `dates.ts` (wall-clock arithmetic in a time zone), the resolver checks calls
  (refusals name the argument), evaluates `currentUser()` and the date functions, and leaves
  the rest as `{ type: 'call', fn, args }`; dialect `nativeFunctionName`, `PERMISSION_NAMES`.
  Server: `search/bind.ts` turns calls into ids (people, tracks, areas, types, options) or ticket
  sets (`TicketSet` in `model.ts`, compiled as semi-joins in `compile.ts`); `search/run.ts`
  reads sign-in times for `currentLogin()`/`lastLogin()`; routes pass the person's time zone,
  session and `allowedTracks` (`searchPerson()` in `routes/search.ts`).
  - **Behaviour changes:** dates in queries are read in the person's time zone
    (`app_user.time_zone`, UTC when unset); weeks now start on Sunday (spec 1.4; they started
    on Monday); `startOfMonth(-1M)` and the like move on the calendar (they moved by a fixed
    number of milliseconds); `now()` takes an increment; a function returning several values
    with `=` is refused (`use IN or NOT IN`).
  - **`Typed` has a `call` variant** without `value`: code that reads `Typed.value` must handle
    it (the binder's `content()` refuses a call where none can stand; the spike compiler
    refuses them).
  - **Never widen:** new ticket functions must be ticket sets inside the statement (or check
    their ticket arguments against `BindContext.filter`, as `linkedTickets()` does); comments
    only through `commentReadableSql`. `search/functions.test.ts` is the property test to
    extend.
  - Conformance: functions 96% (the seven SLA functions need an SLA field, M2-013), all 99%.
  - Not built: teams in `membersOf("id:...")`, `cascadeOption(parent, none)`, ticket functions
    on `ticketLink`, a site setting for the first day of the week, sprint and release functions
    (M1-045), functions in history predicates (M1-039).
  - Fixed at the merge: `parent = KEY`, `ticketLink = KEY` and `key = KEY` (M1-037) did not
    check that the named ticket is one the person sees, so a known key could confirm that a
    hidden ticket exists (no "No ticket" warning) and show the visible tickets hanging off or
    linking to it. `keys()` in `search/bind.ts` now keeps only tickets the viewer sees, keys and
    ids alike, and warns for a hidden key exactly as for an unknown one
    (`routes/search.visibility.test.ts`).

- **M1-043 boards** (built by a background agent on `work/m1-043-boards`; migration 0047;
  ADR-049). Server: `apps/server/src/boards/model.ts` (zod schemas of columns, swimlanes, board
  filters and card rules, defaults, `withIds`, `wipState`, `enteredColumn`), `boards/data.ts`
  (the board's conditions compiled with `compileCond` from the viewer's catalogue of the whole
  workspace and the viewer's ticket filter; counts per status, cards in rank order with lane and
  colour `CASE`s, card details by a slim statement or the ticket view), `routes/boards.ts`
  (`/api/v1/boards` CRUD, `/boards/:id/data?filters=`, `/boards/:id/moves`); events
  `board.created`, `.updated`, `.deleted` (audited); moves emit the ticket routes' own events.
  Web: `apps/web/src/boards/` (`BoardsPage` at `#/boards`, `BoardPage` at `#/boards/<id>`,
  `BoardSettingsPage` at `#/boards/<id>/settings`, client, fake client, stories, tests),
  `styles/boards.css`; e2e `apps/web/e2e/boards.spec.ts`. Shell tests and the mobile drawer
  e2e now use Dashboards as their page without a session (Boards needs one).
  - **Saved searches (M1-063)** add `board.saved_search_id` beside `filter_query` with a check
    that exactly one is set, and `source: {savedSearchId}` in the API (ADR-049).
  - **A move runs the ticket route handlers** (`ticketRoutes()`, as bulk jobs do): the list of
    transitions, then the transition, then the rank. Two writes: a refused rank answers with
    `transitioned: true`. Board queries ignore ORDER BY; cards order by `ticket.rank`.
  - **Board queries resolve against every track and field of the workspace** (`boardScope`),
    so viewers see the part of a multi-track board they may; saving checks them against the
    editor's own catalogue (`editorScope`). The ticket filter alone decides what is shown.
  - Measured (`routes/boards.large.test.ts`, `TASKMOOR_LARGE_BOARD=1`): 5,000 cards of a
    50,000-ticket board p95 about 0.3 s, all 50,000 cards about 2 s, on the loaded machine.
  - Not built: board admins and location in the settings page (API only; the list page creates
    a board kept by its maker), swimlanes by subtickets and by tracks, card covers and development icons, the Kanban
    backlog column, estimation and sprints (M1-044), drag and drop, virtualised rendering and
    the 5,000-card render budget (M1-046), the workflow lint for statuses unmapped on boards
    (`apps/web/src/workflow/lint.ts` mentions it).
  - The agent found M1-052's Home failing in tests that sign in with a stub backend
    (`HomeList` read `tickets.length` of a missing answer; the heading read "Hello, <name>").
    Both were fixed on the branch before the merge: a list without tickets shows as empty, the
    heading is "Home" with the greeting under it.

- **M1-055 guardrails** (migration 0050; ADR-051). `apps/server/src/guardrails/model.ts`: the
  ten guardrails of spec 01a section 1.7 with their defaults, `guardrailLimits` (a workspace's
  own rows in `guardrail_limit`, the default otherwise), `enforceLimit` (throws
  `GuardrailExceeded` inside the route's transaction), `fieldsPerTrackWith`, `guardrailUsage`.
  `app.ts` turns `GuardrailExceeded` into 409 `{error:'guardrail_exceeded', guardrail, limit}`
  and rethrows anything else. Enforced in releases (create, restore), areas, priorities (set
  members), ticket types (type sets), workflow maps, workflows (create and drafts), visibility
  (levels; `LEVELS_PER_POLICY` stays as a request cap of 1,000), access grants (with a lock on
  the policy row) and fields (scopes and options). `routes/guardrails.ts`: `GET/PUT
  /api/v1/admin/guardrails` (site administrators, admin token scope, `guardrail.changed`,
  audited). Web `apps/web/src/guardrails/` (`#/admin/guardrails`: a meter per limit, above-limit
  marks, a raise shows performance guidance). The old `too_many_options` and `too_many_levels`
  refusals are gone; a client that matched on them now sees `guardrail_exceeded`.
  - Migration order on the branch: 0047 (boards) was merged after 0050 had been written, so the
    files sort 0043 to 0047, then 0050. No database outside this container ran 0050 before
    0047; one that did refuses 0047 (Kysely): recreate it. 0048 and 0049 are free (0049 was
    held for M1-038, which needed none).

- **M1-041 query editor** (no migration; ADR-010 "Query editor (M1-041)"). `apps/web/src/search/`:
  `basic.ts` (`basicToQuery`, `queryToBasic`, the basic subset: tracks, stages, assigned to me or
  nobody, words; a property test checks the round trip), `suggest.ts` (`suggest(text, caret,
  {customFields, tracks})`: fields, common ones first, operators, values, connectives, ORDER BY),
  `SearchPage.tsx` (`#/search?q=`, basic and advanced forms, the editor as a combobox with a
  listbox of suggestions, the server's check under the editor with its column, results a page
  at a time), `client.ts`, `fixtures.ts`. The web app depends on `@taskmoor/query` for parsing.
  e2e `search.spec.ts` (desktop and mobile, axe).

- **M1-052 home, create dialog and palette** (migration 0046; ADR-046).
  - Palette: `shell/paletteCommands.tsx` is a registry in two contexts (a stable setter, the
    commands) so a page registers its commands without re-rendering in a loop;
    `usePaletteCommands(id, commands)`. `Command.values` fills label placeholders. Ranking: label
    prefix, then label contains, then keyword. The query clears when the palette closes.
  - Ticket view registers every action (each transition, assign to me, unassign, follow, vote,
    comment, edit summary, activity tabs, copy link, shortcuts); `followSeq` and `voteSeq` refs
    keep an older refresh from overwriting a newer follow or vote; a transition form submits only
    once its options are in.
  - `tickets/CreateTicketDialog.tsx` (New ticket in the top bar, a plus on phones; C outside
    fields; the palette) wraps `CreateTicketPage` (`variant`, `template`/`templateOf` to start
    from a ticket). Layouts per ticket type come from the track's layout set.
  - Home `#/home` (`home/HomePage.tsx`): assigned (search), opened lately (`GET /me/recent-tickets`,
    `PUT /me/recent-tickets/:id` from the ticket view, the latest 50 kept in `ticket_visit`), and
    followed (`GET /me/followed-tickets`), all read through the search filter.
  - e2e: `ticket.spec.ts` (30+ palette actions from the keyboard alone), `create.spec.ts`
    (a layout per type; the home lists).

- **M1-086 importer framework** (migration 0045; ADR-048; built on `work/m1-086-importer`).
  `apps/server/src/import/`: `model.ts` (entity kinds in dependency order, `ImportSource`,
  `Mapper`, the commands), `load.ts` (a loader per kind: plan with reads only, apply with SQL in
  the batch's transaction, read back for samples), `run.ts` (batches: lock the run, extract a
  page after the checkpoint, map, load each record in a savepoint, write `import_record`,
  `import_external_id`, tallies and the checkpoint, commit), `report.ts` (zod schema of the
  fidelity report, JSON Schema golden in `import/__golden__`, HTML), `jobs.ts` (`import.run`,
  50 s parts, ten attempts, registered in the worker in `main.ts`; `IMPORT_FORMATS`),
  `synthetic.ts` (our own NDJSON format, its mapper and a seeded fixture generator). Routes in
  `routes/imports.ts` under `/api/v1/admin/imports` (start from an upload or a generated
  source, dry run, list, progress, report JSON or HTML, cancel), site administrators only;
  events `import_run.created`, `.cancelled` and `.finished` (job, no actor), all audited.
  - **Next importers (M1-087 onwards)** add an `ImportSource` and a `Mapper` and register in
    `IMPORT_FORMATS`; new kinds (custom fields, attachments, followers, votes, key aliases,
    releases, areas, boards) add a command, a loader and a place in `ENTITY_KINDS`. Loaders
    write record by record inside a batch: make the ticket loader set-based before the
    1M-ticket run of M1-091. Not built: delta runs (`updated >= last run`), pause and resume
    and downloadable logs (IMP-013), adding imported statuses and types to workflows and type
    sets (the report warns `status_not_in_workflow`, `type_not_offered`).
  - **New write rules must reach the loaders too** (history, formulas, counters, side tables),
    as they reach the routes: imports write SQL, not through the routes (ADR-048 says why).
  - Fixed on the way: the upgrade harness now runs each seed right after its own migration
    (with 0045 after it, `from 0042` ran the 0024 seed against a schema without
    `track.workflow_id`), and the 0042 seed named the renamed track `SEEDOLD` (now `SEEDNEW`).

- **M1-058 inbox, mentions and activity streams** (built by a background agent on
  `work/m1-058-inbox`; migration 0044; ADR-047). Server: `notifications/mentions.ts` (mention
  ids in documents: `"42"` a person, `"group:7"` a team), `notifications/warnings.ts`
  (`mentionWarnings` on ticket and comment answers), the subscriber writes `mentioned`
  notifications (exactly once per change and channel, superseding the policy's for that
  person, never the writer, only to those who may see the ticket and read the comment) and
  bumps `inbox_state`; `routes/inbox.ts` (`/api/v1/inbox`, `/inbox/count`, `PATCH /inbox/:id`,
  `POST /inbox/read`), `routes/activity.ts` (`/tickets/:id/activity`, `/tracks/:id/activity`);
  the sync socket also pushes `{type: "inbox", version}`. Web: `apps/web/src/inbox/`
  (`InboxPage` at `#/inbox`, nav entry after Home), `styles/inbox.css`; the comments panel shows
  mention warnings. e2e `apps/web/e2e/inbox.spec.ts`; the e2e API server now runs the worker's
  event loop (audit and notifications) on the attachments database.
  - **Event payloads:** `ticket.created`, `comment.created`, `comment.updated` and
    `ticket.transitioned` take an optional `mentions {users, groups}`; `ticket.updated` keeps
    carrying both documents of a rich text change (the subscriber diffs them). **New write
    paths that create rich text must do one or the other**, or their mentions notify nobody.
  - **Inbox reads judge every item again** (ticket list predicate, comment rule) in the
    statement; any new inbox-like reader must too. Reading in the inbox marks the email twin
    read; the mailer now drops notifications already read.
  - The worker's idle wait is 200 ms (was 500), and the notification subscriber now runs before
    the audit subscriber, so an event reaches an open inbox within a second: 239 to 348 ms on a
    quiet machine, 840 to 850 ms during the full e2e run on this loaded machine. At size
    (`routes/inbox.large.test.ts`, `TASKMOOR_LARGE_INBOX=1`): 50,000 items read in 15 to 25 ms
    p95; a track's activity costs one probe per ticket (120 ms at 2,000 tickets).
  - `mentioned` is a product event (`PRODUCT_EVENTS`): preferences accept it, policies do not;
    `GET /notification-events` lists it as `productEvents`. The Account page's event table does
    not offer it yet.
  - Upgrade fixtures: the 0024 seed no longer writes `track.workflow_id` on a database past 0042
    and the 0042 seed uses the renamed local track `SEEDNEW` (both broke once 0042 stopped
    being the newest migration).
  - Not built: an unread badge in the navigation, mentions in custom rich text (paragraph)
    fields, approvals on the Priority tab (M2), reading a very large track's activity by track
    (see ADR-047).

- **M1-037 SQL compiler** (branch `work/m1-037-sql-compiler-2`; migration 0043; ADR-010
  "Implementation (M1-037)", ADR-043 "Selection by query"). Built from the uncommitted draft in
  `/home/user/wt-compiler` (left untouched there), ported onto M1-028 and finished.
  `apps/server/src/search/`: `bind.ts` (names to ids, NOT pushed down, refusals),
  `compile.ts` (pure; SQL is the golden `search/__golden__/compile.json`), `run.ts` (read-only
  transaction under `TASKMOOR_QUERY_TIMEOUT_MS`, keyset cursors, capped counts, explain,
  `collectIds`), `bench/` (`pnpm bench:search`, the 50-query perf set). Routes:
  `GET`/`POST /api/v1/search`, `GET /api/v1/admin/search/explain`; `POST
  /api/v1/bulk-operations` takes `query` instead of `tickets`.
  - **Every statement carries `ticketFilter()`**, value branches and side-table walks
    included; `search/authz.test.ts` property-tests the results against `ticketPermissions`.
    **Comments** are searched only through `commentReadableSql` (`comment ~`, `text ~`).
  - **Value branches:** an order whose first key is priority, status, type, level, close
    reason or track key becomes a `UNION ALL` per value, each walking an index. New indexes
    for that and for search in 0043 (`ticket_priority_created_idx` replaces
    `ticket_priority_idx`; word GIN indexes on summary, description, environment, comments).
  - **Measured at 1M only** (the draft's `m1037_bench_1m` database on the system Postgres,
    11 GB, migrated to 0043 by hand: 0030 applied out of order, the draft's 0035 removed):
    all 50 queries under 300 ms, slowest statement p95 116 ms. 10M needs about 110 GB; the
    risky queries at 10M are two-word summary searches, custom text fields and capped counts
    (ADR-010). `docs/spikes/search-1m.md`.
  - **Upgrade seeds fixed:** with 0043 the upgrade test starts at 0042 for the first time;
    the 0024 seed wrote the dropped `track.workflow_id` and the 0042 seed used the renamed
    `SEEDOLD` track. Both now work from any start.
  - Not done: approximate counts and full text (M1-040), history operators (M1-039),
    functions (M1-038), a word index on custom text values (M1-040), a search page or query
    entry in the bulk UI (M1-041, M1-046).
- **M1-053 admin UI** (no migration). New pages, each with a client interface, an in-memory
  fake (`fixtures.ts`), stories, unit tests and e2e in `apps/web/e2e/configuration.spec.ts` and
  `people.spec.ts`: `people/` (users, groups), `configuration/` (`TracksAdminPage`,
  `WorkflowMapsPage`), `fields/FieldsAdminPage`, `permissions/PermissionsPage`,
  `sets/ConfigurationSetsPage`; routes `#/admin/{users,groups,tracks,workflow-maps,fields,
  permissions,configuration-sets}`, Settings links and palette entries. Every permission has a
  readable name (`permission.*` strings). Still API only: formula fields, context scopes and
  defaults, per-type rules and field editors, layout sets, visibility and notification policies,
  field grantees, status mappings when a map switch is refused.
- **M1-051 ticket view** (no migration). `apps/web/src/tickets/view/` (`TicketPage`,
  `ActivityPanel`, `client.ts`, fixtures, stories, tests) replaces the interim
  `TicketAttachmentsPage` at `#/tickets/<key>`; `styles/ticket-view.css`; e2e
  `apps/web/e2e/ticket.spec.ts`. The create form now links the ticket it made. Shortcuts live in
  the page (a document `keydown` listener that ignores fields and dialogs). Not yet: a people
  picker (only assign to me and unassign), custom fields in the view, adding links, move and
  clone from the view, ticket actions in the command palette (AGL-018 (1)).
- **M1-028 workflow maps** (migration 0042; ADR-045; ADR-039 amended). A ticket's workflow is
  the one its track's map gives its ticket type: `workflow_map` (default workflow and entries per
  type; the default map for tracks without one; a local-mode track owns its own),
  `workflow.owner_track_id` for track-local workflows, `track.workflow_map_id` instead of the
  dropped `track.workflow_id` (each track's workflow became its map's default).
  `workflows/maps.ts` resolves it (`ticketWorkflowId`, `holdTicketWorkflow`, `holdMapWorkflows`,
  the SQL function `ticket_workflow_id()`); `workflows/migration.ts` plans and runs status
  migrations; routes in `routes/workflow-maps.ts`.
  - **API change:** track PATCH and view take `workflowMapId` (null: the default map) instead of
    `workflowId`, with `statusMapping` and per type `typeStatusMapping`; 409
    `status_mapping_required` lists `{ticketTypeId, statusId, ticketCount, workflowId}`. Tests
    and the e2e that set a track's workflow now make a map (`POST /api/v1/workflow-maps
    {name, defaultWorkflowId}`) and assign it. `GET /api/v1/tracks/:id/workflow` takes
    `?ticketTypeId=`; ticket PATCH takes `statusId` with a new `ticketTypeId`.
  - Status migrations: up to 500 tickets in the request, more as the `workflow.migrate` job
    (registered in the worker in `main.ts`), progress at `GET /api/v1/workflow-migrations/:id`.
    A transition on a ticket not yet moved moves it first. While one runs, its tracks refuse a
    map switch, their maps a change of entries, their workflows a publish (409
    `status_migration_running`). 100,000 tickets in 16.4 to 20.9 s (`workflows/migration.large.test.ts`,
    `TASKMOOR_LARGE_MIGRATION=1`).
  - **New workflow readers must take the ticket's type**, never the track alone; statusGate and
    statusGateFor now take the ticket type too (the comment lock checks were updated at the
    merge).
  - Not built: an admin page for maps (M1-053 brings the configuration pages); local-mode
    tracks start on the shared default workflow and make their own with `trackId` on create
    (no automatic copy); statuses stay workspace-wide (only administrators add them).
- **M1-018 comments** (migration 0041; ADR-044). Server: `routes/comments.ts`,
  `tickets/comments.ts` (`readsComment`, `commentReadableSql`, `commentText`); transitions take
  `comment` and `commentVisibility` (`routes/tickets.ts`); history hides rows of unreadable
  comments; notifications (`notifications/subscriber.ts`) and the mailer (`email/deliver.ts`)
  check the comment's readers, the mailer quotes the text. Web: `apps/web/src/comments/`
  (`CommentsPanel` on the ticket page), `richtext/RichTextView.tsx` (read-only rich text from
  the shared schema, no HTML parsing), `styles/comments.css`; e2e `apps/web/e2e/comments.spec.ts`.
  **Search and export (M1-037 and later) must filter comments with `commentReadableSql`.**
  Not yet: mention notifications (NTF-005), reply by email (NTF-009), bulk comment actions
  (the comment routes are plain Fastify routes, not `Caller` handlers), ADF originals for
  comments. The draft in `/home/user/wt-comments` was taken over and that worktree removed.
- **M1-021 bulk operations, finished.** Web: `apps/web/src/bulk/` (`client.ts`,
  `BulkOperationPage.tsx` at `#/bulk/<id>`, stories, fixtures, tests), `styles/bulk.css`, the
  `bulk.*` strings; e2e `apps/web/e2e/bulk.spec.ts` on the attachments database, whose bulk
  jobs the e2e API server now runs. `JobRunner` takes `{ tasks }` to claim only those tasks.
  The 10,000-ticket edit took 50.0 s (`bulk/bulk.large.test.ts`, run with
  `TASKMOOR_LARGE_BULK=1`). Not yet: an entry point from ticket lists (no list page exists;
  M1-046 and the search page should start bulk changes), selection by query (M1-037).
- **Main's CI fixed** after the merge: label suggestions sort with `COLLATE "C"` (CI's
  Postgres sorts by another collation), the email tests no longer depend on the time of day
  or on quoted-printable line breaks in headers, the all-in-one image removes a stale
  `postmaster.pid` left by an unclean stop, and Docker Hub dropped `minio/minio`:
  `tools/storage/minio-test.sh` tries `quay.io/minio/minio`, then the community fork
  `pgsty/minio`, both pinned (`TASKMOOR_MINIO_IMAGE` overrides). On 2026-10-29 the quay.io tag
  did not pull and the fork passed the live S3 tests, so **M1-016 is done**.
- **M1-021 bulk operations, server side** (migration 0040; ADR-043). `apps/server/src/bulk/`
  (`model.ts` request schema, `run.ts` runner, `jobs.ts` the `bulk.run` task, registered in the
  worker in `main.ts`), `routes/bulk.ts`, `tickets/caller.ts`. `routes/tickets.ts` now builds
  plain handlers in `ticketRoutes()`; handlers may only use the `Caller` fields (`workspaceId`,
  `user`, `authz`, `apiToken`, `params`, `query`, `body`). New writes that bulk changes should
  reach must be ticket routes, or routes made callable the same way.
- **M1-029 edit locks** (migration 0038; ADR-042). `apps/server/src/workflows/locks.ts`
  (`statusGate`, `statusGateFor`, `statusLock`, `fieldLockList`, `lockedBody`) and
  `fieldLocks` in `fields/layouts.ts`. Enforced in ticket create, edit, move and transition
  layouts, attachment upload and delete, and co-editing (`collab/persist.ts` `mayEditText`).
  **Comments (M1-018) must check the status's `comment` lock, and bulk operations (M1-021) the
  edit and assign locks and field locks, through the same helpers.** Routes:
  `GET /api/v1/tickets/:id/locks`; layouts and the attachment list report locks. Web:
  `apps/web/src/locks/useLockText.ts` words a lock; the ticket view (M1-051) should grey out
  what `/locks` lists. Two fixes came with it in the create form: a late layout answer for an
  earlier ticket type no longer replaces the chosen type's form, and the labels hint is linked
  to its field. The attachment panel shows a status lock before "not set up".
- **M1-013 formula fields** (built by a background agent on `work/m1-013-formulas`, reviewed
  and merged; migration 0033; ADR-009 "Implementation (M1-013)"; new package
  `@taskmoor/formula`). Formula custom fields compute from custom number, date and text
  fields and the system dates, estimates, time spent and summary: arithmetic,
  avg/min/max/sum/count, rounding, date differences, `workingDaysUntil` (the workspace's
  working week; "Overdue" through `if`) and roll-ups over children (`sum(children.{Points})`).
  A hand-written parser, checker and interpreter with limits (4,000 characters, 64 levels,
  1,000 parts, 1M steps); refusals give their place (400 `invalid_formula`), cycles included.
  Values live in `ticket.fields` and the side table of their output. **Every write path must
  call `refreshFormulas` in its transaction and append the history rows it returns; the M1-021
  bulk edit included.** Collaborative saves (M1-017) do since the merge. Also fixed at the
  merge: `workingDaysUntil`/`workingDaysBetween` looped for ever on a date value far outside
  the calendar (a random property-test seed hung the gate); such values now give empty. Parents are
  recomputed with SKIP LOCKED; held ones go to the `formula.recompute` job; `formula.refresh`
  walks all tickets after formula, context or working-week changes, and daily for date-based
  formulas. `GET /api/v1/formulas/check`; `pnpm fuzz formula`; `pnpm conformance formula`
  (CLAUDE.md's Commands and Layout tables do not list these yet). Not yet: select, people,
  label and rich-text inputs; a workspace time zone and holidays; the editor UI (M1-053).
- **Flaky test fixed:** `storage.test.ts` [NFR-002] "keeps the side tables in step" now runs a
  fixed first example that writes every kind of value, so its closing "rows of every kind"
  check no longer depends on the random seed.
- **M1-017 rich text** (built by a background agent on `work/m1-017-rich-text`, reviewed and
  merged; migration 0034 adds `ticket_text_original` and `ticket_text_state`; ADR-014
  "Implementation (M1-017)"). The editor lives in `apps/web/src/richtext/`, the conversions in
  `packages/richtext` (`markdown.ts`, `collab.ts`), co-editing in `apps/server/src/collab/`
  (realtime role, `/api/v1/collab`). New write paths to description or environment need
  nothing extra: open documents pick up API writes within about 50 ms, or 30 s otherwise.
  Comments (M1-018) should reuse `RichTextEditor` and `readRichText`/`inFormat` from
  `tickets/rich-text.ts`; mention notifications (M1-056, M1-058) can find mention nodes in the
  stored documents (`canView` logic in `routes/rich-text.ts`). Several realtime processes need
  routing by document until updates are relayed between them. At the merge both realtime
  features share one upgrade dispatcher in `app.ts` (co-editing takes `/api/v1/collab`, the
  rest goes to Fastify's WebSocket routes).
- **M1-032 websocket, local copy and outbox** (migration 0037; ADR-013 "Implementation
  (M1-032)"). Server: `apps/server/src/sync/mutations.ts` (idempotent mutations by
  `taskmoor-client-id` and `taskmoor-mutation-id`, answers carry `taskmoor-position`) and
  `sync/socket.ts` (websocket under the `realtime` role; the Vite proxy has `ws: true`). Web:
  `apps/web/src/sync/` (`store.ts` IndexedDB, `engine.ts`, `browser.ts`, `SyncProvider.tsx`
  around the pages in `App.tsx`). Only the ticket page reads the local copy so far; the ticket
  view (M1-051), boards (M1-046) and the inbox (M1-058) should read it and edit through
  `engine.mutate()`. Two fixes came with it: the create form clears the ticket type while a new
  track's types load (a type picked meanwhile was overwritten), and the ticket page no longer
  resets when the engine starts after it (it remounted the attachment panel mid-upload).
  The provider retries a first bootstrap that fails (offline at load) and starts from an
  existing local copy offline.
  New dependencies: `@fastify/websocket` 11.3.4; `ws` 8.22.0 and `fake-indexeddb` 6.2.5 for
  tests. Timings measured on the e2e instance only (see the ADR).
- **M1-031 change log** (migration 0036; ADR-013 "Implementation (M1-031)"). Triggers on
  `ticket`, `track` and `authz_epoch` write `change_log`; a deferred constraint trigger gives
  `seq` at commit. Readers in `apps/server/src/sync/log.ts`, routes `/api/v1/sync/*`, hourly
  trim job in `sync/jobs.ts`. Every ticket write now also writes a log row (and numbers it at
  commit): keep an eye on bulk rewrites (M1-021) and the edit p95. M1-032 adds the websocket
  push, the IndexedDB client store and the outbox on top.
- **M1-057 email notifications** (migration 0032; ADR-041 "Implementation (M1-057)";
  deploy/README "Email notifications"). `apps/server/src/email/` (`deliver.ts` mailer,
  `render.ts`, `transport.ts`); the worker runs it every 30 s when `TASKMOOR_SMTP_URL` is set.
  New dependencies: `nodemailer` 10.1.0, and `smtp-server` 3.19.21 for tests (both MIT-0,
  versions over two weeks old). Web: `apps/web/src/notifications/` (Account page section,
  `#/unsubscribe`). **Not run here:** a real mail provider; set `TASKMOOR_SMTP_*` in an install
  to try it. Email strings are English only (server-side table in `render.ts`).
- **M1-056 notification rules** (migration 0030; ADR-041). `apps/server/src/notifications/`:
  `model.ts` (events, recipient types, channels) and `subscriber.ts` (the bus subscriber that
  writes `notification` rows). Routes `/api/v1/notification-policies`,
  `/api/v1/notification-events`, `/api/v1/account/notification-preferences`, and
  `notificationPolicyId` on track PATCH. Nothing delivers yet: email is M1-057 (SMTP, batching,
  digests) and the inbox M1-058; both read `notification` rows (`delivered_at`, `read_at`) and
  must render content with the recipient's own permissions. Comments (M1-018) should add
  `ticket_commented` and check a restricted comment like a restricted time entry.
- **M1-020 visibility levels** (migration 0029; ADR-012 "Visibility levels and ticket-level
  grantees"). `apps/server/src/authz/visibility.ts` holds the rules; `request.authz.ticket(row)`,
  `canTicket(p, row)` and `seesTicket(row)` replace track checks wherever a ticket is at hand,
  and lists put `(await request.authz.ticketFilter()).sql` (a predicate on alias `k`) in their
  statement; `visibleTickets(ids)` filters a set of ids. **Every new read path must use them**:
  search results (M1-037), notifications (M1-056), sync and exports are not built yet. Site
  administrators are not exempt from levels. Routes: `/api/v1/visibility-policies` (admin scope;
  levels, members, `replaceWith` on delete), `GET /api/v1/tracks/:id/visibility-levels` and
  `/api/v1/tickets/:id/visibility-levels` for forms, `visibilityPolicyId` on track PATCH,
  `visibilityLevelId` on ticket create, edit and move, `?ticket=` on the explainer. No admin UI
  yet (M1-053); the create form does not offer levels yet (M1-051).
- **M1-030 workflow editor** (built by a background agent, reviewed and merged; ADR-039
  "Implementation (M1-030)"). Web only, on the M1-023 API: `#/admin/workflows` (list, create,
  copy, delete, statuses) and `#/admin/workflows/<id>` (the editor), both in Settings and the
  command palette. Code in `apps/web/src/workflow/`: `definition.ts` (pure draft operations),
  `diagram.ts` (layout), `catalogue.ts` (rule forms, typed against `@taskmoor/workflow`, a
  type-only dev dependency of the web app), `shape.ts` and `lint.ts` (checks before
  publishing). `axe-core` is a dev dependency of the web app for the e2e axe check. Board
  column mapping waits for boards (M1-043).
- **M1-016 attachments** (built by a background agent, reviewed and merged; migration 0031;
  ADR-040; new package `@taskmoor/storage`). Files go to local disk (`TASKMOOR_DATA/files` or
  `TASKMOOR_FILES_DIR`) or an S3-compatible bucket (`TASKMOOR_S3_*`, from the environment only)
  under random keys never derived from file names. Routes `/api/v1/tickets/:id/attachments`
  (list, upload, metadata, content, thumbnail, text, entries, entry content, archive, delete)
  and `/api/v1/admin/attachment-settings` (maximum size, default 1 GiB, no ceiling). Uploads
  stream and are refused with 413 `file_too_large` past the limit. S3 files are served only by
  a 302 to a URL signed for 5 minutes after the browse check. `storage_cleanup` is swept after
  deletes, the trash purge, hourly in the worker and every 10 minutes per API process.
  `TASKMOOR_SCAN_CLAMD` plugs in ClamAV. The UI is `AttachmentPanel` on `#/tickets/<key>` until
  the ticket view (M1-051) takes it over.
  - e2e now also needs ports 4174, 4175 and 8791 to 8793 (local-disk and fake-S3 servers).
  - **Not run here:** a real S3-compatible store (`bash tools/storage/minio-test.sh`, CI
    `storage.yml`; the MinIO image tag is unchecked), a real ClamAV, the Helm chart.
  - Left for later: copying attachments on clone (CORE-023 (1)), the Jira-compatible
    attachment API, attachment files in S3 backups, moving files between stores.
- **M1-036 query resolver** (ADR-010 "Implementation (M1-036)"): `packages/query/src/fields.ts`
  holds the spec's field catalogue and `OPERATORS_BY_TYPE`; `resolve.ts` checks queries against
  it; `apps/server/src/search/catalogue.ts` builds a person's catalogue (custom fields they may
  see, track keys old and new) and `GET /api/v1/search/check?q=` checks a query. The M0 spike
  compiler (`compile.ts`) still targets the spike schema; M1-037 replaces it with the
  production compiler over `ticket` and the `v_*` side tables.
- **M1-012 field rules and layouts** (migration 0028; ADR-009 "Implementation (M1-012)"):
  rule sets and layout sets in `fields/layouts.ts` (loaded with the field catalogue), admin
  routes in `routes/layouts.ts`, enforcement in `routes/tickets.ts` (create, PATCH,
  `runTransition`). Writes whose refusal is found after the ticket is written throw `Rollback`
  inside `transact()`; returning an outcome from a Kysely transaction commits it, so do the same
  for any new post-write check. The create page `#/create` (`apps/web/src/tickets/`) is the
  first ticket UI; the ticket view and its edit form come with M1-051.
- **M1-102 upgrade command** (built by a background agent, reviewed and merged; ADR-022
  "Implementation (M1-102)"; no migration). `node cli.mjs upgrade [--dry-run] [--no-backup]
  [--unattended]` (`apps/server/src/upgrade.ts`): read-only pre-flight checks (lock, unknown
  or out-of-order migrations, the N-3/LTS path from `packages/db/src/releases.ts`, backup
  room, a running backup, other `taskmoor-*` processes), a plan, a full backup into
  `<backup dir>/pre-upgrade-<time>` (logged as `manual` with `purpose: 'pre-upgrade'`, never
  pruned), all pending migrations in one transaction verified against the shipped schema
  golden (`EXPECTED_SCHEMA`) before the commit, and rollback by the transaction or, after a
  committed online migration, by dropping new objects and restoring the backup. Exit codes 0,
  1 and 3; the last output line is the report as JSON.
  - `RELEASES` in `packages/db/src/releases.ts` is empty until the first release; cutting a
    release appends `{version, lastMigration, lts?}`.
  - The migration runner (`packages/db/src/migrate.ts`) now pins one connection with a session
    lock and runs pending migrations in one transaction; `export const online = true` runs a
    migration alone outside it. `migrationStatus` reports `outOfOrder`, so a development
    database that applied a later migration before an earlier one is named clearly.
  - Kits: `bash deploy/compose/upgrade.sh <image>`; the all-in-one image runs
    `upgrade --unattended` at every start (marker `upgrade-failed.json`) and
    `taskmoor-allinone upgrade` by hand. **Not run here:** both under Docker (CI's
    `smoke-kits.sh` now exercises them).
- **M1-011 field storage** (migration 0027; ADR-008 "Implementation (M1-010 and M1-011)"):
  side tables `v_text`, `v_number`, `v_date`, `v_time`, `v_user`, `v_option`, written by
  `syncFieldValues` (`fields/storage.ts`) in every transaction that changes a ticket's values,
  track or trash state. Any new write path to `ticket.fields` (bulk edit, import, workflow
  effects on custom fields) must call it too; the property test in `fields/storage.test.ts`
  catches a path that forgets. Daily repair job `field_values.verify` (`fields/jobs.ts`) and
  `node cli.mjs field-values [--repair]`.
  - `ticketQuery` (the ticket view) now reads one-row lookups as scalar subqueries: planning
    the sixteen-table join cost 4 to 7 ms per read.
- **M1-082 LDAP and Active Directory** (built by a background agent, reviewed and merged;
  migration 0021; ADR-019 "LDAP and Active Directory"): directories in `ldap_directory`
  (LDAPS or StartTLS, sealed bind password, precedence, schedule), synced by the worker
  (`ldap/scheduler.ts`, runs in `ldap_sync_run`), full or incremental (AD USN per domain
  controller, otherwise modifyTimestamp with a 10-minute overlap, plus an identifier scan for
  deletions). People are linked by stable identifier or email; disabled or removed entries are
  deactivated (break-glass accounts and the last active admin never). Groups are mirrored with
  nesting at any depth, loops broken by DN. Sign-in binds as the person. Read-only directories
  refuse changes to what they own (`409 directory_managed`); read-write ones take them. API
  `/api/v1/directories`; admin page `#/admin/directories`. Migration 0021 also made the epoch
  triggers on group_member, group_nesting and user_group per statement.
  - e2e now needs port 8790 as well (a fake directory in `e2e/api-server.ts`; its passwords
    are made per run in `playwright.config.ts`).
  - **Not run here:** `bash tools/ldap/openldap-test.sh` in Docker (CI `ldap.yml`); the same
    suite passed with `--local` against slapd 2.6.10 (10,000 people in 3.0 s; 100,000 in
    29 s). Left for later: just-in-time accounts at first sign-in, memberships of accounts
    another directory manages, DirSync or persistent search, writing new entries.
- **M1-010 custom field types, contexts and options** (migration 0026; ADR-009 "Implementation
  (M1-010)", ADR-008 note). Types in `fields/types.ts` (conformance suite beside it), the
  catalogue in `fields/catalog.ts` (one per process, reloaded when `field_epoch` moves),
  values in `fields/values.ts`, routes in `routes/fields.ts`: `/api/v1/fields` (CRUD,
  `/contexts`, `/contexts/:id/options`, `.../options/order`, `/labels`, `/people`) and
  `GET /api/v1/tracks/:id/fields?ticketTypeId=` (what a create form offers). Tickets take
  `fields: {"<fieldId>": value}` on create and PATCH and show `fields` in REST form; history
  rows are named `cf[<id>]`. `FieldCatalogs` is built in `app.ts` and passed to the ticket and
  field routes.
  - Not yet: workflows naming custom fields (M1-012), side tables and indexes (M1-011), option
    mapping on move (M1-021), a UI (M1-053).
- **M1-024 to M1-027 transitions, guards, checks and effects** (migration 0025, ADR-039
  "Implementation (M1-024 to M1-027)"). `packages/workflow/src/engine.ts` is the production
  engine (all 374 conformance cases; property test against the reference in `engine.test.ts`).
  The server feeds it through `workflows/state.ts` (ticket to engine state, results to column
  updates) and `workflows/fields.ts` (fields workflows read and write). Definitions now carry
  `layout`, `guards` (nested `all`/`any`), `checks`, `effects`, `properties`, `event`,
  `triggers`, plus `onCreate`, `rules` and `statusPermissions` (`workflows/model.ts`, refused on
  save when they name unknown or read-only fields). `POST /tickets/:id/transitions` takes
  `{transitionId, fields?, version?}`; `comment` answers 400 until M1-017 brings comments.
  Refusals: 409 `transition_unavailable`, 409 `transition_refused {by, name, message?, check?}`,
  403 `forbidden` with `permission: 'transition'`. `POST /tickets/:id/trigger {event}` is the
  hook M2 automation calls. `GET .../transitions` lists layout and properties. The web side has
  `apps/web/src/workflow/refusal.ts`, which words refusals from the `workflow.*` messages.
  - **Changed behaviour (M1-023 corrected):** the close reason is set only by a layout or an
    effect and cleared only by an effect; the seeded Close asks for one, Reopen clears it.
    Publish, workflow switch and move map statuses only. Global transitions are offered from
    their own target too. `closing` and `transitionsFrom` are gone from `model.ts`.
  - Lookups through the pooled `db` (authz, assignable people) must happen before
    `db.transaction()`; doing them inside exhausted the pool under concurrent transitions.
  - Tests: `routes/transitions.test.ts` (8), `workflows.test.ts` updated, two new contract
    scenarios (transition fields, trigger), `workflow/refusal.test.ts` (4).
  - Next for workflows: M1-028 workflow maps and local workflows, M1-029 per-status edit locks
    (the engine's `checkPermission` is ready), M1-030 the editor.
- **M1-101 scheduled backups, restore drill, trash retention, track trash** (built by a
  background agent, reviewed and merged; migration 0022; ADR-022 "Implementation (M1-101)").
  Scheduled backups are on by default: daily 02:30 UTC in the worker, keep 14, weekly restore
  drill, through the CLI backup path into `TASKMOOR_BACKUP_DIR` (or `TASKMOOR_DATA/backups`;
  folder 0700; `off` disables them for that process). Every run is in `backup_run`; status and
  settings at `GET /api/v1/admin/backups` and `PUT .../schedule`, and on the System status page.
  Manifests carry row counts from the dumped snapshot. `node cli.mjs drill` restores the latest
  backup into a scratch database, checks every table and drops it; `purge-trash` runs the purge
  now. Trash retention is a workspace setting (`/api/v1/admin/trash-policy`, 1 to 365, default
  30); an hourly job purges tickets and tracks past retention with audited
  `ticket.purged`/`track.purged` and history rows on the tickets that remain. Tracks have a
  trash (`DELETE /api/v1/tracks/:id`, `POST .../undelete`, `GET /api/v1/trash/tracks`); the
  authorizer grants nothing in a trashed track and its keys stay reserved until the purge.
  Admin Trash page at `#/admin/trash`. With 1M synthetic tickets: backup 22 s, drill 36 s,
  in-place restore 39 s (`tools/backup/bench-restore.sh`).
  - `linkChange` moved from `routes/links.ts` to `tickets/history.ts`; track views carry
    `trash: null` outside the trash.
  - **Not run here:** the Helm chart (the worker now sets `TASKMOOR_BACKUP_DIR=off` because its
    `/data` is an emptyDir; CI's `helm.yml` lints it) and the Compose kits. Next for backups:
    encryption, S3/SFTP targets, PITR, single-track or deleted-ticket restore from a backup
    (OPS-009 (2)).
- **M1-023 statuses and workflows** (migration 0024, ADR-039): `/api/v1/statuses` (CRUD,
  order), `/api/v1/workflows` (create published as version 1, `PUT/DELETE .../draft`,
  `GET .../impact`, `POST .../publish` with `statusMapping`, `.../versions`,
  `.../versions/:v/restore`), `GET /api/v1/tracks/:id/workflow` (read-only), and
  `GET/POST /api/v1/tickets/:id/transitions`. Tickets have `status`; track PATCH takes
  `workflowId` with `statusMapping`; move takes `statusId`. The rules are in
  `workflows/model.ts` (definition schema) and
  `workflows/store.ts` (`holdWorkflow`, `remapStatuses`). A ticket inserted without a status
  gets its workflow's initial status from a trigger. Entering the closed stage sets the close
  reason and `closedAt`; a close reason set by hand now also sets `closedAt` (it meant
  nothing before workflows). Next for workflows: M1-024 transitions (layouts, properties,
  trigger hook), M1-025 guards, M1-026 checks, M1-027 effects, M1-028 workflow maps.
- **M1-019 time tracking** (migration 0023, ADR-009 note): `GET/PATCH /api/v1/time-tracking`
  (settings), `/api/v1/tickets/:id/time-entries` (list, record with `remainingEstimate`
  `{mode: auto|leave|set|reduce}`, edit, delete with `?remainingEstimate=`), and
  `originalEstimate`/`remainingEstimate` on ticket create and edit (seconds or text such as
  "1w 2d"). The ticket view has `timeTracking` in seconds with `effortRatio`. Durations are
  parsed in `tickets/duration.ts`; `Authorizer.audience(trackId)` gives a person's roles in a
  track and groups, for restricted comments (M1-017) as well. Tests: `routes/time.test.ts` (7),
  `tickets/duration.test.ts` (5).
- **M1-081 SAML 2.0** (built by a background agent, reviewed and merged; migration 0020,
  renumbered from 0016 on merge because 0018 and 0019 had landed; ADR-019 "Single sign-on
  with SAML 2.0"): SAML providers are `identity_provider` rows with `kind` 'saml' and share
  domains, enforcement, break-glass, JIT, group maps and audit with OIDC through
  `sso/sign-in.ts`. The verifier in `sso/saml.ts` (xml-crypto 6.4, @xmldom/xmldom 0.8) refuses
  signature wrapping and reads only the signed bytes; trust comes from the configured
  certificates, never KeyInfo. Endpoints: `/api/v1/auth/saml/:id/{metadata,start,acs}` and
  `/auth/saml/continue` (the ACS answers 303 to `/continue`, where the Lax cookie travels).
  `saml_assertion` is the replay cache; IdP-initiated sign-in is off by default. The admin
  page takes pasted metadata or manual settings and shows the addresses to register. The fake
  SAML IdP (`testing/fake-saml-idp.ts`) generates its keys at run time; e2e now needs ports
  4173, 8787, 8788 and 8789.
  - **Not run here:** the Keycloak SAML e2e (`bash tools/sso/keycloak-test.sh saml`; CI's
    `sso.yml`, whose path filter now includes `routes/saml.ts`). The `taskmoor-saml` realm
    client is untried against a real Keycloak and may need a small fix on its first run.
  - Left for later: signed AuthnRequests, encrypted assertions, metadata from a URL.
- **M1-015 links, web links, followers and votes** (migration 0019, `routes/links.ts`, ADR-009
  note): `/api/v1/link-types` (CRUD, delete with `?replacementId=`), `PUT /api/v1/link-policy`,
  `/api/v1/tickets/:id/links` (GET lists links and web links; POST with `linkTypeId`,
  `ticket` and `direction`; DELETE `/links/:linkId`), `/tickets/:id/web-links` (a repeated
  `globalId` updates), `GET /api/v1/web-links?globalId=`, `/tickets/:id/followers[/:userId|me]`
  and `/tickets/:id/votes`, `/api/v1/account/preferences` (`autoFollow`). The ticket view has
  `followerCount` and `voteCount`. `tickets/followers.ts` holds `autoFollow`, for comments
  (M1-017) to call too. Tests: `routes/links.test.ts` (10).
- **M1-073 and M1-074 AI gateway** (built by a background agent, reviewed and merged; ADR-028
  implementation section): `@taskmoor/ai` has one `ProviderAdapter` interface (generate,
  stream, token counting, model listing, batches, capabilities, typed errors); a Claude adapter
  for the Anthropic API, Bedrock (Mantle client, `anthropic.` model IDs), Vertex and Foundry;
  an OpenAI-compatible adapter for Ollama and vLLM; `createProviderAdapter(config, secrets)`.
  The request policy is checked before every send: adaptive thinking, explicit effort per
  feature (spec 1.2), strict structured output and strict tools with automatic choice, cache
  breakpoints, refusals as data with fallbacks, retries honouring Retry-After and a circuit
  breaker, one repair attempt, streaming with cancel, batches resumable by id. 30 recorded
  fixtures (placeholder credentials only) drive the contract tests.
  - **Half-done:** `packages/ai/src/live.test.ts` has never run. Run it once with
    `TASKMOOR_AI_TEST_KEY=<key with a spend cap> pnpm verify --only=tests -- --project=ai` to
    close M1-073's live smoke test and M1-074's live cache read. The key comes from the
    environment only; it never goes into the repository.
  - The fallback beta names (`server-side-fallback-2026-07-01`, `fallback-credit-2026-07-01`)
    and the Mantle client were checked against the Claude API reference; `claude-opus-5` was
    added to the server-side fallback models.
  - Next for AI: M1-075 key storage, M1-076 settings page (`gateway.listModels()`,
    `availability()`, `capabilities()`), M1-077 spend limits and audit (cost from
    `result.usage`; fallback answers already sum every attempt).
- **M1-014 priorities, close reasons, labels, releases and areas** (migration 0018, ADR-009
  note):
  - `routes/priorities.ts`: `/api/v1/priorities`, `/priority-sets`, `/close-reasons` (CRUD,
    `PUT .../order`, delete with `?replacementId=`), `/labels?q=` suggestions and
    `POST /labels/merge` (administrators). Track PATCH takes `prioritySetId`.
  - `routes/releases.ts`: `/api/v1/tracks/:id/releases` and `/areas` (list, create, release
    order) and `/api/v1/releases/:id` (edit, ship, unship, archive, restore, merge, delete,
    approvers, approval decision), `/api/v1/areas/:id` (edit, archive, restore, delete).
  - Tickets take `priorityId`, `closeReasonId`, `labels`, `targetReleaseIds`,
    `foundInReleaseIds` and `areaIds`; the view shows them, history records them. Mass
    rewrites go through `rewriteTickets` in `tickets/fields.ts` (locks, versions, one change
    set); ticket writes call `holdValues` before locking the ticket (lock order in ADR-009).
  - Tests: `routes/ticket-fields.test.ts` (15, CORE-014 to CORE-017) and 28 contract
    scenarios.
- **M1-083 SCIM 2.0** (ADR-038; ADR-019 points to it), finished from the WIP branch, whose
  filter, PATCH, schema and resource modules held up under the new tests:
  - `/api/v1/scim/v2` (`routes/scim.ts`, data in `scim/store.ts`): discovery, Users and Groups
    with filter, paging, `attributes`, `excludedAttributes`, POST, PUT, PATCH and DELETE; SCIM
    errors and `application/scim+json` throughout (an encapsulated Fastify plugin with its own
    error, not-found and content-type handling).
  - Access: the `scim` token scope, held alone and only by service accounts (`tokens/scopes.ts`
    classes the SCIM routes as `scim`; personal tokens refuse it). No other token and no
    session reaches SCIM.
  - Accounts keep email, name, locale, time zone and active state; `scim_user` the rest.
    `active` false or DELETE deactivates and ends sessions; the account stays and comes back
    when its email is provisioned again. Break-glass accounts and the last active site
    administrator cannot be deactivated through SCIM. SCIM sees only the groups it created.
  - Six audited events `scim.*`. The service account token form offers "SCIM provisioning",
    which clears the other scopes (`TokenForm` `allowScim`).
  - Tests: `routes/scim.test.ts` (compliance over HTTP), `routes/scim.idp.test.ts` with the
    Entra ID and Okta sequences in `testing/scim-idp.ts`, `scim/filter.test.ts` (with 2,000
    random inputs) and `scim/patch.test.ts`, contract scenarios, web tests and a story.
- **M1-009 change history** (migration 0015, `tickets/history.ts`, ADR-009 note): every ticket
  mutation writes `ticket_change` rows (field, old and new value with names, change set);
  `GET /api/v1/tickets/:id/history`. New ticket mutations must call `recordChanges` with
  `ticketChanges(before, after)` from rows read with `loadTicket(s)` in the same transaction.
- The e2e API server (`apps/web/e2e/api-server.ts`) uses `TASKMOOR_TEST_DATABASE_URL` when it
  is set, like the unit tests, so `pnpm verify --e2e` runs in a container that runs as root
  (24 passed here). CI sets the variable, so its e2e now runs on the Postgres 16 service.

### Next (in order)

1. `pnpm next-task` lists 17 ready tasks. In the query engine: M1-040 (full-text search, text
   operators, rank, approximate counts), M1-039 (WAS and CHANGED), M1-063 (saved searches; the
   board's `saved_search_id` waits for it). In planning: M1-044 (sprints; then the board's
   sprint functions, M1-045). Others: M1-067 webhooks, M1-098 CSV import and export, M1-105
   static build, M1-115 accessibility pass, M1-116 i18n completeness.
2. M1-073 and M1-074 (AI gateway) are marked in progress from an earlier session; their done
   criteria need a live smoke test with a test key, which must come from the environment at
   run time and never be written to the repository.
3. Follow-ups named in the Done entries: board admins and location in the settings page, drag
   and drop and the 5,000-card render budget (M1-046); teams in `membersOf()`; Recent in the
   sidebar and starred lists (M1-052); point-and-click for more fields in basic search (M1-041).
4. Run the Entra ID and Okta provisioning validators against a test instance with a public URL
   (IAM-006 (1)); the fixtures here imitate their request shapes.

## Earlier: 2026-10-26 (cloud container)

### Done

- **M1-008 tickets** (migration 0014; ADR-009 implementation note; ADR-037 for the rank):
  - Tables: `ticket`, `ticket_counter` (consecutive numbers per track under a row lock),
    `ticket_key_history` (trigger-written; a number belongs to one ticket for good, so old keys
    resolve after a move as old track keys do after a rename), `ticket_detached_parent` and the
    sequence `ticket_rank_seq`. Date columns now read as `YYYY-MM-DD` text (a type parser in
    `packages/db/src/client.ts`), never as a Date at local midnight.
  - `apps/server/src/tickets/rank.ts`: fractional rank keys, new tickets at the bottom through
    the sequence, moves to a random point in the middle of the gap, retry on a clash.
  - `routes/tickets.ts` (data access in `tickets/store.ts`, rules in `tickets/model.ts`):
    create, view by id or any key it has had (with `redirect`), list in rank order by track or
    parent, edit with a permission per field and an optional `version`, `PUT .../rank`,
    `POST .../move` (subtickets come along; types the target lacks need `ticketTypeId` or
    `subticketTypeId`), `DELETE` to the trash (subtickets go along, other children lose the
    link), `POST .../restore` (links come back), `GET /api/v1/trash`. Errors in values answer
    400 `invalid_fields` with a reason per field. Description and environment are ProseMirror
    documents checked against `@taskmoor/richtext` (now a server dependency, about 1 MB more in
    `server.mjs`).
  - Locks: ticket writes that check levels hold the hierarchy lock shared (`shareHierarchy`), and
    every writer takes the hierarchy, then the track and type set (key share), then tickets.
  - M1-007 hooks filled: `hierarchyTickets` reads only tickets of types whose level changes and
    their parents and children; `ticketsOfTypes` counts the trash too. `ticketTypeMapping` on
    `PATCH /type-sets/:id` and `PATCH /tracks/:id` maps tickets of a leaving type to one at the
    same level (CORE-005 (2)).
  - Events `ticket.created`, `.updated`, `.moved`, `.ranked`, `.deleted`, `.restored`; the last
    two are audited (`audit/subscriber.ts`), the others wait for the change history (M1-009).
  - Tests: `routes/tickets.test.ts` (1,000 parallel creates give 1..1000, moves keep key
    history, concurrent rank moves, trash round trip, type mapping, hierarchy impact),
    `tickets/rank.test.ts` (properties), `packages/db/src/tickets.test.ts`, contract scenarios.
- `apps/web/src/tokens/AdminTokensPage.test.tsx` typed a fixed 2026-10-01 against fixtures dated
  relative to today, so it failed from 2026-10-21 on; it now types a day ten days back.

### Notes for cloud sessions (Linux container, running as root)

- The embedded Postgres refuses to run as root. Start the system one
  (`service postgresql start`), give its `postgres` user a password and point
  `TASKMOOR_TEST_DATABASE_URL` at it, as the CI job does (`.github/workflows/ci.yml`); the
  e2e API server uses it too.
- The container's Chromium (`/opt/pw-browsers`, build 1194) is older than Playwright 1.64's
  (1248). Linking it under the new names in a scratch folder and setting
  `PLAYWRIGHT_BROWSERS_PATH` there runs every story (193 passed).
- The unhandled 57P01 ("terminating connection due to administrator command") that ended some
  full runs was a real bug: no pool had an `error` listener, so an idle connection the server
  ended (a test database dropped, in production a restart or failover) crashed the process.
  `createDb` now always listens (`onIdleError`, logged by the server); `client.test.ts` proves it.

## Earlier: 2026-10-15 (Mac)

### Done

- **Set up on the Mac**: Node 22 (Homebrew `node@22`), pnpm 10 through corepack, the local
  identity and hooks, and the gate green (2,119 tests, 23 e2e) before any change.
- **M1-080 finished** and merged into `main` with the user's go-ahead. Started from the WIP
  branch, then:
  - Wired `#/admin/identity-providers` into the app, Settings ("Single sign-on") and the
    command palette; styles in `apps/web/src/styles/sso.css`; fieldsets for the button and
    mapping groups (Biome's a11y rule).
  - `GET /api/v1/identity-providers` now also answers `redirectUri`, built from `PUBLIC_URL`:
    the WIP showed `window.location.origin`, wrong behind a proxy or another host name.
  - Fixed: an `sso_error` such as `toString` matched an inherited property and passed a
    function to the translator; the email's blur now reads the field, not the last render.
  - At the break-glass address a refused password explains that only break-glass accounts may
    use one for that domain.
  - Tests: `SignInForm.sso.test.tsx`, `sso/*.test.ts(x)` (one reads the server's `fail()` codes
    so the error list cannot drift); stories for every new component, axe in both skins.
  - e2e: `e2e/api-server.ts` starts the fake provider (`FakeIdp`, now exported as
    `@taskmoor/server/testing`) on port 8788, signing in Sam (`sam@sso.test`). The last test
    in `setup.spec.ts` adds the provider through the page, then covers no account, JIT,
    enforcement (password field gone, backend answers `sso_required`) and delete.
  - ADR-019 records the sign-in page and administration design.
- **M1-007 ticket types and hierarchy levels** (finished from the WIP branch in its own
  worktree, then cherry-picked onto `main`; ADR-009 implementation note): migration 0011
  (levels, ticket types, type sets, the default set per track type, `track.type_set_id`), the
  pure model with its property tests in
  `apps/server/src/tickets/hierarchy.ts`, the API in `routes/ticket-types.ts`
  (`/api/v1/hierarchy-levels` with `/impact`, `/api/v1/ticket-types`, `/api/v1/type-sets`) and
  `GET /api/v1/tracks/:id/ticket-types`; tracks get their type's default set (local-mode tracks
  a copy they own, plus their own ticket types). Nine events, all audited; read and write token
  scopes. No UI yet.

### Next (in order)

1. **M1-008 tickets**: the core path to boards. It fills the two hooks M1-007 left in
   `apps/server/src/tickets/configuration.ts`: `hierarchyTickets` (tickets with type and
   parent, so hierarchy changes see the links they break) and `ticketsOfTypes` (a type with
   tickets cannot leave a set until they are mapped to another type, CORE-005 (2); add the
   mapping then). Rollback of a hierarchy change that broke links (CORE-007 (2), 30 days)
   needs tickets too; until it exists such a change is refused with its impact.
2. **M1-083 SCIM** (`wip/m1-083-scim`): SCIM clients are service accounts with a `scim` token
   scope; compliance suite and Okta / Entra ID shaped fixtures.
3. The break-glass switch per account comes with the user admin UI (M1-053); the backend has
   it (`breakGlass` on `PATCH /users/:id`).
4. `pnpm next-task` for the rest (M1-073 AI gateway core and M1-082 LDAP are also ready). The
   query catalogue gaps (targetRelease, area, sprint, due; history on every field; user values
   by name; function arity) belong to M1-036.
5. M1-121 is the contract step for M1-001: one release later, drop the M0 `session` table and
   the default on `app_user.workspace_id` (ADR-022).
6. **Upgrade the local demo** once the WIP branches are merged or dropped. It ran on the Windows
   machine (see Local demo); this Mac has no Docker yet.

## Earlier: 2026-10-12 to 13 (night)

### Done

- **M1-122 skins** (ADR-036, the user's request): light ("Soft daylight") and dark ("Soft
  night") skins as token blocks on `[data-skin]` in `apps/web/src/styles/tokens.css`;
  `apps/web/public/skin-boot.js` paints the saved skin before the app loads; Account,
  Appearance offers System, Light and Dark, applies at once and saves to the account
  (migration 0013 `app_user.appearance`; every sign-in answer and `GET /session` carry it).
  The shell, forms, buttons and cards moved to the soft look (floating rounded panels, pills,
  circles, soft shadows, pastel canvas, waves on the stand-alone pages). Storybook has a skin
  toolbar, and every story runs its axe test in both skins (`vitest.stories.config.ts` and
  `vitest.stories-dark.config.ts`, the skin passed through `test.env.STORY_SKIN`). Adding a
  skin: a token block, an entry in `src/skins/skins.ts`, the name in `public/skin-boot.js` (a
  test keeps them equal).

- **Four parallel branches merged** (each built in its own worktree, then merged in migration
  order 0006 to 0010): M1-003 audit log (ADR-034), M1-004 API tokens and service accounts
  (ADR-035; its ADR was renumbered from 034), M1-006 tracks, M1-084 two-factor UI. Merge rules
  that keep coming up: union the migration index, upgrade seeds and catalogue in number order;
  rebuild `events/contract.test.ts` from main plus each branch's added scenarios (order matters:
  the two-factor policy scenario demands a second factor of later users); regenerate the schema
  golden with `pnpm verify --update --only=tests -- --project=db`; every new event type needs a
  decision in `audit/subscriber.ts`, and every new route a class in `tokens/scopes.ts`.
- **M1-080 single sign-on, backend** (ADR-019 "Single sign-on with OpenID Connect"):
  `apps/server/src/sso/oidc.ts`, `routes/sso.ts`, migration 0010. Providers with sealed client
  secrets, domains and group maps; code flow with PKCE, state and nonce bound to the starting
  browser; JIT and linking only for verified addresses of served domains (never service
  accounts); group sync; enforced single sign-on with break-glass accounts (`breakGlass` on
  `PATCH /users/:id`); refusals in the audit log. Tests use the in-process
  `testing/fake-idp.ts`; `bash tools/sso/keycloak-test.sh` runs the real flow against
  Keycloak 26.7.4 (also `sso.yml` in CI).
- **Fixes found by CI after the merges:** restore now drops partitioned tables before
  `pg_restore --clean` (it cannot drop a partition's inherited primary key); shutdown answers
  with `Connection: close` for `TASKMOOR_SHUTDOWN_DRAIN_MS` before closing, so keep-alive clients
  lose no request during a rolling upgrade (kind lost 1 in 55k before); the licence test counts
  packages per store folder.
- **Skins requested by the user:** light and dark first, in the soft pastel style of their
  reference image. Plan: ADR-036 and M1-122 (see Next).

## Earlier: 2026-10-12 (overnight and morning)

- **M1-005 event bus** (ADR-015 implemented): `apps/server/src/events` (catalogue, emit,
  relay, job queue, worker loop in the worker role). Every new mutating route must emit one
  event in its transaction and get a scenario in `events/contract.test.ts`, or the test fails.
  Subscribers register in `events/subscribers.ts` (none yet; audit is first).
- **M1-002 authorization** (ADR-012 implemented): roles, access policies and grants, global grants,
  track role actors, and `apps/server/src/authz/authorizer.ts` (per-track permission sets, list
  filter for search, explainer, epoch-checked cache). Routes check `request.authz`; site
  administration can now come from a group. The track table exists with its permission columns;
  M1-006 adds the rest.
- **M1-001 identity foundation** (after the user tested the demo): `workspace` table and
  `workspace_id` on every table (fitness test `packages/db/src/workspace-scope.test.ts`), users
  with profiles, nested groups, Argon2id (`hash-wasm`) keyed with a pepper from
  `TASKMOOR_DATA/secrets/password-peppers` or `TASKMOOR_PASSWORD_PEPPER` (backups carry the
  keyring, restore merges it), a password policy with the zxcvbn-ts breached list, lockout and
  address limits in Postgres, hashed session tokens with idle and absolute expiry, session list
  and revoke, admin users and groups API, one-time password links and `node cli.mjs
  password-link <email>`. `apps/server/src/asvs.test.ts` is the ASVS level 2 checklist (three
  todo items wait for email, M1-057). UI: user menu with sign-out, Account page, password link
  page; e2e covers sign-out and in, lockout, password change and activation. ADR-019 records
  the design.
- **Own terminology** (the user's request; `docs/specs/00-terminology.md`): ticket, track,
  ticket type, Outcome / Feature / Bug / Chore / Subticket, requester, followers, close reason,
  stage, areas, releases, guards / checks / effects and the rest, in the specs, ADRs, plans,
  the native query vocabulary (`track`, `closeReason`, `stage`, `targetRelease`, ...), the
  workflow model and the UI ("Tracks" in the navigation). Jira's names, classic and 2025, stay
  in the Jira-compatible dialect, import mappings and Source columns. The compiled SQL of the
  query golden is byte-identical; the workflow suite still passes 374 of 374. The M0 spike
  schema keeps `space_id` and `item_id` (rule 6 of the terminology file).
- **Renamed to taskmoor** (the user's choice): packages `@taskmoor/*`, variables `TASKMOOR_*`,
  images `taskmoor` and `taskmoor-allinone`, the chart in `deploy/helm/taskmoor`, metrics
  `taskmoor_*`, UI and docs. Kept on purpose: the GitHub URL (until the repository is renamed),
  the local folder, dated reports, recorded benchmark data and historical codename mentions.
  The cluster folders moved with it: `G:/taskmoor-pg` (bench) and `G:/taskmoor-pg-test`.
- **M0 accepted by the user (2026-10-12).** `pnpm gate M0 --ci` is all green; the counsel
  review is deferred to the first public release (`docs/plan/decisions.csv`). The local demo
  runs on port 8080 (see Local demo).
- **M0 was 30 of 35 tasks done; 31 of 33 ADRs accepted** at the start of the day. `pnpm gate M0` prints the exit
  checklist; `STATUS.md` has the task table; `docs/status/2026-10-12.md` is the first weekly
  report (also in the user's Drive folder as a Google Doc).
- Foundation (earlier today): repo with the personal identity only, DCO hooks and CI (Postgres
  16 and 18, weekly Windows), `pnpm verify` gate with embedded Postgres, module boundaries,
  licence and secret gates, spec import with stable IDs, traceability, synthetic data generator,
  design system with Storybook and axe, app shell with the command palette and ICU i18n.
- Spikes, each with a report in `docs/spikes` and an accepted ADR:
  - Queue and outbox (ADR-015): in-house SKIP LOCKED queue, 18k jobs/s.
  - Rich text (ADR-014): Tiptap, Yjs, Hocuspocus, lossless conversion.
  - Permissions (ADR-012): in-process SQL evaluator, check p95 1.47 ms cold / 0 ms cached
    against OpenFGA 15.9 ms at 100k users and 30k spaces; pre-filter overhead at most 1.3 ms.
  - Sync (ADR-013): in-house change log, 52k-item bootstrap in 2.6 s, delta p95 1 ms,
    1,392 lock-ordered mutations/s, idempotent outbox replay.
  - Backup XML (ADR-025): 5 GB parsed in 2.6 min at 303 MB RSS with every forbidden
    character removed and logged.
  - Field storage (ADR-008, Proposed) and the query compiler (ADR-010, Proposed): 1M and 200k
    runs within budget; the 10M run is in progress (see Next).
- Stack ADRs 005, 006, 007, 009, 011, 016 to 023, 026, 027, 031, 032 written from the plan.
- Benchmark tooling (M0-033): `pnpm bench:check` (budgets plus a 20% regression check against
  `docs/spikes/baseline`), `pnpm status-report`, the nightly workflow on the `ci-workflows`
  branch (see Waiting on the user).
- Install skeleton (M0-025 to M0-027, M0-029, M0-030; M0-011's image build): one multi-arch
  image with roles by `TASKMOOR_ROLE`, the all-in-one image, two Compose kits with
  `install.sh`/`install.ps1`, first-run setup with cookie sessions, the upgrade harness and the
  operator CLI in the image (`node cli.mjs check-upgrade | migrate | status | backup | restore |
  checksum`), and the restore drill `tools/image/drill-backup.sh` (back up, wipe, restore,
  compare table checksums, sign in) in the CI image job. The nightly install matrix
  (M0-028, `install-matrix.yml`) is green on all five images: 17 to 18 s to `/ready` on the
  Ubuntu 22.04, 24.04 and arm64 runners, 36 s inside Debian 12 and Rocky 9 containers.
- Nightly benchmarks (M0-033): the first green run's results are the CI baseline in
  `docs/spikes/baseline/ci` and `pnpm bench:check --size 200k --baseline docs/spikes/baseline/ci`
  passes against it.
- M1-022 (started while the 10M run holds the bench cluster): `packages/workflow` holds the
  workflow behaviour model, a data-only conformance case format with provenance, 374 cases for
  WF-001 to WF-012, the runner (`pnpm conformance`) and an in-memory reference model that passes
  every case. The engine (M1-023) implements the same `WorkflowEngine` interface and is checked
  against the reference model. Open points are `verify` notes on the cases (history entry order,
  "has been in" and the current status, parent-status check without a parent, Jira class
  names for the import mapping).
- M1-033 (also while the 10M run holds the bench cluster): the query conformance suite in
  `packages/query/src/conformance`, 2,220 data cases for QRY-001 to QRY-013 with provenance,
  run by `pnpm conformance query` against this repository's parser and resolver. Grammar
  passes in full; the per-section pass rates (76% overall) are a golden
  (`__golden__/pass-rates.json`) that M1-034 and M1-035 raise. The failures are gaps, not
  wrong cases: fields the catalogue lacks (versions, components, sprint, due, text, comment,
  resolution, filter), history on every field, user values by name, `@current` sprint tokens,
  slash dates, function arity, ordering comparisons on priorities and versions, ambiguous
  custom names, `=` accepted on text fields.
- M1-034 (in progress, the one-hour fuzz is the last step): the native grammar spec
  (`docs/specs/06-query-language-grammar.md`); the lexer and parser recover from errors
  (`parseWithDiagnostics` reports every independent mistake with offsets, line, column and
  expected tokens, and returns a partial tree that always prints as a valid query;
  `parseQuery` throws the first); a nesting limit of 100 levels (20,000 nested parentheses
  overflowed the stack before); `@current` tokens and slash dates lex. Tests: the 969 parse
  cases of the conformance suite run as parser tests, plus recovery, position, hint, limit
  and property tests. `pnpm fuzz query --minutes 60` is the fuzzer (`packages/devtools`).
- Afternoon (Opus 5.5): M1-035 Jira-compatible dialect (`toNative`/`toJira` on the shared tree);
  M1-103 metrics on port 9464, OTLP traces when configured, the admin System status page (CI
  green including e2e) and example Prometheus rules and a Grafana dashboard in
  `deploy/observability`; the compiler drives custom-field queries from their side table when
  the order allows (10M results under Next); the licence gate now reads the 26 packages pnpm
  stores under hashed folder names (it skipped them before); the fuzzer found a numeral
  precision bug in the lexer (fixed).
- Evening: the bench cluster moved to G: (NVMe) after E: turned out to be a hard disk; on
  NVMe the 10M runs pass every field-storage and query budget (ADR-008 and ADR-010 accepted,
  M0-016, M0-017 and M0-024 done); multi-select queries needed (field_id, value) statistics
  with target 5000. M1-099 Helm chart green on kind in CI (55,271 requests, none failed during
  a rolling upgrade). M1-100 air-gap bundle tooling and its offline install test.
- Query compiler fixes found by the spike: id tiebreaker in the newest-first indexes and
  `NULLS LAST` only on nullable columns (41.7 ms to 0.65 ms); `WAS` as one history `EXISTS`
  (1.9 s to 0.65 ms for a value that never occurred); labels and word search use index-friendly
  operators.
- Test infrastructure: every Vitest project sets its own timeouts; `TASKMOOR_PG_CACHE_DIR`
  moves the embedded clusters to another disk; a second process attaches to the running
  bench cluster instead of starting an empty one.

### Local demo

The demo runs from a copy of the Compose kit in `G:/taskmoor-demo` with the locally built
image (`docker build -t taskmoor:dev .` from the repository). Its `.env` pins the project
name, image, port 8080 and `PUBLIC_URL=http://localhost:8080`. Start or update it with
`bash install.sh` in that folder (it prints the one-time setup link until an administrator
exists; each restart issues a new link, so use the latest one); stop it with
`docker compose down` (add `-v` to delete its data). The old `G:/tracksmith-demo` folder is
unused and can be deleted by the user. What it shows today:
first-run setup, sign-in, the app shell with the command palette, Settings and the admin System
status page. Boards, items and queries arrive with M1.

### Notes and gotchas

- **On the Mac:**
  - Use Node 22: `PATH="/opt/homebrew/opt/node@22/bin:$PATH"`. The default `node` is 25, whose
    built-in `localStorage` hides jsdom's, and 9 web tests fail with
    "window.localStorage.clear is not a function".
  - Run the gate with a resolved temporary folder:
    `TMPDIR="$(cd "$TMPDIR" && pwd -P)/" pnpm verify`. macOS's `os.tmpdir()` is under `/var`, a
    link to `/private/var`, and dependency-cruiser reports resolved paths, so 5 cases in
    `packages/devtools/src/boundaries.test.ts` fail without it (a `realpathSync` around the
    test's `mkdtempSync` would remove the need).
  - e2e needs ports 4173, 8787 and 8788 (the fake identity provider) free.
  - Not on this Mac: Docker (local demo, image smoke tests, `tools/sso/keycloak-test.sh`; CI
    runs `sso.yml`), PostgreSQL client tools (the backup round trip skips; set
    `TASKMOOR_PG_BIN`), the 137 GB benchmark data (stayed on the Windows machine's G:) and the
    OpenFGA binary.
  - In the Storybook dev UI, `userEvent.type` in a play function fills the field without
    React seeing the change (also `PasswordShown`, which predates single sign-on). The same
    plays pass in `pnpm verify`, which runs them through Vitest; check interactions there.
  - The GitHub CLI token here has `repo` but not `workflow`: a push that changes
    `.github/workflows/*` needs `gh auth refresh -s workflow` first.
  - `migrate.test.ts` "applies each migration exactly once when several servers start
    together" once threw an unhandled 57P01 under the load of a full `--e2e` run; reruns
    were clean.

- Pushes use the GitHub CLI token through a repo-local credential helper
  (`git config --local credential.helper`); Git Credential Manager would otherwise open a
  sign-in window. The CLI is signed in as rockersands; its token has the `workflow` scope, so
  pushes that change `.github/workflows/*` go through.
- Bench datasets live in `G:/taskmoor-pg/bench` as UNLOGGED tables: stop that cluster cleanly
  (`pg_ctl -m fast`); an immediate stop empties them. `pnpm gen` checks for rows before reuse.
  The bench cluster is shared: a second process attaches to the running server; if the owner
  stops it (a `pnpm gen` finishing), attached benchmarks fail; rerun them.
- **Disks on this machine (measured 2026-10-12 with Get-PhysicalDisk):** E: is a Seagate
  ST4000DM004, a 5,400 rpm hard disk (random 8 KB reads 13 ms p50), and holds the repository
  and `.cache/pg-test` (the default place for test clusters). C: (Kingston NV1, 342 GB free) and G: (XPG
  S40G, 86 GB free) are NVMe; D: is another hard disk. The user confirmed this and said C:
  and G: are free to use: database clusters and benchmarks go there through
  `TASKMOOR_PG_CACHE_DIR`, the source tree stays on E:. Benchmarks on E: measure seeks, not
  the design. Run the gate with the test clusters on an NVMe drive:
  `TASKMOOR_PG_CACHE_DIR=G:/taskmoor-pg-test pnpm verify`
  (and `PLAYWRIGHT_BROWSERS_PATH=<empty dir>` skips the browser stories; CI runs them).
  Each Vitest project sets its own timeouts; the root config's are not inherited.
- The OpenFGA server binary for the permission spike is in `.cache/tools/openfga` (v1.22.0,
  downloaded from its GitHub release and checksum-verified); `pnpm spike authz --openfga`
  needs it. CI has no binary, so that candidate and its test are skipped there. Its metrics
  port is disabled in the spike; an orphaned instance otherwise blocks the next one.
- `pnpm spike xml` writes its synthetic file under `.cache/xml` unless `--dir` says otherwise
  (use `--dir G:/taskmoor-xml` while E: is busy; the 5 GB file takes two minutes to make).
- In `pnpm verify ... | grep`, use `set -o pipefail` before chaining a commit, or the grep
  status hides a failure. Editing TypeScript through `node -e` string replacement mangles
  `\n` escapes inside quoted strings; use the Edit tool for source edits.
- If `pnpm` is not on PATH, use `corepack pnpm ...`. `corepack enable` needs admin rights on
  this machine, so it was not run.
- When `pg_ctl` starts the server it must not inherit Node's pipes, or the call hangs on Windows
  (see `runWithoutPipes` in `packages/testkit/src/pg/server.ts`).
- In Playwright, `getByRole(..., { name: 'Boards' })` also matches "Dashboards". Use
  `exact: true` for short names.
- First-run setup (M0-027): the API role prints `{"msg":"first-run setup","link":...}` at every
  start until setup completes; `TASKMOOR_SETUP_TOKEN` fixes the token (the e2e suite uses
  `e2e-setup-token-0123456789`). `pnpm verify --e2e` starts `apps/web/e2e/api-server.ts` (embedded
  Postgres cluster `e2e`, port 8787) and the Vite preview proxies `/api` to it.
- Docker drills from Git Bash: wrap docker so that `MSYS_NO_PATHCONV=1` applies to it alone
  (`docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }`), or `/data/...` arguments become
  Windows paths; exporting it instead breaks curl's `-o /dev/null` (exit 23) and `$WORK` paths.
  `docker cp` needs a native host path (`cygpath -w`) and an existing parent directory in the
  container. `curl | grep -q` under `pipefail` can fail with curl's exit 23 because grep closes
  the pipe first (GNU grep also stops early when its output is /dev/null); read the body into a
  variable and match on it.
- PostgreSQL client versions: a pg_restore newer than the server fails on
  `SET transaction_timeout` (17+ emits it), so the image ships clients 16, 17 and 18 under
  `/usr/libexec/postgresql<major>` and `clientBinary()` in `apps/server/src/backup.ts` picks the
  server's major; `TASKMOOR_PG_BIN` points at another directory. The round-trip test
  (`backup.roundtrip.test.ts`) skips when no matching client is on this machine; PostgreSQL
  16.14 client tools are at `G:/tools/pgsql/bin`, so run it with
  `TASKMOOR_PG_BIN=G:/tools/pgsql/bin` after schema or backup changes. The CI image job runs the
  real drill.
- Python's `Path.write_text` on Windows writes CRLF: Biome's format check then fails and git
  shows whole-file diffs. Open files with `newline='\n'` or run `sed -i 's/\r$//'` afterwards.
- Commit 5ffe3ad carries the message of the commit before it; it holds the upgrade harness and
  the operator CLI (M0-029). Noted in the body of the commit that followed.
- `pnpm gate` only counts a full `pnpm verify`: a run narrowed with `--only`, `--changed` or a
  filter writes `partial: true` into `.verify/summary.json` and the gate reports it.
- Spike p95 is nearest-rank: with 10 runs it is the slowest sample. Use 40 or more runs for
  sub-millisecond queries on shared runners.
- `install.sh` resolves the port as Compose does: `TASKMOOR_PORT` in the environment first,
  then `.env`, then 8080. The install-matrix scripts set it in the environment.
- Sign-in limits count per client address. In-process tests pass `remoteAddress` to
  `app.inject` so one test's failures never lock another; behind a proxy the server needs
  `TASKMOOR_TRUSTED_PROXIES`, or every visitor shares the proxy's address.
- Argon2id costs tens of milliseconds per hash: a test that needs many users where the
  password does not matter should reuse one precomputed hash.
- Record task state in `docs/plan/progress.csv` (in-progress, done, waiting-on-user) as you go;
  `pnpm next-task`, `pnpm status-report`, `pnpm gate` and a test read it.

- Parallel sessions: three gates running at once on this machine made the server suite take
  over 800 s and time out in dozens of tests; two at a time is the practical limit. Each
  session needs its own `TASKMOOR_PG_CACHE_DIR` and its own migration number, and e2e runs need
  ports 4173 and 8787 free. Stop a session's embedded Postgres (`pg_ctl stop -m fast -D
  <dir>`) before deleting its worktree, or the folder stays locked.
- Merging parallel branches: union the migration index, upgrade seeds and event catalogue in
  migration order; rebuild `events/contract.test.ts` from `main` plus each branch's added
  scenarios; regenerate the schema golden; give every new event type an audit decision
  (`audit/subscriber.ts`) and every new route a token scope class (`tokens/scopes.ts`).
- Kysely applies migrations only in name order: a database that has run a later migration
  (0013 from `main`) refuses an earlier one merged after it (0011, 0012) as "corrupted
  migrations". Test and e2e databases are created fresh, so only long-lived development
  databases are affected: recreate them. Released databases never meet this, because numbers
  are reserved before a release.
- `apps/server/src/shutdown.test.ts` models two pods behind a Service; without the drain it
  fails with resets, so keep the drain (`TASKMOOR_SHUTDOWN_DRAIN_MS`) when touching shutdown.

### Waiting on the user

- **Release publishing** (decisions.csv): pushing images to ghcr.io and the release signing key
  for the air-gap bundle (M1-100). The user first wanted a local demo; it runs (see Local demo).
- **Repository rename** on GitHub to match the new name; outward-facing, so it waits for the
  user's go-ahead.
- **Counsel review**: deferred by the user to the first public release; it covers the
  clean-room protocol, ADR-002, ADR-003, the terminology and the name screening.
- **Merging `claude/api-key-upload-prevention-9ucz4x` into `main`**: it holds M1-008 and
  M1-083, each gated green. Whether to merge directly or through a pull request is the
  user's call; nothing on it is half-done.
