---
title: "Importing and exporting"
audience: admins
sources: apps/server/src/routes/imports.ts, apps/server/src/import/run.ts, apps/server/src/import/jobs.ts, apps/server/src/import/report.ts, apps/server/src/import/csv.ts, apps/server/src/import/dc.ts, apps/server/src/import/dc-backup/stage.ts, apps/server/src/import/taskmoor.ts, apps/server/src/import/synthetic.ts, apps/server/src/routes/exports.ts, apps/server/src/export/format.ts, apps/server/src/routes/search-export.ts, apps/server/src/cli.ts, apps/server/src/config.ts, apps/web/src/search/SearchPage.tsx, apps/web/src/i18n/messages.en.ts, docs/csv-import.md, docs/export-format.md, deploy/README.md, docs/adr/0048-importer-framework.md, docs/adr/0063-full-export-format.md, docs/adr/0081-dc-backup-mapping.md, docs/adr/0089-dc-fields-and-forms.md, docs/adr/0090-dc-access-and-visibility.md, docs/adr/0092-dc-ticket-content.md, apps/server/src/import/dc-content.ts, apps/server/src/import/dc-backup/stage-issues.ts, apps/server/src/import/load-weblinks.ts, apps/server/src/import/dc-schemes.ts, apps/server/src/import/load-access.ts, apps/server/src/import/dc-fields.ts, apps/server/src/import/load-forms.ts, apps/server/src/fields/sets.ts, docs/specs/02d-dc-backup-format.md, docs/plan/progress.csv, docs/specs/00-terminology.md, docs/specs/02a-platform-api-and-integrations.md
accessed: 2026-10-31
attestation: own-words
jira-names: import sources and field mapping
---
# Importing and exporting

Taskmoor imports CSV files, its own full exports and a Jira Data Center backup's configuration
and issues, and exports a whole workspace, chosen tracks, or the results of a search. Imports are
for site administrators and run in the background; exports of search results are open to
everyone who can search.

## Importing from Jira Cloud or Jira Data Center

A Jira Data Center or Server backup ZIP imports its people, groups, roles, projects (as tracks),
issue types, statuses, priorities, resolutions, custom fields with their contexts and options,
field configurations and screens, permission, issue security and notification schemes, global
permissions, and its issues as tickets with their own fields, custom values, security levels,
watchers, voters and earlier keys, with their comments, change history, time entries, links,
web links and attachments; see [Data Center backups](#data-center-backups). Workflows, boards
and filters are not imported yet: the report counts each of them under "Not imported". Taskmoor does not yet import a Jira Cloud site. Any CSV file can be imported with
a mapping of its columns, including one exported from another tracker; see
[CSV import](#csv-import).

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
`taskmoor` (see [Importing an export](#importing-an-export)), `dc-backup` (see
[Data Center backups](#data-center-backups)), or `synthetic`, a test format of Taskmoor's own
with a seeded generator, for trying the importer on a scratch instance.

### Following a run

| Request | Answers |
|---|---|
| `GET /api/v1/admin/imports` | The latest 50 runs |
| `GET /api/v1/admin/imports/<id>` | One run: state, the kind it is on, batches, and per kind the records read, created, updated, unchanged, linked to an existing object, failed and skipped; the number of warnings and the last error |
| `GET /api/v1/admin/imports/<id>/report` | The fidelity report as JSON; `?format=html` downloads it as a standalone page. `409` until the run has finished |
| `GET /api/v1/admin/imports/<id>/problems` | Every record with a failure or warnings, 100 a page |
| `GET /api/v1/admin/imports/<id>/records` | Every record with its name in the source and what became of it, 100 a page |
| `POST /api/v1/admin/imports/<id>/cancel` | Asks a running import to stop after its current batch |

The **fidelity report** says, per kind, how many records the source had, what became of them,
how many objects exist after the run and the ratio of the two. It compares checksums on a sample
of records (the source's against the record read back), groups warnings by code, counts the kinds
Taskmoor could not import with the reason, and lists the first 100 failures.

Its **mapping** names each configuration object: people, groups, teams, roles, statuses,
priorities, close reasons, ticket types, link types, tracks, releases, areas, fields and
workflows. For each it gives the name the object had in the source, and whether the import
created it, linked it to your object of the same name (people by email address), found it
unchanged since the last run, or left it out, with the reason. It lists up to 500 objects of a
kind. The **records** list has them all and takes `kind`, `outcome` (`created`, `updated`,
`unchanged`, `linked`, `failed` or `skipped`), `limit` and `after`, like the problems list.

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

## Data Center backups

A Jira Data Center or Server backup is the ZIP the server writes into the `export` folder of its
home directory. Copy it into the imports folder and start a dry run first:

```bash
docker compose cp ./jira-backup.zip taskmoor:/data/imports/jira-backup.zip
```

```http
POST /api/v1/admin/imports
Content-Type: application/json

{"name": "Jira, first look", "dryRun": true, "source": {"format": "dc-backup", "path": "jira-backup.zip", "system": "jira-prod"}}
```

Add `"scope": "configuration"` to import everything but the issues first. The report then
counts the issues and their values under "Not imported" with the reason `configuration_only`,
and a later run without it adds them. `"scope": "tickets"` imports the tickets too, but not
their comments, history, time entries, links, web links and attachments, which are counted with
the reason `tickets_only`.

`system` names the Jira instance, by default `dc`. Importing a later backup with the same
`system` updates what the first import made instead of adding copies. Give each instance its own
name if you import several into one workspace.

The request only checks that the file is a ZIP with `entities.xml` at its root. The job then
reads the whole backup once, as a stream, and keeps what it read in a folder next to the ZIP
(`jira-backup.zip.staged`). Later runs of the same file, such as the real run after the dry run,
use that folder instead of reading the backup again. Delete it when you no longer need it. The
imports folder needs room for it: about the size of the backup's `entities.xml` while it is
written, and somewhat less afterwards. Attachment files stay in the ZIP and are read from it
during the import, so keep the ZIP until the import is done.

What the import makes of the backup:

| In the backup | In Taskmoor | How it matches what you have |
|---|---|---|
| Users | People | By email address. A person already here is linked, never changed |
| Inactive users | Deactivated people | By email address |
| Deleted users that issues, comments, history or roles still name | Deactivated people with a placeholder address, so attribution stays | Never matched |
| Groups and their user members | Groups, with the members added | By name. A linked group keeps its own members too |
| Project roles | Roles | By name |
| Projects | Tracks, with key, name, description, lead as owner, type and the last issue number used | Never matched: a key you already use fails that track |
| Project role members (people and groups) | Role members of the track | Added, never removed |
| Issue types | Ticket types; sub-task types become subticket types | By name |
| Statuses | Statuses, with their category as the stage | By name |
| Priorities | Priorities, after your own | By name |
| Resolutions | Close reasons, after your own | By name |
| Custom fields | Fields of the same type: text, paragraph, number, date, date and time, select (dropdown, radio buttons, checkboxes; one value or several), cascading select, person, group, labels, URL, read-only text | By name; a field of yours with that name but another type fails the field |
| Fields of apps Taskmoor has no importer for | Read-only text fields holding each issue's raw values | By name |
| Custom field contexts | Contexts, applying to the same tracks and ticket types | By name within the field |
| Options, with disabled ones and cascading children | Options, in the same order | By value within the context |
| Default values | The context's default: an option, a number or a text | |
| Field configuration schemes, with each issue type's field configuration | Field rule sets, used by the projects' tracks: required, hidden and help text per field, for every type or one | By name. A set of yours with that name is used as it is |
| The default field configuration, for projects without a scheme | A field rule set of the same name for those tracks | By name |
| Issue type screen schemes, with their screen schemes and screens | Layout sets, used by the projects' tracks: per type and operation (create, edit, view), the screen's tabs and fields, and nothing else | By name. A set of yours with that name is used as it is |
| Permission schemes | Access policies, used by the projects' tracks. Identical schemes (the same grants, whatever their names) become one policy, and the report names each merge | By name. A policy of yours with that name is used as it is |
| Grants to groups, people, project roles, the reporter, the assignee, the project lead, user and group fields, anyone signed in, and anyone | Grants to the same, the reporter as the requester and the lead as the track owner | |
| Issue security schemes and their levels | Visibility policies and levels, with the same members and the default level, used by the projects' tracks | By name; levels by name within the policy |
| Notification schemes | Notification policies, used by the projects' tracks, with each event's recipients | By name |
| Global permissions | Global grants: system administrators become site administrators, administrators configuration administrators; the user picker, shared filters, group subscriptions and bulk change keep their meaning | Linked when the same grant is there |
| Issues | Tickets with their key, type, status, priority, close reason, assignee, reporter (as requester), creator, summary, description, due date, estimates, labels, parent, custom values and security level | By track and number on a later run |
| Watchers and voters | Followers and voters of the ticket | |
| Earlier keys of issues moved between projects | Earlier keys of the ticket: opening or searching for the old key finds it | |
| Comments, with group or role restrictions and edits | Comments by the same author at the same time, restricted to the same group or role, marked edited when they were | |
| Change history | History entries with their original author and time: status, resolution (as close reason), priority, type, assignee, reporter, project (as track), key, summary, description, environment, due date, labels, estimates, time spent and custom fields. The ticket's starting values are worked out from the first change of each field | |
| Work logs, with group or role restrictions | Time entries by the same person, started at the same time, with the same duration and text | |
| Links between issues, of any link type | Ticket links of the link type of the same name, made when you have none | By link type name |
| Remote links | Web links with the address, title, summary, icon, relationship and global id | |
| Attachments in the ZIP's `data/attachments` folder | Attachments with their name, type, size, author and time; the file goes to the attachment store, and its hash is checked | |

The report's mapping names each of these objects with its outcome. The warnings to look for:

| Warning | Meaning |
|---|---|
| `removed_character` (kind `source`) | Characters XML does not allow (NUL, control characters, U+FFFE and U+FFFF, and references to them) were removed while reading. The examples give the file and byte offset |
| `deleted_user`, `placeholder_email`, `no_email` | A person became a deactivated placeholder, or has no address in the backup |
| `nested_group_not_imported` | A group inside a group: its members are not added yet |
| `member_not_found` | A membership names a user the backup does not have |
| `status_not_in_workflow` | A new status is in no workflow until workflows are imported |
| `unknown_status_category` | The status's category is not one Taskmoor knows: it is imported as a new-stage status |
| `unknown_project_type` | A project type other than software or business: the track is a business track |
| `original_key_not_kept` | The project was renamed in Jira: its earlier key is not kept yet |
| `role_actor_unknown_group`, `role_actor_unknown_role`, `role_actor_not_imported` | A project role member that could not be added |
| `app_field_as_read_only_text` | A field of an app became read-only text with the raw values |
| `context_scope_not_imported` | A context named a project category, or a project or type the backup does not have. A context with nothing left fails rather than applying everywhere |
| `default_not_imported` | A context's default value could not be read |
| `field_rule_not_mapped`, `layout_field_not_mapped` | A field configuration or screen names a field Taskmoor has no counterpart for (security level, attachments) |
| `form_field_not_imported` | A rule or a layout names a custom field the import left out |
| `field_value_not_imported`, `invalid_field_value` | An issue's value of a field that was not imported, or one the field cannot hold |
| `type_not_offered` | The ticket's track does not offer its type yet (issue type schemes are not imported yet) |
| `merged_into` (kind `access_policy`) | A permission scheme had the same grants as an earlier one: its tracks use that policy |
| `permission_not_mapped` | A permission, often an app's, that Taskmoor does not have |
| `grantee_not_found`, `grantee_not_mapped`, `grantee_not_imported` | A grant or level member whose group, person, role or field is missing, or whose kind Taskmoor does not have. It is left out, so nobody sees more than before |
| `site_admin_browses_every_track` | System administrators became site administrators, who see every track (visibility levels still apply to them) |
| `event_not_mapped`, `custom_event_not_imported`, `recipient_not_mapped` | A notification for an event (such as a comment edited) or to a recipient (such as an email address) Taskmoor has no counterpart for |
| `former_key_not_kept`, `former_key_taken` | A moved issue's earlier key names a project the backup does not have, or another ticket holds it now |
| `history_field_not_mapped` | A change of a field Taskmoor's history does not follow (such as components or sprints): that part of the entry is left out. An entry with nothing left is skipped with the reason `history_nothing_mapped` |
| `visibility_group_and_role` | A comment or time entry restricted to both a group and a role: the role is kept |
| `web_link_application_not_kept`, `web_link_text_cut`, `web_link_icon_dropped` | A web link's application name, an over-long text or an icon that is not a web address was left out |
| `attachment_size_differs`, `attachment_folder_key_differs` | An attachment's file has another size than its row says (the file's is kept), or sits in another issue's folder |
| `link_type_created` | A link type you did not have was made for the backup's links |

Records that fail rather than arrive changed, each with its reason in the report: a comment or
time entry restricted to a group or role that did not import (`visibility_group_missing`,
`visibility_role_missing`), so nobody sees it who could not before; an attachment whose file
is not in the ZIP (`attachment_file_missing`) or whose bytes do not match; a web link whose
address is not an http or https address (`web_link_url_invalid`); a link of a type the backup
does not have (`link_type_missing`).

A ticket whose security level could not be imported fails rather than arriving without one,
because then everyone who browses its track would see it. People who were inactive are
deactivated and see nothing until you reactivate them.

Descriptions, environments and comments are wiki markup in the backup and become formatted
text: headings, lists, emphasis, links, quotes, code, tables and the rest. Time entries hold
plain text, so their markup is reduced to its words. Paragraph custom values still come in as
plain text. Mentions of people (`[~key]`) keep the backup's user key, not the person.

Links between issues and web links carry no time in the backup: a link takes the later of its
two tickets' creation time, and a web link the time of the import. Followers and voters do not
keep when they started following or voted.

Under "Not imported", the report counts each part of the backup the importer does not handle
yet: workflows, filters, boards and sprints, other kinds of associations, and attachment files
no attachment row names (`no_attachment_row`), by their names in the backup, with the reason
`not_imported_yet`. The id counters of the backup are listed as `not_needed`, because Taskmoor
gives its own ids.

Times in a backup carry no time zone. They are read as UTC, so history, comments and time
entries from a server in another zone are shifted by its offset; a setting for the source's
zone is still to come.

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
