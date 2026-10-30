# ADR-039: Workflows as versioned data with instant publish

- Status: Accepted
- Date: 2026-10-28
- Backlog: M1-023

## Context

WF-001 and WF-002 ask for statuses with stages, workflows whose transitions start from one,
several or any status, an editor that changes workflows in use, guided removal of statuses,
publish or discard, a version history with rollback, and a published change that "applies to
the next transition with no downtime". Jira edits an active workflow through a draft copy and a
publish that migrates issues in a long-running job; earlier versions are gone once published.
WF-008 ties the close reason and the Closed time stamp to the closed stage, which release
progress (CORE-016) and reports read.

## Decision

- **A workflow is versioned data.** `workflow_version` holds each version's definition as
  JSON: the statuses it uses, its initial status and its transitions (`id`, `name`, `from` as a
  list or `any`, `to`; guards, checks, effects and layouts join the transition in M1-024 to
  M1-027). `workflow.published_version` names the version tickets move through;
  `draft_version` at most one later version being edited. `workflow_version_status` lists each
  version's statuses so a status in use is found by index.
- **Publishing is one transaction** that holds the workflow row for update, moves the tickets
  of statuses the draft drops to the statuses the admin maps them to (with history and new
  versions), and makes the draft current. Ticket writes hold the workflow row (key share)
  before they lock a ticket, so a transition runs entirely against one version, and a publish
  never leaves a ticket in a removed status. There is no migration job and no window in which
  the two versions mix.
- **Earlier versions stay** and can be restored as the draft, then published like any other.
- **Statuses are the workspace's**, each in one of three stages (new, active, closed) that give
  colour and meaning. A status keeps its stage while tickets are in it; it is deleted only
  when no ticket and no current version uses it.
- **The close reason is a field, not a side effect of the stage** (corrected in M1-024, see
  below): transitions set it through their layout (`close-reason`) or an effect and clear it
  with an effect, as the conformance suite (WF-008) requires. Setting it stamps Closed with the
  time; clearing it clears the stamp. Publishing, switching workflow and moving tickets map
  statuses only and leave the close reason as it is.
- **One workflow per track for now** (`track.workflow_id`, null for the default). Switching
  workflow, or moving a ticket to a track with another workflow, maps statuses the new one
  lacks. Workflow maps per ticket type, local-mode workflows and a background migration for
  very large tracks are M1-028. *Superseded in part by ADR-045:* a ticket's workflow is the one
  its track's workflow map gives its ticket type, `track.workflow_id` is gone, and a change of
  map moves tickets in the background; publishing still moves the tickets of dropped statuses
  in its own transaction.

## Options considered

| Option | For | Against |
|---|---|---|
| Versioned definitions, publish in one transaction (chosen) | Instant publish; rollback is a copy; transitions always see one consistent version | Publishing a status removal locks the workflow while its tickets move; M1-028 adds a background path for the largest tracks |
| Normalised tables for statuses and transitions per workflow, edited in place | Easy queries of single transitions | No history or rollback without copying many rows; edits visible half-done |
| Jira's draft with an asynchronous migration job | Familiar to Jira admins | A window where tickets and workflow disagree; more moving parts |

## Consequences

Transition evaluation reads one JSON document per request (cached by version later if needed),
which keeps guards and effects (M1-025 to M1-027) as data the editor (M1-030) and the importer
can write. Large status removals hold the workflow for the length of the remap; if that proves
too long on 100k-ticket tracks, publishing moves to the background job M1-028 brings, keeping
the same rule that a ticket never sits in a status its workflow lacks.

## Implementation (M1-024 to M1-027)

- **One engine for the server and the tests.** `@taskmoor/workflow` exports `engine`, a
  production implementation of the same `WorkflowEngine` interface as the reference model. It
  compiles each definition once (transitions by id, the transitions offered from each status,
  status stages) and evaluates guards over a lazily built situation (statuses the ticket has
  been in, owner relations). It passes all 374 conformance cases; a fast-check property test
  (2,000 runs of random nested `all`/`any` guards over random tickets and actors) agrees with
  the reference on every verdict and on the transitions offered. `pnpm conformance` runs both.
- **The server maps, the engine decides.** `workflows/state.ts` turns a ticket row, its status
  history (from `ticket_change`, which now records the transition that made each status
  change: migration 0025), its parent, subtickets and owners into the engine's state, and the
  engine's result back into column updates, releases, areas and labels. `workflows/fields.ts`
  is the registry of fields workflows read and write, with the same validation as the edit
  route; a definition naming an unknown or read-only field, an invalid value or pattern, or
  guards nested deeper than 8 is refused on save (WF-002).
- **Order of work in a transition** (WF-005): status, layout values, effects in the essential
  order, then rules, all inside the transaction that holds the track, the workflow (key share),
  the configuration values and the ticket. Lookups through the shared pool (the actor's roles,
  who may be assigned) run before the transaction opens, so a burst of transitions cannot
  exhaust the pool while each holds a connection.
- **Refusals carry their reason:** 409 `transition_unavailable`, 409 `transition_refused` with
  the guard, check or rule that refused (`by`, `name`, the configured message, and the check's
  parameters so the client words it in the reader's language), 403 `forbidden` with
  `permission: 'transition'` when a status forbids it (WF-007). Nothing is written on refusal.
- **Global transitions are offered from every status, the target included** (the suite's
  WF-001 cases); a self-loop runs its effects and records no status change.
- **The trigger hook** (`POST /api/v1/tickets/:id/trigger {event}`) fires the first offered
  transition whose `triggers` name the event, on the automation channel; M2 automation and
  external events call it. Custom events from transitions and `onCreate` ride on
  `ticket.transitioned` and `ticket.created` (`event`, `webhookCount`).
- **Defaults:** the seeded workflow's Close asks for a close reason (layout and a required
  check); Reopen clears it.

## Implementation (M1-030)

The workflow editor (WF-002, WF-012) is a client of the M1-023 API; no endpoint, event or
migration was added. Its code is in `apps/web/src/workflow/`.

- **Where it lives.** `#/admin/workflows` lists the workflows (default, published version,
  draft, tracks using them), creates one (empty with an initial status, or a copy of another's
  published version), deletes an unused one, and manages the workspace's statuses (add with a
  stage, rename, change the stage while no ticket is in it, reorder, delete when unused).
  `#/admin/workflows/<id>` is the editor. Both are offered from Settings and the command
  palette; the API decides who may use them (site and configuration administrators).
- **One draft in the page.** The editor works on a copy of the draft (or of the published
  version when there is none) and changes it through pure operations (`definition.ts`); it
  saves with `PUT .../draft`, discards with `DELETE .../draft`, publishes through
  `GET .../impact` and `POST .../publish` with a mapping for each dropped status that holds
  tickets, and restores an earlier version as the draft. Publishing saves unsaved changes
  first. New transition ids are above every id in the draft and the published version, so a
  removed transition's id is not given to another one while history still names it.
- **Diagram mode is a picture plus lists.** The diagram (`diagram.ts`) is laid out from the
  definition every time, so it is never saved: layers by breadth-first distance from the
  initial status over transitions with a source list, statuses reached only by global
  transitions or not at all in one last layer, one barycentre pass to order each layer, forward
  transitions as curves between box sides, transitions back to an earlier layer below the
  boxes, transitions within a layer to the right, self-loops on a corner, and a global
  transition as a dashed tab above its target rather than lines from every status. No graph
  library: about two hundred lines that a property test keeps honest (no overlapping boxes,
  one labelled edge per transition, everything inside the frame). `x` and `y` in a definition
  are kept as they are and not read yet. The picture is hidden from assistive technology and
  its parts are out of the tab order; the frame takes focus so it scrolls with the keys. The
  lists of statuses and transitions beside it are the equivalent structure that keyboards and
  screen readers use, and choosing an entry there or in the picture opens the same details
  panel, with focus on its heading. On phones the picture waits behind a button and scrolls
  inside its frame.
- **Rule forms come from one catalogue.** `catalogue.ts` lists every guard, check, effect and
  local-mode rule with its parameters and the control each needs (field, comparison, status or
  statuses, transition, role, group, permission, value, and so on). It is typed against the
  workflow model of `@taskmoor/workflow` (a type-only dev dependency of the web app), so a
  type or parameter the model gains or renames fails to compile; a test compares the type
  names with the server's schema, the fields with `workflows/fields.ts` and the problem codes
  with `definitionProblem`. Guards edit as a tree of all/any groups, at most as deep as the
  server allows. Effects show inside the essential sequence the engine runs: status, layout
  values, the optional effects in list order, local-mode rules, then comment, history, index
  and event, notifications after all of them.
- **Text mode is the API's JSON.** The text is the definition exactly as the API stores,
  imports and exports it (WF-011), pretty-printed, with a key from status ids to names.
  Switching modes is lossless: the text reads back as the same definition (property test),
  and a text that does not read keeps the editor in text mode. The editor finds the position
  of a JSON syntax error itself (browsers word `JSON.parse` errors differently), and a shape
  check that mirrors the server's schema (`shape.ts`) names each problem by its path. What
  needs the workspace is the server's `definitionProblem`, shown in words after a save.
- **Checks before publishing (WF-012, `lint.ts`)**, computed from the definition alone:
  errors the server would refuse (unknown or repeated statuses, an initial status or a
  transition end outside the workflow, repeated transition ids, guards nested deeper than ten)
  block saving; warnings do not. A status is unreachable when no path of runnable transitions
  leads to it from the initial status, breadth first (a stronger reading than the engine's
  `lint`, which flags only statuses no transition enters; a property test shows the two agree
  on those, and a plain fixpoint agrees with the breadth-first search). A transition whose
  guards can never pass does not count as a path, and a self-loop does not either. A status
  outside the closed stage with no transition to another status has no exit; a global
  transition is an exit from every status but its own target. Unsatisfiable guards are judged
  as the engine judges them. Statuses unmapped on boards join with boards (M1-043).

## Workflow files (M1-127)

A version downloads as a file in Taskmoor's own format and comes back as a new workflow or a
new draft, in this workspace or another: ADR-073.
