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
  very large tracks are M1-028.

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
