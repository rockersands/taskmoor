---
title: "Importing and exporting"
audience: admins
sources: apps/server/src/routes/imports.ts, apps/server/src/import/run.ts, apps/server/src/import/jobs.ts, apps/server/src/import/report.ts, apps/server/src/import/csv.ts, apps/server/src/import/taskmoor.ts, apps/server/src/import/synthetic.ts, apps/server/src/routes/exports.ts, apps/server/src/export/format.ts, apps/server/src/routes/search-export.ts, apps/server/src/cli.ts, apps/server/src/config.ts, apps/web/src/search/SearchPage.tsx, apps/web/src/i18n/messages.en.ts, docs/csv-import.md, docs/export-format.md, deploy/README.md, docs/adr/0048-importer-framework.md, docs/adr/0063-full-export-format.md, docs/plan/progress.csv, docs/specs/00-terminology.md, docs/specs/02a-platform-api-and-integrations.md
accessed: 2026-10-30
attestation: own-words
jira-names: import sources and field mapping
---
# Importing and exporting

Taskmoor imports CSV files and its own full exports, and exports a whole workspace, chosen
tracks, or the results of a search. Imports are for site administrators and run in the
background; exports of search results are open to everyone who can search.

## Importing from Jira Cloud or Jira Data Center

Taskmoor does not yet import a Jira Cloud site or a Jira Data Center backup ZIP. Any CSV file can
be imported today with a mapping of its columns, including one exported from another tracker;
see [CSV import](#csv-import).

## How imports run

Every import, whatever its source, runs the same way:

- **In the background.** Starting an import queues a job for the worker. It reads the source a
  batch at a time, in a fixed order of kinds (people and groups first, then configuration and
  tracks, then tickets, comments, links, time entries and files, and history last), and commits
  each batch with its checkpoint.
- **Resumable.** If the worker stops, the next attempt goes on from the last checkpoint; a crash
  loses at most the open batch. A batch that fails is retried with a pause, and after ten failed
  attempts the run ends as failed, with its report so far.
- **Dry runs first.** With `"dryRun": true`, the import plans every record and writes nothing but
  its own report. Its counts, warnings and problems are those a real run would have.
- **Safe to run again.** Every imported object is remembered by its source system and its id
  there. Importing the same source again leaves unchanged records alone and updates the ones that
  changed instead of adding copies.
- **One record at a time.** A record that cannot be imported fails alone, with its reason; the
  rest go on.
- **Kept facts.** Authors, times, numbers and statuses come from the source. Imported records
  send no notifications.

A run's state is `queued`, `running`, `done`, `failed` or `cancelled`. Starting, cancelling and
finishing an import are recorded in the audit log.

Taskmoor does not yet have a page for imports in the web app. Site administrators use the API
below (an API token needs the admin scope; see [The REST API](rest-api.md)).

### Starting an import

```http
POST /api/v1/admin/imports
Content-Type: application/json

{"name": "From the old server", "dryRun": true, "source": {"format": "taskmoor", "path": "taskmoor-export-2026-10-30.zip"}}
```

`name` is optional. The answer is `202` with the new run. `source.format` is `csv` (see
[CSV import](#csv-import)),
`taskmoor` (see [Importing an export](#importing-an-export)), or `synthetic`, a test format of
Taskmoor's own with a seeded generator, for trying the importer on a scratch instance.

### Following a run

| Request | Answers |
|---|---|
| `GET /api/v1/admin/imports` | The latest 50 runs |
| `GET /api/v1/admin/imports/<id>` | One run: state, the kind it is on, batches, and per kind the records read, created, updated, unchanged, linked to an existing object, failed and skipped; the number of warnings and the last error |
| `GET /api/v1/admin/imports/<id>/report` | The fidelity report as JSON; `?format=html` downloads it as a standalone page. `409` until the run has finished |
| `GET /api/v1/admin/imports/<id>/problems` | Every record with a failure or warnings, 100 a page |
| `POST /api/v1/admin/imports/<id>/cancel` | Asks a running import to stop after its current batch |

The **fidelity report** says, per kind, how many records the source had, what became of them,
how many objects exist after the run and the ratio of the two. It compares checksums on a sample
of records (the source's against the record read back), groups warnings by code, counts the kinds
Taskmoor could not import, and lists the first 100 failures.

The **problems** list takes `outcome` (`failed`, `skipped` or `warned`), `kind` (such as
`ticket`), `limit` (up to 1000) and `after` (the `next` value of the previous page). Each entry
gives the kind, the source id, the outcome, the target's id and the reasons.

### Files on the server

Small files go in the request itself (up to 16 MB). Larger files, and Taskmoor exports, are named
by a path inside the imports folder: `TASKMOOR_IMPORT_DIR`, by default `imports` in
`TASKMOOR_DATA` (`/data/imports` in the image). A path outside it is refused, and
`TASKMOOR_IMPORT_DIR=off` refuses every path. Create the folder first:

```bash
docker compose exec taskmoor mkdir -p /data/imports
docker compose cp ./backlog.csv taskmoor:/data/imports/backlog.csv
```

## CSV import

```json
{
  "dryRun": true,
  "source": {
    "format": "csv",
    "path": "backlog.csv",
    "system": "spring-backlog",
    "mapping": {
      "track": "WEB",
      "columns": [
        {"column": "Key", "to": "key"},
        {"column": "Summary", "to": "summary"},
        {"column": "Status", "to": "status"}
      ]
    }
  }
}
```

- `data` holds the file's text, or `path` names a file in the imports folder.
- `system` names where the rows come from (`csv` by default). Importing again with the same
  `system` updates the tickets the first import made.
- `mappingFrom: <run id>` instead of `mapping` reuses the mapping of an earlier CSV import, so a
  mapping that worked once serves as a template.
- The header is checked against the mapping before the run is queued: a column the mapping names
  but the file lacks is refused with `400 invalid_source` and the line.

### The mapping

| Key | Meaning |
|---|---|
| `columns` | `{"column", "to"}` pairs: a header of the file's first row and the target it fills. Several columns with the same header all fill that one target |
| `track` | The track for rows with neither a `track` nor a `key` column; it must exist |
| `type` | The ticket type for rows without a `type` column; the track's default type if left out |
| `delimiter` | `,` (default), `;`, a tab, or a vertical bar |
| `listSeparator` | Between several values in one cell; `;` by default |
| `people` | Text the file uses for people (names, old user names) mapped to email addresses |

### Column targets

| Target | Jira-compatible name | Cell |
|---|---|---|
| `id` | | The row's own id in the file; re-imports match rows by it |
| `key` | issue key | A ticket key such as `WEB-12`: the row's track and number. A ticket already at that key is updated |
| `track` | project | A track key |
| `summary`, `description` | | Text; the description is read as Markdown |
| `type` | issue type | A ticket type the target has; an unknown one fails the row |
| `status`, `priority` | | A name the target has; an unknown status leaves the workflow's first status and an unknown priority leaves it empty, each with a warning |
| `assignee`, `creator` | | An email address, or text the `people` map names |
| `requester` | reporter | As for `assignee` |
| `parent` | | Another row's `id` or `key`, or the key of a ticket the target has |
| `labels` | | Labels separated by spaces or the list separator |
| `targetRelease` | fix version | Release names in the row's track; missing ones are created |
| `foundInRelease` | affects version | As for `targetRelease` |
| `area` | component | Area names in the row's track; missing ones are created |
| `startDate`, `dueDate` | | A day (`2026-03-01`) or an instant |
| `createdAt`, `updatedAt`, `closedAt` | `closedAt`: resolved | ISO 8601, a day, or `YYYY-MM-DD HH:MM[:SS]` in UTC |
| `originalEstimate`, `remainingEstimate` | | Seconds, or hours and minutes such as `2h 30m` |
| `field` | | A custom field by its id (`"field": 10`); values go through the same checks as an edit |
| `ignore` | | Nothing; the column is skipped |

Statuses and ticket types are never created from a file. People who are not in Taskmoor yet are
added as deactivated accounts, so tickets keep who did what. Parents are imported before their
children wherever they sit in the file; a parent that is not on a higher hierarchy level is left
out with a warning. A cell that does not read is left empty and listed as a warning on its row.

### Rows, ids and updates

A row is known by its `id` column, else its `key` column, else its line number. Only the first
two survive edits to the file, so give a file you will import again one of them; a repeated id
fails the second row as `duplicate_row_id`. On an update, fields the mapping does not name keep
their values, and every change is in the ticket's history, made by the system.

## Exporting search results

After a search, the results page offers **Export CSV** and **Export JSON** (see
[Search and the query language](../use/search.md)). Both export every ticket the query finds, in
its order and in the columns shown, never a ticket the person could not see. The API is
`GET /api/v1/search/export?q=<query>&format=csv&columns=key,summary,status`:

- `format` is `csv` (default) or `json`; `columns` lists result columns such as `assignee`,
  `targetReleases` or `cf[10]`, and the key always comes first. Without `columns` it uses key,
  summary, status, assignee, priority and updated.
- The file is `tickets-<date>.csv` or `.json`, streamed 500 tickets at a time with no row limit.
- In CSV, lists are joined by `; ` and a cell starting with `=`, `+`, `-`, `@`, a tab or a
  carriage return gets a leading apostrophe, so a spreadsheet does not run it as a formula. CSV
  import removes that apostrophe again; people appear by name, so map them with `people`.

## Full export

A full export writes a workspace as documented plain files that any tool can read and another
Taskmoor instance can import.

- **Download:** a site administrator opens `GET /api/v1/admin/export` and receives
  `taskmoor-export-<date>.zip`, written while it downloads. `?tracks=KEY,KEY` exports only those
  tracks and what belongs to them, with the whole configuration.
- **Command line:** `node cli.mjs export <folder> [--tracks KEY,KEY]` writes the same files into
  an empty folder; see [The operator CLI](cli.md).

Every export is recorded in the audit log.

### What is in it

`manifest.json` and one `.ndjson` file per kind, in the order an import reads them: users,
groups, teams, roles, statuses, priorities, close reasons, ticket types, link types, tracks, releases,
areas, fields, field contexts, field options, workflows, workflow maps, tickets, comments, links,
time entries, attachments and history, plus the files under `attachments/`.

- Each line is one record as JSON with its keys in alphabetical order, so the same data always
  gives the same bytes. Every record has an `id`, the source's own, as a string; other records
  refer to it by that string.
- Times are UTC with microseconds, days are `YYYY-MM-DD`, durations are whole seconds. Rich text
  is Taskmoor's stored document format, unchanged.
- Tickets on higher hierarchy levels come first, so a parent precedes its children. A history
  record is one change of one ticket, with fields named as the query language names them.
- The manifest names the format and its version (1), the source instance and workspace, the time,
  the chosen tracks, and for each file its records, size and SHA-256. It is written last: an
  export without one is incomplete, and an import refuses it.

### Importing an export

Put the folder or the ZIP in the target's imports folder and start an import:

```json
{"source": {"format": "taskmoor", "path": "taskmoor-export-2026-10-30.zip"}, "dryRun": true}
```

A ZIP is unpacked once next to itself, so leave room for it. Objects the target already has are
matched rather than created: people by email; groups, teams, roles, statuses, priorities, close reasons,
ticket types, link types and workflows by name; fields, releases and areas by name within what
they belong to. Importing the same export again changes nothing, and a later export of the same
workspace updates what changed and adds what is new. People arrive without a password: they sign
in through single sign-on or after an administrator sends them a password link.

### Not carried

These stay with the source instance, and the report says what could not come across:

- access policies, track role memberships, global permissions, visibility policies (a ticket
  with a visibility level fails to import), notification policies, field rule sets, layouts, and
  type and priority sets beyond the defaults; set up access to imported tracks again;
- local-mode ownership: such tracks, types and workflows import as shared ones;
- hierarchy levels above Outcome;
- boards, sprints, saved searches, dashboards, webhooks, service accounts and API tokens;
- earlier workflow versions and drafts, earlier versions of comments, reactions, web links, key
  history of moved tickets, and files that failed or await the virus scan.
