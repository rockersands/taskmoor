# 01b Core work tracking: query language, search and agile views

This file specifies, for Tracksmith (a working name for the product), the query language (a native language plus a JQL-compatible dialect), saved filters and subscriptions, the search experience and exports, and the agile and business views built on queries: boards, backlog, sprints, timeline, list and calendar, plus navigation. Query compatibility matters as much as features here: customers must be able to paste their existing saved filters and get the same results, so the catalogs below list every operator, field and function the research found, under both Jira's legacy and 2025-2026 names.

## How to read

- **ID**: `MODULE-NNN`, stable and never reused. This file holds QRY and AGL.
- **MS**: M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must, S = Should, C = Could.
- **Source**: parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit; "verify" marks a fact the research flagged as unconfirmed.
- **Terms**: work item = issue, space = project, work type = issue type.
- In catalogs, "(given)" means the research cites the legacy name; "(derived)" means the legacy name follows Atlassian's rename rule (work item -> issue, space -> project, work type -> issue type) and must be confirmed against a corpus of real filters (verify).

## 1. Reference: query language catalog

### 1.1 Grammar

- A clause is `field operator value`. Values are quoted strings, numbers, dates, function calls or parenthesised lists.
- Keywords: AND, OR, NOT, EMPTY, NULL, ORDER BY (with ASC, DESC). Precedence NOT > AND > OR; parentheses override. Keywords and field names are case-insensitive.
- A clause never matches items where the field is empty unless the query says so (for example `assignee != currentUser() OR assignee IS EMPTY`).
- Field names with spaces are quoted (`"Story points"`). Custom fields are addressable by name or by stable id (Jira's `cf[<id>]` form; verify).

### 1.2 Operators

| Operator | Meaning |
|---|---|
| `=` `!=` | Equals, not equals |
| `>` `>=` `<` `<=` | Ordering comparisons for numbers, dates, versions, priorities |
| `IN` `NOT IN` | Membership in a list or function result |
| `~` `!~` | Contains / does not contain (text fields) |
| `IS` `IS NOT` | Compare with EMPTY or NULL |
| `WAS` `WAS NOT` `WAS IN` `WAS NOT IN` | Value held at any time in history |
| `CHANGED` | Value changed at some point |

The research summary says Jira has 18 operators but lists the 17 above; check for a missing one (verify).

### 1.3 History predicates

WAS forms accept AFTER date, BEFORE date, BY user or (user list), DURING (date1, date2) and ON date. CHANGED also accepts FROM value and TO value. A WAS match checks the value's name as configured at change time and the value's id. Jira limits history operators to Assignee, Fix version, Priority, Reporter, Resolution and Status and searches only the latest 10,000 changes per item; Tracksmith supports every field and the full history.

### 1.4 Date and time values

Absolute formats: `yyyy/MM/dd HH:mm`, `yyyy-MM-dd HH:mm`, `yyyy/MM/dd`, `yyyy-MM-dd`. Relative values: signed number plus unit w, d, h or m (`-1d`). Function increments: `(+/-)nn(y|M|w|d|h|m)`. Evaluated in the user's time zone. End of week defaults to Saturday.

### 1.5 Fields

| Canonical identifier | Also accept | Notes |
|---|---|---|
| `affectedVersion` | | Version field |
| `approvals` | | Service spaces; see approval functions |
| `assignee`, `reporter`, `creator` | | User fields; accept `currentUser()`, `membersOf()` |
| `attachments` | | IS EMPTY / IS NOT EMPTY only |
| `category` | | Space category |
| `changeGatingType` | "Change gating type" | Change records (file 04a) |
| `comment`, `description`, `environment`, `summary` | | Text; `~` only for long text |
| `component` | | |
| `created`, `updated`, `due`, `resolved`, `lastViewed` | `updatedDate` (given); `createdDate`, `dueDate`, `resolutionDate` (verify) | Dates |
| custom field name or id | `cf[<id>]` (verify) | Operators by field type |
| `parent` | `"Epic link"` (retired; rewritten to `parent`) | |
| `filter` | `request`, `savedFilter`, `searchRequest` (given) | Saved filter by id or name; cycles rejected |
| `fixVersion` | | |
| `hierarchyLevel` | | All levels including custom ones |
| `journey`, `journeyParent`, `journeyType`, `journeyTypeVersion`, `journeyWorkItem` | | Parsed and stored; semantics not in research (verify) |
| `labels` | | |
| `level` | | Security level |
| `organization`, `requestType`, `requestChannelType`, `requestLastActivityTime` | | Service spaces |
| `originalEstimate`, `remainingEstimate`, `timeSpent`, `workRatio` | | Time fields |
| `space` | `project` (given) | |
| `parentSpace` | `parentProject` (derived) | |
| `spaceType` | `projectType` (derived) | Values business, software, service_desk |
| `priority`, `resolution`, `status` | | `statusCategory` also accepted (verify Jira support) |
| SLA name | | Service spaces, with SLA functions |
| `sprint` | | With sprint functions and relative tokens (QRY-013) |
| `text` | | Master text: summary, description, environment, comments, free-text custom fields; `~` only |
| `type` | `issuetype` (given), `issueType` | Work type |
| `key` | `issue`, `issueKey` (given: `issue`) | Work item key |
| `voter`, `votes`, `watcher`, `watchers` | | |
| `workItemLink` | `issueLink` (derived) | |
| `workItemLinkType` | `issueLinkType` (derived) | Matches link name and both descriptions |
| `worklogComment`, `worklogDate` | | |

### 1.6 Functions

| Name (2025-2026) | Legacy name | Notes |
|---|---|---|
| `currentUser()` | same | User fields, = and != |
| `membersOf(group)`, `membersOf("id:<teamId>")` | same | Groups or teams; Jira errors above 10,000 users, Tracksmith does not |
| `now()`, `currentLogin()`, `lastLogin()` | same | |
| `startOfDay/Week/Month/Year(inc)`, `endOfDay/Week/Month/Year(inc)` | same | Optional increment |
| `openSprints()`, `closedSprints()`, `futureSprints()` | same | Must work with 60,000+ sprints (Jira DC fails near 65,000) |
| `releasedVersions(space?)`, `unreleasedVersions(space?)` | same | |
| `latestReleasedVersion(space)`, `earliestUnreleasedVersion(space)` | same | Follow manual version order, not dates |
| `componentsLeadByUser(user?)` | same | |
| `spacesLeadByUser(user?)` | `projectsLeadByUser()` (given) | |
| `spacesWhereUserHasPermission(perm)` | `projectsWhereUserHasPermission()` (derived) | |
| `spacesWhereUserHasRole(role)` | `projectsWhereUserHasRole()` (derived) | |
| `linkedWorkItems(key, linkType...)` | `linkedIssues()` (derived) | |
| `workItemHistory()` | `issueHistory()` (given) | Recently viewed; Jira returns 50, here configurable |
| `workItemsWithRemoteLinksByGlobalId(ids)` | `issuesWithRemoteLinksByGlobalId()` (derived) | 1-100 ids in Jira; no cap here |
| `votedWorkItems()`, `watchedWorkItems()` | `votedIssues()`, `watchedIssues()` (derived) | Jira caps at 32,000 ids; no cap here |
| `updatedBy(user, from?, to?)` | same | Jira granularity is 1 day; here 1 minute |
| `linkedWorkItem = key`, `parentEpic = key` | (verify exact form) | Shared-mode spaces in Jira |
| `standardWorkTypes()`, `subtaskWorkTypes()` | `standardIssueTypes()`, `subTaskIssueTypes()` (derived) | |
| `cascadeOption(parent, child or none)`, `choiceOption(ids...)` | same | |
| Service functions | same | `approved()`, `approver()`, `breached()`, `completed()`, `customerDetail()`, `entitlementDetail()`, `entitlementProduct()`, `everBreached()`, `myApproval()`, `myPendingApproval()`, `myPending()`, `organizationDetail()`, `organizationMembers()`, `paused()`, `pending()`, `pendingApprovalBy()`, `pendingBy()`, `remaining()`, `running()`, `withinCalendarHours()` (file 04a) |

### 1.7 Ordering, filters and subscriptions

- `ORDER BY f1 [ASC/DESC], f2 ...` on any sortable field, including custom and read-only info fields; ties broken by key. Boards and backlogs order by rank and ignore ORDER BY in swimlane queries. Without ORDER BY, results sort by created descending (verify Jira default).
- System filters: My open work items, Reported by me, All work items, Open work items, Done work items, Viewed recently, Created recently, Resolved recently, Updated recently.
- Share scopes: private, user, group, space (all members or chosen roles), any signed-in user, public (anonymous). Sharing needs the global permission "Share dashboards and filters"; group subscriptions need "Manage group filter subscriptions". Admins can change owner or delete shared filters.

### 1.8 Text search syntax (Tracksmith's design; Jira's exact rules were not captured, verify)

Words are ANDed; quoted phrases; trailing `*` and single `?` wildcards; `term~` fuzzy match; `-term` excludes; case-insensitive; language stemming per site language; reserved characters escaped with a backslash.

## 2. QRY requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| QRY-001 | **Grammar and parser.** Tracksmith shall parse the grammar of section 1.1 into an AST with error recovery. | (1) A corpus of at least 2,000 real-world Jira filters parses without error. (2) Syntax errors report line, column and an expected-token hint. (3) AST printed back to text yields an equivalent query. | M1 | M | Jira Free |
| QRY-002 | **Typed operators.** Tracksmith shall implement every operator of section 1.2 with per-field-type validity checks. | (1) `~` on a number field returns a validation error naming the field. (2) `IN` with 1,000 values runs. (3) EMPTY semantics match section 1.1 in tests per field type. | M1 | M | Jira Free |
| QRY-003 | **Fields under both vocabularies.** Tracksmith shall resolve every field in section 1.5 by canonical, legacy and display names, and custom fields by name or id. | (1) `project = ABC AND issuetype = Bug` and `space = ABC AND type = Bug` return the same results. (2) An ambiguous custom field name returns an error listing candidate ids. (3) Each field has at least one passing test. | M1 | M | Jira Free; exceeds Jira (new terms not all working) |
| QRY-004 | **Functions.** Tracksmith shall implement every function in section 1.6 under both names, without Jira's result caps. | (1) Each function has tests under each accepted name. (2) `membersOf()` on a 50,000-member group runs. (3) Bad arguments return an error naming the argument. | M1 | M | Jira Free; exceeds Jira |
| QRY-005 | **History search on every field.** Tracksmith shall evaluate WAS and CHANGED predicates (section 1.3) on every system and custom field over the full history. | (1) `"Story points" CHANGED FROM 3 TO 5 BY alice DURING ("2026-01-01", "2026-02-01")` returns the right items. (2) `status WAS "In Review"` still matches after the status is renamed. (3) Changes older than an item's latest 10,000 are found. | M1 | M | Jira Free; exceeds Jira (six fields, 10,000 changes) |
| QRY-006 | **Dates and time zones.** Tracksmith shall evaluate absolute, relative and function dates (section 1.4) in the user's time zone. | (1) `created >= startOfWeek(-1w)` gives the same items for users in UTC+10 and UTC-5 when their local weeks match. (2) End of week defaults to Saturday and follows a site setting. | M1 | M | Jira Free |
| QRY-007 | **Text search.** Tracksmith shall provide `~` text search on text fields and the master `text` field using the syntax of section 1.8 and an index updated in the same transaction as the write. | (1) `text ~ "login"` finds an item whose only match is in a comment. (2) A phrase query matches only adjacent words. (3) An item is findable by text within 1 s of being saved. | M1 | M | Jira Free (syntax verify) |
| QRY-008 | **Permission-aware execution.** Tracksmith shall apply browse permission and security levels inside the compiled query, not by filtering after the fact. | (1) Items the user cannot browse never appear in results, counts, charts, autocomplete or exports. (2) A security-level test matrix of 5 levels and 4 users passes. (3) Query plans show the permission predicate in SQL. | M1 | M | Jira Free |
| QRY-009 | **Ordering and paging.** Tracksmith shall implement ORDER BY (section 1.7) with stable cursor pagination and an optional approximate total. | (1) Paging through 100,000 results returns each item exactly once while other users edit. (2) Multi-field ordering with custom fields is correct. (3) An approximate count is returned in under 100 ms. | M1 | M | Jira Free; exceeds Jira (no totals in new search API) |
| QRY-010 | **Compiler and explain.** Tracksmith shall compile queries to parameterised SQL, give admins an explain view, and enforce a configurable timeout. | (1) A fuzz test of 10,000 generated queries finds no injected SQL. (2) Explain shows the plan and estimated cost. (3) A query over the timeout (default 30 s) stops and returns a clear error. | M1 | M | exceeds Jira |
| QRY-011 | **Saved filters and sharing.** Tracksmith shall save filters with owner, description and star, ship the system filters, support the share scopes of section 1.7, filter references with cycle detection, and admin owner change. | (1) A filter shared with role Developers in space ABC is visible only to them. (2) A filter that references itself through another filter is rejected on save. (3) Public filters are reachable anonymously only when anonymous access is enabled. | M1 | M | Jira Free |
| QRY-012 | **Filter subscriptions.** Tracksmith shall email filter results on a schedule (daily, weekly, monthly or cron) to a user or a group, with an option to send only when results exist. | (1) A group subscription sends each member only items that member may browse. (2) "Only if results" suppresses empty emails. (3) Subscriptions import from Jira (they are dropped by Atlassian's migration tool). | M1 | M | Jira Free (scheduling options verify) |
| QRY-013 | **Relative iteration tokens.** Tracksmith shall accept `@current`, `@next` and `@previous` as sprint values relative to the board or team. | (1) `sprint = @current` follows the active sprint after a sprint is completed and the next one started. | M1 | S | GitHub Projects |
| QRY-014 | **Search experience.** Tracksmith shall provide a basic mode (field pickers) and an advanced editor (highlighting, autocomplete, live validation, multi-line with line numbers), switching when the query fits basic mode, plus inline edit in results, a preview panel, a multi-space picker and column sets (personal, filter, system) that can be reordered and resized. | (1) A query built in basic mode converts to identical query text. (2) Inline edit in results saves without leaving the page. (3) Column sets persist per user and per filter. | M1 | M | Jira Free |
| QRY-015 | **Result export.** Tracksmith shall export results as CSV (all fields or current columns), Excel, Word-compatible document, XML and JSON, asynchronously and without a row cap. | (1) Exporting 500,000 rows completes as a background job with a download link. (2) CSV export re-imports through the CSV importer to identical field values. | M1 | M | Jira Free; exceeds Jira |

## 3. Reference: boards, sprints and views

### 3.1 Board configuration options

- **Source and ownership**: one saved filter (single or multiple spaces); location (a space or a user); board admins; visibility follows the filter and browse permission.
- **Columns**: add, rename, delete, move; several statuses per column; an "unmapped statuses" panel (items in unmapped statuses are hidden); the rightmost column means done; optional Kanban backlog column.
- **WIP limits**: min and max per column; header turns red above max and yellow below min; counts include items hidden by quick filters; limits never hide cards.
- **Swimlanes**: by queries (one query per lane; default lanes "Expedite" with `priority = Blocker` and an undeletable catch-all "Everything else"), by stories (parent with its subtasks), by assignees (unassigned lane first or last), by epics or parents, by spaces, or none. Lanes are ordered by rank; ORDER BY in lane queries is ignored.
- **Quick (custom) filters**: name, query, description; defaults "Only my work items" (`assignee = currentUser()`) and "Recently updated" (`updatedDate >= -1d`); reorderable; shown as buttons or dropdown; several active filters combine with AND (verify).
- **Cards**: colour strip by work type, priority, assignee or query (first match wins); extra fields on the card (Jira allows 3; here up to 10); days-in-column marker; card covers; development status icons.
- **Estimation**: estimation statistic (story points or original time estimate) and time tracking (none, or remaining estimate and time spent).
- **Kanban sub-filter**: a second query that hides finished work, for example released versions (Atlassian's migration tool drops these; verify semantics).

### 3.2 Sprint lifecycle

States future, active, closed. Operations: create; edit name, goal and dates; reorder future sprints; start; add or remove items while active (logged as scope change); complete; reopen; delete (including completed sprints); link a wiki page. Completing needs the Manage sprints permission and offers to move unfinished items to the backlog, a future sprint or a new sprint. "Done" means in the board's rightmost column; completion is blocked while done items have unfinished subtasks (verify exact rule). Several sprints may be active at once (parallel sprints). A sprint shared by several boards: the completing board carries over only its own unfinished items; other boards' unfinished items go to their backlogs.

### 3.3 Space view tabs

Summary, List, Board, Backlog, Timeline, Calendar, Reports, Forms, Approvals, Development, Releases, Components, Capacity. Space admins reorder and hide tabs.

## 4. AGL requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| AGL-001 | **Boards on filters.** Tracksmith shall create Scrum and Kanban boards on a saved filter covering one or more spaces, with board admins and a location. | (1) A board on a filter spanning 3 spaces shows items from all 3. (2) Only board admins or space admins of the location can change configuration. | M1 | M | Jira Free |
| AGL-002 | **Columns and status mapping.** Tracksmith shall implement the column options of section 3.1. | (1) Two statuses mapped to one column both show there. (2) An item in an unmapped status is listed in the unmapped panel count. (3) Dragging between columns runs the matching transition, asking which one when several exist. | M1 | M | Jira Free |
| AGL-003 | **WIP limits.** Tracksmith shall show min and max limits per column and signal breaches. | (1) With max 3 and 4 cards the header is red; with min 2 and 1 card it is yellow. (2) Cards hidden by a quick filter still count. | M1 | M | Jira Free |
| AGL-004 | **Swimlanes.** Tracksmith shall implement every swimlane mode of section 3.1. | (1) A query lane catches matching items before the catch-all. (2) The catch-all lane cannot be deleted. (3) Story mode groups subtasks under their parent. | M1 | M | Jira Free |
| AGL-005 | **Quick filters.** Tracksmith shall provide query-defined quick filters with the two defaults, ordering and button or dropdown display. | (1) Activating two filters shows only items matching both. (2) Filters import from Jira boards with translated queries. | M1 | M | Jira Free |
| AGL-006 | **Card layout.** Tracksmith shall implement card colour rules, up to 10 extra fields, days in column, covers and development icons. | (1) The first matching colour rule wins. (2) Days in column resets when the card changes column. | M1 | M | Jira Free; exceeds Jira (3 fields) |
| AGL-007 | **Estimation and tracking.** Tracksmith shall let each Scrum board choose its estimation statistic and time tracking mode, and space-local spaces toggle estimation. | (1) Switching from story points to time estimate changes card badges and sprint totals. (2) With remaining-estimate tracking, logging work lowers the sprint's remaining total. | M1 | M | Jira Free |
| AGL-008 | **Backlog.** Tracksmith shall provide a ranked backlog with sprint sections, inline create, drag and drop, multi-select, a parent (epic) panel with drag-to-parent and a version panel with drag-to-version. | (1) Dragging 50 selected items into a sprint updates all 50 in one operation. (2) Dropping an item on an epic in the panel sets its parent. | M1 | M | Jira Free |
| AGL-009 | **Global rank.** Tracksmith shall keep one global rank order usable by all boards and backlogs, with move to top and bottom, rank via API, and rank preserved on import. | (1) Ranking on one board is reflected on another board sharing the items. (2) 1,000 consecutive rank moves never need a full rebalance visible to users. (3) Imported Jira rank order is reproduced exactly. | M1 | M | Jira Free |
| AGL-010 | **Sprint lifecycle.** Tracksmith shall implement the sprint states and operations of section 3.2. | (1) Completing a sprint offers backlog, future sprint or new sprint for unfinished items. (2) Items added after start are marked as scope change in reports. (3) A deleted completed sprint disappears from reports and its items keep their history. | M1 | M | Jira Free |
| AGL-011 | **Parallel and shared sprints.** Tracksmith shall allow several active sprints per board and sprints shared across boards, and shall compute velocity per team. | (1) Two active sprints run on one board, each with its own section. (2) Completing a shared sprint carries over only the completing board's items. (3) Velocity can be shown per team (exceeds Jira, whose velocity chart is not per team in parallel sprints). | M1 | M | Jira Free; exceeds Jira |
| AGL-012 | **Auto-rolling cycles.** Tracksmith shall optionally create sprints on a cadence and roll unfinished items into the next one automatically. | (1) With a 2-week cadence, the next sprint exists and starts when the current one ends, and unfinished items move into it. | M1 | S | Linear |
| AGL-013 | **Board scale.** Tracksmith shall render every item matched by the board filter, without a 5,000-item cap, using virtualised rendering. | (1) A 5,000-card board renders in under 1 s (NFR-001). (2) A 50,000-item multi-space board loads and scrolls without errors. | M1 | M | exceeds Jira (5,000 cap on multi-space boards) |
| AGL-014 | **Kanban backlog and sub-filter.** Tracksmith shall offer an optional Kanban backlog per board and a sub-filter that hides finished work. | (1) With the Kanban backlog on, the first column moves to the backlog view. (2) Released items disappear from the board when the sub-filter says so. | M1 | M | Jira Free |
| AGL-015 | **Timeline.** Tracksmith shall show a Gantt timeline of one space with parent-child nesting; parent dates set manually or rolled up from children; Scrum children dated by sprint or start/due; dependency lines from links; zoom by weeks, months and quarters; sprint and release markers; drag to reschedule; side-panel editing; progress roll-up. | (1) A parent's rolled-up bar spans its earliest child start to latest child due. (2) Dragging a bar updates start and due dates. (3) Roll-ups stay on for spaces with over 10,000 items. | M1 | M | Jira Free; exceeds Jira (roll-ups disabled above 10,000) |
| AGL-016 | **List view and format rules.** Tracksmith shall provide a spreadsheet-like list with inline create and edit, sort, filter, group, rank, selectable columns and conditional format rules for cells and rows. | (1) A rule "due < now() and status category != Done" colours overdue rows red. (2) Grouping by assignee shows counts per group. (3) 10,000 rows scroll without blank frames. | M1 | M | Jira Free |
| AGL-017 | **Calendar view.** Tracksmith shall show items by start and due date, show sprints and releases (business calendars may show software release dates), support drag to reschedule, and publish a read-only iCal feed per saved view. | (1) Dragging an item to another day changes its due date. (2) An iCal client subscribed to a view shows the same items. | M1 | M | Jira Free; Vikunja (CalDAV-style feed) |
| AGL-018 | **Navigation and command palette.** Tracksmith shall provide a sidebar (For you, recent, starred, spaces, dashboards, filters; personal customisation), reorderable space tabs (section 3.3), a Ctrl/Cmd+K command palette reaching every action, `/` quick search, and documented keyboard shortcuts. | (1) Every action in the item view menu is reachable from the palette. (2) Shortcuts work for create, assign, watch (W), comment (M) and transition. (3) Space admins reorder and hide tabs. | M1 | M | Jira Free; Linear |
| AGL-019 | **For you page.** Tracksmith shall show assigned, starred, worked-on and viewed items and a recommended list (due soon, mentions, comments on your items, approvals waiting, review requests). | (1) A new mention appears in Recommended within 5 s. (2) Each tab is filterable by space. | M1 | M | Jira Free |
| AGL-020 | **Saved views.** Tracksmith shall save list, board, calendar and timeline configurations (query, grouping, columns, sort) as personal or shared views. | (1) A shared view opens identically for another user with access. | M1 | S | Plane |
| AGL-021 | **Natural-language quick add.** Tracksmith shall parse quick-add text for assignee, priority, labels, due date and space. | (1) "Fix login @alice !high #bug due friday" creates an item with those values. | M2 | S | Vikunja |
| AGL-022 | **Stale item auto-close.** Tracksmith shall optionally close or archive items untouched for a configured period, with a warning first. | (1) Items idle 90 days get a warning comment, then close 14 days later unless touched. | M2 | S | Fizzy |
| AGL-023 | **Story maps and retrospectives.** Tracksmith shall provide a story map view (activities by parent, items by release) and retrospective boards that create action items. | (1) Dragging a card between release rows changes its fix version. (2) A retro action item becomes a work item linked to the sprint. | M4 | C | Easy Agile TeamRhythm app |
