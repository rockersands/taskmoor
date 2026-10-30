# ADR-073: Workflow files: the stored definition with document ids and name tables, mapped by name and never widened

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-127

## Context

WF-011 (1) asks that a workflow exported and imported again be identical, and the backlog asks
that an import into another workspace map statuses by name and report the rest. A stored
definition (`apps/server/src/workflows/model.ts`, the JSON of the editor's text mode) names
statuses, groups, roles, people, priorities, close reasons, ticket types, releases and areas by
their database ids, inside guards, checks, effects, local-mode rules, status locks and field
values. Those ids mean nothing in another workspace or instance. Some of what a file names will
be missing there, and the import must neither fail as a whole nor let more people through a
transition than the file did. The Jira-compatible mapping of workflows is a separate ticket
(M1-090); this one is Taskmoor's own format only. No migration was wanted, because M1-040 held
the next migration number.

## Decision

- **The document** (`apps/server/src/workflows/transfer.ts`): `format: "taskmoor-workflow"`,
  `version: 1`, the workflow's name and description, the definition in its stored shape, and
  one table per kind of object it names (`statuses` with stage and description, `groups`,
  `roles`, `people` with email, `priorities`, `closeReasons`, `ticketTypes`, `releases` and
  `areas` with their track's key). Inside the definition every id is a **document id**: 1, 2,
  3 per kind, in the order the definition first names them, the workflow's own statuses first
  and in its order. An id's JSON type is kept (a number stays a number, text stays text).
  Database ids never leave the workspace, so exporting what an import made gives the same
  bytes again. Empty tables are left out; the file is pretty-printed JSON.
- **One walker in both directions.** `mapDefinition` maps every reference through a `Mapper`:
  the export maps database ids to document ids, the import document ids to the target's ids.
  Both use the same code, so they agree by construction (as `import/remap.ts` does for the full
  export).
- **Matching on import** (`transfer-store.ts`): statuses by name without case, created after
  the last when missing (with the file's stage and description) under the status list's lock;
  a name that matches a status in another stage is used and reported. Groups, roles,
  priorities, close reasons and ticket types by name (a track's own ticket types before shared
  ones for a track's workflow), people by email, releases and areas by track key and name.
  Nothing but statuses is created.
- **What does not map never widens access.** A guard that names it becomes `always-false` in
  place (an `any` around it still allows through its other members; an empty `any` would allow
  everyone, so lists that empty out also become `always-false`). A list loses the missing
  members. A check or a restricting rule (`restrict-*`, `validate-permission`) that names it is
  removed and its transition gets an `always-false` guard first: disabled until an
  administrator fixes it. An effect, a non-restricting rule or a layout field is removed. Status
  locks lose the missing roles and groups (an empty list lets nobody through). Unknown
  permission keys are kept and reported: nobody holds them, so behaviour does not change. Each
  of these is a finding in the report with the file's name for the object, where it was and
  what became of it. A property test checks that a guard passing after the mapping also passed
  before it.
- **Routes** under `/api/v1/admin/workflows` (admin token scope, ADR-035):
  `GET :id/export[?version=N]` downloads a version (published by default) and emits
  `workflow.exported`; `POST import` makes a new workflow (version 1 published, like any new
  workflow; `name`, `description`, `trackId` optional) and `POST :id/import` the next draft of
  one. Both answer the workflow and the report and emit one `workflow.imported` event, which
  lists the statuses created. The result is checked like a saved definition; when it fails, the
  transaction rolls back and nothing the import created stays. A file of another format or
  version is refused before the full check (`not_a_workflow_document`, `unsupported_version`).
  All three events are audited.

## Options considered

| Option | For | Against |
|---|---|---|
| Names inline in the definition (`"from": ["To do"]`) | Readable by hand | A second schema beside the stored one; an id's JSON type is lost; names are not unique for every kind (releases per track, people by email) |
| The stored definition with source database ids and a table of names (chosen with document ids instead) | No rewriting | Exporting what an import made gives other ids, so the round trip is not identical across workspaces |
| Document ids and name tables (chosen) | Identical round trips; the stored shape the text mode shows; one walker both ways | A reader looks names up in the tables |
| Fail the import on anything missing | Simple | WF-011 and the backlog want a report, not a failure |
| Drop rules that name missing objects | Simple | Dropping a guard or a check lets more people through |

## Consequences

- A file names people by email: downloading one is an audited export.
- A later format version adds kinds (custom fields in workflows, visibility levels by name) as
  new tables; version 1 files keep importing. A newer file is refused with
  `unsupported_version` until this server is updated.
- The Jira importer (M1-090) can reuse `mapDefinition` and the report shape for its own
  mappings, with Jira's names in the tables.
- Revisit if workflows start naming custom fields (`cf[N]`): they need a `fields` table and a
  match by name and type.
