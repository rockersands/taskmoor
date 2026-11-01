# ADR-103: The import wizard and the import CLI: one API, an imports folder you can upload into

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-097

## Context

IMP-013 asks for imports run as background jobs from a wizard and the CLI, with progress,
throughput, pause, resume, cancel and logs; IMP-007 for people mapped by address, by a map, or as
SCIM provisioned them. M1-097 is done when the wizard's end-to-end test on the 10,000-issue
fixture is green and the CLI's exit codes are documented and tested. Until now every importer
(ADR-048, ADR-081, ADR-094, ADR-063) was started through `POST /api/v1/admin/imports` by hand,
with a file copied into the server's imports folder (`TASKMOOR_IMPORT_DIR`), and people of a
Data Center backup could only be matched by address. The user decided on 2026-10-31 that the
wizard offers what a backup's system administrators become (ADR-090, Changes).

## Decision

- **Settings > Imports** (`#/admin/imports`, `apps/web/src/admin/imports/`), for site
  administrators, on the existing routes. One form, in order: the source (a Data Center backup,
  a Taskmoor export or a CSV file chosen from the imports folder, or a Jira Cloud site with its
  address, account address, API token and project keys); the options (name; for a backup the
  scope `all`, `tickets` or `configuration` and whether its system administrators become site
  administrators, the default, or configuration administrators; for CSV the column mapping as
  JSON); then **Dry run**. When the dry run ends the page shows its report and the people it
  found (`records?kind=user`, at most 500): who matches someone by address, who would be added,
  who becomes a placeholder, each with a field for the address of an existing person to link
  them to. **Import** starts the real run with those rows. Progress is polled every two seconds
  (state, kind, per-kind counts, cancel); the finished run shows its fidelity report: totals,
  per kind, every warning with its code explained in words for the 30 most common codes (a
  general sentence for the rest), what was not imported, failures, the configuration mapping
  and the HTML download. Earlier runs are listed with their report, and a finished real run of
  a backup or a Cloud site offers **Delta run** (ADR-102), which opens the form for that run
  (a backup delta chooses the later backup; a Cloud delta needs nothing).
- **Uploads into the imports folder**: `GET /api/v1/admin/imports/files` lists the folder's files
  (top level and one folder down, what each looks like: a ZIP with `entities.xml` is a backup,
  one with `manifest.json` or a folder with it an export, `.csv` a CSV; the stage and unpack
  folders an import writes are left out) and `POST /api/v1/admin/imports/files?name=` takes the
  file as an `application/octet-stream` body (the only route with a raw body), up to 4 GiB,
  under a plain name ending in `.zip` or `.csv`, written to a `.part` file and linked into place
  so a cut upload leaves nothing and an existing file is never replaced (`409 file_exists`). The
  folder is made when missing. Event `import_file.uploaded` (name, size, kind), audited; admin
  scope through the `/api/v1/admin` prefix. Backups of tens of gigabytes are still copied into
  the folder on the server; the list shows them.
- **People maps**: a new people mode `map` (`import/cloud/people.ts`): by address, except the
  rows' people, who are linked to the existing person of the row's address (a placeholder with
  `person_unmapped` when nobody has it). The Cloud REST importer takes it beside `email`, `csv`
  and `scim`; the Data Center importer now takes the same `people` settings, its people named by
  user key, deleted people included (their work then goes to the person they are mapped to).
- **The CLI talks to the API** (`node cli.mjs import ...`, `apps/server/src/import/cli.ts`):
  `start` (a `--source` file with any source object, or `--dc-backup`, `--export`, `--csv` with
  `--mapping`, `--cloud` with the site token in `TASKMOOR_SOURCE_TOKEN`; `--people-map` CSV;
  `--dry-run`, `--delta-from`, `--name`), `follow`, `report` (`--json`, `--html FILE`),
  `status`, `list`, `cancel`, with `TASKMOOR_URL` and an API token with the admin scope in
  `TASKMOOR_TOKEN`. It works from the server's container and from an administrator's machine,
  the worker runs the import as usual, and the route's checks (the imports folder, sealing the
  token) apply unchanged. `follow` prints a line whenever the progress changes, then the report
  and a last line of JSON. **Exit codes**: 0 done (nothing failed, warnings within
  `--max-warnings` when given), 1 failed or cancelled, 2 done with failed records or more
  warnings than `--max-warnings`, 64 bad usage, 65 the server refused the request (a bad source,
  a path outside the folder, no such run), 69 the server cannot be reached or answered 5xx, 75
  the report was asked for before the run finished, 77 the token is not a site administrator's
  with the admin scope. Tokens never go on the command line.

## Options considered

- **A CLI on the database** (like `export`), running the import in the CLI's process. Rejected:
  it would repeat the route's checks and run beside the worker; through the API it is one code
  path, and it also works remotely.
- **Multipart uploads.** Rejected for a raw body: one file, streamed to disk without buffering,
  and the name in the query.
- **A column mapping editor for CSV.** Left for later: the JSON mapping of `docs/csv-import.md`
  is what the API takes; the wizard takes it as text.

## Consequences

- Tests: `routes/import-wizard.test.ts` (the folder list with kinds and without working files,
  uploads and their refusals: existing name, `../`, other extensions, hidden names, folders,
  wrong media type, other people, a size limit; a person of a backup mapped to an existing one,
  everyone else unchanged, a row naming nobody warns `person_unmapped`), `import/cli.test.ts`
  (each exit code from its situation), `admin/imports/ImportsPage.test.tsx` (the wizard's
  backup dry run, people map, import and report; upload; Cloud refusals; a delta run; an
  earlier run's report; non-administrators; pseudo-locale; a phone), stories with axe for the
  page, the wizard, the run panel, the report and the people list, and
  `e2e/import-wizard.spec.ts`.
- The end-to-end test uploads the 10,000-issue backup (seed 97, 4.6 MB, generated once by
  `e2e/web-server.ts` into `.cache/e2e`) to an instance of its own on 4185, runs a dry run and
  an import of configuration and tickets (10,000 created), maps a deleted person of the backup
  to the administrator and finds them linked, then a delta run that finds all 10,000 tickets
  unchanged: the spec ran in 3.0 minutes with the servers' start (2026-11-01, shared machine);
  the phone project checks the layout.
- The HTML report link carries no token: from a frontend on another site (OAuth mode) the
  download needs the session of the backend's own origin.
- Not yet: pause and resume as such (cancel and a new run, which updates, serve), downloadable
  logs, throughput figures, a CSV column mapping editor, choosing people from a list instead of
  typing an address, and more than 500 people listed for mapping.
