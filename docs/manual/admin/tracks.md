---
title: "Tracks"
audience: admins
sources: apps/server/src/routes/tracks.ts, apps/server/src/tracks/model.ts, apps/server/src/tracks/templates.ts, apps/server/src/routes/authz.ts, apps/server/src/routes/releases.ts, apps/server/src/routes/workflow-maps.ts, apps/server/src/routes/guardrails.ts, apps/server/src/guardrails/model.ts, apps/server/src/routes/trash.ts, apps/server/src/trash/policy.ts, apps/server/src/trash/purge.ts, apps/server/src/tokens/scopes.ts, apps/server/src/cli.ts, apps/web/src/configuration/TracksAdminPage.tsx, apps/web/src/configuration/NewTrackForm.tsx, apps/web/src/tracks/TracksPage.tsx, apps/web/src/admin/SettingsPage.tsx, apps/web/src/admin/TrashPage.tsx, apps/web/src/guardrails/GuardrailsPage.tsx, apps/web/src/guardrails/StorageQuotas.tsx, apps/server/src/attachments/quota.ts, apps/server/src/routes/attachments.ts, docs/adr/0110-outbound-guard-archive-limits-storage-quotas.md, apps/web/src/releases/ReleasesPage.tsx, apps/web/src/i18n/messages.en.ts, packages/db/src/migrations/0004_authorization.ts, docs/adr/0009-configuration-model.md, docs/adr/0051-configuration-guardrails.md, docs/adr/0062-track-templates.md, docs/specs/01a-core-work-tracking.md, apps/server/src/routes/setup.ts, apps/web/src/tickets/templates/TicketTemplatesPage.tsx, apps/web/src/tickets/templates/TemplateForm.tsx, apps/server/src/routes/ticket-templates.ts, apps/server/src/templates/model.ts, docs/adr/0113-ticket-templates.md
accessed: 2026-11-03
attestation: own-words
---
# Tracks

A track holds tickets, the configuration they follow and the people who work in it. This page
covers making a track, the two configuration modes, a track's settings, archiving, deleting, and
the guardrails that limit how much configuration one track can hold. For the ideas behind
tracks, see [concepts and terms](../concepts.md).

## Where tracks are managed

Site and configuration administrators manage tracks in the web app under **Administration**, **Tracks**. The page adds
tracks, renames them, chooses their workflow map, gives roles to people and groups, and archives
and restores them.

Everything else is done through the [REST API](rest-api.md) under `/api/v1/tracks`.
`GET /api/v1/tracks/:id` takes a track's id or key; the routes that change a track take its id. A token that changes shared configuration needs the
`admin` scope; see [API tokens](api-tokens.md).

**Tracks** in the sidebar opens the page that lists every track you can see, with a box to find one
by name or key. It stays marked as the current place while you are inside a track, on a ticket or on a
board.

## Creating a track

### In the web app

Anyone who may make a track, see [Who may create one](#who-may-create-one), finds **New track** on the
**Tracks** page and in the command palette. Others do not see it. If no track exists yet, the empty
page offers it too.

1. Press **New track**.
2. Fill in **Key** and **Track name**.
3. Choose **Configuration**: **Shared configuration** (shared mode) or **Its own
   configuration** (local mode). Only the ones you may make are listed.
4. Choose **Start from**: one of the **Templates**, or, for a shared track, **The configuration
   of another track**.
5. Press **Create track**. You land in the new track.

Administrators can also use **Administration**, **Tracks**, with the same form under **Add a track**.
There, when the template makes a board, the page shows a link, **Open the board of** and the key.

### Keys

A new key is 2 to 10 characters: a letter A to Z, then letters or digits. Lower-case letters are
turned into capitals. Ticket keys start with it (`PAY-1`, `PAY-2`).

- Keys are unique on the site, ignoring case, and that includes every key a track has had.
- After a key change, old track and ticket keys keep working and point to the new ones. No other
  track can take an old key; the track itself can take it back.
- Keys of imported data may be longer and may contain underscores; such tracks keep them.

### Templates

A template chooses the track type, the features that are on, and the first board. The
configuration sets are the defaults of the track type, as for any new track.

| Template | Track type | Features left off | Board it makes |
|---|---|---|---|
| Scrum | software | none | A Scrum board of every ticket in the track |
| Kanban | software | backlog, sprints | A Kanban board of every ticket in the track |
| Bug tracking | software | backlog, sprints, forms, timeline | A Kanban board of the track's bugs (`type = Bug`) |
| Business | business | as the business type | A Kanban board of every ticket in the track |
| Blank | software | none, until its first board | None; a Kanban board the first time it is opened, which turns backlog and sprints off |

The board is named after the track. Bug tracking relies on a ticket type called Bug in the track's
type set; without one, its board stays empty until someone edits the board's query.

### Copying another track's configuration

A new shared-mode track can take the configuration of an existing shared-mode track: its type,
access policy, type set, priority set, workflow map, field rule set, layout set, visibility and
notification policies, category and features. It points at the same shared configuration; it does
not copy it. Boards, automation and tickets are not copied. A local-mode track cannot be the
source, and a local-mode track cannot be made from a copy.

### Through the API

```http
POST /api/v1/tracks
Content-Type: application/json

{ "key": "PAY", "name": "Payments", "mode": "shared", "template": "scrum" }
```

The body takes `key`, `mode` (`shared` or `local`) and `name`, and optionally `description`,
`type`, `ownerId`, `categoryId`, `icon`, `color`, `accessPolicyId`, `typeSetId`, `features`, and
either `template` (`scrum`, `kanban`, `bug-tracking`, `business`, `blank`) or `copyFrom` (a
track id). A `type` that does not match the template is refused. The answer is `201` with the
track, and the template's board when one was made.

### Who may create one

- Shared-mode tracks: site and configuration administrators.
- Local-mode tracks: people with the global permission **Create tracks with their own
  configuration**. A new site grants it to every signed-in person; change that under
  [permissions and access](permissions.md).

The person who creates the track becomes its owner unless another owner is named, and joins the
role that the track's access policy lets run the track (Administrators in the default policy).

## Shared mode and local mode

The mode is chosen when the track is made and never changes.

| Configuration | Shared mode | Local mode |
|---|---|---|
| Access policy | A shared policy; the default one unless named | Its own copy of the default policy |
| Type set | A shared set; the track type's default unless named | Its own copy of the track type's default set |
| Workflow map | A shared map; the default map unless one is chosen | Its own map, whose default is the site's default workflow |
| Custom fields, ticket types, workflows | Shared ones | Shared ones, plus its own |
| Field rule set, layout set, visibility and notification policies | Shared ones | Shared ones, or its own |

A local-mode track's administrators change its own access policy, type set, map and sets without
being configuration administrators. Nothing they change reaches another track, and changes to
the shared defaults no longer reach it.

## Track settings

### Details

These are changed by the track's administrators (the permission **Run the track**) with
`PATCH /api/v1/tracks/:id`. In the web app, **Manage** on a track offers **Rename**.

| Setting | API field | Notes |
|---|---|---|
| Name | `name` | Up to 255 characters |
| Description | `description` | Up to 10,000 characters |
| Key | `key` | See [keys](#keys) |
| Track type | `type` | Changing it later does not change the features |
| Owner | `ownerId` | An active person |
| Category | `categoryId` | `null` for none |
| Icon and colour | `icon`, `color` | An icon name; a colour as `#rrggbb` |
| Features | `features` | `board`, `backlog`, `sprints`, `releases`, `development`, `forms`, `approvals`, `calendar`, `timeline`, each `true` or `false` |

Turning a feature off deletes nothing. The board's kind decides **backlog** and **sprints**: a
Scrum board turns both on and a Kanban board turns both off, also when the kind changes, recorded as
a change of the track. The web app shows a Backlog and reports that follow sprints only on a track
with a Scrum board and those features on. For the other features, Taskmoor stores the choice, but the
web app and the API do not yet hide the parts a track has turned off.

### People and roles

Under **Manage**, **Who does what in** the track lists who holds which role. Choose a **Role**,
then use **Give the role to a person** (type at least two letters of a name) or **Give the role
to a group**, and **Add**. **Remove** takes a role away.

The default roles are Administrators, Members and Viewers. What each role may do comes from the
track's access policy; see [permissions and access](permissions.md). Through the API, a track's
administrators read `GET /api/v1/tracks/:id/role-actors` and change roles with
`PUT` or `DELETE /api/v1/tracks/:id/roles/:roleId/users/:userId` (or `groups/:groupId`).

A track's administrators manage its roles from **Administration** > **Tracks you run**, and may be allowed
to invite people; see [Inviting people and running a track](invitations.md). A role that runs the
track needs a further permission, and the track's last administrator cannot be removed.

### Configuration sets

A track names the configuration sets it uses. `null` means the site's default. Layouts, priorities,
visibility policy and notifications are chosen on [Which sets a track uses](fields.md#which-sets-a-track-uses).

| API field | What it chooses | Who may change it |
|---|---|---|
| `accessPolicyId` | [Who may do what](permissions.md) | Site and configuration administrators; shared mode only |
| `typeSetId` | The ticket types offered | Site and configuration administrators; shared mode only |
| `workflowMapId` | The workflow of each ticket type | Site and configuration administrators; shared mode only |
| `prioritySetId` | The priorities offered | Site and configuration administrators |
| `fieldRuleSetId`, `layoutSetId` | Field rules and forms | Administrators for a shared set; the track's administrators for its own |
| `visibilityPolicyId` | Ticket visibility levels (`null` for none) | As above |
| `notificationPolicyId` | [Who is told about what](notifications.md) | As above |

In the web app, **Manage** on a shared-mode track offers **Workflow map**. Some switches move
tickets:

- **Workflow map**: tickets in statuses that the new workflows lack must be given new statuses.
  The web app refuses such a switch and says how many tickets are affected; send
  `statusMapping` with the change through the API. See
  [migrating tickets between workflows](workflows.md#migrating-tickets-between-workflows).
- **Type set**: tickets of types the new set lacks need `ticketTypeMapping`, from old type id to
  a new type at the same level. Without it the change answers `type_in_use`.
- **Visibility policy**: tickets at a level the new policy lacks take its default level, or
  none.

A ticket keeps a priority its track stops offering until someone changes it.

### Areas

There is no web page for areas yet. A track's administrators manage them through the API:

- `GET` and `POST /api/v1/tracks/:id/areas`, with `name`, `description`, `ownerId`,
  `ownerTeamId` (the [team](people-and-groups.md#teams) that owns the area) and
  `defaultAssignee`: `area_owner`, `track_owner` or `unassigned` (the default).
- `PATCH /api/v1/areas/:id`, and `POST /api/v1/areas/:id/archive` or `/restore`.
- `DELETE /api/v1/areas/:id`: an area tickets use needs `replacementId` or
  `removeFromTickets=true`.

When a new ticket names no assignee, the first of its areas whose rule names someone who may be
assigned gives it that person. Archived areas stay on tickets but are not offered anew.

### Releases

A track's administrators add releases on the track's **Releases** page with **New release**
(**Name**, **Release date**, **Add release**). A release's own page ships it (**Ship
this release…**) and shows approvals. Shipping a release with open tickets asks where they go.
The API adds start dates, ordering, unshipping, merging, archiving, deleting and approvers under
`/api/v1/tracks/:id/releases` and `/api/v1/releases/:id`.

### Ticket templates

Ticket templates start a new ticket with a summary, an outline, default values and subtickets.
They are not the track templates under [Templates](#templates), which start a track.

- **A track's templates** are on the page **Ticket templates**, linked from the track's summary
  (the address ends in `/tracks/KEY/templates`). Anyone who can browse the track reads them. The
  track's administrators ("Administer track") and configuration administrators change them.
- **Templates for every track** are under **Settings**, **Ticket templates** for site
  administrators; configuration administrators open them by address (it ends in
  `/admin/ticket-templates`). They are offered in every track and read by everyone signed in.
  Configuration administrators and site administrators change them. They show in each track's list
  marked **Every track**, read-only there.

**New template** asks for:

| Field | What it does |
|---|---|
| **Name** | Required; unique among the templates of that track, or among those for every track, ignoring case |
| **What it is for** | Shown beside the template when someone chooses it |
| **Ticket types it fits** | The types that offer it; none means every type |
| **Summary** | A pattern: `{date}` becomes today in the person's time zone, `{track}` the track's key, `{user}` the person's name |
| **Description** | An outline in rich text |
| **Priority**, **Labels** | Default values |
| **Start date** and **Due date**, **in days from today** | Counted from the day the ticket is made; negative numbers count back |
| **Assignee**, **Area**, **Target release**, **Found in release** | Default values; track templates only |
| **Custom fields** | Add a value for a field; text, number, date, URL, choice and label fields |
| **Subtickets** | Up to 50, each a summary pattern and, when the track has several subticket types, a type; otherwise the track's first subticket type |

Custom fields of other types, and an assignee on a template for every track, can be set through the
API. The form says how many it cannot show, and saving keeps them.

Applying a template checks everything as the person making the ticket. Values they may not set, and
fields a rule hides or the layout leaves out, stay off the ticket, and the form names them, so a
template can name an assignee even if some of its users may not assign. A template is checked for
what it refers to when you save it; whether a value suits a type or a person is only known when a
ticket is made. Each track or the every-track list holds at most 500 templates. Deleting a template
changes no ticket already made from it.

Every ticket made records its template in its `ticket.created` event, as `templateId`, and adding,
changing or deleting a template is in the audit log. The API is `/api/v1/ticket-templates`, with
`POST /api/v1/ticket-templates/:id/tickets` to make a ticket from one.

### Categories

Categories group tracks. Configuration administrators manage them through
`/api/v1/track-categories` (`name`, `description`); names are unique, ignoring case. Deleting a
category leaves its tracks without one.

## Archiving a track

On **Administration**, **Tracks**, open **Manage** and press **Archive track**, then **Yes**. **Restore
track** brings it back. Only site and configuration administrators archive and restore
(`POST /api/v1/tracks/:id/archive` and `/restore`).

An archived track keeps everything and changes nothing: its tickets stay readable by link, but
nobody can change them or the track (`409 track_archived`). It is left out of search, and track
lists show it only to administrators who ask for archived tracks.

## Deleting a track and the trash

The web app has no delete button for tracks yet. Site and configuration administrators delete a
track with `DELETE /api/v1/tracks/:id`. It goes to the trash with its tickets, releases and areas.
While it is there:

- nobody else sees the track or anything in it;
- it keeps its keys, so no new track can take them;
- site administrators restore it on **Administration**, **Trash**, under **Tracks**, with **Restore
  track** (or `POST /api/v1/tracks/:id/undelete`).

The trash keeps tracks and tickets for 30 days by default. Site administrators change this under
**Retention**, **Days in the trash** (1 to 365). An hourly job then deletes them for good, in
batches; once that has started, the track can no longer be restored. Site administrators can
delete a track for good at once with `POST /api/v1/tracks/:id/purge`, and the operator command
`purge-trash` runs the job by hand ([the operator CLI](cli.md)). Only then are the track's keys
free again. See also [backups and restore](backups.md).

## Configuration guardrails

Guardrails limit how much configuration one track, field, policy, map, set or workflow may hold.
Site administrators see and change them on **Administration**, **Guardrails**: each shows where it is
used most, marks usage **Above the limit**, and takes a new **Limit** with **Save the limit**.

| Guardrail | Default |
|---|---|
| Custom fields per track | 700 |
| Ticket types per track | 150 |
| Options per field | 20,000 |
| Visibility levels per policy | 50 |
| Grants per permission | 50 |
| Releases per track (archived ones aside) | 15,000 |
| Workflows per workflow map | 150 |
| Statuses per workflow | 200 |
| Areas per track | 10,000 |
| Priorities per priority set | 100 |

- An addition beyond a limit is refused with `409 guardrail_exceeded`, naming the guardrail and
  its limit. A change that adds many at once is refused as a whole.
- Lowering a limit never removes anything; it only refuses further additions.
- A raised limit applies at once. No limit goes above 1,000,000. Pages that show all of something
  get slower as it grows, so watch them after a large raise.
- Through the API: `GET /api/v1/admin/guardrails` and `PUT /api/v1/admin/guardrails/:name` with
  `{ "limit": 1000 }` (names such as `fields_per_track`).

### Attachment storage

Below the guardrails, **Attachment storage** shows how much the attachments take in the whole
workspace and for the person who uploaded most, against two storage quotas. A new installation
starts with 1 TiB for the workspace and 20 GiB a person; an installation upgraded from a version
without quotas starts with none. Change them here, or clear a field to remove that quota.

- **Workspace quota (GiB)** limits all attachments together; **Quota per person (GiB)** limits
  what each person uploads. Leave a field empty for no quota, then **Save the quotas**.
- An upload that would pass a quota is refused with `413 storage_quota_exceeded`, naming the
  quota (`person` or `workspace`), the limit, the usage and the room left, in bytes. The ticket
  page says the same in words. Nothing of a refused file is kept.
- A lowered quota never removes files; it refuses further uploads until enough are deleted.
  Files of tickets in the trash count until the trash is purged; imports count but are never
  refused.
- Through the API: `GET` and `PUT /api/v1/admin/attachment-settings` with
  `{ "workspaceQuota": 1099511627776, "personQuota": null }` (bytes, `null` for none), beside
  `maxFileSize`.
