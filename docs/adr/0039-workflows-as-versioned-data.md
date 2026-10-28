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
- **Closing follows the stage:** entering the closed stage sets the close reason (the one given,
  the one the ticket has, or the workspace's first) and the Closed time stamp; leaving it
  clears both; a close reason set or cleared by hand does the same to the time stamp.
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
