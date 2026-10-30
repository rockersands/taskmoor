# ADR-081: The Data Center backup import: a streaming stage of per-kind files, and a mapping report by name

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-088

## Context

M1-088 is the first mapping step of the Data Center importer (IMP-001, IMP-004): people,
groups and their members, roles, projects, issue types, statuses, priorities and resolutions.
M1-089 to M1-094 add custom fields, workflows, issues with their content, schemes, boards and
filters on the same reader. The importer framework (ADR-048) reads a source a page at a time by
kind, with a cursor, and resumes from a checkpoint. A backup is one ZIP holding one XML file of
up to tens of gigabytes, in an order the format does not promise: comments and history come
before their issues (ADR-072), and references between rows can only be resolved after the
whole file. IMP-001 (1) asks for under 4 GB of memory on a 50 GB backup.

An administrator also needs to know what the import did with their configuration: which of
their statuses, priorities and groups it reused, which it created, and what it left out and
why. The fidelity report (M1-086) counts this per kind, but does not name the objects.

## Decision

- **Stage once, then read files** (`apps/server/src/import/dc-backup/stage.ts`). The first read
  of a run streams the ZIP once through the byte cleaner and saxes (ADR-025). The validator
  and the stage share `parse.ts`. The stage keeps only the small configuration tables in
  memory, and counts every other element, plugin table and file. After the file it resolves
  references and writes one JSON-lines file per kind next to the ZIP (`<zip>.staged/`), with
  `stage.json` written last. It writes into a folder of its own and renames it into place.
  A later run of the same file (same size and modification time) reuses the stage. The source
  (`import/dc.ts`) reads the files by byte offset, like Taskmoor's own export (`lines.ts`,
  shared), so a run resumes inside a kind without reading the backup again. M1-091 stages
  issues and their parts the same way, by streaming them to files instead of keeping them.
- **The backup's identities.** People are known by their lower-case user key. References that
  use a user name are resolved leniently through the key table (format notes, **Verify**). A
  user row without a key row is keyed by its user name. When the same name is in several
  directories, the active directory with the lowest position wins. Groups are known by their
  lower-case name, because memberships, role actors and comment restrictions name them that
  way. Everything else is known by its row id.
- **Deleted people become inactive placeholders only when named** (IMP-007). The stage collects
  every person reference: the format's person attributes, role actors, and the people in
  assignee and reporter changes. A deleted person who is named gets a deactivated user with a
  placeholder address. One named by nothing is skipped, with the reason
  `deleted_user_not_referenced`.
- **Role actors travel with their track.** `track_role_actor` has no id of its own, so it
  cannot be an entity kind with a fidelity target. `TrackCommand.roleActors` adds them when the
  track is created or updated, and never removes them. Actors with an unknown role, an unknown
  group or an unknown actor type are left out with a warning. Nested groups are left out the
  same way (`nested_group_not_imported`) until a later task needs them.
- **Two small framework hooks** (`model.ts`, `run.ts`). `ImportSource.unsupported(kind)` counts
  a kind without a loader at once and gives the reason (`not_imported_yet`, or `not_needed` for
  the id sequences). The run no longer reads a million issues just to count them. The reason
  is stored with the count. `ImportSource.notes()` adds the source's own warnings once, before
  the first kind: the characters the cleaner removed, per kind, with their first byte offsets
  (IMP-001 (2)).
- **A mapping in the report, by name** (`report.ts`; migration 0065). Each import record of a
  configuration kind keeps a label: the source's name for it, a key or an address
  (`import_record.label`). The fidelity report gains `mapping`: kind, source id, label, outcome
  (created, linked to the target's object of the same name, unchanged, failed, skipped),
  target id, the reason when it was not mapped, and its warnings. It lists up to 500 objects per
  kind and sets `mappingTruncated` beyond that. `GET /api/v1/admin/imports/:id/records` pages
  through every record of a run with its label, so nothing depends on the cap. Content kinds
  (tickets, comments, history) keep no label and are only counted.
- **`system` names the instance**, by default `dc`, as CSV's default is `csv`. An administrator
  who imports two instances into one workspace gives each its own name, because the backup
  format carries no instance id that the notes confirm.

## Options considered

| Option | For | Against |
|---|---|---|
| Stage to per-kind JSON-lines files (chosen) | One pass over the backup; resumable reads by offset; memory bound by configuration; the same reader as the export | Disk next to the ZIP, up to the size of the data for M1-091 |
| Re-stream the XML for every page | No staging files | Quadratic on a large backup; references still need the whole file |
| Stage into Postgres tables | Queries for joins | Many more rows to write than to import; a schema for another product's format |
| Stage in memory | Simple | Breaks IMP-001 (1) at the issue level |
| Count unsupported kinds by reading them | No framework change | Hundreds of thousands of empty batches on a large backup; no reason per kind |
| Report names from the target rows | No migration | Lower-cased names; nothing for skipped or failed records; the dry run has no targets |

## Consequences

- M1-089 to M1-094 add their elements to the stage and their kinds to the mapper. Each element
  they consume leaves the `unsupported` list, and the golden report
  (`import/__golden__/dc-10k-seed1.report.json`) shows each change.
- A real backup's people stay in memory during the stage: about 200 bytes each with their
  memberships, so a million people need a few hundred MB. That is within IMP-001 (1), but
  revisit it if a design partner's directory is larger.
- The stage folder needs write access next to the ZIP. The imports folder already needs it for
  unpacked exports (ADR-063).
- Every **Verify** in the format notes still holds for the reader: user names in person
  attributes, the status category numbers, and group descriptions are all read leniently.
