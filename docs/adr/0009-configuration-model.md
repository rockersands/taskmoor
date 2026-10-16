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

## Consequences

Admin pages are organised around objects (fields, workflows, policies) and their users, not
around schemes. The importer carries a golden test suite of resolved configurations so scheme
mapping is verified, not assumed.
