---
spec: 01b
title: "Core work tracking: query language, search and agile views"
sources: docs/research/sources.md
accessed: 2026-10-11
attestation: own-words
---
# 01b Core work tracking: query language, search and agile views

This file specifies, for Taskmoor, the query language (a native language plus a Jira-compatible dialect), saved searches and subscriptions, the search experience and exports, and the agile and business views built on queries: boards, backlog, sprints, timeline, list and calendar, plus navigation. Query compatibility matters as much as features here: customers must be able to paste their existing Jira filters and get the same results, so the catalogs below list every operator, field and function the research found, under the native name and Jira's legacy and 2025-2026 names.

## How to read

- **ID**: `MODULE-NNN`, stable and never reused. This file holds QRY and AGL.
- **MS**: M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must, S = Should, C = Could.
- **Source**: parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit; "verify" marks a fact the research flagged as unconfirmed.
- **Terms**: Taskmoor uses its own names, defined in `docs/specs/00-terminology.md`. The main ones: ticket = Jira issue, track = Jira project, ticket type = Jira issue type. Jira's names stay valid in the Jira-compatible API and query dialect.
- In catalogs, "(given)" means the research cites the legacy name; "(derived)" means the legacy name follows Atlassian's rename rule (work item -> issue, space -> project, work type -> issue type) and must be confirmed against a corpus of real filters (verify).

## 1. Reference: query language catalog

### 1.1 Grammar

- A clause is `field operator value`. Values are quoted strings, numbers, dates, function calls or parenthesised lists.
- Keywords: AND, OR, NOT, EMPTY, NULL, ORDER BY (with ASC, DESC). Precedence NOT > AND > OR; parentheses override. Keywords and field names are case-insensitive.
- A clause never matches tickets where the field is empty unless the query says so (for example `assignee != currentUser() OR assignee IS EMPTY`).
- Field names with spaces are quoted (`"Original estimate"`). Custom fields are addressable by name or by stable id (Jira's `cf[<id>]` form; verify).

### 1.2 Operators

| Operator | Meaning |
|---|---|
| `=` `!=` | Equals, not equals |
| `>` `>=` `<` `<=` | Ordering comparisons for numbers, dates, releases, priorities |
| `IN` `NOT IN` | Membership in a list or function result |
| `~` `!~` | Contains / does not contain (text fields) |
| `IS` `IS NOT` | Compare with EMPTY or NULL |
| `WAS` `WAS NOT` `WAS IN` `WAS NOT IN` | Value held at any time in history |
| `CHANGED` | Value changed at some point |

The research summary says Jira has 18 operators but lists the 17 above; check for a missing one (verify).

### 1.3 History predicates

WAS forms accept AFTER date, BEFORE date, BY user or (user list), DURING (date1, date2) and ON date. CHANGED also accepts FROM value and TO value. A WAS match checks the value's name as configured at change time and the value's id. Jira limits history operators to Assignee, Fix version, Priority, Reporter, Resolution and Status and searches only the latest 10,000 changes per item; Taskmoor supports every field and the full history.

### 1.4 Date and time values

Absolute formats: `yyyy/MM/dd HH:mm`, `yyyy-MM-dd HH:mm`, `yyyy/MM/dd`, `yyyy-MM-dd`. Relative values: signed number plus unit w, d, h or m (`-1d`). Function increments: `(+/-)nn(y|M|w|d|h|m)`. Evaluated in the user's time zone. End of week defaults to Saturday.

### 1.5 Fields

| Canonical identifier | Also accept | Notes |
|---|---|---|
| `foundInRelease` | `affectedVersion` | Release field |
| `approvals` | | Service tracks; see approval functions |
| `assignee`, `requester`, `creator` | `reporter` | User fields; accept `currentUser()`, `membersOf()` |
| `attachments` | | IS EMPTY / IS NOT EMPTY only |
| `trackCategory` | `category` | Track category |
| `changeGatingType` | "Change gating type" | Change records (file 04a) |
| `comment`, `description`, `environment`, `summary` | | Text; `~` only for long text |
| `area` | `component` | |
| `created`, `updated`, `due`, `closed`, `lastViewed` | `resolved`; `updatedDate` (given); `createdDate`, `dueDate`, `resolutionDate` (verify) | Dates |
| custom field name or id | `cf[<id>]` (verify) | Operators by field type |
| `ticket.property[<key>].<path>`, or the index's alias | `issue.property[<key>].<path>` | Values inside a ticket property that a declared property index covers (API-013); operators by the index's type: number, string, text (`~`), date, user. No history predicates |
| `parent` | `"Epic link"` (retired; rewritten to `parent`) | |
| `savedSearch` | `filter`; `request`, `savedFilter`, `searchRequest` (given) | Saved search by id or name; cycles rejected |
| `targetRelease` | `fixVersion` | |
| `hierarchyLevel` | | All levels including custom ones |
| `journey`, `journeyParent`, `journeyType`, `journeyTypeVersion`, `journeyTicket` | `journeyWorkItem` | Parsed and stored; semantics not in research (verify) |
| `labels` | | |
| `visibilityLevel` | `level` | Visibility level |
| `customerGroup`, `requestForm`, `requestChannel`, `requestLastActivity` | `organization`, `requestType`, `requestChannelType`, `requestLastActivityTime` | Service tracks |
| `originalEstimate`, `remainingEstimate`, `timeSpent`, `effortRatio` | `workRatio` | Time fields |
| `track` | `project` (given), `space` | |
| `parentTrack` | `parentProject` (derived), `parentSpace` | |
| `trackType` | `projectType` (derived), `spaceType` | Values business, software, service_desk |
| `priority`, `closeReason`, `status` | `resolution` | `stage` (Jira: `statusCategory`) also accepted (verify Jira support) |
| SLA name | | Service tracks, with SLA functions |
| `sprint` | | With sprint functions and relative tokens (QRY-013) |
| `text` | | Master text: summary, description, environment, comments, free-text custom fields; `~` only |
| `type` | `issuetype` (given), `issueType` | Ticket type |
| `key` | `issue`, `issueKey` (given: `issue`) | Ticket key |
| `voter`, `votes`, `follower`, `followers` | `watcher`, `watchers` | |
| `ticketLink` | `issueLink` (derived), `workItemLink` | |
| `ticketLinkType` | `issueLinkType` (derived), `workItemLinkType` | Matches link name and both descriptions |
| `timeEntryComment`, `timeEntryDate` | `worklogComment`, `worklogDate` | |

### 1.6 Functions

| Native name | Jira-compatible names | Notes |
|---|---|---|
| `currentUser()` | same | User fields, = and != |
| `membersOf(group)`, `membersOf("id:<teamId>")` | same | Groups or teams; Jira errors above 10,000 users, Taskmoor does not |
| `now()`, `currentLogin()`, `lastLogin()` | same | |
| `startOfDay/Week/Month/Year(inc)`, `endOfDay/Week/Month/Year(inc)` | same | Optional increment |
| `openSprints()`, `closedSprints()`, `futureSprints()` | same | Must work with 60,000+ sprints (Jira DC fails near 65,000) |
| `shippedReleases(track?)`, `upcomingReleases(track?)` | `releasedVersions()`, `unreleasedVersions()` | |
| `latestShippedRelease(track)`, `earliestUpcomingRelease(track)` | `latestReleasedVersion()`, `earliestUnreleasedVersion()` | Follow manual release order, not dates |
| `areasOwnedByUser(user?)` | `componentsLeadByUser()` | |
| `tracksOwnedByUser(user?)` | `projectsLeadByUser()` (given), `spacesLeadByUser()` | |
| `tracksWhereUserHasPermission(perm)` | `projectsWhereUserHasPermission()` (derived), `spacesWhereUserHasPermission()` | |
| `tracksWhereUserHasRole(role)` | `projectsWhereUserHasRole()` (derived), `spacesWhereUserHasRole()` | |
| `linkedTickets(key, linkType...)` | `linkedIssues()` (derived), `linkedWorkItems()` | |
| `ticketHistory()` | `issueHistory()` (given), `workItemHistory()` | Recently viewed; Jira returns 50, here configurable |
| `ticketsWithWebLinksByGlobalId(ids)` | `issuesWithRemoteLinksByGlobalId()` (derived), `workItemsWithRemoteLinksByGlobalId()` | 1-100 ids in Jira; no cap here |
| `votedTickets()`, `followedTickets()` | `votedIssues()`, `watchedIssues()` (derived), `votedWorkItems()`, `watchedWorkItems()` | Jira caps at 32,000 ids; no cap here |
| `updatedBy(user, from?, to?)` | same | Jira granularity is 1 day; here 1 minute |
| `linkedTicket = key`, `parentOutcome = key` | `linkedWorkItem`, `parentEpic`; legacy form (verify exact form) | Company-managed spaces in Jira |
| `standardTicketTypes()`, `subticketTypes()` | `standardIssueTypes()`, `subTaskIssueTypes()` (derived), `standardWorkTypes()`, `subtaskWorkTypes()` | |
| `cascadeOption(parent, child or none)`, `choiceOption(ids...)` | same | |
| Service functions | same, except `organizationDetail()`, `organizationMembers()` | `approved()`, `approver()`, `breached()`, `completed()`, `customerDetail()`, `entitlementDetail()`, `entitlementProduct()`, `everBreached()`, `myApproval()`, `myPendingApproval()`, `myPending()`, `customerGroupDetail()`, `customerGroupMembers()`, `paused()`, `pending()`, `pendingApprovalBy()`, `pendingBy()`, `remaining()`, `running()`, `withinCalendarHours()` (file 04a) |

### 1.7 Ordering, saved searches and subscriptions

- `ORDER BY f1 [ASC/DESC], f2 ...` on any sortable field, including custom and read-only info fields; ties broken by key. Boards and backlogs order by rank and ignore ORDER BY in swimlane queries. Without ORDER BY, results sort by created descending (verify Jira default).
- System saved searches: My open tickets, Requested by me, All tickets, Open tickets, Closed tickets, Viewed recently, Created recently, Closed recently, Updated recently.
- Share scopes: private, user, group, track (all members or chosen roles), any signed-in user, public (anonymous). Sharing needs the global permission "Share dashboards and saved searches"; group subscriptions need "Manage group search subscriptions". Admins can change owner or delete shared saved searches.

### 1.8 Text search syntax (Taskmoor's design; Jira's exact rules were not captured, verify)

Words are ANDed; quoted phrases; trailing `*` and single `?` wildcards; `term~` fuzzy match; `-term` excludes; case-insensitive; language stemming per site language; reserved characters escaped with a backslash.

## 2. QRY requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| QRY-001 | **Grammar and parser.** Taskmoor shall parse the grammar of section 1.1 into an AST with error recovery. | (1) A corpus of at least 2,000 real-world Jira filters parses without error. (2) Syntax errors report line, column and an expected-token hint. (3) AST printed back to text yields an equivalent query. | M1 | M | Jira Free |
| QRY-002 | **Typed operators.** Taskmoor shall implement every operator of section 1.2 with per-field-type validity checks. | (1) `~` on a number field returns a validation error naming the field. (2) `IN` with 1,000 values runs. (3) EMPTY semantics match section 1.1 in tests per field type. | M1 | M | Jira Free |
| QRY-003 | **Fields under both vocabularies.** Taskmoor shall resolve every field in section 1.5 by native, Jira-compatible and display names, and custom fields by name or id. | (1) `project = ABC AND issuetype = Bug` and `track = ABC AND type = Bug` return the same results. (2) An ambiguous custom field name returns an error listing candidate ids. (3) Each field has at least one passing test. | M1 | M | Jira Free; exceeds Jira (new terms not all working) |
| QRY-004 | **Functions.** Taskmoor shall implement every function in section 1.6 under every accepted name, without Jira's result caps. | (1) Each function has tests under each accepted name. (2) `membersOf()` on a 50,000-member group runs. (3) Bad arguments return an error naming the argument. | M1 | M | Jira Free; exceeds Jira |
| QRY-005 | **History search on every field.** Taskmoor shall evaluate WAS and CHANGED predicates (section 1.3) on every system and custom field over the full history. | (1) `points CHANGED FROM 3 TO 5 BY alice DURING ("2026-01-01", "2026-02-01")` returns the right tickets. (2) `status WAS "In Review"` still matches after the status is renamed. (3) Changes older than a ticket's latest 10,000 are found. | M1 | M | Jira Free; exceeds Jira (six fields, 10,000 changes) |
| QRY-006 | **Dates and time zones.** Taskmoor shall evaluate absolute, relative and function dates (section 1.4) in the user's time zone. | (1) `created >= startOfWeek(-1w)` gives the same tickets for users in UTC+10 and UTC-5 when their local weeks match. (2) End of week defaults to Saturday and follows a site setting. | M1 | M | Jira Free |
| QRY-007 | **Text search.** Taskmoor shall provide `~` text search on text fields and the master `text` field using the syntax of section 1.8 and an index updated in the same transaction as the write. | (1) `text ~ "login"` finds a ticket whose only match is in a comment. (2) A phrase query matches only adjacent words. (3) A ticket is findable by text within 1 s of being saved. | M1 | M | Jira Free (syntax verify) |
| QRY-008 | **Permission-aware execution.** Taskmoor shall apply browse permission and visibility levels inside the compiled query, not by filtering after the fact. | (1) Tickets the user cannot browse never appear in results, counts, charts, autocomplete or exports. (2) A visibility-level test matrix of 5 levels and 4 users passes. (3) Query plans show the permission predicate in SQL. | M1 | M | Jira Free |
| QRY-009 | **Ordering and paging.** Taskmoor shall implement ORDER BY (section 1.7) with stable cursor pagination and an optional approximate total. | (1) Paging through 100,000 results returns each ticket exactly once while other users edit. (2) Multi-field ordering with custom fields is correct. (3) An approximate count is returned in under 100 ms. | M1 | M | Jira Free; exceeds Jira (no totals in new search API) |
| QRY-010 | **Compiler and explain.** Taskmoor shall compile queries to parameterised SQL, give admins an explain view, and enforce a configurable timeout. | (1) A fuzz test of 10,000 generated queries finds no injected SQL. (2) Explain shows the plan and estimated cost. (3) A query over the timeout (default 30 s) stops and returns a clear error. | M1 | M | exceeds Jira |
| QRY-011 | **Saved searches and sharing.** Taskmoor shall save searches with owner, description and star, ship the system saved searches, support the share scopes of section 1.7, saved-search references with cycle detection, and admin owner change. | (1) A saved search shared with role Developers in track ABC is visible only to them. (2) A saved search that references itself through another saved search is rejected on save. (3) Public saved searches are reachable anonymously only when anonymous access is enabled. | M1 | M | Jira Free |
| QRY-012 | **Search subscriptions.** Taskmoor shall email saved-search results on a schedule (daily, weekly, monthly or cron) to a user or a group, with an option to send only when results exist. | (1) A group subscription sends each member only tickets that member may browse. (2) "Only if results" suppresses empty emails. (3) Subscriptions import from Jira (they are dropped by Atlassian's migration tool). | M1 | M | Jira Free (scheduling options verify) |
| QRY-013 | **Relative iteration tokens.** Taskmoor shall accept `@current`, `@next` and `@previous` as sprint values relative to the board or team. | (1) `sprint = @current` follows the active sprint after a sprint is completed and the next one started. | M1 | S | GitHub Projects |
| QRY-014 | **Search experience.** Taskmoor shall provide a basic mode (field pickers) and an advanced editor (highlighting, autocomplete, live validation, multi-line with line numbers), switching when the query fits basic mode, plus inline edit in results, a preview panel, a multi-track picker and column sets (personal, saved search, system) that can be reordered and resized. | (1) A query built in basic mode converts to identical query text. (2) Inline edit in results saves without leaving the page. (3) Column sets persist per user and per saved search. | M1 | M | Jira Free |
| QRY-015 | **Result export.** Taskmoor shall export results as CSV (all fields or current columns), Excel, Word-compatible document, XML and JSON, asynchronously and without a row cap. | (1) Exporting 500,000 rows completes as a background job with a download link. (2) CSV export re-imports through the CSV importer to identical field values. | M1 | M | Jira Free; exceeds Jira |

## 3. Reference: boards, sprints and views

### 3.1 Board configuration options

- **Source and ownership**: one saved search (single or multiple tracks); location (a track or a user); board admins; visibility follows the saved search and browse permission.
- **Columns**: add, rename, delete, move; several statuses per column; an "unmapped statuses" panel (tickets in unmapped statuses are hidden); the rightmost column means done; optional Kanban backlog column.
- **WIP limits**: min and max per column; header turns red above max and yellow below min; counts include tickets hidden by board filters; limits never hide cards.
- **Swimlanes**: by queries (one query per lane; default lanes "Expedite" with `priority = Urgent` and an undeletable catch-all "Everything else"), by subtickets (each parent with its subtickets), by assignees (unassigned lane first or last), by outcomes or parents, by tracks, or none. Lanes are ordered by rank; ORDER BY in lane queries is ignored.
- **Board filters** (Jira: quick filters): name, query, description; defaults "Only my tickets" (`assignee = currentUser()`) and "Recently updated" (`updated >= -1d`); reorderable; shown as buttons or dropdown; several active board filters combine with AND (verify).
- **Cards**: colour strip by ticket type, priority, assignee or query (first match wins); extra fields on the card (Jira allows 3; here up to 10); days-in-column marker; card covers; development status icons.
- **Estimation**: estimation statistic (points or original time estimate) and time tracking (none, or remaining estimate and time spent).
- **Kanban sub-filter**: a second query that hides finished work, for example shipped releases (Atlassian's migration tool drops these; verify semantics).

### 3.2 Sprint lifecycle

States future, active, closed. Operations: create; edit name, goal and dates; reorder future sprints; start; add or remove tickets while active (logged as scope change); complete; reopen; delete (including completed sprints); link a wiki page. Completing needs the Manage sprints permission and offers to move unfinished tickets to the backlog, a future sprint or a new sprint. "Done" means in the board's rightmost column; completion is blocked while done tickets have unfinished subtickets (verify exact rule). Several sprints may be active at once (parallel sprints). A sprint shared by several boards: the completing board carries over only its own unfinished tickets; other boards' unfinished tickets go to their backlogs.

### 3.3 Track view tabs

Summary, List, Board, Backlog, Timeline, Calendar, Reports, Forms, Approvals, Development, Releases, Areas, Capacity. Track admins reorder and hide tabs.

## 4. AGL requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| AGL-001 | **Boards on saved searches.** Taskmoor shall create Scrum and Kanban boards on a saved search covering one or more tracks, with board admins and a location. | (1) A board on a saved search spanning 3 tracks shows tickets from all 3. (2) Only board admins or track admins of the location can change configuration. | M1 | M | Jira Free |
| AGL-002 | **Columns and status mapping.** Taskmoor shall implement the column options of section 3.1. | (1) Two statuses mapped to one column both show there. (2) A ticket in an unmapped status is listed in the unmapped panel count. (3) Dragging between columns runs the matching transition, asking which one when several exist. | M1 | M | Jira Free |
| AGL-003 | **WIP limits.** Taskmoor shall show min and max limits per column and signal breaches. | (1) With max 3 and 4 cards the header is red; with min 2 and 1 card it is yellow. (2) Cards hidden by a board filter still count. | M1 | M | Jira Free |
| AGL-004 | **Swimlanes.** Taskmoor shall implement every swimlane mode of section 3.1. | (1) A query lane catches matching tickets before the catch-all. (2) The catch-all lane cannot be deleted. (3) Subticket mode groups subtickets under their parent. | M1 | M | Jira Free |
| AGL-005 | **Board filters.** Taskmoor shall provide query-defined board filters with the two defaults, ordering and button or dropdown display. | (1) Activating two board filters shows only tickets matching both. (2) Board filters import from Jira boards with translated queries. | M1 | M | Jira Free |
| AGL-006 | **Card layout.** Taskmoor shall implement card colour rules, up to 10 extra fields, days in column, covers and development icons. | (1) The first matching colour rule wins. (2) Days in column resets when the card changes column. | M1 | M | Jira Free; exceeds Jira (3 fields) |
| AGL-007 | **Estimation and tracking.** Taskmoor shall let each Scrum board choose its estimation statistic and time tracking mode, and local-mode tracks toggle estimation. | (1) Switching from points to time estimate changes card badges and sprint totals. (2) With remaining-estimate tracking, recording time lowers the sprint's remaining total. | M1 | M | Jira Free |
| AGL-008 | **Backlog.** Taskmoor shall provide a ranked backlog with sprint sections, inline create, drag and drop, multi-select, a parent (outcome) panel with drag-to-parent and a release panel with drag-to-release. | (1) Dragging 50 selected tickets into a sprint updates all 50 in one operation. (2) Dropping a ticket on an outcome in the panel sets its parent. | M1 | M | Jira Free |
| AGL-009 | **Global rank.** Taskmoor shall keep one global rank order usable by all boards and backlogs, with move to top and bottom, rank via API, and rank preserved on import. | (1) Ranking on one board is reflected on another board sharing the tickets. (2) 1,000 consecutive rank moves never need a full rebalance visible to users. (3) Imported Jira rank order is reproduced exactly. | M1 | M | Jira Free |
| AGL-010 | **Sprint lifecycle.** Taskmoor shall implement the sprint states and operations of section 3.2. | (1) Completing a sprint offers backlog, future sprint or new sprint for unfinished tickets. (2) Tickets added after start are marked as scope change in reports. (3) A deleted completed sprint disappears from reports and its tickets keep their history. | M1 | M | Jira Free |
| AGL-011 | **Parallel and shared sprints.** Taskmoor shall allow several active sprints per board and sprints shared across boards, and shall compute velocity per team. | (1) Two active sprints run on one board, each with its own section. (2) Completing a shared sprint carries over only the completing board's tickets. (3) Velocity can be shown per team (exceeds Jira, whose velocity chart is not per team in parallel sprints). | M1 | M | Jira Free; exceeds Jira |
| AGL-012 | **Auto-rolling cycles.** Taskmoor shall optionally create sprints on a cadence and roll unfinished tickets into the next one automatically. | (1) With a 2-week cadence, the next sprint exists and starts when the current one ends, and unfinished tickets move into it. | M1 | S | Linear |
| AGL-013 | **Board scale.** Taskmoor shall render every ticket matched by the board's saved search, without a 5,000-ticket cap, using virtualised rendering. | (1) A 5,000-card board renders in under 1 s (NFR-001). (2) A 50,000-ticket multi-track board loads and scrolls without errors. | M1 | M | exceeds Jira (5,000 cap on multi-space boards) |
| AGL-014 | **Kanban backlog and sub-filter.** Taskmoor shall offer an optional Kanban backlog per board and a sub-filter that hides finished work. | (1) With the Kanban backlog on, the first column moves to the backlog view. (2) Tickets in shipped releases disappear from the board when the sub-filter says so. | M1 | M | Jira Free |
| AGL-015 | **Timeline.** Taskmoor shall show a Gantt timeline of one track with parent-child nesting; parent dates set manually or rolled up from children; Scrum children dated by sprint or start/due; dependency lines from links; zoom by weeks, months and quarters; sprint and release markers; drag to reschedule; side-panel editing; progress roll-up. | (1) A parent's rolled-up bar spans its earliest child start to latest child due. (2) Dragging a bar updates start and due dates. (3) Roll-ups stay on for tracks with over 10,000 tickets. | M1 | M | Jira Free; exceeds Jira (roll-ups disabled above 10,000) |
| AGL-016 | **List view and format rules.** Taskmoor shall provide a spreadsheet-like list with inline create and edit, sort, filter, group, rank, selectable columns and conditional format rules for cells and rows. | (1) A rule "due < now() and stage != closed" colours overdue rows red. (2) Grouping by assignee shows counts per group. (3) 10,000 rows scroll without blank frames. | M1 | M | Jira Free |
| AGL-017 | **Calendar view.** Taskmoor shall show tickets by start and due date, show sprints and releases (business calendars may show software release dates), support drag to reschedule, and publish a read-only iCal feed per saved view. | (1) Dragging a ticket to another day changes its due date. (2) An iCal client subscribed to a view shows the same tickets. | M1 | M | Jira Free; Vikunja (CalDAV-style feed) |
| AGL-018 | **Navigation and command palette.** Taskmoor shall provide a sidebar (For you, recent, starred, tracks, dashboards, saved searches; personal customisation), reorderable track tabs (section 3.3), a Ctrl/Cmd+K command palette reaching every action, `/` quick search, and documented keyboard shortcuts. | (1) Every action in the ticket view menu is reachable from the palette. (2) Shortcuts work for create, assign, follow (W), comment (M) and transition. (3) Track admins reorder and hide tabs. | M1 | M | Jira Free; Linear |
| AGL-019 | **For you page.** Taskmoor shall show assigned, starred, worked-on and viewed tickets and a recommended list (due soon, mentions, comments on your tickets, approvals waiting, review requests). | (1) A new mention appears in Recommended within 5 s. (2) Each tab is filterable by track. | M1 | M | Jira Free |
| AGL-020 | **Saved views.** Taskmoor shall save list, board, calendar and timeline configurations (query, grouping, columns, sort) as personal or shared views. | (1) A shared view opens identically for another user with access. | M2 | S | Plane |
| AGL-021 | **Natural-language quick add.** Taskmoor shall parse quick-add text for assignee, priority, labels, due date and track. | (1) "Fix login @alice !high #bug due friday" creates a ticket with those values. | M2 | S | Vikunja |
| AGL-022 | **Stale ticket auto-close.** Taskmoor shall optionally close or archive tickets untouched for a configured period, with a warning first. | (1) Tickets idle 90 days get a warning comment, then close 14 days later unless touched. | M2 | S | Fizzy |
| AGL-023 | **Story maps and retrospectives.** Taskmoor shall provide a story map view (activities by parent, tickets by release) and retrospective boards that create action items. | (1) Dragging a card between release rows changes its target release. (2) A retro action item becomes a ticket linked to the sprint. | M4 | C | Easy Agile TeamRhythm app |
