# ADR-102: Delta runs for cutover windows: the changes since an earlier run, deletions reported

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-096

## Context

IMP-009 asks for an import that re-runs to update rather than duplicate, and that "syncs deltas
with `updated >= last run` during a cutover window": (3) a delta run picks up an item edited in
the source after the first run. M1-096 is done when a delta run after edits yields the exact
target state and the idempotency test is green.

The framework (ADR-048) already keys every imported object by importer, source system, kind and
source id (`import_external_id`) with a checksum of the command that wrote it, so a second run
over the same records reports them `unchanged` and writes nothing. What it lacked:

- the Cloud REST importer (ADR-094) fetched every issue with its changelog, comments and
  worklogs on every run: a cutover's last run would take as long as the first;
- nothing said what a later run should do with records the source no longer holds;
- an update of a ticket wrote history entries for the difference, while the source's own
  history (a backup's change groups, a site's changelog) also arrives as history records, so a
  re-run that updated a ticket wrote each change twice;
- nothing said what happens to edits people made in Taskmoor between two runs.

## Decision

- **A delta run starts from an earlier run.** `POST /api/v1/admin/imports` takes `deltaFrom`:
  a finished, real (not dry) run of the Cloud REST or Data Center importer in the workspace
  (migration 0076 adds `import_run.delta_from`). The delta uses the earlier run's importer and
  source system whatever the body says; a Cloud delta may leave out `source` (the earlier run's
  settings and sealed token serve) or give new settings for the same site (a new token); a Data
  Center delta names the later backup. A second run of the same instance while one is queued or
  running is refused (`409 run_in_progress`): both would write the same external ids.
- **Cloud: only what changed since the earlier fetch began.** A fetch records `startedAt` (this
  server's clock) before its first request. A delta's settings carry it as `since`, and its
  search is `(<the run's query>) AND updated >= -<n>m ORDER BY key ASC`, with `n` the minutes
  since `since` plus an overlap of 15 minutes for clocks that differ. The time is relative, so
  the site reads it the same in any time zone; it is worked out when the search starts from its
  first page and kept with the page token. Only the issues found get their changelog, comments
  and worklogs fetched. Configuration, boards and sprints are small and are read whole again.
  Re-fetching an issue that did not change costs requests, never writes: its records come back
  `unchanged`.
- **Data Center: the later backup, whole.** A backup is the whole instance; a delta reads it all,
  and the checksums make every record that did not change `unchanged`. The report's counts show
  what changed. Where a later backup keeps an attachment's bytes (its offset in the ZIP) is no
  longer part of a record's checksum, only the bytes' SHA-256 is.
- **Deletions in the source are reported, never applied.** After its last kind a delta run
  checks each kind the source can vouch for (`ImportSource.coverage`): `all` (the run read every
  record of the kind: a backup, a site's configuration, boards and sprints), `listed` (the
  source staged the ids it still holds: after its search, a Cloud delta lists the id of every
  issue the run's query finds, ids only, as `listed:ticket` rows), or `within_tickets` (a changed
  ticket's comments, time and history are read whole). A record an earlier run imported that the
  source no longer holds, whose target is still there, gets an `import_record` row with the new
  outcome `deleted` and counts in the warning `deleted_in_source` (kind, count, five examples).
  The target keeps the object: the administrator lists them (`GET .../records?outcome=deleted`)
  and decides. People and select options are only what a Cloud run saw, so nothing is said of
  them; nor of kinds a Data Center run's scope leaves out.
- **The source's history, not a second copy.** A format may declare `sourceHistory` (the Data
  Center and Cloud importers do): an update of a ticket then writes no history entries for the
  difference, since the source's own entries follow as history records. A delta therefore ends
  with the history a fresh import of the same source writes.
- **Edits made in Taskmoor between runs.** A record the source did not change is never written,
  so Taskmoor's edits to it stay. When the source changed a ticket too, the source's version
  replaces the ticket's fields (record by record, not field by field: the earlier command is not
  kept), the record warns `edited_in_target`, and the ticket's history gets an entry by nobody
  for each field Taskmoor had changed going back to the source's value (fields read from history
  entries by people after the import last wrote the ticket; its external id's `updated_at` now
  moves only when an import writes the object). Comments, time, links and attachments added in
  Taskmoor are never touched. A ticket moved to the trash in Taskmoor stays there.

## Options considered

- **Move tickets deleted in the source to the trash.** Rejected for now: a delta runs unattended
  in a cutover window, and a record the token can no longer see (a project's permissions
  changed, a security level, a narrower scope) looks exactly like a deletion. Trashing also
  moves subtickets and detaches children, which the administrator should see first. The
  `deleted` records make a later option to act on them easy to add.
- **Field-by-field merge of target and source edits.** Rejected: it needs the command an import
  last wrote for every object (gigabytes at a million tickets) and a rule per field kind. The
  record-level rule with the warning and the history entry is predictable and visible.
- **An absolute time in the delta query.** Rejected: the site reads a date in the token user's
  time zone, which the importer does not know; a relative duration is the same everywhere.
- **The highest `updated` the earlier run saw as the mark.** Rejected: an issue edited after it
  was fetched but before the fetch ended can have an earlier `updated` than one fetched later,
  and would be missed. The fetch's start, less an overlap, misses nothing.

## Consequences

- Tests: `import/cloud/delta.test.ts` (a first run, edits in the source: a rename with an edited
  comment, a transition, a new comment, new time, a new ticket and a deleted one; edits in the
  target on a ticket the source leaves alone and on one it changes; the delta fetches the
  details of exactly the 5 changed issues, then lists the site's ids; its target equals a fresh
  import of the edited source ticket by ticket, comment, time entry, history entry, board and
  sprint, apart from the deleted ticket it keeps and the target's own edits; a second delta
  creates and updates nothing and leaves the product tables as they were; refusals) and
  `import/dc-delta.test.ts` (a 300-issue backup, then a later backup with a rename and its
  change group, an edited, an added and a deleted comment, and new time; the delta updates the
  tickets those edits touched and leaves every other one unchanged, reports the deleted comment and keeps
  it, and equals a fresh import of the later backup in tickets, comments, time, links,
  followers and history; a second delta writes nothing).
- Taskmoor as a Cloud source does not move a ticket's `updated` when a comment is edited (the
  compatible API's sites do): a delta from a Taskmoor site misses an edited comment on an
  otherwise unchanged ticket.
- Fields whose changes the source's history does not record keep, after a delta, the starting
  value the first run gave them rather than the later one a fresh import would give.
- The first run after this change reports attachments `updated` once (their checksum no longer
  covers the locator); nothing is written for them.
- Not yet: acting on deleted records (trash, remove), deletions of people and options, a
  delta of CSV, Taskmoor export or synthetic sources, and skipping the plan of records whose
  checksum did not change (a Data Center delta still maps and plans every record of the backup;
  only the writes are saved).
