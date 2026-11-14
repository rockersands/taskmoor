---
title: "Workflows"
audience: admins
sources: packages/workflow/src/model.ts, packages/workflow/src/pattern.ts, apps/server/src/workflows/transfer.ts, apps/server/src/workflows/transfer-store.ts, docs/adr/0073-workflow-files.md, packages/workflow/src/engine.ts, apps/server/src/workflows/model.ts, apps/server/src/workflows/fields.ts, apps/server/src/workflows/locks.ts, apps/server/src/workflows/maps.ts, apps/server/src/workflows/migration.ts, apps/server/src/workflows/state.ts, apps/server/src/workflows/store.ts, apps/server/src/routes/workflows.ts, apps/server/src/routes/workflow-maps.ts, apps/server/src/routes/tickets.ts, apps/server/src/routes/tracks.ts, apps/web/src/workflow/WorkflowsPage.tsx, apps/web/src/workflow/WorkflowEditorPage.tsx, apps/web/src/workflow/definition.ts, apps/web/src/workflow/StatusesSection.tsx, apps/web/src/workflow/TransitionInspector.tsx, apps/web/src/workflow/StatusInspector.tsx, apps/web/src/workflow/PublishPanel.tsx, apps/web/src/workflow/VersionHistory.tsx, apps/web/src/workflow/lint.ts, apps/web/src/workflow/catalogue.ts, apps/web/src/configuration/WorkflowMapsPage.tsx, apps/web/src/i18n/messages.en.ts, packages/db/src/migrations/0024_workflows.ts, packages/db/src/migrations/0042_workflow_maps.ts, packages/db/src/migrations/0089_seamless_default_workflow.ts, packages/db/src/migrations/0104_default_workflow_left_strict.ts, packages/db/src/migrations/0107_workflows_left_without_moves.ts, apps/server/src/workflows/free-moving.ts, apps/server/src/workflows/free-moves.ts, apps/server/src/cli.ts, apps/server/src/workflows/close-reasons.ts, docs/adr/0039-workflows-as-versioned-data.md, docs/adr/0042-edit-locks.md, docs/adr/0045-workflow-maps.md, docs/specs/01a-core-work-tracking.md, apps/server/src/workflows/board-managed.ts, docs/adr/0079-board-managed-workflows.md, docs/adr/0116-one-place-per-track.md, apps/web/src/workflow/client.ts, apps/web/src/workflow/WorkflowDiagram.tsx, apps/web/src/workflow/diagram.ts, apps/web/src/workflow/StructureLists.tsx, apps/web/src/admin/NewButton.tsx, apps/web/src/shell/DangerAction.tsx, apps/web/src/shell/NotFoundPage.tsx, apps/web/src/admin/ActionSlot.tsx
accessed: 2026-11-14
attestation: own-words
---
# Workflows

A workflow is a set of statuses and the transitions that move tickets between them. This page
covers statuses and stages, what a transition can do, the workflow editor, publishing a change,
workflow maps, and how tickets move when their workflow changes. Each map in the list names its
workflow for the types without one of their own ("Workflow for every other type: …").

Site and configuration administrators manage shared workflows. In the web app they are under
**Administration**, **Workflows** and **Administration**, **Workflow maps**; everything is also in the
[REST API](rest-api.md) under `/api/v1/statuses`, `/api/v1/workflows` and
`/api/v1/workflow-maps`. Each page says under its title what it is for, and the **?** button beside
the title says more.

## Statuses and stages

Statuses belong to the whole site; each workflow uses some of them. Every status is in a stage:

| Stage | Meaning | Colour |
|---|---|---|
| New | Not started yet | Grey |
| Active | Being worked on | Blue |
| Closed | Finished; reports count it as done | Green |

A fresh site has these statuses: Open, New, Backlog, Selected for Development and Draft (new);
Active, In Review and Under review (active); Approved, Rejected, Cancelled, Published and Closed
(closed).

The **Statuses** section of **Administration**, **Workflows** manages them: **New status** opens the
form (with **Name**, **Description** and **Stage**); each status has **Edit**, move up and down,
and **Delete**. **Delete** is in the danger colour and asks first. The buttons stand in columns: a
status with no move up or down keeps that button's place. On a phone a status's buttons share one
line.

- A status keeps its stage while tickets are in it.
- Changing a status's stage takes the free moves into it along: on every workflow whose global
  transition into it asks nothing and only sets or clears the close reason, entering a status made
  closed-stage now sets the reason free moves close with (Completed, unless it was replaced), so the
  ticket also gets its Closed time; entering one moved out of the closed stage clears the reason.
  Each workflow that changes gets a new version, and its draft changes too. A transition with a
  rule, or that sets a reason you chose, stays as it is, and so does a workflow a board manages.
- A status is deleted only when no ticket is in it and no workflow's published version or draft
  uses it.

## Workflows as versioned data

Each workflow has a **published version**, which tickets move through, and at most one
**draft**, which you edit. Publishing makes the draft current at once: the next transition of
every ticket uses it, with no downtime. Earlier versions stay, and any of them can be restored
as the draft.

A fresh site has one **Default workflow**. It moves freely: a ticket can go from any status to
any other at once, and nothing asks for a field. Each transition is named after the status it
goes to:

| Transition | From | To | What it does |
|---|---|---|---|
| New | Any status | New | Clears the close reason |
| Active | Any status | Active | Clears the close reason |
| In Review | Any status | In Review | Clears the close reason |
| Closed | Any status | Closed | Sets the close reason to Completed |

The status says where a ticket stands; why it moved goes in a comment. New tickets start in New.
The default workflow cannot be deleted.

These are only the defaults. To require a field, a guard or a check, edit the workflow or make
your own (below): a new workflow moves freely as well, until you add a rule, and a rule you add
stays. A site that had already changed its default workflow before this version keeps its own
rules, and so does every imported workflow.

## Transitions

A transition has a name and an optional description. It **starts from** a list of statuses, or
from **any status** (a global transition, offered from every status including its target), and
**goes to** one status. It can also have:

- **Fields asked for on the transition**: people fill them in when they run it, and the values
  save together with the transition.
- **Guards**, **checks**, **effects** and **local-mode rules** (below).
- **Properties**: keys and values that integrations read through the API.
- **Custom event**: the event the transition fires instead of the generic one. Lower-case
  letters, digits and hyphens, starting with a letter.
- **Run by external events**: event names that run the transition as automation, through
  `POST /api/v1/tickets/:id/trigger` with `{ "event": "..." }`.

People run transitions from the ticket. Programs list them with
`GET /api/v1/tickets/:id/transitions` and run one with `POST` to the same address. A transition
that is refused changes nothing, and the answer names what refused it
(`409 transition_refused`).

### Guards

Guards decide who sees a transition. When they do not pass, the transition is hidden and the API
refuses it, naming the guard. Guards combine in groups, **All must pass** or **One is enough**,
nested up to ten deep. A transition without guards is offered to everyone who may move tickets
through the workflow.

| In the editor | Passes when |
|---|---|
| Only the assignee | The person is the ticket's assignee |
| Only the requester | The person is the ticket's requester |
| Holds a track permission | The person holds a named permission in the track |
| Holds a track role / Holds one of these track roles | The person holds the role, or one of the roles, in the track |
| Member of a group / Member of one of these groups | The person is in the group, or one of the groups |
| Named in a people field | The person is the value of a people field |
| Member of a group named in a field | The person is in a group a field names |
| The ticket has been in a status | The ticket was in the status before (optionally only as the most recent one) |
| Not the person who ran another transition | The person did not run the named transition on this ticket |
| Every subticket is in one of these statuses | All subtickets are in the listed statuses |
| A number field compared with a number | A number field compares as stated (`=`, `!=`, `>`, `>=`, `<`, `<=`) |
| A field compared with a value | A field compares as stated with a value |
| Hidden from people (automation and API only) | The transition is run by automation, an effect or an API token, never from a signed-in browser |
| Waits for an approval | No approval is pending |
| Never (a retired transition) | Never: the transition is no longer offered |

### Checks

Checks decide whether a transition may complete. A failing check stops it with its **Message
when it blocks** (or a standard message in the reader's language), and nothing changes.

| In the editor | Passes when |
|---|---|
| A field is filled in | The field has a value |
| A field has been changed | The transition's fields give the field a new value |
| A field holds one value only | The field has at most one value |
| A field matches a pattern | The field's text matches a regular expression (see below) |
| Two dates compared | Two date fields compare as stated, optionally with the time of day |
| A date within some days of another | A date lies within a number of days of another |
| The parent is in one of these statuses | The ticket has a parent, in one of the listed statuses |
| The person holds a track permission | The person holds a named permission in the track |
| The ticket has been in a status | The ticket was in the status before |
| A form is attached / Every form is submitted | A form is attached, or every attached form is submitted |

A pattern runs on whatever people type into the field, so Taskmoor refuses, when the workflow
is saved, a pattern that could take the server minutes on a short text: one that repeats a group
that itself repeats (`(a+)+`), repeats a choice (`(a|aa)*`), refers back to a group (`\1`), or is
longer than 500 characters. Write the pattern without the nesting: `^a+$` instead of `^(a+)+$`.
A pattern of this kind saved before version 1.0 is not run; the transition then refuses with a
message that the pattern cannot run.

### Effects

Every transition runs in a fixed order: set the status, save the fields entered on the
transition, run the optional effects in their list order, apply the local-mode rules, add the
comment if one was entered, record the history and store the ticket, update the search index,
and fire the event. Notifications go out only once the whole sequence has run.

| Optional effect | What it does |
|---|---|
| Assign to the person running it | Sets the assignee to that person |
| Assign to the owner (the area owner, else the track owner) | Sets the assignee to the owner |
| Assign to the requester | Sets the assignee to the requester |
| Set a field / Set a system field | Writes a value into a field |
| Clear a field | Empties a field |
| Copy one field to another | Copies a value, optionally from the parent ticket |
| Set the visibility level from the track role | Picks a visibility level by the person's role |
| Call a webhook | Names an `http` or `https` address |
| Imported function to replace | A placeholder that does nothing until replaced |

A workflow can also give effects and a custom event to ticket creation (`onCreate` in the
definition).

### Local-mode rules

Rules are a simpler kind of check and effect, meant for workflows of local-mode tracks; they run
after the effects. The types are **Assign the ticket**, **Only when a field has a value**, **Only
when the ticket has been through a status** (with **Count the current status**, **Reverse**,
**Only the most recent status counts** and **Ignore transitions that loop back**), **Only these
people, groups or roles**, **The person holds a permission**, **Copy one field to another** and
**Set a field**.

### Fields a workflow can use

Guards, checks, layouts and effects name ticket fields by these names. The first fourteen can
be written; the last four are read only.

`summary`, `description`, `environment`, `assignee`, `close-reason`, `priority`, `labels`,
`start-date`, `due-date`, `original-estimate`, `remaining-estimate`, `target-release`,
`found-in-release`, `area`; read only: `time-spent`, `ticket-type`, `requester`, `creator`.

Custom fields cannot be used in workflows yet.

### Permissions per status

A workflow can name, per status, the roles and groups that alone may edit a ticket, comment on
it, attach files, assign it or run transitions while it sits there. Everyone else keeps their
track permissions but is refused those actions (`403`), with the reason. These restrictions
grant nothing. The editor shows them on the status, and you change them in text mode. Here, in
status 7 only role 1 may edit and only group 4 may run transitions (ids are your site's):

```json
"statusPermissions": {
  "7": { "edit": [{ "role": "1" }], "transition": [{ "group": "4" }] }
}
```

## The workflow editor

**Administration**, **Workflows** lists the workflows with their published version, any draft and how
many tracks use them. **New workflow** asks for a **Name**, a **Description**, **Start
from** (**A workflow that moves freely** or **A copy of** another one) and an **Initial status**.
A workflow that moves freely starts with that status and the global transition into it; a copy
has whatever rules its source has. In the API, `POST /api/v1/workflows` with no `transitions`, or
an empty list, builds one global transition into each status it names, and a list that names some
is kept as written.
**Delete** removes an unused workflow with all its versions; a workflow that a workflow map
names cannot be deleted. It is in the danger colour and asks first, as every destructive action
in Administration does. The address of a workflow that does not exist, or no longer does, opens
**Workflow not found**, with the ways on to Home and Search.

**Edit** opens the editor. It works on the draft, or on the published version until the first
**Save draft** starts a draft. Unsaved changes stay in the page.

- **Diagram** mode draws the workflow and lists its statuses and transitions; choose one in the
  picture or the lists to change it in the details panel. Every box and label in the picture is a
  button named by its words, so Tab and Enter choose it as a click does; a label is named as a
  transition, such as "Transition: Approve", so it is never taken for a status, and the one open
  is marked as the current one. On a touch screen each label is at least a finger's height. A transition from any
  status sits in a tab above its status; when it is the only one there, the tab takes the free
  room beside the box so its name shows whole. Two or more sit side by side, with the next column
  moved over to make room, and no tab ever covers another. On phones the picture waits behind **Show the
  diagram**. The page's breadcrumb ends at the workflow's name, under **Workflows**, and **Name
  and description** opens with a chevron.
- **Text** mode shows the definition as JSON, with a key from status ids to names. Switching
  modes keeps every change.
- **Add a status** picks one of the site's statuses, and **Add to workflow** puts it into the
  workflow. On a workflow that moves
  freely (every transition global, with no guard, check, field or rule) it also adds the global
  transition into it, so tickets can enter it at once: a closed-stage status sets the close reason
  Completed, or what took its place if it was renamed or replaced, and any other clears the reason.
  If you replace Completed and later make a new reason named Completed, the free moves already
  there keep the replacement, and the ones added from then on set the new Completed.
  On a workflow with rules it adds only the status, and the
  steps into it are yours to draw. **New transition** adds a transition. A status's panel can **Make
  it the initial status** or remove it from the workflow.
- **Discard draft** throws the draft away; the published version stays as it is.
- A draft of the default workflow saved before workflows moved freely may still have the steps the
  site first came with: **Start**, **Send to review**, **Back to active**, **Close** (which asks
  for a close reason) and **Reopen**. The editor says so and offers **Let this draft move freely**,
  which puts in their place the global transitions the published version has, and keeps any step
  you drew yourself. Nothing changes until you save the draft. A step you changed is yours, and the
  offer does not appear.

**Checks before publishing** list problems as you edit. Errors, such as a transition to a status
that is not in the workflow, block saving. Warnings do not:

- **Unreachable**: no path from the initial status leads to the status.
- **No exit**: no transition leaves a status outside the closed stage.
- **Never offered**: nobody can satisfy the transition's guards.

## Publishing changes

**Publish** saves any unsaved change and opens **Publish version** with the number. The panel
says which tracks the change reaches at once and how many warnings the draft has. For each
status the new version drops that holds tickets, choose where the tickets go, then press
**Publish now**. They move with their history; their close reason stays as it is.

**Version history** lists every version with who saved and published it. **Restore as draft**
replaces the draft with an earlier version; publish it to use it again. A version that sets a close
reason deleted since cannot be restored, nor can a draft name one: every move through that
transition would be refused. Set the reason on the current version instead.

Through the API: `PUT /api/v1/workflows/:id/draft` with `{ "definition": ... }`,
`GET /api/v1/workflows/:id/impact`, then `POST /api/v1/workflows/:id/publish` with
`{ "statusMapping": { "<dropped status id>": <new status id> } }`. Without a needed mapping the
publish answers `409 status_mapping_required` with the statuses and ticket counts.

A draft saved through the API follows the same rule as **Add a status**: on a workflow that moves
freely, each status the draft adds and no transition reaches gets its global transition, numbered
above every transition id the workflow has used. A draft with no transitions, or the next draft of
a workflow left with none, gets one into every status no transition reaches, as a new workflow
does. A closed-stage status gets one only when there is a close reason to set. The answer shows the
draft as saved. Statuses that were already in the workflow, steps you drew, any draft with a
rule and the draft of a workflow a board manages are saved as sent. Send
`"transitionsAsSent": true` beside the definition to keep the transitions of a draft that has any
exactly as sent; the editor always does, since its **Add a status** gives the status its free move
already, so a move you delete before saving stays deleted. A draft with no transitions at all still
gets its free moves.

So that no ticket is left unable to move, a draft with no transitions at all (an earlier, empty
version restored as the draft, or a file imported as the next draft) is published with a
transition from any status into each of its statuses, as a new workflow gets, and **Publish
version** says so before you publish. The moves are added only when the publish goes through: a
publish refused, for example to ask where the tickets of a dropped status go, leaves the draft as
it was. A draft with a rule, and the workflow of a board that manages it, are published as they
are. So is a draft whose only statuses are closed-stage ones when no close reason exists to set:
it is published with no transitions, and `cli.mjs workflow-moves` lists it until you add some.

A workflow left with no transitions by an earlier version of Taskmoor got those moves when the
server was upgraded, as a new published version; a draft you had saved stays as you saved it,
numbered after it. A workflow with a rule, one a board manages, and one whose only statuses are
closed-stage ones with no close reason to set were left for you to edit. Whoever runs the server
can list any such workflow with `cli.mjs workflow-moves` ([The operator CLI](cli.md)).

## Workflow files

Each workflow on the workflows page has a **Download** link: a file in Taskmoor's own format
with the workflow and the names of everything it refers to (statuses, groups, roles, people by
email, priorities, close reasons, ticket types, releases and areas), but no database ids. Bring
it to this server or another with **Import a workflow**: choose the file, then import it as
**A new workflow** (published as version 1, used by no track until a workflow map names it) or
as **The next draft** of an existing one, to check in the editor and publish.

A file whose workflow has no transitions at all imports with a transition from any status into
each of its statuses, as a new workflow gets; a file with transitions or rules keeps them as they
are.

The import matches statuses by name, ignoring case, and creates those this site lacks.
Everything else must already exist with the same name. Whatever cannot be found never lets
more people through: a guard naming it never passes, a list drops it, a check that names it is
removed and its transition is turned off until you fix it, and effects drop it. The report
after the import lists each such change and where it was. A file that cannot be saved changes
nothing, statuses included.

Through the API: `GET /api/v1/admin/workflows/:id/export`, `POST /api/v1/admin/workflows/import`
and `POST /api/v1/admin/workflows/:id/import` (the next draft).

## Board-managed workflows

On a board of a local-mode track, **This board's columns are its track's statuses** in the
board's settings (under **Columns**) hands the track's workflow to the board. Each column
becomes one status: the column's first status, or one named after it. Any card can then move to
any column, and the rightmost column closes a ticket with the close reason **Completed**;
moving it out clears the close reason. A new column gets a status of its own when you save; the
tickets of a removed column go to the first column. The track's administrators turn it on and
off; a track whose types follow different workflows, or a shared-mode track, cannot.

Behind the board it is an ordinary workflow, so the workflow editor shows it, with one
transition per column from any status. The board rewrites it each time its columns change, so
change the columns rather than the transitions. Turning it off keeps the workflow as it is.
Through the API: `PUT /api/v1/boards/:id/workflow` with `{"managed": true}`.

## Workflow maps

A workflow map says which workflow each ticket type follows in the tracks that use it. Types the
map does not name follow its default workflow. A fresh site has the **Default workflow map**,
where every type uses the default workflow; tracks without a map of their own use it.

On **Administration**, **Workflow maps**:

- **New workflow map** opens the form: **Add a workflow map** with a **Map name** and a
  **Default workflow**.
- **Manage** a map to change the **Workflow for every other type**, to **Give a type its own
  workflow**, to change what a type follows or **Remove** it, then **Save the map**.
- **Delete map** removes a map no track uses. It is in the danger colour and asks first, saying
  that no track can use the map afterwards. The default map cannot be deleted.

A map holds at most 150 workflows by default ([guardrails](tracks.md#configuration-guardrails)).
A shared-mode track chooses its map under **Administration**, **Tracks**, **Manage**, **Workflow map**.

A local-mode track owns one map, named after its key, made with the track. Its administrators
change it through the API, and may create workflows the track owns (`POST /api/v1/workflows`
with `trackId`) and name them in its map.

## Migrating tickets between workflows

Changing a map's workflows, or switching a track to another map, can leave tickets in statuses
their new workflow lacks. Those tickets need a new status:

- The change takes `statusMapping`, from old status id to new status id, and, where one ticket
  type needs other targets, `typeStatusMapping` keyed by ticket type id. Without it the change
  answers `409 status_mapping_required` with the statuses and ticket counts. The web app shows
  that count and asks you to give the mapping through the API.
- Preview a change first: `POST /api/v1/workflow-maps/:id/impact` for a map,
  `GET /api/v1/tracks/:id/workflow-map/impact?workflowMapId=` for a track's switch.
- The change applies at once. Up to 500 tickets move within the request; more move in the
  background, and the answer names a migration whose progress is at
  `GET /api/v1/workflow-migrations/:id`.
- A ticket not yet moved still works: a transition on it moves it first.
- While a migration runs, its tracks refuse another map change and their workflows refuse a
  publish (`409 status_migration_running`).

## Reading a track's workflow

Track members with the permission **See the workflow** read the workflow a ticket type follows
with `GET /api/v1/tracks/:id/workflow?ticketTypeId=`, and the track's map with
`GET /api/v1/tracks/:id/workflow-map`.

## Not available yet

- Approvals and forms. Until they arrive, **Waits for an approval** never holds a transition
  back, and the two form checks always block.
- **Call a webhook** does not send a request yet: the transition's event only counts the calls.
  To be told about transitions, register a webhook for ticket events through the API.
