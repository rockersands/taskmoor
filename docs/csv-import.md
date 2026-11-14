# CSV import

A site administrator imports tickets from a CSV file through the importer framework (IMP-012,
ADR-048): the same background runs, dry runs, resumption, fidelity reports and per-record
problems as every other import. This page describes the request and the mapping.

## Starting an import

```
POST /api/v1/admin/imports
{
  "dryRun": true,
  "source": {
    "format": "csv",
    "data": "Key,Summary,Status\nWEB-1,First,New\n",
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

- `data` is the file's text (up to 16 MB), or `path` names a file in the imports folder
  (`TASKMOOR_IMPORT_DIR`, by default `TASKMOOR_DATA/imports`) for larger files. A path outside
  that folder is refused.
- `system` names the file's rows: importing again with the same `system` updates the tickets the
  first import made instead of adding new ones. It defaults to `csv`.
- `mappingFrom: <import id>` instead of `mapping` reuses the mapping of an earlier CSV import, so a
  mapping that worked once is a template for the next file.
- The header is checked against the mapping when the import is started: a column the mapping
  names but the file lacks answers 400 `invalid_source` with the line.

Follow the run at `GET /api/v1/admin/imports/<id>`; read the fidelity report at `.../report` and
every row's problems at `.../problems` (`?outcome=failed`, `warned` or `skipped`, `?kind=ticket`,
paged with `after`).

## The mapping

| Key | Meaning |
|---|---|
| `columns` | `{column, to}` pairs: the header as the file's first row has it, and what it fills. A header that appears several times fills one field with every column of that name. |
| `track` | The track of rows that have neither a `track` nor a `key` column. It must exist. |
| `type` | The ticket type of rows without a `type` column (it must exist); the track's default type if left out. |
| `delimiter` | `,` (default), `;`, a tab or `|`. |
| `listSeparator` | Between several values in one cell (releases, areas, fields with several values); `;` by default. |
| `people` | Text the file uses for people (display names, old user names) to their email addresses. |

`to` is one of:

| Target | Cell |
|---|---|
| `id` | The row's own id in the file: re-imports match rows by it. |
| `key` | A ticket key such as `WEB-12`: the row's track and number. A ticket already at that key is updated (create or update by key). |
| `track` | A track key. |
| `summary`, `description` | Text; the description is read as Markdown. |
| `type`, `status`, `priority` | A name the target has. A row with an unknown type fails; an unknown status leaves the ticket in its workflow's first status and an unknown priority leaves it empty, each with a warning. Statuses and types are never created from a file. |
| `assignee`, `requester`, `creator` | An email address, or text the `people` map names. People who are not in the target yet are added as deactivated accounts, so the tickets keep who did what. |
| `parent` | The `id` (or `key`) of another row of the file, or the key of a ticket the target already has. Parents are imported before their children wherever they are in the file. A parent must sit on a higher hierarchy level (a subticket under a feature, say); one that does not is left out with a warning. |
| `labels` | Labels separated by spaces or the list separator. |
| `targetRelease`, `foundInRelease`, `area` | Names in the row's track; ones the track lacks are created. |
| `startDate`, `dueDate` | A day (`2026-03-01`) or an instant. |
| `createdAt`, `updatedAt`, `closedAt` | An instant in ISO 8601, a day, or `YYYY-MM-DD HH:MM[:SS]` in UTC. |
| `originalEstimate`, `remainingEstimate` | Seconds, or hours and minutes (`2h 30m`). |
| `field` (with `field: <id>`) | A custom field of the target by its id: option values by name (a cascading choice as `Parent / Child`), people by email, groups, teams, releases and areas by name, numbers, days, text. The value goes through the same checks as an edit through the API. |
| `ignore` | Nothing: the column is read past. |

A cell that does not read (an unknown option, a date that is not one) is left empty and listed as
a warning on its row; a row that cannot be imported at all (no summary for a new ticket, an
unknown track or type) fails alone and is listed with its reason.

On an update, fields the mapping does not name keep their values. Every change an import makes
is in the ticket's history, by the system.

## Rows and ids

A row is identified by its `id` column, else its `key` column, else its line in the file
(`line:<n>`). Only the first two survive edits to the file, so give a file that will be imported
again one of them. Two rows with the same id: the second fails as `duplicate_row_id`.

## Files from Taskmoor

A CSV exported from search results (`GET /api/v1/search/export`) imports back with a mapping of
its columns. Its first bytes are a UTF-8 byte-order mark, as on every Taskmoor CSV export (T-252);
the importer leaves the mark out, as it does for any file that starts with one. Lists in its cells are separated by `; `, and the apostrophe the export puts before a
cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return (so that a spreadsheet does
not run it as a formula) is removed again. People appear by name in that export: map them with
`people`.
