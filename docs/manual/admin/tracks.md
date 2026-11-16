---
title: "Tracks"
audience: admins
sources: apps/server/src/routes/tracks.ts, apps/server/src/tracks/model.ts, apps/server/src/tracks/templates.ts, apps/server/src/routes/authz.ts, apps/server/src/routes/releases.ts, apps/server/src/routes/workflow-maps.ts, apps/server/src/routes/guardrails.ts, apps/server/src/guardrails/model.ts, apps/server/src/routes/trash.ts, apps/server/src/trash/policy.ts, apps/server/src/trash/purge.ts, apps/server/src/tokens/scopes.ts, apps/server/src/cli.ts, apps/web/src/configuration/TracksAdminPage.tsx, apps/web/src/configuration/client.ts, apps/web/src/configuration/NewTrackForm.tsx, apps/web/src/tracks/TracksPage.tsx, apps/web/src/admin/SettingsPage.tsx, apps/web/src/admin/TrashPage.tsx, apps/web/src/guardrails/GuardrailsPage.tsx, apps/web/src/guardrails/StorageQuotas.tsx, apps/server/src/attachments/quota.ts, apps/server/src/routes/attachments.ts, docs/adr/0110-outbound-guard-archive-limits-storage-quotas.md, apps/web/src/releases/ReleasesPage.tsx, apps/web/src/i18n/messages.en.ts, packages/db/src/migrations/0004_authorization.ts, docs/adr/0009-configuration-model.md, docs/adr/0051-configuration-guardrails.md, docs/adr/0062-track-templates.md, docs/specs/01a-core-work-tracking.md, apps/server/src/routes/setup.ts, apps/server/src/authz/create-tracks.ts, docs/adr/0118-track-invitations.md, apps/web/src/tickets/templates/TicketTemplatesPage.tsx, apps/web/src/tickets/templates/TemplateForm.tsx, apps/web/src/tickets/templates/draft.ts, apps/web/src/tickets/templates/client.ts, apps/web/src/tickets/CreateTicketPage.tsx, apps/web/src/tickets/form.ts, apps/server/src/routes/ticket-templates.ts, apps/server/src/templates/model.ts, docs/adr/0113-ticket-templates.md, apps/server/src/sprints/lifecycle.ts, apps/server/src/tracks/membership.ts, apps/server/src/routes/track-groups.ts, apps/server/src/trackgroups/access.ts, apps/web/src/trackgroups/TrackArrangement.tsx, apps/web/src/trackgroups/ShareGroupDialog.tsx, packages/db/src/migrations/0100_track_groups.ts, docs/adr/0121-personal-track-groups.md, apps/server/src/notifications/track-groups.ts, apps/server/src/trackgroups/privacy.ts, packages/db/src/migrations/0103_checklist_notices.ts, apps/server/src/notifications/checklists.ts, apps/web/src/tracks/NewTrackDialog.tsx, apps/web/src/shell/ModalDialog.tsx, apps/server/src/api/operations.ts, apps/web/src/admin/NewButton.tsx, apps/web/src/tickets/pickerSources.ts, apps/web/src/tickets/PersonPicker.tsx, apps/server/src/routes/fields.ts, apps/server/src/routes/rich-text.ts, apps/server/src/routes/users.ts, apps/server/src/routes/teams.ts
accessed: 2026-11-16
attestation: own-words
---
# Tracks

A track holds tickets, the configuration they follow and the people who work in it. This page
covers making a track, the two configuration modes, a track's settings, archiving, deleting, and
the guardrails that limit how much configuration one track can hold. For the ideas behind
tracks, see [concepts and terms](../concepts.md).

## Where tracks are managed

Site and configuration administrators manage tracks in the web app under **Administration**, **Tracks**. The page adds
tracks, renames them, chooses their workflow map, turns their sprints on or off, gives roles to
people and groups, and archives and restores them. With no track yet, it says so and what a track
is.

Everything else is done through the [REST API](rest-api.md) under `/api/v1/tracks`.
`GET /api/v1/tracks/:id` takes a track's id or key; the routes that change a track take its id. A token that changes shared configuration needs the
`admin` scope; see [API tokens](api-tokens.md). `GET /api/v1/tracks?member=true` lists only the
tracks the caller belongs to, as **Your tracks** on Home does (see
[Your tracks](../use/tickets.md#your-tracks)): a role given to them or to one of their groups,
a track they lead, or one whose board or area names a team of theirs. Tracks they see only
because they are open to everyone, through a grant of the access policy, or as an administrator
are left out. `keys=OPS,SHOP` (at most 50 keys, ignoring case) keeps only the tracks with those
keys; Home sends it with the tracks you opened lately, so it finds them however many tracks you
belong to.

**Tracks** in the sidebar opens the page that lists every track you can see, with a box to find one
by name or key. It stays marked as the current place while you are inside a track, on a ticket or on a
board.

## Groups of tracks

Everyone arranges the **Tracks** page in groups of their own. A group is yours alone until you
share it. An open group is a glass bubble with its tracks inside; a minimized group takes the
place of one track card and shows its name, how many tracks it holds and a small square for each.
Tracks in no group follow under **Tracks in no group**. Typing in **Find a track** lists the
matches plainly, without groups.

Each card and each group has a grip at its corner. Drag it with the mouse or a finger, or press
it for a menu of the same moves; with the grip in focus, Alt and the arrow keys move a track
within its group or a group within your order.

| To | Drag | Or from the grip's menu |
|---|---|---|
| Make a group | A track onto another track in no group, then name the group | **New group with this track** |
| Put a track in a group | The track onto the group, or onto a track in it for that place | **Move to** and the group |
| Take a track out | The track down to **Tracks in no group** | **Take out of** and the group |
| Change the order | A track within its group, or a group onto another | **Move earlier**, **Move later** |

A group's own menu also has **Rename**, **Share…**, **Set on someone…** and **Delete group…**,
which first says what will happen and offers **Delete** with the group's name beside **Cancel**;
the arrow beside its name minimizes and opens it. A track sits in only one of your groups:
moving it into another takes it out of the first. Your arrangement is kept on the server, so it
is the same on every device. A group shows only the tracks you may see.

### Sharing a group

**Share…** shows the group on another person's **Tracks** page as you keep it: when you rename
it or move tracks, they see the change. They may minimize it and put it where they like among
their groups, nothing more. You choose a person and a **Role on its tracks**, or **No role: the
group only**:

- With a role, they get it on each of the group's tracks where you could give it on that track's
  **Who does what** page: tracks you run, and for a role that runs the track, tracks where you may
  also appoint who runs it. Each role in the list says on how many of the group's tracks you may
  give it. Where you may not, the share gives nothing.
- A track you later move into a shared group brings the role, if you may give it there; a track
  you move out takes it back.
- **Take back** (or deleting the group) removes only the roles the share gave. A role the person
  already had, or that someone gives them afterwards on the track's page, by an invitation or by
  an import, stays. A role two shared groups gave stays until both are taken back.
- If what you take back was the last track the person ran, a permission to create tracks they got
  with a role goes too ([Letting a manager create tracks](invitations.md#letting-a-manager-create-tracks)).
- Nothing is taken back that would leave a track with nobody to run it; give someone else that
  role on the track first. If the group's owner is erased, such a role stays with the person
  instead, as their own (see [Erasing a person](people-and-groups.md#erasing-a-person)).
- Only active people can receive a group. A person deactivated after you shared stays listed as
  deactivated, and you can still take the share back.

To change the role, take the share back and share again. The roles a share gives are ordinary
roles: they show on each track's **Who does what** page, where its administrators can remove
them, and every share, take-back and role that came or went is in the audit log.

The person you share a group with, or set it on, hears of it in their
[inbox](../use/notifications.md#the-inbox) and by email, as their notification settings say. The
notice names the group and you, and the role if you chose one; never its tracks.

### Leaving a group shared with you

A group someone shared with you has **Leave group…** in its menu. It first says what goes: the
group leaves your page, and the role it gave you goes from as many of the tracks you see in it as
the share alone gave it on. A role you hold any other way stays, the same as when the owner takes
the share back, and nothing is taken that would leave a track with nobody to run it. Once you
leave, the tracks it opened to you go from the page at once, the page says you left, and the
keyboard stays on the page: on a group or track still there, or on the note that no track is left
when the group was all you had. Only the owner can share it with you again. The owner's audit log
records who left and which roles went.

### Setting a group on someone

**Set on someone…** gives a person a group of their own: a copy with the same name and tracks,
marked **From** and your name. From then on it is theirs to rename, rearrange or delete, and
later changes on either side do not reach the other. Tracks they already keep in one of their
groups stay where they put them. A role works as for sharing, but it is given as an ordinary role
that no share holds: deleting either group takes nothing away.

### Groups through the API

`GET /api/v1/track-groups` answers your groups and those shared with you, in your order; every
change answers the same. `POST /api/v1/track-groups` makes a group (`name`, `trackIds`),
`PATCH /api/v1/track-groups/:id` renames or minimizes it, `PUT /api/v1/track-groups/order` sets
the order, `PUT` and `DELETE /api/v1/track-groups/:id/tracks/:trackId` move a track in (with an
optional `position`, counted among the tracks you see) and out, and
`DELETE /api/v1/track-groups/:id` deletes a group.
`GET`, `POST /api/v1/track-groups/:id/shares` and `DELETE …/shares/:userId` list, make and take
back shares (`userId`, `roleId` or `null`); `POST /api/v1/track-groups/:id/copies` sets the group
on someone; `POST /api/v1/track-groups/:id/leave` leaves a group shared with you, answering your
groups (`403` for your own group). A group shared with you carries `holds`: on how many of the
tracks it shows you its role is yours through that share alone. A refusal to take back answers
`409` with `last_track_admin` and the tracks; a deactivated person, or one erased while the share
waited, answers `400` with `person_inactive`. Reading needs a token's `read` scope and
changing its `write` scope; finding people (`GET /api/v1/track-groups/people?q=`) needs the
**Browse users** permission.

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

The form opens in a dialog over a dimmed page. **Close** at its title, **Cancel**, Escape or a
click on the page around it leaves without making a track.

Administrators can also use **Administration**, **Tracks**, where **New track** opens the same form, **Add a track**.
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
  configuration**. On a new site nobody but site administrators holds it. A site administrator
  gives it on [Permissions and access](permissions.md); giving someone the role that runs a track
  can give it too ([Letting a manager create tracks](invitations.md#letting-a-manager-create-tracks)).
  A site set up with an earlier version keeps what it had, usually everyone signed in; remove
  that grant to follow the new default.

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
`PATCH /api/v1/tracks/:id`. In the web app, **Manage** on a track offers **Rename** and the
**Sprints in** box for the track.

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
| Checklist notices | `checklistNotices` | `true` tells the followers of its tickets when checklists change ([Checklist changes](../use/notifications.md#checklist-changes)). Off for a new track; a copy (`copyFrom`) takes the source's. In the web app, on the track's **Manage** page under **Tracks you run** |

Turning a feature off deletes nothing. The board's kind decides **backlog** and **sprints**: a
Scrum board turns both on and a Kanban board turns both off, also when the kind changes, recorded as
a change of the track. The web app shows a Backlog and reports that follow sprints only on a track
with a Scrum board and those features on. For the other features, Taskmoor stores the choice, but the
web app and the API do not yet hide the parts a track has turned off.

**Sprints** cannot be turned off while a sprint is running on the track's board, as the board cannot
change to Kanban then: the answer is `409 sprint_running`, with `sprintId` and `sprintName` naming
the sprint, nothing changes and nothing is recorded. With several active sprints, each has to be
completed first. In the web app, the **Sprints in** box stays ticked, names the sprint and links to
the track's board, where **Complete sprint** finishes it. While sprints are off, starting a planned
sprint is refused too (`409 sprints_off`), and the backlog offers no **Start sprint**; turning them
on again lets it start.

**Sprints** go on only for a track whose board is Scrum, since the board's kind decides them. For a
Kanban board, or a track with no board yet (its first board is Kanban), turning them on is refused
with `409 not_scrum` and `boardId` (`null` when there is no board), and nothing changes. In the web
app, **Manage** shows the **Sprints in** box only on a track with a Scrum board. Elsewhere it says
why: for a Kanban board it links to the board's settings, where its kind changes to Scrum; for a
track with no board it links to the track's board, which is made when it is first opened.

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
A person may also hold a role through a [shared group of tracks](#sharing-a-group); it shows here
like any other. Giving them that role here makes it theirs, so taking the share back leaves it.

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
  (the address ends in `/tracks/KEY/templates`). It sits under the track's tab bar, titled
  **Ticket templates** under the track's name, and its line says it lists the templates offered in
  this track, those for every track included. Anyone who can browse the track reads them. The
  track's administrators ("Administer track") and configuration administrators change them.
- **Templates for every track** are under **Settings**, **Ticket templates** for site
  administrators; configuration administrators open them by address (it ends in
  `/admin/ticket-templates`). They are offered in every track and read by everyone signed in.
  Configuration administrators and site administrators change them. They show in each track's list
  marked **Every track**, read-only there.

**Delete** on a template, in the danger colour, asks first: tickets already made from it stay as
they are.

**New template**, under the page's title and its line, opens the form above the list; it stays
there while a template is being changed. It asks for:

| Field | What it does |
|---|---|
| **Name** | Required; unique among the templates of that track, or among those for every track, ignoring case |
| **What it is for** | Shown beside the template when someone chooses it |
| **Ticket types it fits** | The types that offer it; none means every type |
| **Summary** | A pattern: `{date}` becomes today on the person's clock (the time zone saved in their account, else their device's), `{track}` the track's key, `{user}` the person's name |
| **Description** | An outline in rich text |
| **Priority**, **Labels** | Default values |
| **Start date** and **Due date**, **in days from today** | Counted from the day the ticket is made; negative numbers count back |
| **Assignee**, **Areas**, **Target releases**, **Found in releases** | Default values; track templates only |
| **Custom fields** | Add a value for a field; text, number, date, URL, choice, label, person, group and team fields, and on a track's template release and area fields |
| **Subtickets** | Up to 50, each a summary pattern and, when the track has several subticket types, a type; otherwise the track's first subticket type |

A custom release or area field shows under **Custom fields** with its values by name, an archived
one marked **(archived)** and one the track does not have named by its number, each with
**Remove**. Below them, **Release to add to** (or **Area to add to**) and the field's name lists the
track's releases or areas that are not archived and not yet chosen, as the create form offers
them; choose one and press **Add**. A field that holds a single value offers this list once its
value is removed. When the track has none that are not archived, the form says so instead. On a
template for every track there are no releases or areas to choose, so these fields are not
offered.

A custom person, group or team field shows under **Custom fields** with its values by name, as the
create form's pickers name them, each with **Remove**. Below them, **Person to add to** (or
**Group to add to**, **Team to add to**) and the field's name is the create form's search: type a
name and press the one you want. It never offers a value the field already holds, and a field that
holds a single value offers it once its value is removed. It looks where the create form looks:

- On a track's template, people who can be found in the track. When the field allows only some
  people (it is limited to a group or a role), only the people it allows are offered, for every
  ticket type the template fits (all of the track's types when it names none), so someone a Bug
  allows but a Chore does not is left out of a template for both.
- On a template for every track, anyone active on the site, as configuration administrators find
  people when they give a track's roles. A person field that allows only some people anywhere has
  no search there, since who it allows is only known for a track and a ticket type, and the form
  says so: set it on a track's template, or through the API.
- Groups and teams are the site's, wherever the template is.

One you may not see (people and groups need "Browse users and groups"), or one that is gone, is
named by its number, for example "Group 52, hidden from you or gone", and saving keeps it unless
you remove it. Other custom field types, and an assignee on a template for every track, are set
through the API. An archived release or area the template already holds also stays chosen,
marked, in **Areas**, **Target releases** and **Found in releases**. For the other types, and for
a value it cannot read as ids, the form says how many values it cannot show, and saving keeps them
as they are.

When a save is refused over a value, the reason shows under that value, in the words the create
form uses (for example "This release or area is archived. Choose another." or "This track does not
offer this choice. Choose one of its own."), and the line above **Save the template** says to look
under each value. A reason goes as soon as you change its value, and the line goes with the last
one. A refused value the form does not show keeps the general line, which says to check the days,
the fields and the subtickets.

Applying a template checks everything as the person making the ticket. Values they may not set, and
fields a rule hides or the layout leaves out, stay off the ticket, and the form names them, so a
template can name an assignee even if some of its users may not assign. A template is checked for
what it refers to when you save it: an archived release or area, in its own field or a custom
one, is refused as it would be on a new ticket, and so is a custom field's release or area of
another track. One the template already held before it was archived stays, so you can still edit
the rest of the template after a release ships; a ticket made from it leaves that value out and
says so. Whether a value suits a type or a person is only known when a ticket is made. Each track or the every-track list holds at most 500 templates. Deleting a template
changes no ticket already made from it.

Every ticket made records its template in its `ticket.created` event, as `templateId`, and adding,
changing or deleting a template is in the audit log. The API is `/api/v1/ticket-templates`, with
`POST /api/v1/ticket-templates/:id/tickets` to make a ticket from one. Reading one,
`GET /api/v1/ticket-templates/:id` also gives `names`: the names of the people, groups and teams its
custom values name, by body key (`fields.12`), as far as the reader may see them.

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
used most (a permission by its name, a bulk change by its kind), marks usage **Above the limit**,
and has its own **Limit** field, which takes a whole number with or without separators. One
**Save the limits** at the end saves every limit you changed.

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
  `{ "limit": 1000 }` (names such as `fields_per_track`), stable operations of the
  [REST API](rest-api.md). Each guardrail's `usage.where` names what holds the largest count; for
  grants per permission it is the access policy, with the permission's key in its own
  `permission` field.

### Attachment storage

Below the guardrails, **Attachment storage** shows how much the attachments take in the whole
site and for the person who uploaded most, against two storage quotas. A new installation
starts with 1 TiB for the site and 20 GiB a person; an installation upgraded from a version
without quotas starts with none. Change them here, or clear a field to remove that quota.

- **Site quota (GiB)** limits all attachments together; **Quota per person (GiB)** limits
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
