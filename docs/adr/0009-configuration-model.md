# ADR-009: One configuration model

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

Jira configures a project through a hierarchy of schemes: issue type schemes, field
configuration schemes, screen schemes, issue type screen schemes, workflow schemes, permission
schemes and notification schemes, each an indirection between projects and the objects they
use. Administrators find it the hardest part of Jira; imports must preserve it. The spec asks
for shared and track-local configuration on one model (CORE-003), unified field rules and
layouts (CORE-013) and track templates (CORE-004).

## Decision

- **A track's configuration is one object graph:** ticket types and hierarchy levels; fields
  with contexts, layouts (create, edit, view, transition; with tabs) and validation; workflows
  with statuses, transitions and rules; access policy; notification policy; boards,
  automation rules and SLA definitions where the module applies. The same graph serves
  shared mode and local mode: a track either references shared objects or owns
  local copies, element by element.
- **Sharing is explicit and visible.** A shared object lists the tracks that use it; saving it
  shows that list before commit. Converting between shared and local is a copy or a link, not
  a configuration set swap.
- **Templates are serialised configuration graphs** (CORE-004), with optional sample tickets,
  exportable as files.
- **Jira's scheme hierarchy is mapped by the importer** (IMP-004): each project's effective
  configuration is resolved through its schemes and written as shared objects where several
  projects resolve to the same one, local otherwise. The native model never exposes scheme
  objects, and the Jira-compatible API shim (ADR-016) synthesises them where clients ask.

## Options considered

| Option | For | Against |
|---|---|---|
| One configuration graph with explicit sharing (chosen) | Understandable admin UI; templates and export fall out of it; one model for the query engine and API | Importer does the resolution work |
| Replicate Jira's schemes one to one | Lossless import | Reproduces the main administration complaint; the shim can still present schemes |
| Per-track configuration with no sharing | Simplest | Large sites need one change to reach many tracks; the spec requires shared configuration |

## Implementation (M1-006: the track)

Migration 0008 expands the `track` table of M1-002 and adds `track_category` and
`track_key_history`; the API is `/api/v1/tracks` and `/api/v1/track-categories`
(`apps/server/src/routes/tracks.ts`, rules in `apps/server/src/tracks/model.ts`).

- **Type and mode are columns.** `type` is software, business, service or discovery; `mode`
  is shared or local and is fixed at creation (converting a track between modes waits for
  the configuration objects it would copy). Existing tracks became shared software tracks.
- **Feature toggles are one boolean column each** (`feature_board` to `feature_timeline`, the
  nine of CORE-002), so queries and boards filter on them directly. The type is only the
  preset applied at creation: software turns all nine on; business and service turn on board,
  forms, approvals, calendar and timeline; discovery turns on board, forms and timeline. A
  track administrator changes any toggle later; turning one off deletes nothing.
- **Keys.** New keys follow the native rule: an ASCII letter, then letters or digits, 2 to 10
  characters, stored upper case (input is upper-cased for ASCII letters only). The spec asks
  that every key in imported Jira data be accepted (CORE-001 (3)), and a Jira site's
  administrator can widen the key pattern, so the importer uses a wider rule: an ASCII letter,
  then letters, digits or underscores, 1 to 255 characters (verify against real import data;
  neither rule allows the hyphen that separates key and number). Lookups accept either.
- **Every key a track has had is a row in `track_key_history`**, the current one included,
  under one unique index on `(workspace_id, upper(key))`. An old key therefore keeps resolving
  (`GET /api/v1/tracks/ABC` answers with the track and a redirect to its current key) and no
  other track can take it, by create or by rename; the track itself may take an old key back.
  A trigger on `track` writes the table, so the importer and direct SQL keep it complete, and
  concurrent creates or renames to the same key are settled by the unique indexes (409).
- **The default policy is a flag** (`access_policy.is_default`, one per workspace; migration
  0004's "Default access policy" got it). New shared-mode tracks use it unless a shared policy
  is named. Shared-mode tracks are created by site and configuration administrators.
- **Local mode owns its access policy.** A local-mode track (global permission "Create
  local-mode tracks") gets a copy of the default policy's grants in a policy whose
  `owner_track_id` is the track. The copy is the first element of "the track owns local copies,
  element by element": changes to it reach no other track, changes to the default no longer
  reach it, no shared track may use it, and the track's administrators read and change its
  grants without being configuration administrators (section 1.1). Fields, ticket types and
  workflows follow the same pattern when they arrive (M1-007 onwards).
- **The creator becomes owner** (unless another owner is named) **and joins the role that the
  track's policy lets administer the track** (Administrators by default), found through the
  grants rather than by name so a renamed role still works.
- **Categories** are workspace-scoped with names unique ignoring case; configuration
  administrators manage them and deleting one leaves its tracks without a category.
- **Archiving** (CORE-025) belongs to site and configuration administrators. It sets
  `archived_at` and `archived_by`; the authorizer then keeps only read permissions in the
  track for everyone and leaves it out of the search pre-filter (ADR-012, implementation
  note), so nothing in it can change until it is restored. Lists show archived tracks only to
  administrators who ask (`?archived=include` or `only`); a link still opens one read-only.
- **Events:** `track.created`, `track.updated` (field changes, `features.<name>` for toggles),
  `track.archived`, `track.restored` and `track_category.created`, `.updated`, `.deleted`;
  one per mutation, the local policy copy and the creator's role included in `track.created`.

## Implementation (M1-007: hierarchy levels, ticket types and type sets)

Migration 0011 adds `hierarchy_level`, `ticket_type`, `type_set`, `type_set_member`,
`type_set_default` and `track.type_set_id`; the API is in
`apps/server/src/routes/ticket-types.ts`, the rules in `apps/server/src/tickets/hierarchy.ts`
(a pure model with property tests) and `tickets/configuration.ts`.

- **Levels belong to the workspace, not to a track:** a parent may sit in another track (spec
  01a section 1.2, rule 5), so every track sees one ladder. Each level stores its rank. The
  built-in levels keep theirs (subticket -1, standard 0, Outcome 1) and are renamed but never
  moved or removed; custom levels take 2 and above without a gap, so adding, moving or removing
  one renumbers the custom levels above it in the same transaction (a deferred unique
  constraint on the rank, and an advisory lock per workspace so two changes never start from
  the same ladder). Removing a level moves its ticket types to the standard level (rule 7).
- **Several ticket types share a level;** a ticket's level is its type's. Changing a type's
  level is a hierarchy change like the others.
- **Impact before change** (CORE-007 (1)): `GET /api/v1/hierarchy-levels/impact` shows the
  levels and types that would move, the parent links that would break and the parentless
  tickets that would land on the subticket level. Until rollback exists (CORE-007 (2), which
  needs tickets, M1-008 onwards), a change that would break a parent link is refused with that
  impact instead of being applied.
- **Type sets are ordered lists of ticket types with an optional preselected member** (a
  deferred foreign key keeps the default a member). Each track type has one default set in
  `type_set_default` (software, business and discovery sets ship; service tracks use the
  business set until request forms arrive); a track type never loses its default, another set
  takes it over. Every set lists the tracks that use it (section 1.5).
- **Local mode follows the access policy's pattern:** a local-mode track gets a copy of its
  type's default set, owned by the track, and may own ticket types; its track administrators
  change both without being configuration administrators. A shared set only holds shared
  types, a local set holds shared types and its own track's types, and neither a local set nor
  a local type reaches another track.
- **A type in use stays.** A ticket type is deleted only once no set holds it, and a set (or a
  track switching sets) drops a type only when no ticket of it remains in the tracks
  concerned; mapping those tickets to another type (CORE-005 (2)) comes with tickets.
- **Events:** `hierarchy_level.created`, `.updated`, `.deleted` (with the levels renumbered
  and the types that fell to the standard level), `ticket_type.*` and `type_set.*`, all
  audited; `track.created` names the track's type set and `track.updated` a change of it.

## Implementation (M1-008: tickets)

Migration 0014 adds `ticket`, `ticket_counter`, `ticket_key_history`, `ticket_detached_parent`
and the sequence `ticket_rank_seq`; the API is `apps/server/src/routes/tickets.ts`, with the
data access in `tickets/store.ts`, the rules in `tickets/model.ts` and the rank keys in
`tickets/rank.ts` (ADR-037).

- **A key is the track's key and a number.** `ticket_counter` holds the last number per track;
  taking the next one locks that row until the transaction ends, so parallel creates in a
  track get consecutive numbers and a rolled-back create gives its number to the next.
  `ticket_key_history`, written by a trigger, keeps every track and number a ticket has had,
  with one unique index over all of them: a number belongs to one ticket for good, and an old
  key keeps resolving after a move (CORE-023 (3)) as old track keys do after a rename.
- **System fields now:** track, number, type, parent, summary, description and environment
  (ProseMirror documents checked against the shared schema, ADR-014), assignee, requester,
  creator, start and due dates, rank, created and updated, plus `version` for optimistic
  saves. Status, priority, close reason, labels, areas, releases and custom fields arrive with
  their own tasks as columns or side tables (ADR-008).
- **Level rules hold for every stored ticket, the trash included,** so a restore never brings
  back a broken link. Writes that check levels hold the workspace's hierarchy lock shared
  (hierarchy changes hold it exclusively) and take their locks in one order: the hierarchy,
  the track and its type set (key share), then tickets. A type set change and a track's switch
  of set hold their row first and rewrite tickets after, so neither deadlocks with a ticket
  write. A subticket lives in its parent's track and moves with it.
- **Hierarchy changes read only the tickets they can affect:** those of types whose level
  changes, with their parents and children.
- **A type leaving a track takes a mapping** (CORE-005 (2)): `ticketTypeMapping` on a type set
  change or a track's switch of set names the new type for each leaving type with tickets; the
  new type must stay offered and sit at the same level, so no link changes. Without one the
  change answers `type_in_use`.
- **The trash** (CORE-025 (3)): deleting keeps the row with `deleted_at`; subtickets go along
  (`trashed_with`), other children lose the link and `ticket_detached_parent` remembers it. A
  restore brings back the subtickets and re-attaches the children that have no other parent
  since. A ticket whose parent is still in the trash comes back without the link, which the
  parent's restore puts back; a subticket waits for its parent. The trash keeps tickets for
  30 days; the setting and the purge job are M1-101.
- **Permissions per field:** create, edit, assign, modify requester and schedule (dates and
  rank) as in spec 05a; moving needs "Move tickets" in the source and "Create tickets" in the
  target; deleting and restoring "Delete tickets". Ticket-level grantees (requester, assignee)
  and visibility levels apply per ticket from M1-020.
- **Events:** `ticket.created`, `.updated`, `.moved`, `.ranked`, `.deleted` and `.restored`;
  deletion and restore are audited, the rest is ticket activity for the change history
  (M1-009).

## Implementation (M1-009: change history)

Migration 0015 adds `ticket_change`, hash-partitioned by ticket into 16 partitions, and the
sequence `ticket_change_set_seq`; the rules are in `apps/server/src/tickets/history.ts`.

- **Every ticket mutation records one row per field it changed,** in its own transaction: the
  value before and after as text (ids for references, ISO days, canonical JSON for rich text)
  and the names those values had then, so history reads right after a rename. Rows of one
  mutation share a change set, across tickets too (a move with its subtickets, a deletion that
  detaches children, a type mapping). The fields follow the query language's names (track,
  key, type, parent, summary, description, environment, assignee, requester, startDate,
  dueDate, rank, trash).
- **A new ticket records every value it starts with,** so `WAS` finds the first value
  (ADR-010) and replaying a history from nothing gives the ticket as it is.
- **Reads go to one partition through the primary key** (ticket, id):
  `GET /api/v1/tickets/:id/history` pages newest first (or oldest first) with a cursor, up to
  1,000 rows a page; a page of a 20,000-change history takes milliseconds. History is never
  truncated (CORE-022 (3)); it leaves only with its ticket.
- Comments, links, attachments and time entries add their own fields to the same table when
  they arrive (M1-015 to M1-019).

## Implementation (M1-014: priorities, close reasons, labels, releases and areas)

Migration 0018 adds the lists, sets and side tables; the routes are `routes/priorities.ts`
(priorities, priority sets, close reasons, labels) and `routes/releases.ts` (releases and
areas), the ticket rules `tickets/fields.ts`.

- **Priorities and close reasons are the workspace's ordered lists,** with a gapless order
  under a deferred unique constraint; `PUT .../order` names every value once. A fresh install
  has the defaults of spec 01a section 1.6.
- **A priority set chooses which priorities a track offers and the default for new tickets**
  (CORE-014 (2)). `track.priority_set_id` null means the workspace's default set, which every
  new priority joins and which cannot be deleted; deleting another set sends its tracks back to
  it. A ticket keeps a priority its track stops offering until someone changes it, so a switch
  of set rewrites no tickets.
- **Deleting a value tickets use takes a replacement** (CORE-014 (3)): the tickets take it,
  each with a new version and a history row, as one change set; for a priority, the sets that
  offered it offer the replacement, as their default where it was. Areas take a replacement or
  `removeFromTickets=true`; releases merge or take that flag.
- **Lock order:** a change that rewrites tickets locks the value first (`FOR UPDATE`) and the
  tickets after, in id order; ticket writes hold the values they point at (`FOR KEY SHARE`)
  before they lock the ticket. A ticket write that loses the race finds the value gone
  (`not_found`), never a dangling reference; a test races 20 writes against a deletion.
- **Labels are a `text[]` on the ticket** (GIN-indexed), one word each, in the order given,
  with the `label` table as the workspace's vocabulary for suggestions (CORE-017 (1)). Merging
  replaces labels in place on every ticket that has one, keeping the first position
  (CORE-017 (2)); a rename is a merge into a new name. Suggestions are workspace-wide, as the
  spec asks, so a label name is visible to everyone signed in.
- **Releases and areas belong to a track;** its administrators manage them. Archived ones stay
  on tickets that have them; no ticket takes one anew. A ticket lists its releases in the
  track's release order and its areas by name; moving it to another track drops both.
- **Shipping** (CORE-016): open target tickets (outside the trash, `closed_at` null) make it
  answer 409 `open_tickets` until the call names `moveOpenTo` another upcoming release, or
  null to leave them. With approvals required, every approver must approve; a decline blocks
  and is recorded (`release.approval_decided`). A release with approvals required and no
  approvers ships. `closed_at` is set by workflows from M1-023.
- **An area's rule assigns new tickets** that name no assignee (CORE-015 (1)): the first of
  their areas whose rule names someone (its owner, or the track's owner) who may be assigned.
- History fields: `priority`, `closeReason`, `labels` (space-separated), `targetRelease`,
  `foundInRelease` and `area` (ids by commas, names by ", "). All new events are audited:
  they are configuration.

## Implementation (M1-015: links, web links, followers and votes)

Migration 0019 adds `link_type`, `ticket_link`, `link_policy`, `ticket_web_link`,
`ticket_follower`, `ticket_vote` and `user_preference`; the routes are `routes/links.ts`.

- **Link types are the workspace's,** with a name and the phrase each side reads; a link is
  stored once, from source to target, and each ticket reads it from its side ("blocks", "is
  blocked by"; CORE-018 (2)). The copy type that cloning uses (CORE-023) is marked and cannot
  be deleted. Deleting another type in use takes a replacement; a pair the replacement
  already links keeps that single link (CORE-018 (1)). A workspace switch stops new links and
  leaves existing ones.
- **Links cross tracks;** a ticket lists only links whose other ticket the viewer may browse,
  checked once per track rather than once per link, and none to tickets in the trash, whose
  links return with them. One query reads both directions; 1,000 links load well under
  300 ms.
- **Web links** carry a title, an icon and an optional global id; adding the same global id
  again updates that link, so an integration keeps one per object, and
  `GET /api/v1/web-links?globalId=` finds the tickets. URLs must be http or https. Events
  name changed fields, never URLs, which can carry tokens.
- **History:** a link records a `link` row on both tickets (value `type:side:ticket`, display
  "blocks ABC-2"); web links record `webLink` (URL, display title). Following and voting are
  not history.
- **Followers and votes** (CORE-019): one row per person and ticket, no cap. Everyone who may
  browse a ticket follows and votes for themselves and sees the counts (also on the ticket
  view); the names need "View voters and followers", others' following "Manage followers",
  and a follower must be able to browse the track. People follow what they create and edit
  unless they turn `autoFollow` off (`/api/v1/account/preferences`); comments join in M1-017.

## Consequences

Admin pages are organised around objects (fields, workflows, policies) and their users, not
around schemes. The importer carries a golden test suite of resolved configurations so scheme
mapping is verified, not assumed.
