# ADR-079: Board-managed workflows as ordinary workflows the board rewrites

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-126

## Context

WF-010 and spec 01a section 3.6 describe the simplified workflow of local-mode tracks:
statuses are the board's columns, managed by the board's administrators; any card moves to any
column; there are no transition layouts; the rightmost column sets the close reason Completed
and leaving it clears it. The workflow engine already models this (`WorkflowDef.board`,
`boardMove`, the conformance suite's board cases), but the server stored only ordinary
versioned workflows, which tickets, boards, history, reports and the editor all read.

## Decision

- **An ordinary workflow, rewritten by the board.** A board of a local-mode track can manage
  that track's workflow (`board.manages_workflow`, migration 0063; at most one board per
  track). The workflow stays a versioned workflow like any other, so everything that reads
  workflows keeps working. Its definition gains `board: { boardId, columns }` (the column
  statuses in order), and the board writes and publishes a new version whenever its columns
  change: one status per column, and one transition per column, named after it, from any
  status to the column's status. The rightmost column's transition sets the close reason
  Completed (made in the workspace when it has none); the others clear it. Global transitions
  give "any card to any column" through the moves, transitions and history that exist.
- **Turning it on** (`PUT /api/v1/boards/:id/workflow`, track administrators): each column
  keeps its first status, or gets one named after it (an existing status of that name, or a
  new one, new stage in the first column, closed in the rightmost, active between); tickets in
  a status a column also held follow that column's status. A track still on the workspace's
  default workflow (every new local-mode track) gets a workflow of its own, "Board workflow",
  as its map's default. A track whose map gives types different workflows is refused, as is a
  shared-mode track.
- **Changing columns** of a managed board (`PATCH /api/v1/boards/:id`): a column without a
  status gets one; a column with two is refused (`409 one_status_per_column`); tickets in a
  removed column's status go to the first column, or where `statusMapping` says.
- **One event.** A mutation emits one event (M1-005): `board.updated` carries a `workflow`
  object with the workflow, its new version, the statuses made and dropped, and the tickets
  moved, instead of separate status, workflow and map events.
- **Turning it off** leaves the workflow as it was, now an ordinary workflow of the track.

## Options considered

| Option | For | Against |
|---|---|---|
| An ordinary workflow the board rewrites (chosen) | Moves, history, reports, sync and the editor work unchanged | A version per column change; transitions the editor shows are generated |
| A separate board-move path calling `boardMove` | Mirrors the engine's model exactly | A second way to change status, with its own history, events, checks and locks to keep in step |

## Consequences

- Editing a managed workflow in the workflow editor is possible, and the board's next column
  change overwrites the transitions; the page says the columns manage it.
- Column renames do not rename the status, which other workflows may share.
- The rightmost column's status keeps its own stage: an existing status named after a column
  is reused as it is.
