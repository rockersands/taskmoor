# 01a Core work tracking: work items, fields and workflows

This file specifies the work-item core of Tracksmith (a working name for the product): spaces, work types and hierarchy, system and custom fields, configuration modes and schemes, versions, components, links, comments, attachments, history, archiving and the workflow engine (statuses, transitions, conditions, validators, post functions and approvals). Everything else in the product (boards, queries, service desk, plans, automation) builds on these objects, so the catalogs below are also the contract the importer (file 02a) maps Jira data into. Files 01b and 01c continue the core with search, agile views, reports and collaboration.

## How to read

- **ID**: `MODULE-NNN` (for example CORE-012). IDs are stable and never reused. This file holds CORE and WF.
- **MS** (milestone): M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must (required for parity or for the milestone), S = Should, C = Could.
- **Source**: the product or tier whose behaviour is the parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit or pain point. "verify" marks a fact the research flagged as unconfirmed; check it against real Jira data before relying on it.
- **Terms**: work item = Jira issue, space = Jira project, work type = Jira issue type. Legacy terms stay valid in the API shim and the query language.
- Acceptance criteria are numbered (1), (2), (3); each must become at least one automated test.

## 1. Reference: domain model

### 1.1 Space types and configuration modes

- **Space types**: business (list, board, calendar, timeline, forms, approvals, summary), software (adds Scrum/Kanban boards, backlog, sprints, releases, development data), service (adds service-desk features, file 04a) and discovery (ideas, file 03). One work-item engine serves all four; a type is a preset of feature toggles.
- **Shared mode** (Jira "company-managed"): configuration objects (work type sets, field schemes, layouts, workflows, permission, notification and security policies) live at site level and are reused by many spaces. Only site or product admins edit them.
- **Space-local mode** (Jira "team-managed"): the space owns its fields, work types and workflows; the space admin edits them; nothing leaks to other spaces. Jira caps these spaces at 50 custom fields and 55 options per select; Tracksmith has no such caps.
- **Templates**: software (Kanban, Scrum, Bug tracking), business (marketing, HR, legal, operations, procurement, recruiting, lead tracking; verify the current Jira business catalog), service (file 04a), discovery (file 03), plus admin-made custom templates (CORE-004).

### 1.2 Hierarchy rules

1. Levels are integers. Defaults: level 1 "Epic", level 0 standard types (Story, Task, Bug), level -1 "Subtask". Admins may rename levels.
2. Admins may add any number of levels above 1 (for example 2 "Initiative", 3 "Theme") and assign several work types to one level. Jira restricts both to Premium/Enterprise; here they are free.
3. One `Parent` field links an item to its parent for every level. Legacy Epic Link and Parent Link values import into it.
4. A parent must sit at a higher level; by default exactly one level higher. A per-site option may allow skipping levels (verify Jira's rule against import data).
5. Parents may be in another space when the user can browse both spaces.
6. A subtask always has a parent, moves with it, cannot be archived alone, and is archived when its parent is.
7. Removing a level moves its work types to level 0. Links that become invalid are listed before the change and restorable afterwards (CORE-007).
8. The query field `hierarchyLevel` accepts every level, including custom ones.

### 1.3 System fields

| Group | Fields |
|---|---|
| Identity | Key, Space, Space category, Space type, Work type, Hierarchy level, Parent |
| Content | Summary (required, max 255 chars), Description (rich text), Environment (rich text), Labels, Components, Attachments, Comments, Work item links, Remote links |
| Workflow | Status, Status category, Resolution, Resolved (timestamp), Priority, Security level |
| People | Assignee, Reporter, Creator, Watchers, Voters, Participants (read-only), Team |
| Dates | Created, Updated, Start date, Due date, Last viewed, Date of first response (read-only) |
| Agile and planning | Sprint, Story point estimate, Rank, Fix versions, Affects versions, Goals, Development (read-only summary) |
| Time | Original estimate, Remaining estimate, Time spent, Work ratio (time spent / original estimate x 100), Worklogs (file 03, TIM) |
| Service (file 04a) | Request type, Request participants, Organizations, Request channel type, SLA fields, Approvals, Satisfaction |
| Derived, read-only | Time in status, Days since last comment, Votes count, Watchers count |

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
| User picker (single, multi), People | Context can restrict choices to a group or space role; naming a person in a People field does not notify them | Jira Free |
| Group picker (single, multi) | Site groups | Jira Free |
| Version picker (single, multi) | Versions of the item's space | Jira Free |
| Space picker | Legacy "project picker" | Jira Free (verify name) |
| Labels | Separate label vocabulary per field | Jira Free |
| URL; Read-only text | Validated URL; text writable only by API or automation | verify (not on the Jira page captured) |
| Formula | Output number, currency, percentage, date, duration or text (CORE-011) | Jira Free |
| Time tracking | Estimate and spent block for space-local spaces | Jira Free |
| Read-only info | Date of first response, Days since last comment, Participants, Time in status (CORE-012) | Jira Free |
| Team, Goals | References to site teams (CORE-027) and goals (file 03, PRT) | Jira Free |
| Assets object | References CMDB objects, file 04b | JSM |
| Discovery types | Rating, slider, votes, insights count, delivery progress and status, date interval, roll-up and weighted-score formulas (file 03, DSC) | JPD |
| Checklist | Ordered checklist items with done state, counted in queries | Smart Checklist app; exceeds Jira |
| Extension types | Any type registered by an extension (file 02b, EXT) | Forge custom field type |

A field's type cannot change after creation; changing type means creating a new field and migrating values with bulk edit.

### 1.5 Schemes and the target configuration model

| Jira object | Purpose | Target object in Tracksmith |
|---|---|---|
| Work type scheme | Types available in a space, default type, order | Work type set |
| Field configuration + field configuration scheme | Required, hidden, help text and renderer per field and work type | Field scheme (one object, as in Jira's 2026 "field schemes") |
| Screen, screen scheme, work type screen scheme | Which fields appear on create, edit, view and transition | Layout set (per work type and operation, with tabs) |
| Workflow scheme | Workflow per work type | Workflow assignment |
| Permission scheme | Who can do what in a space | Permission policy (file 05a) |
| Notification scheme | Who is told about which event | Notification policy (file 01c) |
| Work item security scheme | Item-level visibility levels | Security level set (file 05a) |
| Priority scheme | Priorities available per space | Priority set |
| Custom field context | Field scope, options and default per space and type | Field context |

Rules: every target object is either shared (site level) or owned by one space. The importer maps Jira schemes one to one, then merges objects with identical content (hash comparison) and reports each merge. Every shared object shows "used by N spaces" and the list.

### 1.6 Defaults shipped on a fresh install

- Status categories: To Do (grey), In Progress (blue), Done (green).
- Statuses: Open, To Do, Backlog, Selected for Development, In Progress, In Review, Under review, Approved, Rejected, Cancelled, Draft, Published, Done.
- Priorities: Highest, High, Medium, Low, Lowest. Resolutions: Done, Won't do, Duplicate, Cannot reproduce (service spaces add Known error and others).
- Link types: Relates, Duplicates, Blocks, Clones (verify Jira's full default set).

### 1.7 Configuration guardrails (defaults, admin-adjustable)

Fields per space 700; work types per space 150; options per field 20,000; security levels per space 50; grants per permission 50; versions per space 15,000 (archived excluded); workflows per workflow assignment 150; statuses per workflow 200; components per space 10,000; priorities per space 100. These match Jira Cloud's 2026 enforced values; here they are defaults an admin can raise (CORE-026).

## 2. CORE requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| CORE-001 | **Spaces and keys.** Tracksmith shall let authorised users create spaces with a unique key, name, lead, category, avatar and description, and shall number work items KEY-n in sequence per space. | (1) The first item in new space ABC is ABC-1 and 100 concurrent creates yield ABC-2..ABC-101 with no duplicates. (2) After the key is renamed to XYZ, old keys such as ABC-7 still resolve and redirect. (3) Key validation accepts every key format found in imported Jira data. | M1 | M | Jira Free |
| CORE-002 | **Space types, templates and feature toggles.** Tracksmith shall provide the four space types and templates of section 1.1, and per-space feature toggles (board, backlog, sprints, releases, development, forms, approvals, calendar, timeline) that a space admin can change at any time. | (1) Kanban, Scrum and Bug tracking templates each create a working board. (2) Turning a feature off hides its tab and API resources without deleting data; turning it on restores them. (3) Toggles work in both configuration modes. | M1 | M | Jira Free; exceeds Jira (Jira locks company-managed spaces to template features) |
| CORE-003 | **Configuration modes.** Tracksmith shall support shared and space-local configuration (section 1.1) on one data model, query engine and API. | (1) Editing a space-local field in space A has no effect on space B. (2) Saving a shared field scheme lists every affected space before commit and applies to all of them. (3) A space-local space accepts 51 and more custom fields and selects with more than 55 options. | M1 | M | Jira Free; exceeds Jira (50-field cap) |
| CORE-004 | **Custom space templates.** Tracksmith shall let admins save a space's configuration, optionally with sample items, as a template and create spaces from it. | (1) A space created from a template has the same work types, fields, workflows, boards, automation rules and permission policy. (2) Templates export to a file and import into another instance. | M2 | M | Jira Enterprise |
| CORE-005 | **Work types.** Tracksmith shall let admins define work types (name, icon, description, hierarchy level) and assign them to spaces through work type sets with a default and an order. | (1) The create dialog shows only the space's types, in set order, with the default preselected. (2) Removing a type that is in use requires mapping its items to another type first. | M1 | M | Jira Free |
| CORE-006 | **Hierarchy levels.** Tracksmith shall implement the hierarchy rules of section 1.2, including unlimited custom levels and several types per level, for all users at no extra tier. | (1) An admin adds levels 2 and 3; a level-3 item can parent level-2 items in other spaces. (2) `hierarchyLevel = 2` returns those items. (3) Imported Epic Link and Parent Link values appear in Parent. | M1 | M | Jira Premium; exceeds Jira (query field ignores custom levels) |
| CORE-007 | **Safe hierarchy changes.** Tracksmith shall preview the impact of hierarchy changes and allow rollback. | (1) Before a level is removed the admin sees the number of parent links that would break and the types that fall to level 0. (2) A hierarchy change can be rolled back for at least 30 days, restoring the broken links. | M1 | S | exceeds Jira (change cannot be undone) |
| CORE-008 | **Create, view and edit.** Tracksmith shall support creation from a full dialog, inline in list, board and backlog, and via API; viewing as full page, side panel and modal; inline editing with optimistic save; and per-type field layouts with main, context and "hide when empty" sections. | (1) An inline-created item shows before server confirmation and is removed with an error message if the server rejects it. (2) A space admin's layout change is visible on the next open. (3) Missing required fields block creation with field-level messages in UI and REST. | M1 | M | Jira Free |
| CORE-009 | **Field contexts and options.** Tracksmith shall give each custom field one or more contexts, each scoped to spaces and work types with its own options and default value. | (1) One field offers options {A, B} in space X and {C} in space Y. (2) A user picker restricted to group G offers only members of G. (3) Options can be reordered, disabled (kept on existing items, hidden for new values) and renamed without changing stored option ids. | M1 | M | Jira Free |
| CORE-010 | **Custom field type catalog.** Tracksmith shall implement every type in section 1.4 with validation, query operators, sorting and REST representation. | (1) A number field rejects 2e12, stores 1.23456 as 1.235 and accepts "5e3" as 5000. (2) Short text rejects 256 characters. (3) Each type round-trips through REST, CSV export and import, and the Jira importer without loss. | M1 | M | Jira Free |
| CORE-011 | **Formula fields.** Tracksmith shall compute formula fields from other fields using arithmetic, average, max, min, power, abs, rounding, working days until due, and conditional text output. | (1) `{Story points} * 2` updates within 1 s after story points change and after bulk edits. (2) Working-days-until-due uses the site working-week setting and can output "Overdue". (3) Invalid formulas are rejected at save time with the error position. | M1 | M | Jira Free |
| CORE-012 | **Read-only info fields.** Tracksmith shall compute Date of first response, Days since last comment, Participants and Time in status from history. | (1) Time in status equals the sum of status intervals in the change history. (2) Days since last comment is searchable and sortable. | M1 | M | Jira Free; exceeds Jira (not searchable in Jira) |
| CORE-013 | **Field schemes and layouts.** Tracksmith shall implement unified field schemes and layout sets (section 1.5) for create, edit, view and transition operations, with tabs. | (1) A field required for Bug and optional for Task is enforced only on Bugs, in UI and REST. (2) A hidden field is not displayed and is rejected on write, while stored values are kept. (3) Imported Jira field configurations, screens and screen schemes produce equivalent schemes and layouts, reported per space. | M1 | M | Jira Free (2026 field schemes) |
| CORE-014 | **Statuses, priorities and resolutions.** Tracksmith shall manage site lists of statuses (with category), priorities (with priority sets per space) and resolutions, with icons, colours and order, shipping the defaults of section 1.6. | (1) A fresh install contains the default values. (2) A space using priority set {P1, P2} offers only those. (3) Deleting a value in use requires choosing a replacement. | M1 | M | Jira Free |
| CORE-015 | **Components.** Tracksmith shall provide per-space components with description, lead and a default-assignee rule (component lead, space lead, unassigned). | (1) An item created with component C and no assignee is assigned to C's lead when the rule says so. (2) Components can be archived and are queryable with `component` and `componentsLeadByUser()`. | M1 | M | Jira Free |
| CORE-016 | **Versions and releases.** Tracksmith shall provide versions with name, description, start and release dates, manual order, released and archived flags; Fix version, Affects version and single-version fields; release, unrelease, merge and archive; and a release page with progress, warnings and release approvers. | (1) Releasing a version with open items prompts to move them to another version. (2) With "require approvals" on, release is blocked until every approver approves; declines are recorded. (3) Reordering versions changes the result of `latestReleasedVersion()`. | M1 | M | Jira Free |
| CORE-017 | **Labels.** Tracksmith shall support free-form labels with site-wide autocomplete, and admin rename and merge of labels. | (1) Typing "fro" suggests the existing label "frontend". (2) Merging "front-end" into "frontend" updates every item and records the change in history. | M1 | M | Jira Free |
| CORE-018 | **Work item links and remote links.** Tracksmith shall support link types with name and outward and inward descriptions, admin create, edit and delete with remapping, a site-wide on/off switch, a clone link type, and remote links carrying a global id, title, URL and icon. | (1) Deleting link type "Causes" asks for a replacement and remaps all its links. (2) A Blocks link reads "blocks" on one item and "is blocked by" on the other. (3) A remote link is found by `workItemsWithRemoteLinksByGlobalId()`. | M1 | M | Jira Free |
| CORE-019 | **Watchers and votes.** Tracksmith shall let users watch and vote on items, auto-watch on comment or edit as a personal setting, and gate watcher and voter lists by permission. | (1) Pressing W toggles watching. (2) Seeing the lists requires View voters and watchers; changing others' watch state requires Manage watchers. (3) No cap on watchers or voters per item. | M1 | M | Jira Free |
| CORE-020 | **Comments.** Tracksmith shall support rich-text comments with mentions, reactions, permalinks, edit and delete governed by own/all permissions, and visibility restricted to a role or group. | (1) A comment restricted to role Developers is invisible to others in UI, API, search, notifications and export. (2) Reactions can be added and removed and show counts. (3) Editing a comment marks it edited and keeps prior versions for admins. | M1 | M | Jira Free |
| CORE-021 | **Attachments.** Tracksmith shall support upload by drag, paste and API; previews for images, PDF, video and text; browsing and downloading ZIP contents; download-all as ZIP; an admin-set maximum file size (default 1 GB, no fixed ceiling); local or S3-compatible storage; and no storage quota. | (1) With a 3 GB limit a 2.5 GB file uploads; with a 1 GB limit it is rejected with a clear message. (2) S3 objects are served only through short-lived signed URLs to users who can browse the item. (3) Deletion follows delete own/all attachment permissions. | M1 | M | Jira Premium (unlimited storage); exceeds Jira (2 GB file cap) |
| CORE-022 | **Change history and activity.** Tracksmith shall record every field change, transition, link, attachment, worklog and comment action with actor, time, old and new values (ids and display names), and show an activity feed filterable by Comments, History, Work log and All. | (1) History is complete after a 1,000-step scripted edit sequence. (2) An item with 50,000 history entries renders each page of the activity feed within 500 ms. (3) History is never truncated or aged out. | M1 | M | Jira Free; exceeds Jira (10,000-change window, DC 20,000 guardrail) |
| CORE-023 | **Clone, deep clone and move.** Tracksmith shall clone items with options, deep-clone a parent with all descendants, and move items between spaces and work types through a status and field mapping wizard. | (1) A clone with subtasks, attachments and links creates a Clones link to the source. (2) A deep clone copies an epic and 3 levels of descendants into another space. (3) A moved item keeps its history and its old key keeps resolving. | M1 | M | Jira Free; Deep Clone app |
| CORE-024 | **Bulk operations.** Tracksmith shall run bulk edit, transition, move, delete, archive, assign, comment and watch as background jobs with progress, cancel and a per-item result report, for users with Make bulk changes. | (1) A bulk transition of 20,000 items finishes as one job; items failing a validator are listed and the rest succeed. (2) There is no fixed 1,000-item cap. (3) Bulk delete sends items to trash (CORE-025). | M1 | M | Jira Free; exceeds Jira |
| CORE-025 | **Archive, trash and restore.** Tracksmith shall archive items (read-only, subtasks follow the parent, restore singly or in bulk) and spaces (items, components, attachments, versions), and shall soft-delete items to a trash with admin-set retention. | (1) An archived item opens read-only by link and is absent from search and boards. (2) A subtask cannot be archived alone; archiving its parent archives it. (3) A deleted item restores with history, links and attachments within retention (default 30 days). | M1 | M | Jira Premium (space archiving); exceeds Jira (no undo for deletions) |
| CORE-026 | **Configuration guardrails.** Tracksmith shall enforce the limits of section 1.7 as admin-adjustable guardrails and display usage against each limit. | (1) The admin page shows usage and limit for every guardrail. (2) An addition beyond a limit is rejected; a bulk action that would exceed it is rejected entirely; existing configuration is untouched. (3) Raising a limit takes effect immediately and shows performance guidance. | M1 | M | Jira Free (2026 limits); exceeds Jira (limits fixed) |
| CORE-027 | **Teams.** Tracksmith shall provide site-wide teams with members, lead and description, a Team field, and team references usable by boards, plans, on-call and ownership. | (1) `membersOf("id:<teamId>")` returns the team's members. (2) Renaming a team updates every reference. | M1 | M | Jira Free (Atlassian Teams) |
| CORE-028 | **Work intake forms.** Tracksmith shall let space admins build any number of forms (sharing the forms engine of SD-013) whose submission creates an item of a chosen non-subtask type, with conditional fields and optional public access. | (1) A submission creates an item labelled "Form" and "Form-<id>". (2) If the submitter lacks Create permission the space owner is recorded as creator and the submitter's identity is kept on the item. (3) Public forms work without sign-in and are rate-limited per IP. | M2 | M | Jira Free |

## 3. Reference: workflow catalog

### 3.1 Transition anatomy

Each transition has an id, name, source statuses (a list, or "any status" for a global transition), target status, optional layout (screen), condition tree, validator list, post-function list, triggers, properties (key-value pairs), display order and the event it fires. Each workflow has one initial status.

### 3.2 Conditions (all M1 except approval)

| Condition | Behaviour |
|---|---|
| Always false | Transition is never offered (used to retire a transition) |
| Block until approval | Unavailable while an approval on the status is pending (M2, WF-013) |
| Compare number field | Number field compared with a constant using =, !=, >, >=, <, <= |
| Hide from user | Not offered in UI; callable only by automation, post functions and REST |
| Only assignee / Only reporter | Current user is the assignee / the reporter |
| Permission | Current user holds a named space permission |
| Previous status | Item has been in status X, optionally only as the most recent status |
| Separation of duties | User who performed transition A on this item cannot perform this one |
| Subtask blocking | All subtasks are in one of the listed statuses |
| User in group / in any group | Current user belongs to the group / to one of the groups |
| User in space role / in any space role | Current user holds the role / one of the roles in this space |
| User in custom field | Current user is a value of a user field |
| User in group custom field | Current user belongs to a group stored in a group field |
| Value field | A field compared with a value |

Conditions nest in all/any groups to any depth. A failed condition hides the transition and the REST call returns an error naming the condition.

### 3.3 Validators

Field required; Field has been modified; Field has single value; Date compare (two date fields with an operator, optionally including time); Date window (a date within N days of another); Regular expression check; Forms attached; Forms submitted (with forms, M2); Parent status (parent in one of the listed statuses); Permission; Previous state. Jira's sunsetted "User permission validator" imports as Permission. A failed validator blocks the transition, runs no post function and changes nothing.

### 3.4 Post functions

- **Essential, fixed order, not removable**: (1) set status, (2) add the comment if entered, (3) update change history and store the item, (4) update the search index, (5) fire the transition's event (generic or custom). Notifications are sent only after the whole sequence completes.
- **Optional**: assign to current user; assign to lead developer (component lead, else space lead); assign to reporter; clear field value; copy value from another field (including parent to subtask); set security level from the user's space role; trigger webhook; update a custom field; update a system field (assignee, description, environment, priority, resolution, summary, original or remaining estimate); create Perforce job (C; imported as a webhook placeholder).

### 3.5 Space-local workflow rules

Assign an item to someone; restrict to when a field has a specific value; restrict to when the item has been through a status (options: include current status, reverse, most recent only, ignore looped transitions); restrict who can move the item; validate that people hold a permission; copy one field's value to another; update a field.

### 3.6 Board-managed (simplified) workflow

Statuses are the board's columns and are managed by the board admin; any card can move to any column; there are no transition screens; the rightmost column sets resolution Done and leaving it clears the resolution. Scrum default columns: To Do, In Progress, Done. Kanban default columns: Backlog, Selected for Development, In Progress, Done.

## 4. WF requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| WF-001 | **Workflow model.** Tracksmith shall model statuses with categories, workflows with transitions from one, several or any status, an initial status, and workflow assignment per work type in shared mode or per space in space-local mode. | (1) A global "Cancel" transition is offered from every status. (2) A transition with two source statuses is offered from both. (3) Bug uses W1 and Task uses W2 in the same space. | M1 | M | Jira Free |
| WF-002 | **Workflow editor.** Tracksmith shall offer diagram and text editing, editing of active workflows with an impact panel listing affected spaces and types, guided removal of statuses, publish or discard, version history with rollback, and a read-only view for users with View read-only workflow. | (1) Removing status QA with 120 items prompts for a target status and moves all 120 before publish. (2) A published change applies to the next transition with no downtime. (3) A previous version can be restored. | M1 | M | Jira Free (new editor); exceeds Jira (rollback) |
| WF-003 | **Conditions.** Tracksmith shall implement every condition in section 3.2 with nested all/any groups. | (1) With Only assignee, a non-assignee does not see the transition and REST returns an error naming the condition. (2) The tree A and (B or C) passes tests for all 8 input combinations. (3) Hide-from-user transitions run only from automation, post functions and REST. | M1 | M | Jira Free |
| WF-004 | **Validators.** Tracksmith shall implement every validator in section 3.3 with configurable error messages. | (1) Field required blocks with a field-level message. (2) A regular expression check rejects non-matching values. (3) After any validator failure the item, history and post functions are untouched. | M1 | M | Jira Free |
| WF-005 | **Post functions.** Tracksmith shall run the essential post functions in fixed order and the optional ones of section 3.4, and send notifications after the sequence. | (1) A test asserts the essential order on every transition. (2) Copy-from-parent sets a subtask field from its parent. (3) The webhook post function also fires on the create transition. | M1 | M | Jira Free; exceeds Jira (create-transition webhook gap) |
| WF-006 | **Transition layouts, properties and events.** Tracksmith shall show an optional layout per transition, store transition properties, and fire generic or custom events selectable in notification policies. | (1) Fields entered on a transition layout save atomically with the transition and its comment. (2) Properties are readable through the API. (3) A custom event fired by a transition triggers the recipients configured for it. | M1 | M | Jira Free |
| WF-007 | **Per-status permissions.** Tracksmith shall restrict edit, comment, attach, assign and transition per status to named roles or groups. | (1) In status Approved only role Approvers can edit; others see read-only fields and REST returns 403. (2) The UI explains why a field is read-only. | M1 | M | Jira Free (workflow properties); Linear lacks it |
| WF-008 | **Resolution and status categories.** Tracksmith shall set and clear resolution via transitions and layouts, stamp Resolved when a resolution is set, and drive colours and reports from status categories. | (1) Moving to Done with a resolution sets Resolved; reopening clears both. (2) Boards, gadgets and reports colour statuses by category. | M1 | M | Jira Free |
| WF-009 | **Space-local rules.** Tracksmith shall implement the seven rule types of section 3.5 for space-local workflows. | (1) Each option of "has been through a status" is covered by a test. (2) Rules created in one space do not appear in another. | M1 | M | Jira Free |
| WF-010 | **Board-managed workflow.** Tracksmith shall implement the simplified workflow of section 3.6. | (1) Adding a column creates a status. (2) Any card can be dragged to any column. (3) The rightmost column sets resolution Done and leaving it clears it. | M1 | M | Jira Free |
| WF-011 | **Workflow import, export and Jira function mapping.** Tracksmith shall export and import workflows in its own JSON format and import Jira workflow definitions, mapping each condition, validator and post function by Jira class name to this catalog. | (1) Export then import yields an identical workflow. (2) Unmapped Jira functions appear in the import report and become disabled placeholders that an admin can replace with a script (WF-014). | M1 | M | Jira Free |
| WF-012 | **Workflow lint.** Tracksmith shall warn about unreachable statuses, statuses with no exit outside the Done category, statuses unmapped on boards using the workflow, and conditions no user can satisfy. | (1) Each of the four defects produces a named warning in the editor and in the publish dialog. | M1 | S | exceeds Jira |
| WF-013 | **Approvals.** Tracksmith shall let admins add an approval step to any status, with approvers from users, groups, roles or user and group fields; quorum any, all, majority or N; decisions from email, inbox, item, approvals list ("pending your approval") and mobile; decision-driven transitions; reminders, timeout escalation and an audit trail. | (1) "All of CAB (5 people)" moves only after 5 approvals; one decline runs the decline transition. (2) Majority of 4 moves after 3 approvals. (3) Every decision records approver, time, comment and channel. | M2 | M | Jira Premium; quorum from change-management apps; exceeds Jira |
| WF-014 | **Extended and scripted workflow functions.** Tracksmith shall provide expression-based conditions, validators and post functions (field comparison, query match, state of linked or child items, create, link and transition related items, set fields by expression, send email) and script-backed ones running in the extension runtime (file 02b). | (1) A post function moves the parent to Done when all children are Done, without automation rules. (2) A script validator that exceeds its time limit fails closed with a message. | M2 | M | JMWE, JSU and ScriptRunner apps |
| WF-015 | **Development-event triggers.** Tracksmith shall transition items automatically on development events linked by key: branch created, commit created, pull request created, merged or declined, review state changes, build and deployment status. | (1) A merged pull request whose title holds PROJ-12 moves PROJ-12 through the configured transition. (2) Triggers skip conditions only when the admin opts in, and every run is logged. | M2 | M | Jira Free (verify full trigger list) |
