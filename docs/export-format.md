# Taskmoor export format, version 1

Taskmoor can write a whole workspace, or chosen tracks, as a set of plain files that any tool can
read and that another Taskmoor instance can import (IMP-014, ADR-063). This page describes those
files. It is the contract: a change that breaks a reader gets a new version number.

## Getting an export

- **Download**: a site administrator opens `GET /api/v1/admin/export` and receives a ZIP named
  `taskmoor-export-<date>.zip`. `?tracks=KEY,KEY` exports only those tracks and what belongs to
  them, with the whole configuration. The archive is written while it downloads, so its size
  has no limit and nothing is throttled. Every download is recorded in the audit log
  (`workspace.exported`).
- **Command line**: `node cli.mjs export <folder> [--tracks KEY,KEY]` writes the same files into
  an empty folder. In the image: `docker compose exec taskmoor node cli.mjs export /data/exports/now`.

## Importing an export

Put the folder or the ZIP inside the imports folder of the target instance (`TASKMOOR_IMPORT_DIR`,
by default `TASKMOOR_DATA/imports`) and start an import as a site administrator:

```
POST /api/v1/admin/imports
{"source": {"format": "taskmoor", "path": "taskmoor-export-2026-10-30.zip"}, "dryRun": true}
```

The import runs in the background through the importer framework (ADR-048): a dry run first if
you like, progress at `GET /api/v1/admin/imports/<id>`, the fidelity report at
`.../report` (JSON or HTML), every record's problems at `.../problems`. It can be interrupted and
resumes where it stopped; importing the same export again changes nothing, and importing a later
export of the same workspace updates the records that changed and adds the new ones (history
entries are only ever added, and a workflow the import created keeps the version it published).

Objects the target already has are matched rather than created: people by email; groups, roles,
statuses, priorities, close reasons, ticket types, link types and workflows by name; the default
workflow and workflow map with the target's defaults; fields, contexts and options by name within
what they belong to; releases and areas by name within their track. Matched objects keep the
target's settings. A newly set-up instance already has the built-in statuses, priorities, types,
roles and the default workflow, so on such an instance an export of a workspace whose built-in
objects were left as shipped comes back exactly.

People are created without a password: they sign in through single sign-on or after an
administrator sends them a password link. Tracks need their access set up again (see "Not
carried" below).

## Layout

```
manifest.json
users.ndjson
groups.ndjson
teams.ndjson
roles.ndjson
statuses.ndjson
priorities.ndjson
close-reasons.ndjson
ticket-types.ndjson
link-types.ndjson
tracks.ndjson
releases.ndjson
areas.ndjson
fields.ndjson
field-contexts.ndjson
field-options.ndjson
workflows.ndjson
workflow-maps.ndjson
tickets.ndjson
comments.ndjson
links.ndjson
time-entries.ndjson
attachments.ndjson
checklists.ndjson
history.ndjson
attachments/<attachment id>
```

Each `.ndjson` file holds one record per line, as JSON. The files are listed in the order an
import reads them: a record only refers to records in the same file further up or in files above
it. Within `tickets.ndjson`, tickets on higher hierarchy levels come first, so a parent always
precedes its children; `field-options.ndjson` lists top-level options before cascading children.

## Conventions

- **Canonical lines.** Every line is JSON with its keys in alphabetical order and no spaces
  outside strings. The same data always produces the same bytes, which is what makes the
  checksums in the manifest meaningful.
- **Ids.** Every record has an `id`: the source instance's own identifier, as a string. Other
  records refer to it by that string (`"track": "3"`). Ids mean nothing outside the export; an
  import gives every object a new id and remembers the mapping.
- **Lists of references** (members, followers, releases, scopes) are sorted by id.
- **Times** are UTC with microseconds: `2026-10-30T06:15:29.291616Z`. **Days** are
  `YYYY-MM-DD`. **Durations** and estimates are whole seconds.
- **Rich text** (descriptions, comments, paragraph fields) is the document format Taskmoor stores
  (ProseMirror JSON, ADR-014), unchanged. A mention is a node `{"type": "mention", "attrs":
  {"id": "<user id>", "label": "..."}}`, or `"group:<group id>"` for a team.
- **Values with ids inside** are written exactly as Taskmoor stores them and refer to records of
  the export by their ids:
  - a ticket's `fields`: custom values keyed by field id; options, people, groups, teams,
    releases and areas by id (several in ascending order, a cascading choice as `[parent, child]`);
  - history values: see `history.ndjson` below;
  - workflow definitions: statuses by number, groups, roles and people by id as text;
  - formula fields: the expression names fields as `{cf[<field id>]}`.

## The manifest

```json
{
  "format": "taskmoor-export",
  "version": 1,
  "system": "taskmoor:<instance uuid>:<workspace key>",
  "workspace": "default",
  "exportedAt": "2026-10-30T07:00:00.000Z",
  "tracks": null,
  "files": [
    {"name": "users.ndjson", "kind": "user", "records": 21, "bytes": 2140, "sha256": "..."}
  ],
  "attachments": {"files": 100, "bytes": 5000000, "sha256": "..."}
}
```

- `system` names the instance and workspace the export came from. It stays the same for every
  export of that workspace, so an import can tell a later export of it from a different source.
- `tracks` lists the keys of the chosen tracks, or is `null` for the whole workspace.
- `files` has one entry per `.ndjson` file: its record count, its size and the SHA-256 of its
  bytes.
- `attachments.sha256` is the SHA-256 of the lines `<file name> <file sha256>\n` for every file
  under `attachments/`, sorted by name.

The manifest is written last. An export without one is incomplete (a download that broke off),
and an import refuses it.

## Records

`?` marks a value that may be `null`.

| File | Fields |
|---|---|
| users | `email`, `name`, `active` (false for deactivated people), `timeZone?`, `locale?` |
| groups | `name`, `description`, `members` (user ids) |
| teams | `name`, `description`, `lead?` (a user id), `members` (user ids); exports made before M1-123 have no such file |
| roles | `name`, `description` |
| statuses | `name`, `description`, `stage` (`new`, `active` or `closed`); in the workspace's order |
| priorities | `name`, `description`, `icon?`, `color?`; in the workspace's order |
| close-reasons | `name`, `description`; in the workspace's order |
| ticket-types | `name`, `description`, `icon?`, `color?`, `level` (`subticket`, `standard`, `outcome` or `custom`) |
| link-types | `name`, `outward` (what the source ticket reads), `inward` |
| tracks | `key`, `name`, `description`, `type` (`software`, `business`, `service`, `discovery`), `mode` (`shared` or `local`), `owner?`, `icon?`, `color?`, `lastNumber` (the last ticket number given out) |
| releases | `track`, `name`, `description`, `startDate?`, `releaseDate?`, `shippedAt?`, `archivedAt?`; per track in the track's order |
| areas | `track`, `name`, `description`, `owner?`, `ownerTeam` (the team that owns it; present only when one does, since M1-123), `defaultAssignee` (`area_owner`, `track_owner`, `unassigned`), `archivedAt?` |
| fields | `name`, `description`, `type`, `multiple`, `config` (type settings; a formula's `expression` and `output`), `track?` (the track that owns a local field) |
| field-contexts | `field`, `name`, `description`, `defaultValue?` (stored form; options are flagged on the options instead), `config`, `scopes` (`{track?, type?}` pairs; `null` means every track or type) |
| field-options | `context`, `parent?`, `value`, `sortOrder`, `disabled`, `default` (part of its context's default value) |
| workflows | `name`, `description`, `isDefault`, `definition` (the published version: statuses, the initial status, transitions with their guards, checks and effects, as in the workflow API) |
| workflow-maps | `name`, `description`, `isDefault`, `defaultWorkflow`, `entries` (`{type, workflow}`), `tracks` (the tracks that use the map; tracks without one use the default map) |
| tickets | see below |
| comments | `ticket`, `author?`, `body` (rich text), `visibleGroup?`, `visibleRole?`, `createdAt`, `updatedAt`, `editedAt?`, `editedBy?`, `deletedAt?`, `deletedBy?` |
| links | `source`, `target`, `type` (`{name, outward, inward}`), `creator?`, `createdAt` |
| checklists | `ticket`, `name`, `position`, `creator?`, `createdAt`, `updatedAt`, `items` (each `{text, state, position, creator?, editor?, createdAt, updatedAt}`; `state` is `open`, `in_progress`, `done` or `rejected`; `editor` is who wrote the words as they read now when that is not the creator, and an export from before it has none). An export from before checklists has no such file |
| time-entries | `ticket`, `author`, `startedAt`, `seconds`, `description`, `visibleGroup?`, `visibleRole?`, `createdBy?`, `createdAt`, `updatedAt` |
| attachments | `ticket`, `name`, `declaredType`, `sniffedType?`, `size` (bytes), `sha256`, `author?`, `createdAt`, `width?`, `height?`, `file` (its path in the export) |
| history | see below |

A ticket has `track`, `number` (with the track's key, its key: `KEY-12`), `type`, `status`,
`parent?`, `summary`, `description?` and `environment?` (rich text), `assignee?`, `requester?`,
`creator?`, `priority?`, `closeReason?`, `labels`, `startDate?`, `dueDate?`, `createdAt`,
`updatedAt`, `closedAt?`, `originalEstimate?`, `remainingEstimate?`, `timeSpent`, `rank` (its
place in the global order), `fields` (custom values, formula results included), `targetReleases`,
`foundInReleases`, `areas`, `followers`, `voters`, `visibilityLevel?`, and, for a ticket in the
trash, `deletedAt`, `deletedBy?` and `trashedWith?` (the parent it went to the trash with).

A history record is one change of one ticket: `id` (`<change set>-<ticket>`), `ticket`, `at`,
`actor?` and `items`, each `{field, from?, to?, fromDisplay?, toDisplay?, transition?}`. Fields
are named as the query language names them; values are text as Taskmoor keeps them, with the
names they had at the time in `fromDisplay` and `toDisplay`:

| Field | Value |
|---|---|
| `track`, `type`, `parent`, `status`, `assignee`, `requester`, `priority`, `closeReason` | the id of the track, ticket type, ticket, status, person, priority or close reason |
| `targetRelease`, `foundInRelease`, `area` | ids separated by commas |
| `comment`, `attachment` | the comment's or the file's id |
| `timeEntry` | `<time entry id>:<seconds>` |
| `link` | `<link type id>:<outward or inward>:<other ticket id>` |
| `cf[<field id>]` | a custom value: ids as in `fields` (commas between several, a colon in a cascade), labels separated by spaces, rich text as JSON |
| `description`, `environment` | the document as JSON |
| `key`, `summary`, `labels`, dates, estimates, `timeSpent`, `rank`, `webLink`, `trash` | the value itself |

A ticket's first history record holds the values it was created with. `transition` is the id of
the workflow transition that made the change, which stays valid because workflow definitions keep
their transition ids.

## Not carried in version 1

These stay with the source instance; an import reports what it could not bring:

- access policies, role memberships of tracks, global permissions, visibility policies (a ticket
  with a visibility level fails to import rather than become visible to everyone), notification
  policies, field rule sets and layouts, type sets and priority sets beyond the defaults;
- local-mode ownership: tracks, ticket types and workflows owned by one track import as shared
  ones (the report warns), and a local track's own workflows and maps are not exported;
- custom hierarchy levels above Outcome (their tickets' types fail to import);
- boards, sprints, saved searches, dashboards, webhooks, service accounts and API tokens;
- earlier workflow versions and drafts, earlier versions of comments, reactions, web links, key
  history of moved tickets, rich text originals kept from imports (IMP-008), files that failed
  or are waiting for the virus scan.

History values that name objects the export does not carry (visibility levels) import as empty,
with their display text kept. A value that names an object that no longer exists (a deleted
file) does too.

## Checking a round trip

An import records which source id became which target id. Exporting the target again with those
ids translated back (`translationOf` in `apps/server/src/export/write.ts`) gives files that are
byte for byte the source's when nothing was lost, so comparing the two manifests' checksums
checks every record at once. `apps/server/src/routes/export-roundtrip.large.test.ts` does this for
100,000 tickets.
