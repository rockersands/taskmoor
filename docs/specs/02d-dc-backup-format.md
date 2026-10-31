---
spec: 02d
title: "Data Center backup format: what the backup importer reads (format notes)"
sources: docs/research/sources.md
accessed: 2026-10-30
attestation: own-words
---
# 02d Data Center backup format

These notes describe the backup ZIP that the Data Center importer reads (IMP-001, IMP-004;
ADR-025, ADR-072): the entities file, the active-objects file and the attachment files. They
are written in our own words from public pages only (ADR-003). Nothing here is copied from a
product, a backup or a vendor document, and no vendor product was used to write them.

The synthetic backup generator (M1-087, `apps/server/src/import/dc-backup/`) writes exactly
this shape, and its validator checks it. Both follow `format.ts`, which mirrors these notes.
Because this is the format layer, it uses the format's own names (issue, project, resolution).
The rest of Taskmoor uses its own terms (file 00): ticket, track and close reason.

## How to read

- `[Sn]` cites the public page numbered n under "Sources". Each source line says whether the
  page was read or only seen as a search summary.
- **Verify** marks a rule no public page confirms. It is our best assumption, and the generator
  writes it. A design partner's real backup confirms or corrects it (ADR-003, "Consequences").
  Readers stay lenient wherever they meet one of these rules.
- **Our choice** marks something the format leaves open, or a rule of the synthetic data.

## The generator

```
pnpm gen:dc-backup --issues 10000 --seed 1 --out backups/dc-10k.zip
pnpm gen:dc-backup --issues 1000000 --seed 1 --out backups/dc-1m.zip --attachment-rate 0.05
pnpm gen:dc-backup --validate backups/dc-10k.zip
```

The generator writes the ZIP and then `<name>.manifest.json` beside it, and validates the ZIP.
Use `--no-validate` to skip that step. The manifest
(`apps/server/src/import/dc-backup/manifest.ts`) holds the options. It also holds the size and
SHA-256 of both XML files, and the number, total size and combined hash of the attachment
files. It then counts rows per element and per table, the cases the importer must handle, and
the characters XML forbids that went in on purpose. The same options always give the same
manifest. The test suite pins the 10,000-issue manifest for seed 1 as a golden file
(`__golden__/dc-backup-10k-seed1.manifest.json`), so the mappings of M1-088 onwards can compare
their imported counts with it exactly.

Sizes scale with `--issues`:

- 1 project per 2,500 issues (2 to 400).
- 1 person per 200 issues (20 to 5,000), plus 1 deleted person per 40.
- 1 group per 25 people (3 to 200).
- 1 board per software project (up to 200), with 0 to 6 sprints each.

Per issue there are about 1.2 comments, 2.8 change groups (3.3 change items), 0.47 labels,
0.37 time entries, 0.2 links, 1.6 watchers, 0.3 votes and 0.09 web links; about 1 issue in 300
was moved from another project (M1-091). Attachments come at `--attachment-rate` (5% of issues
have 1 to 3 files by default), and `--forbidden-rate` sets the share of text values that carry
a forbidden character (0.2% by default).

The `cases` counted in the manifest:

- **People:** present, inactive, deleted (named by rows but without rows of their own) and
  referenced, keyed by user name or by a generated key.
- **Issues:** skipped issue numbers, sub-tasks, unassigned issues, resolved issues.
- **Comments:** restricted to a group or to a role, edited.
- **Time entries:** restricted to a group or to a role (M1-091).
- **History:** anonymous changes, changes of a custom field.
- **Issues' people and keys:** watches, votes, moved issues, web links (M1-091).
- **Sprints:** closed, active, future.
- **Text:** values written as child elements, and CDATA sections split at `]]>`.

Rows are written in name order, with the id sequences last. So comments and history come before
the issues they belong to, and a reader must not resolve references in a single pass.

Not generated yet; the M1-093 and M1-094 mappings add them as they need them: versions,
components, renamed projects, each issue's workflow state, draft workflows, rank, the board
columns and the issues' sprints, projects renamed more than once (`ProjectKey` rows), avatars
and logos, and thumbnails. A renamed project is generated only on request
(`renamedProjects`, M1-128). Custom fields (M1-089),
permission, security and notification schemes (M1-092), workflows with their schemes (M1-090),
issue content with watchers, voters and the keys of moved issues (M1-091), and saved filters
with their shares, favourites and subscriptions, and dashboards with their gadgets (M1-094) are
generated.

### Measured

| Issues | Rows | ZIP | entities.xml | Attachments | Generate | Validate | Peak heap |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100,000 (CLI) | 948,480 | 33.2 MB | 183.3 MB | 10,049 files, 19.5 MB | 34.6 s | 26.1 s | RSS 226 MB |
| 1,000,000 (`dc-backup.large.test.ts`) | 9,490,567 | 343.4 MB | 1,850.9 MB | 100,104 files, 195.7 MB | 280.9 s | 48.0 s | 99 MB writing, 148 MB checking (RSS 668 MB) |

Measured on this Mac (Apple silicon, Node 22) on 2026-10-30, with a load average of 9 to 18
from other sessions' work; the 1,000,000-issue run also shared the machine with a whole-repo
typecheck. An earlier run of the same test, without the typecheck, took 141 s for both steps.
MB here are MiB. The live heap stays near 100 MB while writing, whatever the size: memory
holds the small parts of the instance and one issue. The ZIP's list of entries grows with the
number of attachment files. The 10,000-issue test in the gate takes about 2 s.

## 1. The ZIP

- A backup is one ZIP. Its root holds exactly two XML files, `entities.xml` and
  `activeobjects.xml`. A restore fails when they sit in a folder inside the ZIP or when their
  names differ in any way. [S1]
- On Data Center and Server, the backup holds the database only. The server writes it as a ZIP
  into the `export` folder of its home directory. Attachments are not inside it: they are kept,
  backed up and restored as files of the home directory. [S2] [S3] [S53]
- A restore reads the ZIP from the `import` folder of the home directory and replaces the whole
  database, users included. Attachments are copied back into the attachment folder separately.
  [S3]
- A cloud backup can also carry the files ("additional files"; optional). Next to the two XML
  files it has a `data` folder with `attachments` and `avatars`, and a `logos` folder at the
  root. A ZIP with only the XML files, or only `data`, is still usable. [S4] [S5] [S6]
- The vendor's own guidance for moving large sites is about 25 GB of data and 50 to 100 GB of
  attachments. [S6]
- **Our choice:** the synthetic ZIP takes the cloud layout. The two XML files sit at the root,
  with the attachment files under `data/attachments`, so one file carries a whole fixture. The
  reader accepts a ZIP with or without `data`, and attachments in a separate folder (the Data
  Center case).
- The entities file holds the attachment folder as a setting named `jira.path.attachments`.
  [S51] (search summary only)
- **Verify:** entries other than these (avatars, logos, thumbnails, files of apps) are ignored
  and counted as unsupported.
- Entities files of more than 4 GB exist: one server version failed to ZIP them for instances
  over about 600,000 issues, so readers must accept ZIP64. [S46] One reported backup held about
  133 million rows in 4.6 GB compressed. [S47]

## 2. entities.xml: the shape

- The root element is `entity-engine-xml`. [S10]
- Each database row is one element directly under the root, named after its entity (for example
  `Issue`, `Project`, `Action`, `ApplicationUser`, `CustomFieldValue`). Each is usually written
  on one line. [S11] [S12] [S13] [S48] [S49]
- Column values are attributes of the row element. The attribute names are the entity's field
  names, which can differ from the database column names: the issue's type is `type` where the
  column is `issuetype`, and its status is `status` where the column is `issuestatus`. [S26]
  [S27]
- A null value has no attribute. Rows that lack a required attribute break a restore. [S12]
  [S13]
- A text value is written either as an attribute or as a child element named after the field,
  with its text in a CDATA section. Both forms occur for the same field (`description`). [S14]
  [S15]
- Text holding the end of a CDATA section (`]]>`) broke the CDATA wrapper in an old version.
  Text with it must be split over two sections. [S14]
- **Our choice:** a text value goes into a child element when it has a line break or is longer
  than 255 characters, and is an attribute otherwise. `]]>` is split as `]]]]><![CDATA[>`.
- **Verify:** the file is UTF-8 and starts with an XML declaration.
- Timestamps look like `2024-01-02 10:11:12.345`: date, a space, time with fractional seconds,
  and no time zone. [S12]
- **Verify:** times are in the server's time zone. The generator writes UTC, so the importer
  needs the source zone as a setting.
- **Verify:** flags are `1` and `0`.
- Restores fail on characters XML 1.0 forbids: control characters (for example 0xC), U+FFFE and
  U+FFFF. They turn up in attributes such as `description`, in CDATA sections and in comments.
  The vendor's own cleaning tool removes or replaces them. [S15] [S16]
- **Verify:** NUL bytes and numeric references to forbidden characters (`&#0;`) appear as well.
  ADR-025's reader removes both and logs every removal with its offset (IMP-001 (2)). The
  generator writes all four kinds, raw characters into attributes and CDATA, references into
  attributes, and counts each in the manifest.
- Rows of entities with a sequence take their ids from `SequenceValueItem` rows, one per
  entity, with `seqName` (the entity's name) and `seqId`. `seqId` must stay above the entity's
  highest id. [S35] [S36] The server hands out ids in blocks of ten, so it is stored rounded up
  to a multiple of ten. [S31]
- **Verify:** entity ids start at 10000. The generator starts every entity's ids there.

## 3. entities.xml: the elements

### People

- Users live in a directory-backed user table and a table of user keys. The user table holds
  the user name and its lower-case copy, the directory, the active flag, creation and update
  times, the display name and the email address with lower-case copies, and the credential.
  First and last names exist but are not used. The user-key table maps a stable `user_key` to
  the lower-case user name. The same user name may exist in several directories, and the
  directory with the lowest position wins. [S17]
- `User` carries `id`, `directoryId`, `userName`, `lowerUserName`, `active`, `createdDate`,
  `updatedDate`, `firstName`, `lowerFirstName`, `lastName`, `lowerLastName`, `displayName`,
  `lowerDisplayName`, `emailAddress`, `lowerEmailAddress` and `credential`. [S19] [S20]
- `ApplicationUser` carries `id`, `userKey` and `lowerUserName`. User keys must be unique even
  ignoring case. [S11] [S18]
- Other rows name people by their user key: comment authors and user role actors do, for
  example. [S22] [S29]
- **Verify:** the issue's people (`reporter`, `assignee`, `creator`) and every other person
  attribute hold user keys too. One schema page calls them user names. A key equals the
  lower-case user name for older people and differs for renamed or newer ones, so both readings
  agree for the older people. [S25]
- **Our choice:** a third of the people are keyed by their lower-case user name, the rest by a
  generated `JIRAUSER<n>` key. One person in 40 is deleted: other rows name them, but they have
  no `User` or `ApplicationUser` row. One in 17 is inactive. Generated users have no
  `credential`.
- `Group` rows hold the groups, and the group table holds the name with a lower-case copy, the
  active and local flags, times, a description, a type and the directory. [S17] [S24]
- **Verify:** `Group` carries `id`, `groupName`, `lowerGroupName`, `active`, `local`,
  `createdDate`, `updatedDate`, `type` (`GROUP`) and `directoryId`.
- `Membership` carries `id`, `parentId`, `childId`, `membershipType` (`GROUP_USER` for a user
  in a group), `parentName`, `lowerParentName`, `childName`, `lowerChildName` and
  `directoryId`. [S21] Memberships can also nest groups (group to group). [S17]
- **Verify:** directories are `Directory` rows with `id`, `directoryName`, `active` and
  `directoryPosition`. The generator writes one directory, id 1.

### Roles and projects

- Project roles have an id and a name. A role actor ties a role to a project (`pid`) through
  `projectroleid`, with `roletype` and `roletypeparameter`. For `atlassian-user-role-actor`
  the parameter is a user key; for `atlassian-group-role-actor` it is a group name. [S22]
- `ProjectRoleActor` carries `id`, `pid`, `projectroleid`, `roletype` and
  `roletypeparameter`. [S23] [S24]
- **Verify:** `ProjectRole` carries `id`, `name` and `description`.
- `Project` rows hold the projects. The project table has an id, the key (`pkey`), the name
  (`pname`) and the project type. [S22] [S24] [S48]
- **Verify:** `Project` carries `id`, `name`, `key`, `originalkey`, `lead` (a user key),
  `description`, `counter` (the highest issue number given) and `projecttype`.
- **Our choice:** projects are `software` or `business`. Every project has role actors: its
  lead as a user actor of one role, a group of another, and up to two people of a third.

### Issue types, statuses, priorities and resolutions

- Issues refer to their type, status, priority and resolution by id, stored as text. The status
  table holds the status names. [S25] [S28]
- A sub-task's issue type has the style `jira_subtask`. Statuses fall in the categories `new`,
  `indeterminate`, `done` (and `undefined`). [S24]
- **Verify:** the elements are `IssueType` (`id`, `sequence`, `name`, `style`, `description`),
  `Status` (`id`, `sequence`, `name`, `description`, `statuscategory`), `Priority` and
  `Resolution` (`id`, `sequence`, `name`, `description`).
- **Verify:** `statuscategory` stores the category's number: `2` for new, `4` for
  indeterminate, `3` for done.
- **Our choice:** five issue types (one of them for sub-tasks), six statuses (two done), five
  priorities, four resolutions, all with invented names.

### Issues

- Since version 6.1 an issue row stores its number and its project's id (entity fields
  `number` and `project`). The old stored key column was emptied. [S26] The key people see is
  the project key, a hyphen and the number. [S25]
- The issue table holds the reporter, assignee and creator, summary, description, environment,
  type, priority, resolution and status, created, updated, due and resolution dates, votes and
  watches, the original and remaining estimates, the time spent, the workflow entry, the
  security level and older version and component columns. [S25]
- The `Issue` entity's fields include `type`, `status`, `priority`, `reporter`, `assignee`,
  `summary`, `description`, `environment`, `created`, `updated`, `duedate`, `votes`,
  `timeoriginalestimate`, `timeestimate`, `timespent`, `workflowId` and `security`. [S27]
- **Verify:** the creator, the resolution and resolution date, and the watch count are written
  as `creator`, `resolution`, `resolutiondate` and `watches`.
- **Our choice:** the generator writes no `workflowId` (no workflow state rows; workflows
  themselves come with M1-090), and `security` since M1-092. Issue numbers skip now and then, as after deleted issues, so a project's `counter`
  can be above its count of issues. About 12% of issues are sub-tasks. `timespent` is the sum
  of the issue's time entries, and `timeestimate` is what is left of the original estimate.
- The workflow state of each issue sits in separate workflow-entry and current-step tables,
  joined by the issue's workflow entry. [S28] **Our choice:** these are not generated; the
  issue's `status` is the truth.

### Comments, history, links, files, time and labels

- Comments are rows of the action table with the type `comment`. They hold the issue, the
  author (a user key) and the body. [S29] The `Action` entity's fields are `id`, `issue`,
  `author`, `type`, `body`, `created`, `updateauthor` and `updated`. [S24] [S30]
- **Verify:** a comment visible to one group or one role carries `level` (the group name) or
  `rolelevel` (the role's id).
- Each change to an issue is a change group (the issue, the author, the time) with one or more
  change items. A group without an author is an anonymous change. An item holds the field type
  (`jira` for system fields), the field, and the old and new values as ids (`oldvalue`,
  `newvalue`) and as display text at the time (`oldstring`, `newstring`). The elements are
  `ChangeGroup` and `ChangeItem`. [S24] [S31]
- `ChangeItem` carries `id`, `group`, `fieldtype`, `field`, `oldvalue`, `oldstring`,
  `newvalue` and `newstring`. [S32]
- **Verify:** `ChangeGroup` carries `id`, `issue`, `author` and `created`. Custom fields have
  the field type `custom` and are named by the field's name.
- **Our choice:** each issue's history walks its status from the first status to the current
  one. The step into a done status also sets the resolution, at the issue's resolution time.
  Some issues also change assignee (from someone or from nobody), priority, summary or a custom
  field. Every change ends at the issue's current value, so the starting values can be worked
  out backwards. About 1% of changes are anonymous.
- Links are `IssueLink` rows of a link type (`IssueLinkType`). The link table holds the type,
  the source, the destination and a sequence. The link type table holds the name, the inward and
  outward descriptions and a style. [S24] [S25]
- `IssueLinkType` carries `linkname`, `inward`, `outward` and `style`. [S24]
- Sub-tasks hang from their parents through a hidden link type. Its name is
  `jira_subtask_link`, its descriptions are `jira_subtask_inward` and `jira_subtask_outward`,
  and its style is `jira_subtask`. [S24] [S25]
- **Verify:** `IssueLink` carries `id`, `linktype`, `source`, `destination` and `sequence`.
  For a sub-task link, `source` is the parent and `sequence` is the sub-task's position from 0.
- Attachments are `FileAttachment` rows. The attachment table holds the issue, the file name,
  the size in bytes, the MIME type, the creation time, and the author. [S7] [S24] [S33] [S49]
- **Verify:** `FileAttachment` carries `id`, `issue`, `mimetype`, `filename`, `created`,
  `filesize`, `author`, `zip` and `thumbnailable`.
- Time entries are `Worklog` rows. The worklog table holds the issue, the author, a group and a
  role level, the text, the creation and update times with the updater, the seconds worked and
  the start date. [S24] [S34]
- **Verify:** `Worklog` carries `id`, `issue`, `author`, `body`, `created`, `updateauthor`,
  `updated`, `startdate` and `timeworked` (seconds).
- Labels are `Label` rows with `id`, `issue`, `fieldid` and `label`. [S24]
- **Verify:** a label of the system labels field has no `fieldid`.
- **Verify:** a time entry visible to one group or one role carries `grouplevel` (the group's
  name) or `rolelevel` (the role's id), as comments carry `level` and `rolelevel`.
- **Our choice:** about 3% of time entries are restricted to a group and 3% to a role, from a
  stream of their own (M1-091).

### Text: wiki markup (M1-091)

- **Verify:** descriptions, environments, comment bodies and time entry text are written in the
  server's wiki markup, which Taskmoor reads with `fromWiki` (ADR-091).
- **Our choice:** a quarter of descriptions, a seventh of comments and a tenth of time entries
  end in a piece of markup: a heading, a bulleted or numbered list, emphasis, monospace, a link,
  a quote, a code block, a table, or underline, superscript, subscript and citation marks.

### Watchers, votes, moves and web links (M1-091)

- **Verify:** watchers and voters are `UserAssociation` rows with `sourceName` (a user key),
  `sinkNodeId` (the issue's id), `sinkNodeEntity` `Issue`, `associationType` `WatchIssue` or
  `VoteIssue`, and `created`. These rows have no `id`. An issue's `watches` and `votes` count
  its rows.
- **Our choice:** an issue's reporter watches it unless deleted; other watchers and voters are
  present people, a voter is never the reporter, each person once.
- **Verify:** an issue moved to another project keeps its earlier key in a `MovedIssueKey` row
  (`id`, `oldIssueKey`, `issueId`). The move is a change group with a `project` item (the
  project ids as values, their names as text) and a `Key` item (the keys as text). The earlier
  project's counter stays where it was, so no later issue takes the earlier number.
- **Our choice:** about 1 issue in 250 that is not a sub-task was moved, from a project where
  it held a number that project skipped, at a time between its creation and its last update.
  Its sub-tasks keep only their own keys.
- **Verify:** links to pages outside are `RemoteIssueLink` rows with `id`, `issueid`,
  `globalid`, `title`, `summary`, `url`, `iconurl`, `icontitle`, `relationship`,
  `applicationtype` and `applicationname`. They carry no time or author.
- **Our choice:** 6% of issues have one or two web links to `docs.example.test`, some with a
  summary, an icon, a relationship phrase and an application's global id.

### Renamed projects (M1-128)

- **Verify:** a project whose key was changed keeps its first key in `originalkey`, and its
  issues' attachment folders stay under that key [S9]. Its issues' keys use the current key;
  links and queries with the earlier key still find them in the source.
- **Our choice:** with the generator option `renamedProjects` set, the first projects get an
  earlier key: their key followed by `OLD`. No other fixture uses the option, so their data is
  unchanged.

### Boards' filters

- **Verify:** saved filters are `SearchRequest` rows with `id`, `name`, `author` (a user key)
  and `request` (the query text). The generator writes one filter per board,
  `project = KEY ORDER BY Rank ASC`.

### Saved filters, dashboards and subscriptions (M1-094)

Nothing in this section comes from a public page we could cite: it is our best understanding of
the format, so every rule is **Verify** until a design partner's backup confirms it.

- **Verify:** a saved filter is a `SearchRequest` row: besides the attributes above it has
  `description` and `favCount` (how many people made it a favourite). Its `request` is the query
  in the Jira-compatible language (spec 01b section 1), as the person or a script wrote it:
  fields and functions by name, the instance's objects by name or by id (a project `10000`, a
  status `10001`, a custom field `cf[10010]`, an option `10100`, a sprint, another filter), and
  people by user name or user key.
- **Verify:** who besides the owner may see a filter or a dashboard is a `SharePermissions` row
  each, with `id`, `entityId`, `entityType` (`SearchRequest` or `PortalPage`), `sharetype` and
  two parameters. `global` shares with everyone, anonymous visitors included; `loggedin` with
  everyone signed in; `group` with the group named by `param1`; `project` with the members of
  the project whose id is `param1`, or, with a role's id in `param2`, only that role's members.
  Newer versions add `rights`: `1` to view, `3` to view and change. A filter with no row is
  private.
- **Verify:** a person's favourites are `FavouriteAssociations` rows with `id`, `username` (a
  user key, despite the name), `entityType`, `entityId` and `sequence` (the order in their
  list).
- **Verify:** a dashboard is a `PortalPage` row with `id`, `username` (its owner's key),
  `pagename`, `description`, `sequence`, `favCount`, `layout` and `ppversion`. The layout names
  its columns by letters: `A` one column, `AA` two of the same width, `AAA` three, `AB` a narrow
  one then a wide one, `BA` a wide one then a narrow one.
- **Verify:** each gadget on a dashboard is a `PortletConfiguration` row with `id`,
  `portalpage`, `columnNumber` (from 0), `positionSeq` (from 0, top down), `gadgetXml` (the
  address of the gadget's definition, which names the app module that provides it as
  `<app key>:<module>` before `/gadgets/`) and `color`. Each of its settings is a
  `GadgetUserPreference` row with `id`, `portletconfiguration`, `userprefkey` and
  `userprefvalue`. A setting that names a filter or a project writes `filter-<id>` or
  `project-<id>`; `filterId` and `projectOrFilterId` are the usual names, `num` a number of
  rows, `statType`, `xstattype` and `ystattype` what a chart counts by (`assignees`,
  `statuses`, `priorities`, `issuetype`, `project`, `resolution`, `components`, `fixfor`,
  `version`, `labels`, `reporter` or `customfield_<id>`), `daysprevious` and `periodName`
  (`hourly` to `yearly`) a chart's window, `rapidViewId` a board.
- **Verify:** a filter subscription is a `FilterSubscription` row with `id`, `filterID`,
  `username` (the person who made it, a user key), `groupname` (the group it goes to, or none
  for that person alone), `lastRun` and `emailOnEmpty` (`true` to mail an empty result too).
  Its schedule is a `ClusteredJob` row whose `jobId` is `JIRA-SUB-` and the subscription's id,
  with `jobRunnerKey`, `schedType` `C` and a `cronExpression`, or `I` and `intervalMillis`. The
  expression has six or seven fields: seconds, minutes, hours, day of month, month, day of week
  (`1` is Sunday, or `MON` to `SUN`), and an optional year; `?` stands for "no particular day",
  `L` for the last day, `W` for the nearest weekday and `#` for the n-th weekday of the month.
  Other jobs are `ClusteredJob` rows too. Schedules carry no time zone of their own in the rows
  the generator writes.
- **Our choice:** about one filter per corpus entry of the translation corpus
  (`translate/corpus.ts`), plus one more per ten people, with each query written against the
  instance's own ids and names: projects by key, id and name, statuses, priorities, resolutions,
  types and security levels by id and name, people by user name and key, every custom field
  kind by id and name, options by id and value, sprints, an earlier filter by id and by name,
  history clauses, ORDER BY `Rank`, apps' functions and fields, a person and a project nobody
  has, and broken text. The first filter is shared with everyone. About a third are private;
  the rest are shared with everyone, everyone signed in, a group (some with change rights) or a
  project (some only with a role, some with a group too). Owners and a few others make filters
  favourites.
- **Our choice:** one dashboard per gadget kind at least (one per five people, at most 200),
  with every layout, two to five gadgets of the kinds `GADGETS` lists (results of a filter,
  assigned to me, watched, a pie chart, created against resolved, recently created, average
  age, resolution time, statistics, a two-dimensional table, a text gadget, a sprint burndown,
  sprint days remaining, an activity stream and an app's calendar), most over a filter and the
  rest over a project. The first dashboard is shared with everyone signed in.
- **Our choice:** about one filter in seven has a subscription, some to a group, with schedules
  that are daily, on weekdays, weekly, monthly, every fifteen minutes, on Fridays, and two that
  no five-field cron can say: the last day of the month and the first Monday.

### Custom fields and their values (M1-089)

- `CustomField` and `CustomFieldValue` are elements. A value names its issue and its field by
  the `customfield` attribute, and holds a string, number, text or date value. [S13] [S24]
  [S52]
- **Verify:** `CustomField` carries `id`, `customfieldtypekey`, `customfieldsearcherkey`,
  `cfname` and `description`. The built-in types' keys start with
  `com.atlassian.jira.plugin.system.customfieldtypes:` and end in `textfield`, `textarea`,
  `float`, `datepicker`, `datetime`, `select`, `multiselect`, `radiobuttons`,
  `multicheckboxes`, `cascadingselect`, `userpicker`, `multiuserpicker`, `grouppicker`,
  `multigrouppicker`, `labels`, `url` or `readonlyfield`. A plugin's field type has a key of
  its own.
- **Verify:** `CustomFieldValue` carries `id`, `issue`, `customfield`, `parentkey`,
  `stringvalue`, `numbervalue` (a decimal number), `textvalue` (long text, which may be a
  child element) and `datevalue` (a timestamp). Text, URL, read-only text and the choice
  types keep `stringvalue`: an option's id, a person's user key or a group's name. A field
  with several values has one row per value. A cascading select has a row for the parent
  option and one for the child with `parentkey` `1`. Numbers have a decimal point (`5.0`).
  Dates and date-times keep `datevalue`; a date is at midnight.
- **Verify:** a labels custom field keeps its values as `Label` rows whose `fieldid` is the
  field's id, not as values.
- **Verify:** configuration tables name a custom field `customfield_<id>`.
- **Verify:** a field's contexts are `FieldConfigScheme` rows (`id`, `name`, `description`,
  `fieldid`). Each has `ConfigurationContext` rows (`id`, `projectcategory`, `project`, `key`,
  `fieldconfigscheme`): one with neither a project nor a category makes the context apply to
  every project. Its `FieldConfigSchemeIssueType` rows (`id`, `issuetype`,
  `fieldconfigscheme`, `fieldconfiguration`) name its issue types, and a row without
  `issuetype` means every type. Each names the `FieldConfiguration` (`id`, `name`,
  `description`, `fieldid`) that holds the context's options and default value.
- **Verify:** options are `CustomFieldOption` rows with `id`, `customfield`,
  `customfieldconfig` (the `FieldConfiguration`), `parentoptionid` (a cascading select's
  child), `sequence`, `customvalue` and `disabled` (`Y` or `N`).
- **Verify:** default values are `GenericConfiguration` rows with `datatype` `DefaultValue`,
  `datakey` (the `FieldConfiguration` id) and `xmlvalue`, a small XML value such as
  `<string>10021</string>` (an option's id) or `<double>3.0</double>`.
- **Our choice:** 18 fields, one of each built-in type above and one plugin type
  (`com.example.ratings:stars`). Most have one context for every project and type; one is
  limited to software projects and two issue types, one to one type, and the select field has
  a context of its own for the first project before the general one. A project's own context
  wins over the general one. Values are written only for issues inside a context. People in
  values are present users, so deleted people stay named only by the attributes above. About
  1 in 20 choice values names a disabled option. The Effort change in the history ends at the
  issue's current Effort value, or clears it when there is none.

### Field configurations and screens (M1-089)

- **Verify:** field configurations are `FieldLayout` rows (`id`, `name`, `description`, and
  `type` `default` on the one projects use without a scheme). Their `FieldLayoutItem` rows
  (`id`, `fieldlayout`, `fieldidentifier`, `description`, `verticalposition`, `ishidden`,
  `isrequired`, `renderertype`) list every field with `true` or `false` flags and an optional
  help text. A system field is named by its id (`summary`, `duedate`, `components`,
  `timetracking` ...), a custom field as `customfield_<id>`.
- **Verify:** a `FieldLayoutScheme` (`id`, `name`, `description`) picks a field configuration
  per issue type through `FieldLayoutSchemeEntity` rows (`id`, `scheme`, `issuetype`,
  `fieldlayout`); the row without `issuetype` is for every other type.
- **Verify:** screens are `FieldScreen` rows (`id`, `name`, `description`) with tabs
  (`FieldScreenTab`: `id`, `name`, `description`, `sequence`, `fieldscreen`) and fields on
  each tab (`FieldScreenLayoutItem`: `id`, `fieldidentifier`, `sequence`, `fieldscreentab`).
- **Verify:** a `FieldScreenScheme` (`id`, `name`, `description`) picks a screen per
  operation through `FieldScreenSchemeItem` rows (`id`, `operation`, `fieldscreen`,
  `fieldscreenscheme`): `operation` `0` for create, `1` for edit, `2` for view, and none for
  the default screen of the other operations.
- **Verify:** an `IssueTypeScreenScheme` (`id`, `name`, `description`) picks a screen scheme
  per issue type through `IssueTypeScreenSchemeEntity` rows (`id`, `issuetype`, `scheme`,
  `fieldscreenscheme`); the row without `issuetype` is the default.
- **Verify:** a project uses a scheme through a `NodeAssociation` row with `sourceNodeId` (the
  project's id), `sourceNodeEntity` `Project`, `sinkNodeId` (the scheme's id),
  `sinkNodeEntity` (the scheme's element, such as `FieldLayoutScheme` or
  `IssueTypeScreenScheme`) and `associationType` `ProjectScheme`. These rows have no `id`.
- **Our choice:** three field configurations (the default, one for defects, one for business
  projects) in two schemes, and three screens (everything, defects, a short create screen) in
  two screen schemes and two issue type screen schemes. Every project has an issue type screen
  scheme; every project but the second has a field configuration scheme, so the second uses
  the default field configuration.

### Permissions, issue security and notifications (M1-092)

- **Verify:** permission schemes are `PermissionScheme` rows (`id`, `name`, `description`).
  Each grant is a `SchemePermissions` row with `id`, `scheme`, `permission` (an old numeric
  code, which may be missing), `permissionKey` (such as `BROWSE_PROJECTS`), `type` and
  `parameter`. The types are `group` (a group's name; none means anyone, signed in or not),
  `user` (a user key), `projectrole` (a role's id), `reporter`, `assignee`, `lead`, `userCF` and
  `groupCF` (a field key `customfield_<id>`) and `applicationRole` (anyone signed in). Apps add
  permission keys of their own.
- **Verify:** issue security schemes are `IssueSecurityScheme` rows (`id`, `name`,
  `description`, `defaultlevel`). Their levels are `SchemeIssueSecurityLevels` rows (`id`,
  `name`, `description`, `scheme`), and who sees a level is in `SchemeIssueSecurities` rows
  (`id`, `scheme`, `security` (the level), `type`, `parameter`), with the same types as
  permissions. An issue's level is its `security` attribute. A sub-task has its parent's level.
- **Verify:** notification schemes are `NotificationScheme` rows (`id`, `name`,
  `description`). Each `Notification` row (`id`, `scheme`, `eventTypeId`, `type`, `parameter`)
  sends one event to one kind of recipient. The event numbers are 1 created, 2 updated, 3
  assigned, 4 resolved, 5 closed, 6 commented, 7 reopened, 8 deleted, 9 moved, 10 work logged,
  11 work started, 12 work stopped, 13 generic, 14 comment edited, 15 work log updated, 16 work
  log deleted and 17 comment deleted. Custom events have numbers from 10000. The recipient
  types are `Current_Assignee`, `Current_Reporter`, `Current_User`, `Project_Lead`,
  `Component_Lead`, `All_Watchers`, `Single_User` (a user key), `Group_Dropdown` (a group),
  `Project_Role` (a role's id), `User_Custom_Field_Value` and `Group_Custom_Field_Value` (a
  field key), and `Single_Email_Address`.
- **Verify:** global permissions are `GlobalPermissionEntry` rows with `id`, `permission`
  (such as `SYSTEM_ADMIN`, `ADMINISTER`, `USE`, `USER_PICKER`, `CREATE_SHARED_OBJECTS`,
  `MANAGE_GROUP_FILTER_SUBSCRIPTIONS`, `BULK_CHANGE`) and `group_id`, which holds a group's
  name, or nothing for anyone.
- **Verify:** a project uses its permission, issue security and notification schemes through
  `NodeAssociation` rows like the ones above, with `sinkNodeEntity` `PermissionScheme`,
  `IssueSecurityScheme` or `NotificationScheme`.
- **Our choice:** four permission schemes, two of them identical but for the name; two issue
  security schemes with five levels, one with a default level; two notification schemes,
  including a comment-edited event, an email address recipient and a custom event; eight
  global permissions, one for a plugin and one to anyone. Projects take the permission schemes
  in turn; two in three projects have an issue security scheme. About 40% of issues there have
  a level.

### Workflows, workflow schemes and custom events (M1-090)

- **Verify:** workflows are `Workflow` rows with `id`, `name`, `creatorname` (a user name),
  `descriptor` and `islocked`. The descriptor is the whole workflow as one XML document, written
  as a child element in CDATA. It starts with an XML declaration and a document type
  declaration of the open-source workflow library the server uses; readers ignore both.
- **Verify:** the built-in workflow (named `jira`) has no row: the product carries it, and
  schemes name it. A type whose scheme names no workflow for it uses the built-in one, and so
  does every type of a project without a workflow scheme.
- **Verify:** the descriptor's root is `workflow`. It holds `meta` elements (a `name`
  attribute and text; `jira.description` describes the workflow), then `initial-actions`,
  `global-actions`, `common-actions` and `steps`. Each of the three action lists holds `action`
  elements.
- **Verify:** a `step` has an `id`, a `name`, `meta` elements and an `actions` element. Its
  meta `jira.status.id` names the step's `Status` row; every step has one, and no two steps of a
  workflow share a status. A step's `actions` holds its own `action` elements and
  `common-action` elements whose `id` names an action of `common-actions`.
- **Verify:** an action is a transition with an `id` (unique in its workflow, and the
  transition's stable id), a `name`, a `view` (`fieldscreen` when it shows a screen) and `meta`
  elements: `jira.description`, `jira.fieldscreen.id` (the `FieldScreen` row of its screen),
  and others such as `opsbar-sequence` that are kept as they are.
- **Verify:** the initial action (id 1) creates an issue: its result's step is the initial
  status. A global action is offered from every step. A common action is offered from each step
  that names it, and a step's own action from that step only.
- **Verify:** `restrict-to` holds one `conditions` element with `type` `AND` or `OR`, whose
  items are `condition` elements and nested `conditions` groups. A condition may carry
  `negate="true"`.
- **Verify:** `validators` holds `validator` elements, `pre-functions` and `post-functions`
  hold `function` elements. Each has a `type`: `class` with an `arg` named `class.name` that
  holds the implementing class, or a script type such as `beanshell` with the script in an
  argument. Other `arg` elements (a `name` attribute and text) are the rule's settings.
- **Verify:** `results` holds `result` elements, each with its own conditions, taken when they
  hold, and one `unconditional-result` taken otherwise. A result has `old-status`, `status` and
  `step` (the step the issue moves to), and may hold validators and `post-functions`.
- **Verify:** the built-in conditions, validators and functions are classes under
  `com.atlassian.jira.workflow.condition.`, `.validator.` and `.function.`. These are the ones
  the generator writes, with their settings: `AllowOnlyAssignee`, `AllowOnlyReporter`,
  `AlwaysFalseCondition`, `PermissionCondition` (`permissionKey`), `SubTaskBlockingCondition`
  (`statuses`, status ids with commas), `UserInGroupCondition` (`group`, a group name),
  `InProjectRoleCondition` (`jira.projectrole.id`), `InAnyProjectRoleCondition`
  (`jira.projectrole.ids`), `UserIsInCustomFieldCondition` (`fieldName`), `InGroupCFCondition`
  (`groupcf`), `PermissionValidator` and `UserPermissionValidator` (`permissionKey`), and the
  functions `AssignToCurrentUserFunction`, `AssignToLeadFunction`, `AssignToReporterFunction`,
  `UpdateIssueFieldFunction` (`field.name` and `field.value`, empty to clear),
  `SetIssueSecurityFromRoleFunction` (`jira.projectrole.id`, `jira.securitylevel.id`),
  `UpdateIssueStatusFunction`, `CreateCommentFunction`, `GenerateChangeHistoryFunction`,
  `IssueReindexFunction`, `IssueCreateFunction` and `FireIssueEventFunction` (`eventTypeId`).
- **Verify:** the webhook post function is
  `com.atlassian.jira.plugins.webhooks.workflow.TriggerWebhookFunction` and names a webhook
  by id. Apps add classes of their own.
- **Verify:** a step's meta can limit what people may do in it: `jira.issue.editable` set to
  `false` locks the issue's fields, and `jira.permission.<permission>.<grantee type>` (such as
  `jira.permission.comment.projectrole` with a role's id, or `.group` with a group's name)
  lets only that grantee do it.
- **Verify:** workflow schemes are `WorkflowScheme` rows (`id`, `name`, `description`). A
  `WorkflowSchemeEntity` (`id`, `scheme`, `workflow`, `issuetype`) gives one issue type its
  workflow, by the workflow's name; `issuetype` `0` stands for every type the scheme does not
  name. A project uses a scheme through a `NodeAssociation` row like the ones above, with
  `sinkNodeEntity` `WorkflowScheme`.
- **Verify:** custom events are `EventType` rows (`id`, `name`, `description`, `type`
  `jira.custom.event.type`), with ids from 10000. A transition fires one through
  `FireIssueEventFunction`; event 13 is the generic event.
- **Verify:** each issue's workflow state is in `OSWorkflowEntry`, `OSCurrentStep` and
  `OSHistoryStep` rows, joined by the issue's `workflowId`.
- **Our choice:** six workflows: one for software work, one for defects, one for sub-tasks
  with global transitions only, one for business projects, a copy of the first that differs
  only in its name, and an old one no scheme uses. All but the old one hold every status, so
  every issue's status is a step of its workflow. Between them they use every built-in kind
  above and, as rules Taskmoor cannot hold, a negated condition, a conditional result, a
  `beanshell` script, conditions on a user and a group custom field, the webhook, a security
  level from a role, an update that sets a priority, step properties that delete or lock, and
  apps' conditions, validators and functions under `com.example`. One transition fires the
  custom event `Escalated` (10001), which a notification scheme also names.
- **Our choice:** three workflow schemes: one for software projects (defects and sub-tasks
  have their own workflows), one for business projects, and a legacy one that repeats the
  first through the copy. The third project uses the legacy one. Transition screens use a
  screen of their own (`Close screen`, with ids from 10500 so they stay clear of the M1-089
  screens) holding the resolution, the assignee, fix versions, time tracking and a custom field.
- **Our choice:** each issue's workflow state is not generated; the issue's `status` is the
  truth, and the reader does not need the state rows.

### Seen, not generated yet

- `Version`, `Component`, `NodeAssociation` rows for an issue's affected and fix versions and
  its components, `OSPropertyEntry` and `EntityProperty` are elements too. [S13] [S24] [S52]

## 4. activeobjects.xml

- The file holds the tables of the server's plugins, with their definitions and their rows.
  [S37] [S40] [S41]
- **Verify:** the root element is `backup` in the namespace `http://www.atlassian.com/ao`. The
  generator also declares the XML Schema instance namespace for `xsi:nil`.
- A table definition is a `table` element with a `name`. It holds `column` elements with
  `name`, `primaryKey`, `autoIncrement`, `sqlType` and `precision`. [S37] [S38] A wrong
  `autoIncrement` on a primary key breaks later inserts after a restore. [S38]
- Foreign keys are `foreignKey` elements with `fromTable`, `fromColumn`, `toTable` and
  `toColumn`. They can point at core tables, and some cloud backups name tables that a server
  does not have. [S39]
- Rows come per table in a `data` element with a `tableName`. It first lists its columns as
  `column` elements with only a `name`, then holds one `row` element per row. [S37] [S40]
- A row holds one typed element per column: `string`, `integer`, `boolean`, `timestamp`. A
  null is the typed element with `xsi:nil="true"`. [S37] [S41]
- A restore inserts the rows first and applies the constraints afterwards. [S41]
- **Verify:** `sqlType` holds the JDBC type number. The generator uses the standard Java
  numbers: `-5` big integer, `4` integer, `12` variable text, `16` boolean, `2005` long text.
  [S50]
- **Verify:** `boolean` values are `true` and `false`, and `double` is a value type too.
- A table's name is `AO_`, then six hexadecimal characters from a hash of the plugin, then `_`
  and the table's own name in capitals with underscores. Names stay within 30 characters.
  [S42]
- Tables starting `AO_60DB71` belong to the agile plugin (boards and sprints). [S43]
- `AO_60DB71_SPRINT` has `ID`, `NAME`, `RAPID_VIEW_ID`, `STARTED`, `CLOSED`, `START_DATE`,
  `END_DATE`, `COMPLETE_DATE`, `GOAL` and `SEQUENCE`. A sprint that started and is not closed
  is active, a closed one is complete, and one not started is in the future. [S44]
- Boards are rows of `AO_60DB71_RAPIDVIEW`, and sprints refer to them through
  `RAPID_VIEW_ID`. [S45] (search summary only)
- **Verify:** sprint dates are milliseconds since 1970, as big integers.
- **Verify:** `AO_60DB71_RAPIDVIEW` has `ID`, `NAME`, `OWNER_USER_NAME`, `SAVED_FILTER_ID`
  (a `SearchRequest` id) and `SPRINTS_ENABLED`.
- `AO_60DB71_LEXORANK` holds the rank and has a foreign key to the issue table. [S39]
  **Our choice:** not generated yet (M1-093).
- Backing up and restoring large plugin tables can run out of memory. [S40]

## 5. Attachments

- On disk an attachment is the file
  `data/attachments/<project>/<bucket>/<issue key>/<attachment id>` under the home directory.
  The file is named by the attachment's id, without the file name or an extension. [S5] [S7]
- The bucket comes from the issue number, in blocks of 10,000: numbers 1 to 10,000 go in
  `10000`, 10,001 to 20,000 in `20000`, and so on. [S7] [S8]
- Before version 7.0 there was no bucket level: `<project>/<issue key>/<attachment id>`. [S7]
  [S8]
- The project folder is named by the project's original key, so a renamed project keeps its
  folder. [S7] Cloud exports of renamed projects keep the old key as well. [S9]
- Thumbnails of images go into a `thumbs` folder in the issue's folder, named
  `_thumb_<attachment id>.png`. [S7]
- Cloud backups put attachments under `data/attachments` in the ZIP. The examples disagree on
  the order of the bucket and issue key folders. [S5]
- **Verify:** the issue key folder uses the current project key.
- **Our choice:** files are 16 bytes to 4 KB of generated text cut to the row's size. A
  `.bin` file is labelled `application/octet-stream`. No thumbnails are written.

## 6. Reading it

- **Our choice:** ADR-025 stays: stream each XML file through the byte cleaner and saxes, one
  row at a time. Stage rows by entity and id, and resolve references after the whole file. The
  validator works the same way (`validate.ts`). It keeps a bitmap per entity for ids and
  references, a few bytes per issue for project and number, and one entry per attachment.
- **Our choice:** the importer (M1-088, ADR-081) stages a backup once into a folder next to the
  ZIP (`stage.ts`): one file of records per kind it maps, written after the whole file is read,
  and a count of every other element, table and file. The validator and the stage share
  `parse.ts`.
- **Our choice:** people are known by their lower-case user key. A person attribute that holds a
  user name instead is resolved through the user-key table, and a user row without a key row
  is keyed by its user name. A key that names no user row is a deleted person. The importer keeps
  one only when some row names them: the person attributes of `format.ts`, user role actors, and
  the old and new values of assignee and reporter changes.
- **Our choice:** when the same user or group name is in several directories, the active
  directory with the lowest `directoryPosition` wins, as for user names in [S17].
- **Our choice:** a group is known by its lower-case name, because memberships, role actors and
  comment restrictions name groups that way. A `Membership` of the type `GROUP_GROUP` is read
  as a group inside a group (**Verify**), and any other type as a user in a group.
- **Our choice:** the reader takes the status category by number or by key (`new`,
  `indeterminate`, `done`), and a group's `description` when it is there.
- **Our choice:** custom fields, contexts, options, field configurations and screens are small,
  so the stage keeps them and resolves them after the file (M1-089, ADR-089). Issue rows go to
  a raw file during the pass; each issue's custom values, labels and sub-task link are kept
  until the end, and then one ticket record per issue is written, issues without a parent
  first. A context row naming a project category, or a project or type with no row, is left
  out with a warning; a context left with no scope at all is refused rather than widened.
- **Our choice:** identical permission schemes (the same grants, names aside) are merged into
  the one with the lowest id, which takes the others' projects; the report names each merge
  (M1-092, ADR-090). Grants, levels and notifications that name a person keep that person
  named, so a deleted person stays as a placeholder.
- **Our choice:** a project without a field configuration scheme gets a field rule set of its
  own made from the default field configuration. A screen scheme's default screen stands in for
  each operation it does not name.
- **Our choice:** the stage reads each descriptor into the model of `workflow-format.ts`, which
  the generator's writer shares, and resolves what it names (statuses, groups, roles, screens,
  custom events) against the rest of the backup (M1-090, ADR-093). Workflows that are the same
  but for their names and descriptions merge into the one with the lowest id, and so do the
  schemes that become the same with them. A scheme that names the built-in workflow gets a
  record of it that links to the target's default workflow, with a warning.
- **Our choice:** a workflow name in a scheme entity is matched exactly, then ignoring case.
- **Our choice:** the stage keeps no issue content in memory (M1-091, ADR-092). While it reads,
  the rows of tickets (issues, custom values, labels, watchers, voters) go to bucket files by
  issue id range, change groups and items to bucket files by change group id range, and
  comments, time entries, links, web links and attachments to one file each. After the file
  each bucket is joined on its own, so memory holds one bucket, the sub-task links, the earlier
  keys of moved issues and an index of the attachment files (their place in the ZIP, size, hash
  and type, read once). Tickets are written in issue id order, parents first.
- **Our choice:** attachment files are found by the attachment id that names them, under any
  folders (`<project>/<bucket>/<issue key>/<id>` or the older layout without the bucket); the
  import reads each from its place in the ZIP. A file no attachment row names is reported.
- **Our choice:** saved filters, their shares and favourites, dashboards with their gadgets and
  settings, and subscriptions with their schedule jobs are small, so the stage keeps them and
  resolves them after the file (M1-094, ADR-096). It analyses each filter's query there, since
  only the stage knows the source's custom fields, people, projects and filters by id and name,
  and writes filters that name other filters after them. Other `ClusteredJob` rows are reported
  as not imported. A share naming a group, project or role without a row is left out, never
  widened.

## Sources

Read for M1-087 on 2026-10-30, by research passes separate from the code. Only the facts
above were taken. The pages are also listed in `docs/research/sources.md`.

- [S1] <https://support.atlassian.com/jira/kb/unable-to-find-jira-backup-entitiesxml-inside-of-zip-file-error/>: the two files at the root, exact names, and re-zipping without `data` (read)
- [S2] <https://confluence.atlassian.com/adminjiraserver0910/backing-up-data-1282246276.html>: the backup ZIP in the export folder; attachments kept separately (read)
- [S3] <https://confluence.atlassian.com/adminjiraserver/restoring-data-from-an-xml-backup-938847707.html>: restore from the import folder; attachments restored separately (read)
- [S4] <https://confluence.atlassian.com/servicedeskcloud/exporting-issues-1097176638.html>: cloud backup with `data/attachments`, `data/avatars` and `logos`; optional files (read)
- [S5] <https://support.atlassian.com/atlassian-cloud/kb/partial-or-selective-import-of-a-jira-backup-export-into-jira-cloud/>: cloud backup layout; attachment files named by id; partial ZIPs (read)
- [S6] <https://support.atlassian.com/jira-cloud-administration/docs/export-issues/>: what cloud backups hold and leave out; size guidance (read)
- [S7] <https://support.atlassian.com/jira/kb/locate-jira-data-center-file-attachments-in-the-filesystem/>: attachment path, bucket, file name, original key, thumbnails (read)
- [S8] <https://confluence.atlassian.com/jirasoftware/jira-software-7-0-0-release-notes-776997721.html>: the bucket level since 7.0 (read)
- [S9] <https://jira.atlassian.com/browse/JRACLOUD-83900>: renamed projects keep the old key folder (read)
- [S10] <https://support.atlassian.com/jira/kb/restoring-an-xml-backup-fails-due-to-exception-is-orgxmlsaxsaxparseexception>: the root element (read)
- [S11] <https://jira.atlassian.com/browse/JRACLOUD-71392>: `ApplicationUser` rows, one per line; keys unique ignoring case (read)
- [S12] <https://jira.atlassian.com/browse/JRACLOUD-74672>: rows as elements with attributes; missing attributes; timestamps (read)
- [S13] <https://support.atlassian.com/jira/kb/jira-project-import-failed-with-unexpected-problem-processing-the-backup-xml-file/>: rows without value attributes; `CustomFieldValue` (read)
- [S14] <https://jira.atlassian.com/browse/JRASERVER-5475>: description as a CDATA child element; the CDATA end in text (read)
- [S15] <https://support.atlassian.com/jira/kb/importing-xml-backup-or-anonymizing-data-fails-due-to-invalid-characters-in-attribute-values-in-jira/>: forbidden characters in attributes and CDATA (read)
- [S16] <https://confluence.atlassian.com/display/JIRA064/Removing+invalid+characters+from+XML+backups>: removing forbidden characters (read)
- [S17] <https://developer.atlassian.com/server/jira/platform/database-user-and-group-tables/>: user, user key, group, membership and directory tables (read)
- [S18] <https://support.atlassian.com/jira/kb/duplicate-entry-key-uk_lower_user_name-when-upgrading-to-jira-6x>: `ApplicationUser` fields (read)
- [S19] <https://github.com/funidata/jira-manglr>: `User` attributes, from an open-source tool's description (read)
- [S20] <https://community.unix.com/t/is-it-possible-to-use-sed-to-truncate-email-addresses-within-a-file-so-only-the-user-name-remains/384235>: `User` attributes (read)
- [S21] <https://support.atlassian.com/jira/kb/duplicate-entry-for-key-cwd_membershipuk_mem_dir_parent_child-error-when-restoring-a-backup/>: `Membership` attributes (read)
- [S22] <https://support.atlassian.com/jira/kb/retrieve-a-list-of-users-assigned-to-project-roles-in-jira-data-center/>: roles, role actors, project columns (read)
- [S23] <https://support.atlassian.com/jira/kb/project-import-fails-due-to-missing-projectroleid/>: `ProjectRoleActor` attributes (read)
- [S24] <https://docs.atlassian.com/software/jira/docs/api/7.0.5/constant-values.html>: entity names, link type fields, sub-task names and styles, label fields, status category keys (read; names only)
- [S25] <https://developer.atlassian.com/server/jira/platform/database-issue-fields/>: issue columns, keys, links, link types, sub-tasks (read)
- [S26] <https://developer.atlassian.com/server/jira/platform/preparing-for-jira-6-1>: issue `number` and `project` since 6.1 (read)
- [S27] <https://support.atlassian.com/jira/kb/unable-to-create-issue-due-to-data-corruption/>: `Issue` field names next to column names (read)
- [S28] <https://developer.atlassian.com/server/jira/platform/database-issue-status-and-workflow/>: statuses and workflow state (read)
- [S29] <https://support.atlassian.com/jira/kb/how-to-find-all-the-comments-related-to-one-user-in-the-database>: comments in the action table; authors as user keys (read)
- [S30] <https://jira.atlassian.com/browse/JRA-16054>: `Action` fields (read)
- [S31] <https://developer.atlassian.com/server/jira/platform/database-change-history/>: change groups and items; ids in blocks of ten (read)
- [S32] <https://docs.atlassian.com/software/jira/docs/api/7.6.1/com/atlassian/jira/model/ChangeItem.html>: `ChangeItem` fields (read; names only)
- [S33] <https://support.atlassian.com/jira/kb/how-to-get-attachment-statistics-from-the-database-in-jiradatacenter-and-server/>: attachment columns (read)
- [S34] <https://developer.atlassian.com/server/jira/platform/database-schema/>: worklog columns (read)
- [S35] <https://jira.atlassian.com/browse/JRA-26636>: `SequenceValueItem` fields (read)
- [S36] <https://support.atlassian.com/jira/kb/cannot-insert-duplicate-key-in-object-when-adding-content-to-a-jira-application/>: sequence names and values (read)
- [S37] <https://support.atlassian.com/jira/kb/could-not-determine-the-proper-mapping-from-oracle-export-for-columndefault/>: active-objects tables, columns and data (read)
- [S38] <https://jira.atlassian.com/browse/JRASERVER-61007>: column attributes; `autoIncrement` (read)
- [S39] <https://support.atlassian.com/jira/kb/importing-from-cloud-to-server-fails-while-restoring-active-objects-data/>: foreign keys; the rank table (read)
- [S40] <https://jira.atlassian.com/browse/JRASERVER-45917>: data sections; memory of large tables (read)
- [S41] <https://support.atlassian.com/jira/kb/backup-restore-fails-when-restoring-activeobjects-with-foreign-key-constraint-error-in-jira/>: typed values, `xsi:nil`, constraints after rows (read)
- [S42] <https://developer.atlassian.com/server/framework/atlassian-sdk/table-names>: plugin table names (read)
- [S43] <https://support.atlassian.com/jira/kb/how-to-identify-active-objects-ao-tables-in-jira-application-database/>: plugin table prefixes (read)
- [S44] <https://support.atlassian.com/jira/kb/determining-sprint-status-from-the-database/>: sprint columns and states (read)
- [S45] <https://jira.atlassian.com/browse/JRASERVER-74729>: the board table (search summary only)
- [S46] <https://jira.atlassian.com/browse/JRASERVER-29305>: entities files over 4 GB (read)
- [S47] <https://jira.atlassian.com/browse/JRASERVER-78781>: a backup of about 133 million rows (read)
- [S48] <https://gist.github.com/christo/4316074>: element names counted under the root (read)
- [S49] <https://github.com/hbrowser/jira-cloud-backup-viewer>: element names in a backup, from an open-source tool's description (read)
- [S50] <https://docs.oracle.com/en/java/javase/21/docs/api/constant-values.html>: the standard JDBC type numbers (`java.sql.Types`)
- [S51] <https://support.atlassian.com/jira/kb/xml-import-fails-with-ioexception-no-such-file-or-directory/>: the attachment folder setting (search summary only)
- [S52] <https://support.atlassian.com/jira/kb/removing-a-custom-field-from-an-xml-backup/>: the `customfield` attribute (read)
- [S53] <https://support.atlassian.com/jira/kb/attachment-not-imported-during-backup-restoration-in-jira-data-center/>: attachments outside the XML (read)
