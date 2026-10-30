# ADR-062: Track templates as recipes over the create route, and configuration copied by reference

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-054

## Context

CORE-002 asks for the track types and templates of spec 01a section 1.1 and per-track feature
toggles; its first check: Kanban, Scrum and Bug tracking templates each create a working board.
M1-054 scopes templates to Scrum, Kanban, Business and Blank (Bug tracking joins them, as the
check names it) and adds "clone configuration": a new track that works like an existing one.
Admin-made custom templates with sample tickets, export and import are CORE-004 (M2). Tracks
already have types with default feature toggles and type sets (ADR-006, M1-007), shared or
local configuration modes, and boards that a person makes in a track's space (ADR-049).

## Decision

- **A template is a recipe** (`apps/server/src/tracks/templates.ts`): a track type, the feature
  toggles, and the board to make, if any. Scrum: software, every feature, a Scrum board over the
  track. Kanban: software without backlog and sprints, a Kanban board over the track. Bug
  tracking: software without backlog, sprints, forms and timeline, a Kanban board of the
  track's bugs (`track = KEY AND type = Bug`). Business: business, its type's features, a Kanban
  board. Blank: software, its type's features, no board. Configuration sets are the type's
  defaults, as for any new track; nothing a template sets is fixed afterwards.
- **`POST /api/v1/tracks` takes `template`**. A `type` that disagrees with the template is
  refused (400). The track is made as before (its event names the template); then the board is
  made through the boards' own create function as the creator, in the track's space and named
  after the track, with its own `board.created` event (the boards' checks and default columns
  apply). The answer carries the board, or `boardProblem` if it could not be made: the track
  stays either way.
- **`copyFrom`** (shared mode only) gives the new track another shared-mode track's type, access
  policy, type set, priority set, workflow map, field rule set, layout set, visibility and
  notification policies, category and feature toggles, by reference (they are shared
  configuration already); values given in the request win. A local-mode source owns its sets
  and policy, so copying it is refused (409 `source_not_shared`). Boards, automation and tickets
  are not copied.
- **Late binding**: tracks register before boards, so the track routes take a hooks object that
  `buildApp` fills with the boards' create function once they are registered.
- **Web**: the tracks admin page's add form has "Start from": the templates (Blank selected,
  the old behaviour), and, for a shared track, the configuration of each shared track. After a
  template with a board the page links to it.

## Options considered

| Option | For | Against |
|---|---|---|
| Server recipes on the create route (chosen) | One call for API users and the web; the boards' own rules make the board | One route emits two events (the board's is the boards' own) |
| Templates in the web only (two calls) | No server change | API users rebuild each template; nothing tests the recipe |
| Copying sets for a clone | The copy can diverge freely | Duplicate configuration to maintain; shared mode exists to share it |
| Stored templates (rows) | Admins could edit them | That is CORE-004 (M2), with export and import |

## Consequences

- A template's board follows the default columns of the track's workflows; a workspace that
  changes default workflows changes what new template boards look like, as for any new board.
- Bug tracking relies on a ticket type named Bug in the track's type set; with none, its board
  stays empty until the query is edited.
- Custom templates (saved from a track, with sample tickets, exported and imported) and copying
  boards and automation rules come with CORE-004 in M2.
