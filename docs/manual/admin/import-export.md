---
title: "Importing and exporting"
audience: admins
sources: apps/server/src/import/archive.ts, docs/adr/0110-outbound-guard-archive-limits-storage-quotas.md, apps/server/src/routes/imports.ts, apps/server/src/import/run.ts, apps/server/src/import/jobs.ts, apps/server/src/import/report.ts, apps/server/src/import/csv.ts, apps/server/src/import/dc.ts, apps/server/src/import/dc-backup/stage.ts, apps/server/src/import/taskmoor.ts, apps/server/src/import/synthetic.ts, apps/server/src/routes/exports.ts, apps/server/src/export/format.ts, apps/server/src/routes/search-export.ts, apps/server/src/cli.ts, apps/server/src/config.ts, apps/web/src/search/SearchPage.tsx, apps/web/src/i18n/messages.en.ts, docs/csv-import.md, docs/export-format.md, deploy/README.md, docs/adr/0048-importer-framework.md, docs/adr/0063-full-export-format.md, docs/adr/0081-dc-backup-mapping.md, docs/adr/0089-dc-fields-and-forms.md, docs/adr/0090-dc-access-and-visibility.md, docs/adr/0093-dc-workflows.md, apps/server/src/import/dc-workflows.ts, apps/server/src/import/dc-backup/stage-workflows.ts, apps/server/src/import/load-config.ts, apps/server/src/import/dc-schemes.ts, apps/server/src/import/load-access.ts, apps/server/src/import/dc-fields.ts, apps/server/src/import/load-forms.ts, apps/server/src/fields/sets.ts, docs/specs/02d-dc-backup-format.md, docs/plan/progress.csv, docs/specs/00-terminology.md, docs/specs/02a-platform-api-and-integrations.md, docs/adr/0092-dc-ticket-content.md, apps/server/src/import/dc-content.ts, apps/server/src/import/dc-backup/stage-issues.ts, apps/server/src/import/load-weblinks.ts, docs/adr/0094-cloud-rest-import.md, apps/server/src/import/cloud/source.ts, apps/server/src/import/cloud/fetch.ts, apps/server/src/import/cloud/client.ts, apps/server/src/import/cloud/people.ts, apps/server/src/import/load-agile.ts, apps/server/src/boards/one-per-track.ts, docs/adr/0116-one-place-per-track.md, apps/server/src/import/dc-agile.ts, apps/server/src/import/dc-backup/stage-agile.ts, apps/server/src/import/dc-backup/agile-format.ts, docs/adr/0095-dc-boards-and-sprints.md, apps/server/src/import/dc-filters.ts, apps/server/src/import/load-filters.ts, apps/server/src/import/translate/jql.ts, apps/server/src/import/translate/corpus.ts, apps/server/src/import/dc-backup/stage-filters.ts, apps/server/src/routes/saved-searches.ts, apps/web/src/search/SavedSearchBar.tsx, docs/adr/0096-dc-filters-and-query-translation.md, docs/adr/0097-imported-keys-and-links.md, docs/adr/0102-delta-import-runs.md, docs/adr/0103-import-wizard-and-cli.md, apps/server/src/import/cli.ts, apps/server/src/import/files.ts, apps/web/src/admin/imports/ImportsPage.tsx, apps/web/src/admin/imports/ImportWizard.tsx, packages/webconfig/src/links.ts, apps/server/src/routes/imported-links.ts, apps/server/src/frontend.ts, apps/web/src/routing/ImportedLinkPage.tsx
accessed: 2026-11-03
attestation: own-words
jira-names: import sources and field mapping
---
# Importing and exporting

Taskmoor imports CSV files, its own full exports, a Jira Data Center backup's configuration
and issues, and a Jira Cloud site (or any server with a Jira-compatible REST API) read with your
own API token, and exports a whole workspace, chosen tracks, or the results of a search. Imports are
for site administrators and run in the background; exports of search results are open to
everyone who can search.

## Importing from Jira Cloud or Jira Data Center

A Jira Data Center or Server backup ZIP imports its people, groups, roles, projects (as tracks),
issue types, statuses, priorities, resolutions, custom fields with their contexts and options,
field configurations and screens, permission, issue security and notification schemes, global
permissions, workflows and workflow schemes, and its issues as tickets with their own fields, custom values, security levels,
watchers, voters and earlier keys, with their comments, change history, time entries, links,
web links and attachments, its versions (as releases) and components (as areas), its boards with
their columns, quick filters and sprints, and the issues' rank; see
[Data Center backups](#data-center-backups). Saved filters are not imported yet: the report
counts them under "Not imported". A Jira Cloud site imports its projects, issues with their changelog, comments and worklogs,
custom fields, boards and sprints over its REST API, with your own API token; see
[Jira Cloud sites](#jira-cloud-sites). Any CSV file can be imported with
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
  changed instead of adding copies. A [delta run](#delta-runs-for-a-cutover) brings only what
  changed since an earlier run.
- **One record at a time.** A record that cannot be imported fails alone, with its reason; the
  rest go on.
- **Kept facts.** Authors, times, numbers and statuses come from the source. Imported records
  send no notifications.

A run's state is `queued`, `running`, `done`, `failed` or `cancelled`. Starting, cancelling and
finishing an import are recorded in the audit log.

Site administrators import from **Administration > Imports** (see [The import wizard](#the-import-wizard)),
from the command line (see [The import command](#the-import-command)), or through the API
below (an API token needs the admin scope; see [The REST API](rest-api.md)).

### The import wizard

**Administration > Imports** takes you through one import at a time:

1. **Source.** A Jira Data Center backup, a Taskmoor export or a CSV file from the imports
   folder (see [Files on the server](#files-on-the-server)), or a Jira Cloud site with its
   address, the account's email address, an API token and, if you like, the project keys. A
   file of up to 4 GB can be uploaded into the folder from here; larger backups are copied into
   the folder on the server, and then appear in the list.
2. **Options.** A name for the import. For a backup: what to bring (everything; configuration
   and tickets without their comments, history, time, links and files; or configuration only),
   and whether the backup's system administrators become site administrators (the default) or
   configuration administrators. For a CSV file: the column mapping as JSON (see
   [CSV import](#csv-import)).
3. **Dry run.** It reads everything and writes nothing. Its report appears when it ends, with
   the people of the source: who matches someone here by email address, who would be added, and
   who becomes an inactive placeholder. To link a person to someone who is already here (a
   colleague whose address changed, or someone who left), type that person's address next to
   them. Everyone else is matched by address.
4. **Import.** The real run, with your people mapping. The page follows it: what it is on, the
   records read and what became of them per kind, and a button to cancel it. Then it shows the
   report: the totals, each kind, every warning with what its code means, what was not imported
   and why, failures, how each configuration object was mapped, and the report to download as a
   page.

Earlier imports are listed below the wizard with their reports. A finished import of a backup or
a Cloud site offers **Delta run**, which brings only what changed since; see
[Delta runs for a cutover](#delta-runs-for-a-cutover).

### The import command

On the server, or on any machine that reaches it, `cli.mjs` starts and follows imports through
the API. It needs the server's address in `TASKMOOR_URL` and an API token of a site
administrator with the admin scope in `TASKMOOR_TOKEN`:

```bash
docker compose exec -e TASKMOOR_URL=http://localhost:8080 -e TASKMOOR_TOKEN taskmoor \
  node cli.mjs import start --dc-backup jira-backup.zip --scope tickets --dry-run --follow
```

| Command | Does |
|---|---|
| `import start <source> [--dry-run] [--name N] [--delta-from ID] [--follow] [--max-warnings N]` | Starts an import; with `--follow`, follows it to its report |
| `import follow <id>` | Follows a run: a line whenever its progress changes, then its report |
| `import report <id> [--json] [--html FILE]` | The report as text, as JSON, or written to a page |
| `import status <id>`, `import list`, `import cancel <id>` | One run, the latest 50, or cancel one |

The source is one of `--dc-backup PATH` (with `--scope all|tickets|configuration`,
`--system-admins site_admin|configuration_admin` and `--system NAME`), `--export PATH`,
`--csv PATH --mapping FILE` (the mapping as JSON), `--cloud URL` (with `--email`, `--projects
A,B` and `--jql`; the site's API token goes in `TASKMOOR_SOURCE_TOKEN`, never on the command
line), or `--source FILE`, a file with the whole `source` object of the API. `--people-map FILE`
links people as the wizard does: a CSV of two columns, the person in the source (user key,
account id or address) and the address of the person here. Paths are inside the imports folder.
A delta run takes `--delta-from ID` alone for a Cloud site, or with the later backup.

The command's **exit code** says how it went, for scripts:

| Code | Meaning |
|---|---|
| 0 | Done: nothing failed, and no more warnings than `--max-warnings` when it is given (also: started, without `--follow`) |
| 1 | The run failed or was cancelled |
| 2 | Done, but some records failed, or there were more warnings than `--max-warnings` |
| 64 | Bad usage: an unknown command or option, a missing value |
| 65 | The server refused the request: a bad source, a file outside the imports folder, no such run |
| 69 | The server could not be reached, or answered with an error of its own |
| 75 | The report was asked for before the run finished |
| 77 | The token is not a site administrator's with the admin scope |

### Starting an import

```http
POST /api/v1/admin/imports
Content-Type: application/json

{"name": "From the old server", "dryRun": true, "source": {"format": "taskmoor", "path": "taskmoor-export-2026-10-30.zip"}}
```

`name` is optional. The answer is `202` with the new run. `source.format` is `csv` (see
[CSV import](#csv-import)),
`taskmoor` (see [Importing an export](#importing-an-export)), `dc-backup` (see
[Data Center backups](#data-center-backups)), `cloud-rest` (see
[Jira Cloud sites](#jira-cloud-sites)), or `synthetic`, a test format of Taskmoor's own
with a seeded generator, for trying the importer on a scratch instance.

### Following a run

| Request | Answers |
|---|---|
| `GET /api/v1/admin/imports` | The latest 50 runs |
| `GET /api/v1/admin/imports/<id>` | One run: state, the kind it is on, batches, and per kind the records read, created, updated, unchanged, linked to an existing object, failed and skipped; the number of warnings, the last error, and the run a delta started from (`deltaFrom`) |
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
`unchanged`, `linked`, `failed`, `skipped`, or `deleted` for what a
[delta run](#delta-runs-for-a-cutover) found gone from the source), `limit` and `after`, like the
problems list.

The **problems** list takes `outcome` (`failed`, `skipped` or `warned`), `kind` (such as
`ticket`), `limit` (up to 1000) and `after` (the `next` value of the previous page). Each entry
gives the kind, the source id, the outcome, the target's id and the reasons.

### Files on the server

Small files go in the request itself (up to 16 MB). Larger files, and Taskmoor exports, are named
by a path inside the imports folder, where the wizard also uploads them
(`POST /api/v1/admin/imports/files?name=<file name>` with the file as an
`application/octet-stream` body, up to 4 GB; `GET /api/v1/admin/imports/files` lists the
folder): `TASKMOOR_IMPORT_DIR`, by default `imports` in
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
and a later run without it adds them. Boards come with the configuration, but their sprints and the
issues' rank are counted as `configuration_only` until the tickets come. `"scope": "tickets"`
imports the tickets too, but not
their comments, history, time entries, links, web links and attachments, which are counted with
the reason `tickets_only`.

The source's system administrators become site administrators, who run the instance and see
every track. Add `"systemAdmins": "configuration_admin"` to make them configuration
administrators instead: they manage the configuration but not the site, and the report warns
`system_admin_as_configuration_admin`. Importing again with the other choice changes the grants
the earlier run made, so nobody keeps the wider one.

Before anything is unpacked, the ZIP is held to the archive limits: at most 512 GiB unpacked,
at most 200 times its packed size for an entry above 1 MiB or for the whole archive, and at most
10 million entries. A backup beyond them is refused when the import starts, with the limit and
the numbers; raise them with `TASKMOOR_ARCHIVE_MAX_GIB`, `TASKMOOR_ARCHIVE_MAX_RATIO` and
`TASKMOOR_ARCHIVE_MAX_ENTRIES` (see [the configuration reference](configuration.md)).

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
| Workflows | Published workflows (version 1) with the same statuses, initial status and transitions: global ones from any status, shared ones from every status that offers them, and each status's own. A transition keeps its id, name, description, screen (as its layout), properties and custom event. Identical workflows (whatever their names) become one, and the report names each merge | By name. A workflow of yours with that name is used as it is |
| Conditions, validators and post functions | Guards, checks and effects of the same kind, with their settings: only the assignee or reporter, never, a permission, sub-tasks done, a group, a role or any of several roles, a people field; permission validators; assign to the current user, the project lead or the reporter, and clearing a field. Groups of conditions keep their all or any nesting | |
| Step properties that lock editing or limit comments, attachments, assigning or transitions to a role or group | Who may do what in the status | |
| Workflow schemes | Workflow maps, used by the projects' tracks: each issue type's workflow, and the default for the rest. Schemes that become identical once their workflows merged become one | By name. A map of yours with that name is used as it is |
| The built-in workflow a scheme names but the backup does not hold | Your default workflow | |
| Custom events a transition fires | The transition's own event, which notification policies name as `custom:<name>`; a notification scheme's rules for it come along | |
| Global permissions | Global grants: system administrators become site administrators, administrators configuration administrators; the user picker, shared filters, group subscriptions and bulk change keep their meaning | Linked when the same grant is there |
| Issues | Tickets with their key, type, status, priority, close reason, assignee, reporter (as requester), creator, summary, description, due date, estimates, labels, parent, custom values and security level | By track and number on a later run |
| Watchers and voters | Followers and voters of the ticket | |
| Earlier keys of issues moved between projects | Earlier keys of the ticket: opening or searching for the old key finds it | |
| A renamed project's first key | An earlier key of the track: its tickets open, and queries find them, by either key | A key another track has stays theirs (`former_key_taken`) |
| Comments, with group or role restrictions and edits | Comments by the same author at the same time, restricted to the same group or role, marked edited when they were | |
| Change history | History entries with their original author and time: status, resolution (as close reason), priority, type, assignee, reporter, project (as track), key, summary, description, environment, due date, labels, estimates, time spent and custom fields. The ticket's starting values are worked out from the first change of each field | |
| Work logs, with group or role restrictions | Time entries by the same person, started at the same time, with the same duration and text | |
| Links between issues, of any link type | Ticket links of the link type of the same name, made when you have none | By link type name |
| Remote links | Web links with the address, title, summary, icon, relationship and global id | |
| Attachments in the ZIP's `data/attachments` folder | Attachments with their name, type, size, author and time; the file goes to the attachment store, and its hash is checked | |
| Versions | Releases of the track, in the same order, with start and release dates. Released and archived versions are shipped or archived on their release date (the backup keeps no other time) | By name within the track |
| Components | Areas of the track, with the lead as owner and the default assignee (the component lead, the project lead, or unassigned) | By name within the track |
| An issue's fix versions, affected versions and components | Its target releases, found-in releases and areas | |
| Boards | Boards of the first track their filter names: Scrum when sprints are on, Kanban otherwise. The filter's query becomes the board's own query, so a board across several projects shows the same tickets here | By name within the track |
| Board columns | Columns with the same statuses, in the same order, with their minimum and maximum | |
| Quick filters | Board filters with the same name and query | |
| A Kanban board's sub-filter | The board's sub-filter | |
| Sprints | Sprints of the board with their state (future, active or closed), start, end and completion dates, goal and order | By the import's own record on a later run |
| The sprint field's values | The tickets in each sprint. A closed sprint keeps its tickets in its history; a ticket is in one open sprint at most | |
| Rank | Every ticket's rank, so boards and backlogs show tickets in the same order as the backup | |
| The agile plugin's sprint and rank fields | Not fields here: they are skipped with the reasons `sprint_field_as_sprints` and `rank_field_as_rank`, since sprints and rank carry them | |
| Saved filters (the boards' own included) | Saved searches with the same owner and name, the query translated (below), the people who made it a favourite as stars | Never matched: a name the owner already has gets " (imported)" |
| Filter and dashboard shares | Shares of the same reach: everyone (anonymous visitors included) becomes public, everyone signed in any user, a group or a project (with or without a role) the same. Change rights are not kept, only viewing | |
| Filter subscriptions | Search subscriptions to the same person or group, daily, weekly, monthly or on a cron schedule, in UTC; "send when empty" becomes the opposite of "only if results" | |
| Dashboards | Dashboards with the same owner, name, layout (one to three columns, a wide one first or last) and shares | Never matched |
| Gadgets: results of a filter, assigned to me, watched, pie chart, created against resolved, recently created, average age, resolution time, statistics, two-dimensional table, text, sprint burndown, sprint days remaining | Widgets of the same kind over the same saved search or track, with their settings (rows, days, period, what they count by); text loses its formatting | |

The report's mapping names each of these objects with its outcome. The warnings to look for:

| Warning | Meaning |
|---|---|
| `removed_character` (kind `source`) | Characters XML does not allow (NUL, control characters, U+FFFE and U+FFFF, and references to them) were removed while reading. The examples give the file and byte offset |
| `deleted_user`, `placeholder_email`, `no_email` | A person became a deactivated placeholder, or has no address in the backup |
| `nested_group_not_imported` | A group inside a group: its members are not added yet |
| `member_not_found` | A membership names a user the backup does not have |
| `status_not_in_workflow` | A new status that no workflow in the backup holds: it is in no workflow |
| `unknown_status_category` | The status's category is not one Taskmoor knows: it is imported as a new-stage status |
| `unknown_project_type` | A project type other than software or business: the track is a business track |
| `former_key_taken` (kind `track`) | The project was renamed in Jira, and its earlier key belongs to another track here: that track keeps it |
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
| `system_admin_as_configuration_admin` | System administrators became configuration administrators, as the import asked (`"systemAdmins": "configuration_admin"`) |
| `event_not_mapped`, `custom_event_not_imported`, `recipient_not_mapped` | A notification for an event (such as a comment edited) or to a recipient (such as an email address) Taskmoor has no counterpart for |
| `condition_not_mapped` (kind `workflow`) | A condition Taskmoor cannot hold: an app's or a script, a negated one, or one on a custom field (Taskmoor's workflows read system fields only). The detail names the workflow, the transition and its id, and the class. It stands as "never", so the transition stays closed (or that alternative of an any-group falls away) until you replace it in the workflow editor: nobody can do more than before |
| `check_not_mapped` | A validator Taskmoor cannot hold, often an app's. It is left out, so check the transition by hand |
| `effect_not_mapped` | A post function Taskmoor cannot hold: an app's, a script, the webhook function, a security level from a role, or an update that sets another object (a priority, say). It becomes a disabled placeholder that keeps its class, to replace |
| `conditional_result_not_mapped` | A transition that goes elsewhere when some conditions hold: Taskmoor's transitions have one target, the unconditional one |
| `create_check_not_mapped`, `create_condition_not_mapped` | A validator or condition on creating an issue (Taskmoor checks "Create tickets" itself) |
| `layout_field_not_mapped` (kind `workflow`) | A field on a transition's screen that layouts cannot take: custom fields, for now |
| `status_property_not_mapped` | A step property Taskmoor has no counterpart for, such as who may delete in that status |
| `system_workflow_linked_to_default` | A scheme names the built-in workflow, which a backup does not hold: those types use your default workflow, whose statuses may differ |
| `merged_into` (kind `workflow`, `workflow_map`) | A workflow or scheme the same as an earlier one: its tracks use that one |
| `workflow_not_found`, `issue_type_not_found` | A scheme entity names a workflow or issue type the backup does not have; that type uses the scheme's default |
| `former_key_not_kept`, `former_key_taken` | A moved issue's earlier key names a project the backup does not have, or another ticket holds it now |
| `history_field_not_mapped` | A change of a field Taskmoor's history does not follow (such as components or sprints): that part of the entry is left out. An entry with nothing left is skipped with the reason `history_nothing_mapped` |
| `visibility_group_and_role` | A comment or time entry restricted to both a group and a role: the role is kept |
| `web_link_application_not_kept`, `web_link_text_cut`, `web_link_icon_dropped` | A web link's application name, an over-long text or an icon that is not a web address was left out |
| `attachment_size_differs`, `attachment_folder_key_differs` | An attachment's file has another size than its row says (the file's is kept), or sits in another issue's folder |
| `link_type_created` | A link type you did not have was made for the backup's links |
| `board_filter_not_imported` (kind `board`) | A quick filter whose query does not translate: it names an app's field or function, a saved filter or a sprint by id, or something the import left out. The detail names the filter and what it uses, for example `Commented (app): Unknown field "issueFunction"`. Add it again by hand if you need it |
| `board_query_not_imported`, `board_sub_query_not_imported` | The board's filter or a Kanban board's sub-filter did not translate: the board shows its whole track instead, or has no sub-filter |
| `board_query_narrowed_to_track` | A board shows one track, and this board's query could reach others, such as `track IN (PAY, WEB)`. The board arrives on `track = KEY`, its first track, and shows only that. The detail names the board and gives the source's query, so you can save it as a search or a dashboard |
| `board_became_saved_search` | Taskmoor keeps one board per track, and this board's track already had one. The board's query arrives as a saved search of the track's owner, private to them, under the board's name; its sprints go to the track's board. Its columns, sub-filter and quick filters are not kept, and the report's count of boards reads below 100% by these boards. The detail names the board |
| `board_not_kept_no_owner` | The same, on a track with no owner: a saved search needs a person to own it, so the query is not kept, and the sprints still go to the track's board. The detail names the board. Add the search by hand if you need it |
| `board_filter_missing`, `board_project_unknown` | The board's saved filter is not in the backup, or names a project the backup does not have. A board whose filter names no project at all fails, since it has no track to live in |
| `column_status_unknown`, `column_minimum_above_maximum` | A column names a status the backup does not have, or a minimum above its maximum (the minimum is dropped) |
| `release_date_unknown` | A released or archived version has no date: it arrives as not shipped |
| `rank_not_kept`, `rank_changed` | An issue's rank could not be read, or another ticket already holds it: the ticket goes to the bottom of the order |
| `ticket_in_another_open_sprint` | A ticket was in more than one sprint that is not closed: it stays in the first |
| `closed_sprint_never_started` | A sprint that is closed without having started |
| `query_not_translated` (kind `saved_search`) | The filter's query cannot run here. The detail names the reason and the function, field, person or value: `unknown_function` (often an app's, such as `subtasksOf`), `unknown_field` (an app's field, or one the backup does not have), `unknown_person`, `unknown_project`, `unknown_saved_search`, `ambiguous_field`, `field_not_imported`, `value_not_imported` (a sprint, release or option that did not come), `syntax_error`, or `refused` with Taskmoor's own words (an operator a field does not take here, such as `>` on keys). The saved search keeps the query as Jira had it and says why on the search page; change the query and save it to fix it |
| `query_flagged` | The query translated but names something of a module this version does not have yet (approvals, SLAs, customer organisations): it is kept, and says so when run |
| `query_changed` | An ORDER BY term was left out because Taskmoor does not sort by it (`Rank`, an app's field): the same tickets come back, in another order |
| `share_not_imported`, `edit_share_not_imported` | A share naming a group, project or role the backup does not have was left out, so nobody sees more than before; a share that also let people change the filter keeps only the view |
| `name_taken` | The owner already had a saved search of that name: the imported one is called "... (imported)" |
| `schedule_not_imported`, `schedule_time_zone_utc` | A subscription's schedule Taskmoor's cron cannot say (the last day of a month, the first Monday, a year): it is skipped with the reason, and the detail gives the expression. Schedules are read in UTC |
| `gadget_not_mapped` (kind `dashboard`) | A gadget with no widget counterpart, named by its module (activity streams, apps' gadgets) |
| `gadget_setting_not_imported`, `gadget_period_changed`, `widget_reference_not_imported`, `widget_not_imported` | A gadget without the filter or project it shows, a chart period Taskmoor rounds to a day, week or month, or a widget whose saved search, track, board or field did not import (boards come with the board import) |
| `dashboard_favourites_not_imported` | Dashboards cannot be starred in Taskmoor |

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

**Saved filters' queries.** Each query is read in the Jira-compatible language and written
back in Taskmoor's own: `project = 10000` becomes `track = ABC`, `status = 10001` the status by
name, `assignee = jsmith` the person by address, `cf[10010]` (or the field by name) the imported
field's `cf[<id>]`, an option's id its value, `filter = 10020` the imported saved search, and
`resolution = Unresolved` `closeReason IS EMPTY`. A saved search that imports clean has been
prepared as its owner would run it, so it runs. The translation is tested against a corpus of
about a hundred queries as people and scripts write them; the backup's fixture uses them all.

Under "Not imported", the report counts each part of the backup the importer does not handle
yet: saved filters, other kinds of associations, rows of the agile plugin that name a board,
column or issue the backup does not hold, and attachment files
yet: boards and sprints, other kinds of associations and scheduled jobs, and attachment files
no attachment row names (`no_attachment_row`), by their names in the backup, with the reason
`not_imported_yet`. The id counters of the backup, and each issue's workflow state (its status
is what counts), are listed as `not_needed`, because Taskmoor gives its own ids.

Projects without a workflow scheme keep your default workflow map. Draft workflows are not read.

Boards keep their columns, filters and sprints, but not yet their swimlanes, card colours, card
layout, estimation field, working days or administrators: they take the defaults a new board gets,
and you can change them on the board. A board's quick filters replace the default board filters.
Queries name releases and areas by name, so a quick filter for version `1.2` on a board across
two tracks finds the `1.2` of both, as in the backup.

Times in a backup carry no time zone. They are read as UTC, so history, comments and time
entries from a server in another zone are shifted by its offset; a setting for the source's
zone is still to come.

### Old links keep working

Point the old tracker's host name at Taskmoor (or add a redirect from it) and the links people
kept go on working. When the backend serves the app, these addresses redirect to the page they
stand for, in either routing mode; a static frontend kit reads them too:

| Old link | Opens |
|---|---|
| `/browse/ABC-42`, with anything after it, and `/projects/ABC/issues/ABC-42` | Ticket ABC-42, also by an earlier key: a ticket moved from OLD-5 to NEW-9 opens by both, and the address then shows NEW-9 |
| `/browse/ABC` | The track's summary |
| `/issues/?filter=10010`, `/secure/IssueNavigator.jspa?requestId=10010` | The saved search the import made of filter 10010 |
| `/issues/?jql=...` | The search page with that query |
| `/secure/RapidBoard.jspa?rapidView=12` | The board the import made of board 12 |
| `/secure/Dashboard.jspa?selectPageId=10100` | The dashboard the import made of it |

Filters, boards and dashboards are found through the import's external ids, once the person has
signed in and only when they may see the result; otherwise the page says that nothing imported
matches the link. When you imported several instances, the latest import of that id wins.

## Jira Cloud sites

A Jira Cloud site, or any server that speaks the Jira-compatible REST API (another Taskmoor
too), is read over that API with an API token of yours. Use the token of an account that can
browse every project you want and see people's email addresses: the import sees what that
account sees.

```http
POST /api/v1/admin/imports
Content-Type: application/json

{"dryRun": true, "source": {"format": "cloud-rest", "baseUrl": "https://example.your-site.net",
  "email": "you@example.com", "token": "<your API token>", "projects": ["OPS", "WEB"]}}
```

| Setting | Meaning |
|---|---|
| `baseUrl` | The site's address. It must use `https`, or `http` to this machine only, with no user name, query or fragment |
| `email`, `token` | Sign in with Basic: the account's email address and its API token. Without `email`, the token is sent as a Bearer token |
| `projects` | The project keys to import; left out, every project the account sees |
| `jql` | The issues to import, as a query; left out, every issue of those projects |
| `people` | How people are matched; see below. Left out: by email address |
| `pageSize`, `concurrency` | Issues per page (up to 100, the default) and requests at once (1 to 16, default 4) |
| `system` | Names the site in Taskmoor's records of what came from where; by default its host name. Import the same site again under the same name to update rather than duplicate |

**The token** is sealed with the server's password pepper before the run is stored, and never
shown again. It is not written to logs, errors or reports. Keep the run as long as you may want
to import again; delete the token in the site's account settings when you are done.

**What is read.** In order, each step committed as it goes: custom fields, issue types,
priorities, resolutions, statuses, link types and projects (with their versions as releases and
components as areas); the issues, by token-paged search and bulk fetch, a page at a time; each
issue's changelog, comments and worklogs; boards with their columns, and each Scrum board's
sprints with the issues in them; then the people seen along the way, looked up for their email
address. Issues the account cannot read and boards of projects you left out are counted under
"Not imported".

**Throttling.** When the site answers `429` or `503` with `Retry-After` (seconds or a date),
every request waits that long, up to 15 minutes. Without it, and after other server errors or
lost connections, a request is tried again after a growing, randomised pause (half a second to
a second at first, the range doubling each time up to a minute), eight times in all. If it still fails, the attempt stops and the
import's next attempt goes on from the last page it kept: nothing fetched before is fetched
again. The report counts the slow-downs under `source_throttled` and the retried failures under
`source_failures_retried`.

**People** are matched one of three ways (`"people": {"mode": ...}`):

- `email` (the default): by email address, as other imports do. People Taskmoor does not have are
  created; people whose address the site hides become placeholders.
- `csv`: a file you give in `data`, two columns: the person in the site (account id or email
  address) and the address of their Taskmoor account. A header row is optional. Everyone the file
  leaves out, or maps to an address nobody here has, is **unmapped**.
- `scim`: the person your identity provider provisioned over SCIM with the same address. Everyone
  else is unmapped.
- `map`: by email address, except the people `rows` names (`[{"source": "<account id or
  address>", "target": "<address here>"}]`), who are linked to that person here. The wizard
  sends this. A Data Center backup takes the same `people` setting, its people named by user
  key.

An unmapped person becomes a deactivated placeholder, so their comments, time and history keep
an author, and their record warns `person_unmapped`. Run a dry run first: the `records` list for
`kind=user` names everyone unmapped. A later run with a better file links them to the right
person from then on; content an earlier run gave a placeholder stays with the placeholder.

**How it maps.** Statuses take their stage from their category; sub-task types become subticket
types and types above the standard level outcome types. Descriptions, comments and paragraph
fields come in the document format and keep their mentions. Each custom field gets one context
that applies to every track and type, and select fields get the options that issues hold (the
API has no list of options), so options no issue uses are not imported. Fields of apps become
read-only text. Changelog entries keep their author and time for status, assignee, reporter,
summary, dates, priority, resolution, type, labels and estimates; changes to other fields are
counted as warnings (`history_field_not_imported`). A board keeps its type, columns and the
statuses in them, and a sprint its state, dates, goal and issues; other board settings take a
new board's defaults.

**Not imported yet:** links between issues, attachments, watchers and votes, filters and
dashboards (the Data Center backup brings them), issue type and permission schemes (tickets of a type the track does not offer keep
it and warn `type_not_offered`), and comment visibility (warned).

## Delta runs for a cutover

While people still work in the old tracker, import once, check the result, and then bring over
only what changed since with a **delta run**, as often as you like, until the day you switch.
Give the earlier run it starts from:

```http
POST /api/v1/admin/imports
Content-Type: application/json

{"name": "Friday evening", "deltaFrom": 41}
```

- **A Jira Cloud site** needs nothing else: the delta uses the earlier run's settings and token.
  To use a new token, give the same `source` as before with it (another site is refused). The
  delta asks the site only for the issues updated since the earlier run's fetch began, less 15
  minutes in case the two clocks differ, and fetches their changelog, comments and worklogs.
  Configuration, boards and sprints are read whole again. It then lists the id of every issue
  the run's projects or query still find, so it knows which ones the site no longer has.
- **A Jira Data Center backup**: copy the later backup into the imports folder and give it as
  `source` (`{"format": "dc-backup", "path": "jira-backup-friday.zip"}`). The delta reads the
  whole backup; only what changed is written.
- The delta keeps the earlier run's importer and `system`. It can start from any finished run
  that was not a dry run; a dry run of a delta (`"dryRun": true`) says what it would do. A second
  run of the same source while one is queued or running is refused (`409 run_in_progress`).

**What a delta does:**

- Records that did not change are counted `unchanged` and not written. The report's counts per
  kind show what was created and updated.
- **Changes in the source win.** A ticket the source changed is written as the source has it;
  its history gets the source's own entries for the change, as a fresh import would.
- **Edits made in Taskmoor stay**, as long as the source did not change the same ticket. If it
  did, the source's version replaces the ticket's fields, the record warns `edited_in_target`, and
  the ticket's history shows each field you had changed going back. Comments, time, links and
  files added in Taskmoor are never touched.
- **What the source deleted is reported, not deleted here.** Each record an earlier run brought
  that the source no longer has counts in the warning `deleted_in_source`, and the records list
  names them all (`GET /api/v1/admin/imports/<id>/records?outcome=deleted`). Taskmoor keeps the
  object: move the tickets you no longer want to the trash yourself. A record the token can no
  longer see looks the same as a deleted one, which is why nothing is removed for you. From a
  Cloud site, deletions are found for tickets, configuration, boards and sprints, and for the
  comments, time and history of the tickets the delta read; not for people or select options.

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
| `status`, `priority` | | A name the target has; an unknown status leaves the workflow's first status and an unknown priority leaves it empty, each with a warning. A ticket with no priority keeps none after the import (it does not take the track's default) until someone chooses one; `priority IS EMPTY` finds those |
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

A ZIP is unpacked once next to itself, so leave room for it. The same archive limits as for a
backup apply before it is unpacked, and a refused or broken ZIP leaves nothing behind. Objects the target already has are
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
