---
spec: 01a
title: "Core work tracking: tickets, fields and workflows"
sources: docs/research/sources.md
accessed: 2026-10-11
attestation: own-words
---
# 01a Core work tracking: tickets, fields and workflows

This file specifies the ticket core of Taskmoor: tracks, ticket types and hierarchy, system and custom fields, configuration modes and configuration sets, releases, areas, links, comments, attachments, history, archiving and the workflow engine (statuses, transitions, guards, checks, effects and approvals). Everything else in the product (boards, queries, service desk, plans, automation) builds on these objects, so the catalogs below are also the contract the importer (file 02a) maps Jira data into. Files 01b and 01c continue the core with search, agile views, reports and collaboration.

## How to read

- **ID**: `MODULE-NNN` (for example CORE-012). IDs are stable and never reused. This file holds CORE and WF.
- **MS** (milestone): M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must (required for parity or for the milestone), S = Should, C = Could.
- **Source**: the product or tier whose behaviour is the parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit or pain point. "verify" marks a fact the research flagged as unconfirmed; check it against real Jira data before relying on it.
- **Terms**: Taskmoor uses its own names, defined in `docs/specs/00-terminology.md`. The main ones: ticket = Jira issue, track = Jira project, ticket type = Jira issue type. Jira's names stay valid in the Jira-compatible API and query dialect.
- Acceptance criteria are numbered (1), (2), (3); each must become at least one automated test.

## 1. Reference: domain model

### 1.1 Track types and configuration modes

- **Track types**: business (list, board, calendar, timeline, forms, approvals, summary), software (adds Scrum/Kanban boards, backlog, sprints, releases, development data), service (adds service-desk features, file 04a) and discovery (ideas, file 03). One ticket engine serves all four; a type is a preset of feature toggles.
- **Shared mode** (Jira "company-managed"): configuration objects (type sets, field rule sets, layouts, workflows, access, notification and visibility policies) live at site level and are reused by many tracks. Only site admins and configuration admins edit them.
- **Local mode** (Jira "team-managed"): the track owns its fields, ticket types and workflows; the track admin edits them; nothing leaks to other tracks. Jira caps team-managed projects at 50 custom fields and 55 options per select; Taskmoor has no such caps.
- **Templates**: software (Kanban, Scrum, Bug tracking), business (marketing, HR, legal, operations, procurement, recruiting, lead tracking; verify the current Jira business catalog), service (file 04a), discovery (file 03), plus admin-made custom templates (CORE-004).

### 1.2 Hierarchy rules

1. Levels are integers. Defaults: level 1 "Outcome", level 0 standard types (Feature, Bug, Chore; To-do in business tracks), level -1 "Subticket". Admins may rename levels.
2. Admins may add any number of levels above 1 (for example 2 "Objective", 3 "Strategy") and assign several ticket types to one level. Jira restricts both to Premium/Enterprise; here they are free.
3. One `Parent` field links a ticket to its parent for every level. Legacy Epic Link and Parent Link values import into it.
4. A parent must sit at a higher level; by default exactly one level higher. A per-site option may allow skipping levels (verify Jira's rule against import data).
5. Parents may be in another track when the user can browse both tracks.
6. A subticket always has a parent, moves with it, cannot be archived alone, and is archived when its parent is.
7. Removing a level moves its ticket types to level 0. Links that become invalid are listed before the change and restorable afterwards (CORE-007).
8. The query field `hierarchyLevel` accepts every level, including custom ones.

### 1.3 System fields

| Group | Fields |
|---|---|
| Identity | Key, Track, Track category, Track type, Ticket type, Hierarchy level, Parent |
| Content | Summary (required, max 255 chars), Description (rich text), Environment (rich text), Labels, Areas, Attachments, Comments, Ticket links, Web links |
| Workflow | Status, Stage, Close reason, Closed (timestamp), Priority, Visibility level |
| People | Assignee, Requester, Creator, Followers, Voters, Participants (read-only), Team |
| Dates | Created, Updated, Start date, Due date, Last viewed, Date of first response (read-only) |
| Agile and planning | Sprint, Points, Rank, Target releases, Found in releases, Goals, Development (read-only summary) |
| Time | Original estimate, Remaining estimate, Time spent, Effort ratio (time spent / original estimate x 100), Time entries (file 03, TIM) |
| Service (file 04a) | Request form, Request participants, Customer groups, Request channel, SLA fields, Approvals, Satisfaction |
| Derived, read-only | Time in status, Days since last comment, Votes count, Followers count |

### 1.4 Custom field types

| Type | Rules | Source |
|---|---|---|
| Short text | Single line, max 255 characters | Jira Free |
| Paragraph | Rich text; default value may contain checklists and decisions; at least 32,767 chars, admin limit up to 100,000 | Jira Free |
| Number | Formats number, currency, percentage; configurable decimals; range -10^12 to +10^12; values rounded to 0.001; scientific notation accepted (5e3) | Jira Free |
| Date, Date time, Time stamp | Date only; date and time with user time zone; time stamp read-only on set | Jira Free |
| Select (single), Dropdown, Radio buttons | Ordered options; options can be disabled; default guardrail 20,000 options | Jira Free |
| Select (multiple), Checkboxes | As above, many values | Jira Free |
| Cascading select | Parent option with child options; searched with `cascadeOption()` | Jira Free |
| User picker (single, multi), People | Context can restrict choices to a group or track role; naming a person in a People field does not notify them | Jira Free |
| Group picker (single, multi) | Site groups | Jira Free |
| Release picker (single, multi) | Releases of the ticket's track | Jira Free |
| Track picker | Jira "project picker" (2025: "space picker") | Jira Free (verify name) |
| Labels | Separate label vocabulary per field | Jira Free |
| URL; Read-only text | Validated URL; text writable only by API or automation | verify (not on the Jira page captured) |
| Formula | Output number, currency, percentage, date, duration or text (CORE-011) | Jira Free |
| Time tracking | Estimate and spent block for local-mode tracks | Jira Free |
| Read-only info | Date of first response, Days since last comment, Participants, Time in status (CORE-012) | Jira Free |
| Team, Goals | References to site teams (CORE-027) and goals (file 03, PRT) | Jira Free |
| Inventory object | References CMDB objects, file 04b | JSM |
| Discovery types | Rating, slider, votes, evidence count, delivery progress and status, date interval, roll-up and weighted-score formulas (file 03, DSC) | JPD |
| Checklist | Ordered checklist items with done state, counted in queries | Smart Checklist app; exceeds Jira |
| Extension types | Any type registered by an extension (file 02b, EXT) | Forge custom field type |

A field's type cannot change after creation; changing type means creating a new field and migrating values with bulk edit.

### 1.5 Configuration sets and the target configuration model

| Jira object | Purpose | Target object in Taskmoor |
|---|---|---|
| Work type scheme | Types available in a track, default type, order | Type set |
| Field configuration + field configuration scheme | Required, hidden, help text and renderer per field and ticket type | Field rule set (one object, as in Jira's 2026 "field schemes") |
| Screen, screen scheme, work type screen scheme | Which fields appear on create, edit, view and transition | Layout set (per ticket type and operation, with tabs) |
| Workflow scheme | Workflow per ticket type | Workflow map |
| Permission scheme | Who can do what in a track | Access policy (file 05a) |
| Notification scheme | Who is told about which event | Notification policy (file 01c) |
| Work item security scheme | Ticket-level visibility levels | Visibility policy (file 05a) |
| Priority scheme | Priorities available per track | Priority set |
| Custom field context | Field scope, options and default per track and type | Field context |

Rules: every target object is either shared (site level) or owned by one track. The importer maps Jira schemes one to one, then merges objects with identical content (hash comparison) and reports each merge. Every shared object shows "used by N tracks" and the list.

### 1.6 Defaults shipped on a fresh install

- Stages: new (grey), active (blue), closed (green).
- Statuses: Open, New, Backlog, Selected for Development, Active, In Review, Under review, Approved, Rejected, Cancelled, Draft, Published, Closed.
- Priorities: Urgent, High, Normal, Low, Very low; a ticket always has one, and only an import can leave it empty. Close reasons: Completed, Not planned, Duplicate, Not reproducible (service tracks add Known error and others).
- Link types: Relates, Duplicates, Blocks, Copies (verify Jira's full default set).
- Default workflow: statuses New, Active, In Review and Closed, initial status New, one global transition into each status, named after it. No fields, guards or checks. Entering Closed sets close reason Completed; entering any other status clears the close reason. Why a ticket moved goes in a comment. Administrators may add rules to it or use a stricter workflow; imported workflows keep their source's rules.

### 1.7 Configuration guardrails (defaults, admin-adjustable)

Fields per track 700; ticket types per track 150; options per field 20,000; visibility levels per track 50; grants per permission 50; releases per track 15,000 (archived excluded); workflows per workflow map 150; statuses per workflow 200; areas per track 10,000; priorities per track 100. These match Jira Cloud's 2026 enforced values; here they are defaults an admin can raise (CORE-026).

## 2. CORE requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| CORE-001 | **Tracks and keys.** Taskmoor shall let authorised users create tracks with a unique key, name, owner, category, avatar and description, and shall number tickets KEY-n in sequence per track. | (1) The first ticket in new track ABC is ABC-1 and 100 concurrent creates yield ABC-2..ABC-101 with no duplicates. (2) After the key is renamed to XYZ, old keys such as ABC-7 still resolve and redirect. (3) Key validation accepts every key format found in imported Jira data. | M1 | M | Jira Free |
| CORE-002 | **Track types, templates and feature toggles.** Taskmoor shall provide the four track types and templates of section 1.1, and per-track feature toggles (board, backlog, sprints, releases, development, forms, approvals, calendar, timeline) that a track admin can change at any time. | (1) Kanban, Scrum and Bug tracking templates each create a working board. (2) Turning a feature off hides its tab and API resources without deleting data; turning it on restores them. (3) Toggles work in both configuration modes. | M1 | M | Jira Free; exceeds Jira (Jira locks company-managed spaces to template features) |
| CORE-003 | **Configuration modes.** Taskmoor shall support shared mode and local mode (section 1.1) on one data model, query engine and API. | (1) Editing a local field in track A has no effect on track B. (2) Saving a shared field rule set lists every affected track before commit and applies to all of them. (3) A local-mode track accepts 51 and more custom fields and selects with more than 55 options. | M1 | M | Jira Free; exceeds Jira (50-field cap) |
| CORE-004 | **Custom track templates.** Taskmoor shall let admins save a track's configuration, optionally with sample tickets, as a template and create tracks from it. | (1) A track created from a template has the same ticket types, fields, workflows, boards, automation rules and access policy. (2) Templates export to a file and import into another instance. | M2 | M | Jira Enterprise |
| CORE-005 | **Ticket types.** Taskmoor shall let admins define ticket types (name, icon, description, hierarchy level) and assign them to tracks through type sets with a default and an order. | (1) The create dialog shows only the track's types, in set order, with the default preselected. (2) Removing a type that is in use requires mapping its tickets to another type first. | M1 | M | Jira Free |
| CORE-006 | **Hierarchy levels.** Taskmoor shall implement the hierarchy rules of section 1.2, including unlimited custom levels and several types per level, for all users at no extra tier. | (1) An admin adds levels 2 and 3; a level-3 ticket can parent level-2 tickets in other tracks. (2) `hierarchyLevel = 2` returns those tickets. (3) Imported Epic Link and Parent Link values appear in Parent. | M1 | M | Jira Premium; exceeds Jira (query field ignores custom levels) |
| CORE-007 | **Safe hierarchy changes.** Taskmoor shall preview the impact of hierarchy changes and allow rollback. | (1) Before a level is removed the admin sees the number of parent links that would break and the types that fall to level 0. (2) A hierarchy change can be rolled back for at least 30 days, restoring the broken links. | M1 | S | exceeds Jira (change cannot be undone) |
| CORE-008 | **Create, view and edit.** Taskmoor shall support creation from a full dialog, inline in list, board and backlog, and via API; viewing as full page, side panel and modal; inline editing with optimistic save; and per-type field layouts with main, context and "hide when empty" sections. | (1) An inline-created ticket shows before server confirmation and is removed with an error message if the server rejects it. (2) A track admin's layout change is visible on the next open. (3) Missing required fields block creation with field-level messages in UI and REST. | M1 | M | Jira Free |
| CORE-009 | **Field contexts and options.** Taskmoor shall give each custom field one or more contexts, each scoped to tracks and ticket types with its own options and default value. | (1) One field offers options {A, B} in track X and {C} in track Y. (2) A user picker restricted to group G offers only members of G. (3) Options can be reordered, disabled (kept on existing tickets, hidden for new values) and renamed without changing stored option ids. | M1 | M | Jira Free |
| CORE-010 | **Custom field type catalog.** Taskmoor shall implement every type in section 1.4 with validation, query operators, sorting and REST representation. | (1) A number field rejects 2e12, stores 1.23456 as 1.235 and accepts "5e3" as 5000. (2) Short text rejects 256 characters. (3) Each type round-trips through REST, CSV export and import, and the Jira importer without loss. | M1 | M | Jira Free |
| CORE-011 | **Formula fields.** Taskmoor shall compute formula fields from other fields using arithmetic, average, max, min, power, abs, rounding, working days until due, and conditional text output. | (1) `{Points} * 2` updates within 1 s after points change and after bulk edits. (2) Working-days-until-due uses the site working-week setting and can output "Overdue". (3) Invalid formulas are rejected at save time with the error position. | M1 | M | Jira Free |
| CORE-012 | **Read-only info fields.** Taskmoor shall compute Date of first response, Days since last comment, Participants and Time in status from history. | (1) Time in status equals the sum of status intervals in the change history. (2) Days since last comment is searchable and sortable. | M1 | M | Jira Free; exceeds Jira (not searchable in Jira) |
| CORE-013 | **Field rules and layouts.** Taskmoor shall implement unified field rule sets and layout sets (section 1.5) for create, edit, view and transition operations, with tabs. | (1) A field required for Bug and optional for Chore is enforced only on Bugs, in UI and REST. (2) A hidden field is not displayed and is rejected on write, while stored values are kept. (3) Imported Jira field configurations, screens and screen schemes produce equivalent field rule sets and layout sets, reported per track. | M1 | M | Jira Free (2026 field schemes) |
| CORE-014 | **Statuses, priorities and close reasons.** Taskmoor shall manage site lists of statuses (with stage), priorities (with priority sets per track) and close reasons, with icons, colours and order, shipping the defaults of section 1.6. | (1) A fresh install contains the default values. (2) A track using priority set {P1, P2} offers only those. (3) Deleting a value in use requires choosing a replacement. | M1 | M | Jira Free |
| CORE-015 | **Areas.** Taskmoor shall provide per-track areas with description, owner and a default-assignee rule (area owner, track owner, unassigned). | (1) A ticket created with area C and no assignee is assigned to C's owner when the rule says so. (2) Areas can be archived and are queryable with `area` and `areasOwnedByUser()`. | M1 | M | Jira Free |
| CORE-016 | **Releases and shipping.** Taskmoor shall provide releases with name, description, start and release dates, manual order, shipped and archived flags; Target release, Found in release and single-release fields; ship, unship, merge and archive; and a release page with progress, warnings and release approvers. | (1) Shipping a release with open tickets prompts to move them to another release. (2) With "require approvals" on, shipping is blocked until every approver approves; declines are recorded. (3) Reordering releases changes the result of `latestShippedRelease()`. | M1 | M | Jira Free |
| CORE-017 | **Labels.** Taskmoor shall support free-form labels with site-wide autocomplete, and admin rename and merge of labels. | (1) Typing "fro" suggests the existing label "frontend". (2) Merging "front-end" into "frontend" updates every ticket and records the change in history. | M1 | M | Jira Free |
| CORE-018 | **Ticket links and web links.** Taskmoor shall support link types with name and outward and inward descriptions, admin create, edit and delete with remapping, a site-wide on/off switch, a copy link type, and web links carrying a global id, title, URL and icon. | (1) Deleting link type "Causes" asks for a replacement and remaps all its links. (2) A Blocks link reads "blocks" on one ticket and "blocked by" on the other. (3) A web link is found by `ticketsWithWebLinksByGlobalId()`. | M1 | M | Jira Free |
| CORE-019 | **Followers and votes.** Taskmoor shall let users follow and vote on tickets, auto-follow on comment or edit as a personal setting, and gate follower and voter lists by permission. | (1) Pressing W toggles following. (2) Seeing the lists requires View voters and followers; changing others' follow state requires Manage followers. (3) No cap on followers or voters per ticket. | M1 | M | Jira Free |
| CORE-020 | **Comments.** Taskmoor shall support rich-text comments with mentions, reactions, permalinks, edit and delete governed by own/all permissions, and visibility restricted to a role or group. | (1) A comment restricted to role Developers is invisible to others in UI, API, search, notifications and export. (2) Reactions can be added and removed and show counts. (3) Editing a comment marks it edited and keeps prior versions for admins. | M1 | M | Jira Free |
| CORE-021 | **Attachments.** Taskmoor shall support upload by drag, paste and API; previews for images, PDF, video and text; browsing and downloading ZIP contents; download-all as ZIP; an admin-set maximum file size (default 1 GB, no fixed ceiling); local or S3-compatible storage; and storage quotas that a new workspace starts with at 1 TiB in all and 20 GiB a person, and that a site administrator changes or removes (ADR-110; an upgraded install starts without them). | (1) With a 3 GB limit a 2.5 GB file uploads; with a 1 GB limit it is rejected with a clear message. (2) S3 objects are served only through short-lived signed URLs to users who can browse the ticket. (3) Deletion follows delete own/all attachment permissions. | M1 | M | Jira Premium (unlimited storage); exceeds Jira (2 GB file cap) |
| CORE-022 | **Change history and activity.** Taskmoor shall record every field change, transition, link, attachment, time entry and comment action with actor, time, old and new values (ids and display names), and show an activity feed filterable by Comments, History, Time entries and All. | (1) History is complete after a 1,000-step scripted edit sequence. (2) A ticket with 50,000 history entries renders each page of the activity feed within 500 ms. (3) History is never truncated or aged out. | M1 | M | Jira Free; exceeds Jira (10,000-change window, DC 20,000 guardrail) |
| CORE-023 | **Clone, deep clone and move.** Taskmoor shall clone tickets with options, deep-clone a parent with all descendants, and move tickets between tracks and ticket types through a status and field mapping wizard. | (1) A clone with subtickets, attachments and links creates a Copies link to the source. (2) A deep clone copies an outcome and 3 levels of descendants into another track. (3) A moved ticket keeps its history and its old key keeps resolving. | M1 | M | Jira Free; Deep Clone app |
| CORE-024 | **Bulk operations.** Taskmoor shall run bulk edit, transition, move, delete, archive, assign, comment and follow as background jobs with progress, cancel and a per-ticket result report, for users with Make bulk changes. | (1) A bulk transition of 20,000 tickets finishes as one job; tickets failing a check are listed and the rest succeed. (2) There is no fixed 1,000-ticket cap. (3) Bulk delete sends tickets to trash (CORE-025). | M1 | M | Jira Free; exceeds Jira |
| CORE-025 | **Archive, trash and restore.** Taskmoor shall archive tickets (read-only, subtickets follow the parent, restore singly or in bulk) and tracks (tickets, areas, attachments, releases), and shall soft-delete tickets to a trash with admin-set retention. | (1) An archived ticket opens read-only by link and is absent from search and boards. (2) A subticket cannot be archived alone; archiving its parent archives it. (3) A deleted ticket restores with history, links and attachments within retention (default 30 days). | M1 | M | Jira Premium (space archiving); exceeds Jira (no undo for deletions) |
| CORE-026 | **Configuration guardrails.** Taskmoor shall enforce the limits of section 1.7 as admin-adjustable guardrails and display usage against each limit. | (1) The admin page shows usage and limit for every guardrail. (2) An addition beyond a limit is rejected; a bulk action that would exceed it is rejected entirely; existing configuration is untouched. (3) Raising a limit takes effect immediately and shows performance guidance. | M1 | M | Jira Free (2026 limits); exceeds Jira (limits fixed) |
| CORE-027 | **Teams.** Taskmoor shall provide site-wide teams with members, lead and description, a Team field, and team references usable by boards, plans, on-call and ownership. | (1) `membersOf("id:<teamId>")` returns the team's members. (2) Renaming a team updates every reference. | M1 | M | Jira Free (Atlassian Teams) |
| CORE-028 | **Work intake forms.** Taskmoor shall let track admins build any number of forms (sharing the forms engine of SD-013) whose submission creates a ticket of a chosen non-subticket type, with conditional fields and optional public access. | (1) A submission creates a ticket labelled "Form" and "Form-<id>". (2) If the submitter lacks Create permission the track owner is recorded as creator and the submitter's identity is kept on the ticket. (3) Public forms work without sign-in and are rate-limited per IP. | M2 | M | Jira Free |
| CORE-029 | **Ticket templates.** Taskmoor shall let people keep named templates that start a new ticket: a purpose, the ticket types they fit (none for every type), a summary pattern with `{date}`, `{track}` and `{user}`, a description outline, default values (priority, labels, assignee, areas, releases, custom fields, and start and due dates as days from today) and up to 50 subtickets. A template belongs to one track or to every track. Names are unique within that scope, ignoring case; areas and releases need a track template. | (1) A track's templates are read by those who browse the track and changed by its administrators and by configuration administrators; others are refused. (2) Templates for every track are offered in every track, seen by everyone signed in and changed by configuration administrators only. (3) A template limited to ticket types is offered for those types only. | M1 | M | User requirement |
| CORE-030 | **Creating a ticket from a template.** Taskmoor shall create a ticket from a template through the ticket create path, as the person creating it, so every permission, field rule, lock and default applies. The person's values win over the template's; a value they clear is left out. Each subticket is its own create under the new ticket, and one that fails is reported while the ticket stays. | (1) The ticket takes the template's values, with the person's edits winning, and its subtickets are made. (2) A template value the person may not set is left out and reported; the same value given by the person is refused. (3) A template value a field rule hides is left out and reported; the person's own is refused. (4) A template of one track makes no ticket in another. | M1 | M | User requirement |
| CORE-031 | **Links from the ticket page.** On every ticket type, a person with "Link tickets" shall add several links from the ticket's page, each with a category read from the site's link types (each side of a type is a category), and remove them. A picker finds tickets of the same track as the person types a number or a name, debounced and through the search route, and walks by keyboard. Links show grouped by what they read from this side, whichever side made them. The API still links across tracks. | (1) Typing `retry` or `40` lists matching tickets of the track, never another track's or one the person may not see. (2) Two links in a row need no reload. (3) A link to another track, made by an import or the API, shows and can be removed. (4) Down, Up, Enter and Escape work the list. | M1 | M | User requirement (2026-11-03) |
| CORE-032 | **Subtickets on the ticket page.** Taskmoor shall show a ticket's subtickets on its page with each one's status, add one inline from a summary (then stay or open it), and show how many are in a closed stage as a percentage, a bar and the numbers in text; board cards and the list view show the same small progress when a ticket has subtickets. Counts cover what the person may see. A subticket is a ticket: it follows the track's workflow, and has no subtickets of its own. On a ticket above the standard level the same section holds the tickets one level down. | (1) One of two subtickets closed reads "1 of 2 closed" and 50%. (2) A subticket shows no such section. (3) A hidden subticket counts for nobody who cannot see it. | M1 | M | User requirement (2026-11-03) |
| CORE-033 | **Checklists.** Every ticket type shall hold any number of named checklists, separate from the description, each with items of plain text in one of four states: open, in progress, done or rejected. Checking an item makes it done and unchecking it makes it open. Each checklist and the ticket overall show a completion percentage in which a rejected item is left out of the count. Items are added, edited, reordered (with a keyboard path) and removed. Changes need "Edit tickets", appear in the ticket's history, emit one event each and reach open pages; checklists travel in export and import, clone (items restart as open), the trash and personal data. | (1) 3 done, 1 open and 1 rejected reads 75% (the user's decision, 2026-11-03). (2) Someone without "Edit tickets" reads but cannot change. (3) A clone has the checklists with every item open. (4) Export then import gives back the same checklists. | M1 | M | User requirement (2026-11-03) |
| CORE-034 | **Personal track groups.** Each person shall arrange the Tracks page in named groups of tracks that are theirs alone until shared: made by dragging one track onto another and naming the group, renamed, deleted, put in order, minimized and opened, with tracks moved in, out, between groups and within one. A track sits in at most one of a person's groups, and a group shows only the tracks its viewer may see. An open group is a glass bubble holding its tracks; a minimized one takes the place of one track card with its name, a count and a small glass square per track. Every drag works by mouse and by touch and has a keyboard path, and the arrangement is kept on the server per person. | (1) Two tracks dragged together and named make a group only its owner sees. (2) A track moved into another group leaves the first. (3) The order and which groups are minimized are the same after signing in on another device. (4) Each move is possible from the keyboard alone. (5) A track the person cannot see is never shown in a group. | M1 | M | User requirement (2026-11-03) |

## 3. Reference: workflow catalog

### 3.1 Transition anatomy

Each transition has an id, name, source statuses (a list, or "any status" for a global transition), target status, optional layout (Jira: screen), guard tree, list of checks, list of effects, triggers, properties (key-value pairs), display order and the event it fires. Each workflow has one initial status.

### 3.2 Guards (all M1 except approval)

| Guard | Behaviour |
|---|---|
| Always false | Transition is never offered (used to retire a transition) |
| Block until approval | Unavailable while an approval on the status is pending (M2, WF-013) |
| Compare number field | Number field compared with a constant using =, !=, >, >=, <, <= |
| Hide from user | Not offered in UI; callable only by automation, effects and REST |
| Only assignee / Only requester | Current user is the assignee / the requester |
| Permission | Current user holds a named track permission |
| Previous status | Ticket has been in status X, optionally only as the most recent status |
| Separation of duties | User who performed transition A on this ticket cannot perform this one |
| Subticket blocking | All subtickets are in one of the listed statuses |
| User in group / in any group | Current user belongs to the group / to one of the groups |
| User in track role / in any track role | Current user holds the role / one of the roles in this track |
| User in custom field | Current user is a value of a user field |
| User in group custom field | Current user belongs to a group stored in a group field |
| Value field | A field compared with a value |

Guards nest in all/any groups to any depth. A failed guard hides the transition and the REST call returns an error naming the guard.

### 3.3 Checks

Field required; Field has been modified; Field has single value; Date compare (two date fields with an operator, optionally including time); Date window (a date within N days of another); Regular expression check; Forms attached; Forms submitted (with forms, M2); Parent status (parent in one of the listed statuses); Permission; Previous state. Jira's sunsetted "User permission validator" imports as Permission. A failed check blocks the transition, runs no effect and changes nothing.

### 3.4 Effects

- **Essential, fixed order, not removable**: (1) set status, (2) add the comment if entered, (3) update change history and store the ticket, (4) update the search index, (5) fire the transition's event (generic or custom). Notifications are sent only after the whole sequence completes.
- **Optional**: assign to current user; assign to owner (area owner, else track owner); assign to requester; clear field value; copy value from another field (including parent to subticket); set visibility level from the user's track role; trigger webhook; update a custom field; update a system field (assignee, description, environment, priority, close reason, summary, original or remaining estimate); create Perforce job (C; imported as a webhook placeholder).

### 3.5 Local-mode workflow rules

Assign a ticket to someone; restrict to when a field has a specific value; restrict to when the ticket has been through a status (options: include current status, reverse, most recent only, ignore looped transitions); restrict who can move the ticket; validate that people hold a permission; copy one field's value to another; update a field.

### 3.6 Board-managed (simplified) workflow

Statuses are the board's columns and are managed by the board admin; any card can move to any column; there are no transition layouts; the rightmost column sets close reason Completed and leaving it clears the close reason. Scrum default columns: New, Active, Closed. Kanban default columns: Backlog, Selected for Development, Active, Closed.

## 4. WF requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| WF-001 | **Workflow model.** Taskmoor shall model statuses with stages, workflows with transitions from one, several or any status, an initial status, and workflow assignment through a workflow map per ticket type in shared mode or per track in local mode. | (1) A global "Cancel" transition is offered from every status. (2) A transition with two source statuses is offered from both. (3) Bug uses W1 and Chore uses W2 in the same track. | M1 | M | Jira Free |
| WF-002 | **Workflow editor.** Taskmoor shall offer diagram and text editing, editing of active workflows with an impact panel listing affected tracks and types, guided removal of statuses, publish or discard, version history with rollback, and a read-only view for users with View read-only workflow. | (1) Removing status QA with 120 tickets prompts for a target status and moves all 120 before publish. (2) A published change applies to the next transition with no downtime. (3) A previous version can be restored. | M1 | M | Jira Free (new editor); exceeds Jira (rollback) |
| WF-003 | **Guards.** Taskmoor shall implement every guard in section 3.2 with nested all/any groups. | (1) With Only assignee, a non-assignee does not see the transition and REST returns an error naming the guard. (2) The tree A and (B or C) passes tests for all 8 input combinations. (3) Hide-from-user transitions run only from automation, effects and REST. | M1 | M | Jira Free |
| WF-004 | **Checks.** Taskmoor shall implement every check in section 3.3 with configurable error messages. | (1) Field required blocks with a field-level message. (2) A regular expression check rejects non-matching values. (3) After any check failure the ticket, history and effects are untouched. | M1 | M | Jira Free |
| WF-005 | **Effects.** Taskmoor shall run the essential effects in fixed order and the optional ones of section 3.4, and send notifications after the sequence. | (1) A test asserts the essential order on every transition. (2) Copy-from-parent sets a subticket field from its parent. (3) The webhook effect also fires on the create transition. | M1 | M | Jira Free; exceeds Jira (create-transition webhook gap) |
| WF-006 | **Transition layouts, properties and events.** Taskmoor shall show an optional layout per transition, store transition properties, and fire generic or custom events selectable in notification policies. | (1) Fields entered on a transition layout save atomically with the transition and its comment. (2) Properties are readable through the API. (3) A custom event fired by a transition triggers the recipients configured for it. | M1 | M | Jira Free |
| WF-007 | **Per-status permissions.** Taskmoor shall restrict edit, comment, attach, assign and transition per status to named roles or groups. | (1) In status Approved only role Approvers can edit; others see read-only fields and REST returns 403. (2) The UI explains why a field is read-only. | M1 | M | Jira Free (workflow properties); Linear lacks it |
| WF-008 | **Close reasons and stages.** Taskmoor shall set and clear the close reason via transitions and layouts, set the Closed time stamp when a close reason is set, and drive colours and reports from stages. | (1) Moving to status Closed with a close reason sets the Closed time stamp; reopening clears both. (2) Boards, widgets and reports colour statuses by stage. (3) The default workflow asks for nothing: entering Closed sets close reason Completed and leaving it clears the reason (section 1.6); a transition asks for a close reason only when an administrator adds that. (4) A workflow an administrator starts, a status added to a workflow that moves freely, and sample data all move freely, until someone adds a rule on purpose; imported workflows keep their rules, and one published or imported with no transitions at all gets the moves a new workflow gets. | M1 | M | Jira Free |
| WF-009 | **Local-mode rules.** Taskmoor shall implement the seven rule types of section 3.5 for local-mode workflows. | (1) Each option of "has been through a status" is covered by a test. (2) Rules created in one track do not appear in another. | M1 | M | Jira Free |
| WF-010 | **Board-managed workflow.** Taskmoor shall implement the simplified workflow of section 3.6. | (1) Adding a column creates a status. (2) Any card can be dragged to any column. (3) The rightmost column sets close reason Completed and leaving it clears it. | M1 | M | Jira Free |
| WF-011 | **Workflow import, export and Jira function mapping.** Taskmoor shall export and import workflows in its own JSON format and import Jira workflow definitions, mapping each Jira condition, validator and post function by Jira class name to a guard, check or effect in this catalog. | (1) Export then import yields an identical workflow. (2) Unmapped Jira functions appear in the import report and become disabled placeholders that an admin can replace with a script (WF-014). | M1 | M | Jira Free |
| WF-012 | **Workflow lint.** Taskmoor shall warn about unreachable statuses, statuses with no exit outside the closed stage, statuses unmapped on boards using the workflow, and guards no user can satisfy. | (1) Each of the four defects produces a named warning in the editor and in the publish dialog. | M1 | S | exceeds Jira |
| WF-013 | **Approvals.** Taskmoor shall let admins add an approval step to any status, with approvers from users, groups, roles or user and group fields; quorum any, all, majority or N; decisions from email, inbox, ticket, approvals list ("pending your approval") and mobile; decision-driven transitions; reminders, timeout escalation and an audit trail. | (1) "All of CAB (5 people)" moves only after 5 approvals; one decline runs the decline transition. (2) Majority of 4 moves after 3 approvals. (3) Every decision records approver, time, comment and channel. | M2 | M | Jira Premium; quorum from change-management apps; exceeds Jira |
| WF-014 | **Extended and scripted workflow functions.** Taskmoor shall provide expression-based guards, checks and effects (field comparison, query match, state of linked or child tickets, create, link and transition related tickets, set fields by expression, send email) and script-backed ones running in the extension runtime (file 02b). | (1) An effect moves the parent to Closed when all children are Closed, without automation rules. (2) A script check that exceeds its time limit fails closed with a message. | M2 | M | JMWE, JSU and ScriptRunner apps |
| WF-015 | **Development-event triggers.** Taskmoor shall transition tickets automatically on development events linked by key: branch created, commit created, pull request created, merged or declined, review state changes, build and deployment status. | (1) A merged pull request whose title holds PROJ-12 moves PROJ-12 through the configured transition. (2) Triggers skip guards only when the admin opts in, and every run is logged. | M2 | M | Jira Free (verify full trigger list) |
