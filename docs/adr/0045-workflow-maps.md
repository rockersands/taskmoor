# ADR-045: Workflow maps, track-local workflows and background status migration

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-028

## Context

WF-001 (3) asks for "Bug uses W1 and Chore uses W2 in the same track": workflow assignment
through a workflow map per ticket type in shared mode, and per track in local mode (spec 01a
section 1.1: a local-mode track owns its workflows, its administrators edit them, nothing leaks
to other tracks). Until now a track had one workflow (`track.workflow_id`, null for the
workspace's default), switched in the request that changed it (ADR-039). The backlog's measure
is a map switch on a 100,000-ticket track in under five minutes, with history rows. Every place
that reads a ticket's workflow (create, transitions, the transitions offered, move, a change of
type, per-status locks, bulk transitions, publish impact, "used by") had to follow.

## Decision

- **A ticket's workflow is the one its track's map gives its ticket type.** `workflow_map` has a
  name, a description, a default workflow and entries (`workflow_map_entry`, ticket type to
  workflow); a type the map does not name uses the default. `track.workflow_map_id` names a
  track's map; null means the workspace's default map (`is_default`), which every type sends to
  the default workflow until an administrator changes it. The database function
  `ticket_workflow_id(workspace, track, type)` is the one definition: the trigger that gives an
  imported ticket its initial status uses it, and so do set-based queries.
- **`track.workflow_id` is dropped** (migration 0042). Each track's workflow became its map's
  default: one shared map per workflow for shared-mode tracks (`<workflow> map`), the default
  map for tracks on the default workflow, and an own map for each local-mode track. The track
  API replaces `workflowId` with `workflowMapId` (PATCH, view); there is no alias, as an alias
  would have to invent maps.
- **Shared and local maps.** Shared maps belong to site and configuration administrators
  (`/api/v1/workflow-maps`) and serve any number of shared-mode tracks. A local-mode track gets
  its own map when it is created (`<KEY> workflows`, default workflow first), which its
  administrators change; it may name shared workflows and types and the track's own. A
  local-mode track never takes a shared map, and a shared map never names a track's workflow.
- **Track-local workflows.** `workflow.owner_track_id` marks a workflow a local-mode track owns
  (`trackId` on create). Its administrators change, publish and delete it through the existing
  workflow routes; lists show shared workflows, and a track's own with `?trackId=`. Names are
  unique among shared workflows and within each track. Statuses stay the workspace's: a track
  uses the statuses there are, and only administrators add statuses.
- **Lock order.** A ticket write holds its track (key share), then the track's map (key share),
  then the workflow (key share), then the ticket. A change of a map holds the map (update) before
  it reads the tickets it affects; a track's switch holds the track (update), then both maps and
  every workflow they name. A move holds every workflow of the target's map, since the types it
  needs are known only once its tickets are locked; a transition checks that the ticket's track
  and type are still the ones whose workflow it holds (409 `moved_meanwhile` otherwise).
- **Status mapping.** A change that leaves tickets in statuses their type's new workflow lacks
  needs `statusMapping` (from status to target, for every type) and, where a type needs another
  target, `typeStatusMapping` (`{type: {from: to}}`). Without one it answers 409
  `status_mapping_required` with each type and status, its ticket count and the new workflow; a
  target outside that workflow answers 400. `GET /api/v1/tracks/:id/workflow-map/impact` and
  `POST /api/v1/workflow-maps/:id/impact` show the types whose workflow changes and the statuses
  lost, by type, before anything changes.
- **Background migration.** The change commits at once: the next ticket created, moved or
  transitioned uses the new workflow. The tickets to move are recorded as a
  `workflow_migration` (who asked, progress, one history change set) with steps (track, type,
  from status, to status, count). Up to 500 tickets move in the request through the same batch
  code; more go to the `workflow.migrate` job, which moves 2,000 tickets per transaction with
  set-based SQL (`FOR UPDATE SKIP LOCKED`, so a ticket someone is writing is taken in a later
  batch), a new version, a status history row each in the migration's change set with the
  person who asked as actor, the change log rows the ticket triggers write, and formulas
  recomputed. Parts run 50 seconds and hand over, as bulk operations do (ADR-043). No per-ticket
  domain event: the request's own event (`track.updated` or `workflow_map.updated`, with
  `statusMapped` and `statusMigrationId`) is audited, and each ticket's history holds its move.
  Progress: `GET /api/v1/workflow-migrations/:id`. There is no cancel: a half-done migration
  would leave tickets in statuses their workflow lacks.
- **Tickets keep working meanwhile.** A ticket not reached yet offers the transitions of its
  mapped status; a transition first moves it as the migration would (same change set and
  actor), then runs against the new workflow, in one transaction, and a refused transition
  rolls both back. Edits need no workflow and go on as usual; a move or a change of type maps
  the status itself.
- **While a migration runs** the tracks it covers refuse another switch of map, the maps they
  use refuse a change of default or entries, and the workflows they use refuse a publish (409
  `status_migration_running` with the migration id), so a mapping's target stays in its workflow
  until every ticket has moved. Renames and descriptions go on.
- **Changes of type.** A ticket edit that changes its type to one whose workflow lacks its
  status takes `statusId` or that workflow's initial status (`statusId` without a type change
  is refused); a move maps each ticket, subtickets included, by the workflow its type has in the
  target; a type set change (CORE-005 (2)) gives the tickets it retypes their new workflow's
  initial status where needed, with history, as a move without a status does.

## Options considered

| Option | For | Against |
|---|---|---|
| Map per track, set-based background migration, transitions settle first (chosen) | Change in force at once; 100,000 tickets in 16 to 21 s; tickets usable throughout | A window in which a ticket's stored status is outside its workflow, which every workflow reader must tolerate |
| Keep the switch in one transaction (ADR-039's way) | No window at all | Holds the track and workflows for the whole remap; a large track blocks every write to it |
| Each ticket through the transition or edit route, as bulk operations do | One code path for every check | 200 tickets a second: 100,000 tickets take over eight minutes; a status mapping is configuration, not a person's edit |
| Store the workflow on each ticket | Old and new workflows coexist explicitly | A column on every ticket to keep in step with maps, types and moves; doubles the places that decide a workflow |
| Keep `track.workflow_id` beside the map | No API change | Two sources for one fact; an alias would have to create maps behind the caller's back |

## Consequences

- Every new reader of a ticket's workflow takes its track and type (`ticketWorkflowId`,
  `holdTicketWorkflow`, `holdMapWorkflows` in `workflows/maps.ts`), never a track alone.
- A change of map that needs no status mapping still commits at once and moves nothing.
- "Used by" lists and the publish impact come from the maps that name a workflow; a workflow a
  map names cannot be deleted until the map changes.
- The measure: on the cloud container with the system Postgres 16, switching a 100,000-ticket
  track took 20.9 s from the request (0.3 s) to the last batch, 4,791 tickets a second (16.4 s in
  a second run), with one history row per ticket (`workflows/migration.large.test.ts`, `TASKMOOR_LARGE_MIGRATION=1`).
- There is no admin page for maps yet; the configuration pages (M1-053) bring one, on these
  routes. Revisit the 500-ticket in-request limit if requests that switch maps feel slow.
