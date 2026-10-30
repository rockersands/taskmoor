# ADR-061: The releases hub reads releases through the search runner and generates notes

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-050

## Context

CORE-016 asks for a release page with progress, warnings and release approvers; its checks
(shipping a release with open tickets prompts to move them, approvals block shipping until
everyone approves, the manual order drives `latestShippedRelease()`) were built server side in
M1-014 (ADR-009 note). M1-050 asks for the releases hub on the web and release notes generated
from a release's tickets, with a release flow end to end and a golden test of the notes. Track
summaries (ADR-060) already count tickets through the search runner so that every number equals
the search it links to.

## Decision

- **Overview** (`GET /api/v1/releases/:id/overview`, `routes/release-hub.ts`): the release's
  target tickets by status stage (new, active, closed) and the open ones, each as a query
  (`targetRelease = <id> AND stage = ...`) counted through the search runner as the viewer, so
  each number equals its search; the first 200 tickets in rank order; the approvers and their
  decisions; whether the viewer may manage the release and whether they are an approver.
- **Warnings**, each with its count and, for tickets, the search that finds them:
  `overdue` (upcoming, its day passed, open tickets), `open_after_ship` (shipped with open
  tickets left), `unassigned` (upcoming, open tickets with nobody assigned), `open_found` (open
  tickets found in this release), and for approvals while upcoming `no_approvers`,
  `approval_declined` or `approvals_waiting`.
- **Release notes** (`GET /api/v1/releases/:id/notes`, `?format=markdown` for a file): the
  closed target tickets the viewer sees, grouped by ticket type in the order of the track's
  type set (types outside it last, by name), each section by key. **Done** means closed with
  the workspace's first close reason (by order; Completed by default) or with none; tickets
  closed otherwise (not planned, duplicates) are left out and counted by reason. The Markdown
  has the track and release name, the day it shipped (the release date, else the day it was
  shipped) or the planned day, the description, and a section per type; Markdown characters in
  names and summaries are escaped. At most 5,000 tickets; more and the notes say they are cut.
- **Who reads**: anyone who may browse the release's track (and site and configuration
  administrators); others get 404. The list of a track's releases now says whether the caller
  may manage them (`mayManage`).
- **Web** (`apps/web/src/releases`): `#/tracks/<KEY>/releases` lists upcoming releases in the
  track's order, then shipped ones (latest first) and, folded, archived ones, each with its
  dates, a state word with a tone (upcoming, overdue, shipped, archived) and its closed share;
  its administrators add releases there. `#/releases/<id>` shows the dates and description,
  one bar of the stages in the flow reports' ordinal blue with a legend whose numbers open
  their searches, the warnings, approvers (who approve or decline with a comment there),
  shipping on a day with the open tickets moved to another upcoming release or left, the
  tickets, and the notes to copy as Markdown or download. Track summaries link to the hub.

## Options considered

| Option | For | Against |
|---|---|---|
| Counts through the search runner (chosen) | Equal to the linked search by construction; the viewer's filter applies | One query per number (six or seven per page) |
| Counts from `ticket_release` joins | One statement | A second definition of "open" and of visibility to keep in step with search |
| Notes stored when a release ships | Fixed text, editable | Stale when tickets change; shows tickets to viewers who may not see them |
| Notes with every closed ticket | Simple | Duplicates and "not planned" read as delivered |

## Consequences

- Notes are computed on each read and differ per viewer; a frozen, edited copy at shipping
  time (and publishing them elsewhere) is for later.
- "Done" for notes follows the close reason order; a workspace that reorders its reasons
  changes what its notes include. A per-reason flag is the next step if that proves wrong.
- Not built here: editing, reordering, archiving, merging and deleting releases from the web
  (the API has them), release burndown on the release page (it is on Scrum boards, ADR-059),
  the timeline's release markers (M1-048) and story maps (AGL-023).
