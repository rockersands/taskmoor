# ADR-063: Full export as canonical NDJSON with source ids, imported verbatim; checked by a translated re-export

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-098

## Context

IMP-014 asks that a site or chosen tracks can be exported at any time, without throttling, as
documented and versioned NDJSON plus attachments, and that importing an export into an empty
instance reproduces tickets, history, comments, attachments and configuration. M1-098's
done-when: a 100,000-ticket export and re-import round trip is lossless, shown by checksums.
IMP-012 asks for CSV import with a field mapping, create-or-update by key, hierarchy through a
parent column and reusable mappings; ADR-048 requires every source format to run through the
importer framework (staged, resumable, idempotent by external id, dry run, fidelity report).

Ids differ between instances, and a target that was just set up already has built-in statuses,
types, priorities, roles and a default workflow, so "the same rows" cannot be compared table by
table. Taskmoor also keeps ids inside values: custom values name options and people, history
entries hold ids as text, rich text mentions people, workflow definitions name statuses, groups
and roles, formula expressions name fields.

## Decision

- **Format** (`docs/export-format.md`, `apps/server/src/export/format.ts`): a folder or a ZIP
  with `manifest.json`, one NDJSON file per kind in load order, and `attachments/<id>`. Records
  carry the source's ids as strings and refer to each other by them. Values with ids inside are
  written as stored. Every line is canonical JSON (keys sorted), times are UTC text with
  microseconds read in SQL (a JavaScript `Date` would drop them), lists of references are sorted:
  the same data gives the same bytes. The manifest lists each file's records, bytes and SHA-256
  and one SHA-256 over the attachments, and is written last. Tickets come by hierarchy level from
  the top, so parents precede children; history comes per ticket in the tickets' order.
- **Writing** (`export/write.ts`): one keyset-paged query per kind (pages of 1,000 ids; history
  read through its `(ticket_id, id)` key for each page of tickets), lines written to a sink that
  waits for its reader: a folder (`node cli.mjs export`) or a ZIP streamed to the response
  (`GET /api/v1/admin/export`, site administrators, audited as `workspace.exported`). Only
  attachments that passed the scan are exported; their bytes are checked against their stored
  SHA-256 on the way out.
- **Importing** (`import/taskmoor.ts`): the `taskmoor` source format of the framework. A ZIP is
  unpacked once beside itself (entries outside the format are refused); each kind's file is read
  from a byte offset, the offset being the cursor, so resuming never rereads a file. The format
  is **verbatim** (`ImportFormat.verbatim`): tickets get no starting values written for them,
  comments, links and files no history rows, and history entries are written as they are, since
  the export holds the complete history; time spent, formula values and ranks are kept, the rank
  sequence and ticket counters move past what was imported.
- **New loaders** (`import/load-config.ts`, `import/load-files.ts`): roles, priorities, close
  reasons, link types, releases, areas, fields, contexts, options, workflows (published
  definition, checked with `definitionProblem`) and workflow maps (with the tracks that use
  them), and attachments (bytes from the source into the active store under a new key, checked
  against the record's SHA-256, registered for cleanup until the batch commits). Objects are
  matched by name as ADR-048 does for people and statuses; the default workflow and map match
  the target's defaults. A context's default options are flagged on the options, which load after
  their contexts. Ticket, comment and time entry loaders take the further properties the export
  has (custom values, releases, areas, followers, voters, trash, visibility of comments and time,
  edit and delete marks).
- **Ids inside values** (`import/remap.ts`): one walker per place (custom values, history values
  by field, rich text mentions, workflow definitions, formula expressions) over an `IdMap`. The
  import maps source ids to target ids through the run's resolver; before a batch is planned, a
  collecting map gathers every id the batch's values name and looks them up in two queries. An id
  that does not map is never kept (it would name an unrelated object): a reference empties, a
  list loses it, a mention keeps its label, and the report warns (`unmapped_reference`).
- **Lossless, by checksums**: the import records every source id's target id
  (`import_external_id`). Exporting the target with those ids translated back
  (`translationOf`, `ExportOptions.translate`) uses the same walkers in the other direction and
  gives byte-identical files when nothing was lost, so equal manifests (per-file SHA-256 and the
  attachments' checksum) prove the round trip for every record, not a sample.
- **CSV** (`import/csv.ts`, `docs/csv-import.md`): the `csv` source format. The source scans the
  file once per job part with an RFC 4180 reader over bytes, keeps each row's byte offsets,
  orders rows parents first, and emits the people, statuses, types, tracks, releases and areas
  the rows name as records the framework links (people by email, created deactivated when
  missing; statuses, types and tracks must exist; releases and areas are created). A row is keyed
  by its id column, else its key column, else its line. A key column means create or update by
  key (`TicketCommand.match`), and properties the mapping does not name are kept on update
  (`TicketCommand.keep`); a parent that does not sit on a higher level is dropped with a warning
  (sources other than Taskmoor's own export). Custom cells are read against the target's catalogue and go through
  `checkCustomValues`, as a REST edit does. A run's mapping can be reused (`mappingFrom`). Each
  record's warnings are kept with it, and `GET /api/v1/admin/imports/:id/problems` lists them, so a
  dry run shows every row's problems. Files named by path must be inside `TASKMOOR_IMPORT_DIR`.

## Options considered

| Option | For | Against |
|---|---|---|
| Natural keys instead of ids (ticket keys, emails, names) | Readable references | Comments, history, files and options have none; names change and collide; values with ids inside still need mapping |
| A bulk restore beside the framework (COPY with id rewriting) | Faster for large exports | A second import path without dry run, resumption, external ids or report; ADR-048 asks for one framework |
| Lossless checked on samples (the fidelity report's checksums) | Exists already | A sample proves little about 100,000 tickets; the re-export compares everything |
| Per-table checksums of normalized database rows | Independent of the export code | Needs a natural key for every row, which history and comments lack; the translated re-export reaches the same with the walkers the import already needs |
| Fixed-size JSON documents per ticket (history and comments inside) | One file to read | Large tickets make large lines; files would not be checked per kind |

## Consequences

- A change to a table the export carries needs the writer, the mapper, the loader and the
  documentation to follow; the round-trip tests (`export/export.test.ts`, and
  `routes/export-roundtrip.large.test.ts` with `TASKMOOR_LARGE_ROUNDTRIP=1`) fail until they do.
- Not carried in version 1 (listed in the format reference): access and visibility policies,
  notification policies, field rule sets and layouts, type and priority sets beyond the defaults,
  local-mode ownership, custom hierarchy levels, boards, sprints, saved searches, dashboards,
  webhooks, earlier workflow versions, comment versions and reactions, web links, key history,
  rich text originals. A ticket with a visibility level fails to import rather than leak.
- Objects matched by name keep the target's settings, so a round trip into an instance whose
  built-in objects differ from the source's is exact only for what the source created.
- The import is record by record (ADR-048): 100,000 tickets and their content import in minutes
  (measured in the progress row); set-based loading stays a later optimisation for the 1M-ticket
  imports of M1-091.
- The Jira-compatible CSV of IMP-014 is the search export of M1-042; the CSV importer reads it
  back.
