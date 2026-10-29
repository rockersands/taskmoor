# ADR-048: The importer framework: extract, map and load in resumable batches

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-086

## Context

IMP-001 to IMP-012 ask for importers of backups, the Cloud REST API and CSV that bring every
entity of spec 02a section 3, keep authors, times and keys (IMP-007, IMP-011), resume after an
interruption with the same final state as an uninterrupted run, update rather than duplicate on
a second run, offer a dry run (IMP-009) and end with a fidelity report of counts per entity,
checksums on samples and warnings, as JSON and HTML (IMP-010). The source formats arrive in
later tasks (M1-087 synthetic backups, M1-088 to M1-094 the backup mappings, M1-095 the Cloud
REST reader, CSV); M1-086 builds the machinery they share and proves it with a synthetic
source of our own. Clean room (ADR-003): no Atlassian code, documents, schemas or sample data;
the synthetic format and fixtures are written by us.

## Decision

- **Three stages, a batch at a time** (`apps/server/src/import/`).
  - *Extract*: an `ImportSource` returns up to N records of one kind after a cursor, in an order
    that never changes. Kinds run in dependency order (`ENTITY_KINDS`: user, group, status,
    ticket type, track, ticket, comment, link, history, time entry); kinds the framework has no
    loader for run after them and are only counted, as `unsupported` in the report.
  - *Map*: a format's `Mapper` turns a source record into a command of the target model, with
    references to other source records (`Ref`), or says why not (`skip`, `fail`), and lists
    warnings for what it leaves out (unknown fields, unsupported history fields). Formats bring
    a reader and a mapper; the commands and loaders are shared.
  - *Load*: one loader per kind plans a command (create, update, link to an existing object
    by email or name, or fail with a reason) with reads only, then applies it. A dry run plans
    and records, never applies.
- **Load writes SQL in the batch's transaction, not through the routes.** The routes stamp the
  caller and the current time, give new numbers, start tickets in their workflow's initial
  status and fire create effects; an import must keep source authors, times, numbers, statuses
  and history, and must commit a batch, its external ids and its checkpoint atomically. What the
  routes keep right the loaders keep right the same way: history rows through
  `tickets/history.ts` (a new ticket's starting values as one change set at its creation time
  by its creator; the source's own entries then correct the starting value of each field they
  change), the change log through its row triggers, ticket counters moved past imported
  numbers, labels remembered, time spent recomputed from time entries and formulas refreshed
  (`refreshFormulas`) for every ticket a batch touched. Imported objects emit no domain events:
  an import is one audited operation, and notifications for history that happened elsewhere
  would be noise.
- **External ids.** `import_external_id` keys every imported object by (workspace, import
  source, source system, entity kind, source id) with the target id and a checksum of the
  command. A second run finds the object: an equal checksum is `unchanged` (no write), a
  different one an update (tickets record the difference as history by the system). History
  entries never change once imported. No foreign key on the target: an object deleted since
  fails its record as `target_deleted` instead of being created again.
- **Resumable.** `import_run` holds the state (queued, running, done, failed, cancelled), the
  checkpoint (kind and source cursor after the last committed batch), tallies per kind,
  warnings grouped by kind, code and detail with up to five example ids, and unsupported
  counts. A batch locks the run row, reads the checkpoint, extracts, maps and loads each record
  in a savepoint (a bad record fails alone, with its reason), writes `import_record` rows (one
  per source record: outcome, target, sample checksum), the external ids and the new checkpoint,
  and commits. A crash loses at most the open batch; the next attempt resumes from the
  checkpoint. The `import.run` job runs batches for up to 50 s and queues the next part (as
  bulk operations do, ADR-043); an error rolls the batch back, keeps the message on the run and
  lets the queue retry with backoff, and after ten failed attempts the run ends as `failed`
  with its report so far.
- **Dry run.** Plans resolve references to records the run would create through its own
  `import_record` rows (a pending id); the report is built the same way, with no target counts
  and source-side sample checksums only. Checks that need objects the run would create are
  approximated: a ticket of an existing type in a track the run would create is checked
  against the default type sets. A record a real run fails on a database constraint the plan
  does not check shows as created in the dry run.
- **Fidelity report** (`import/report.ts`): a zod schema (`fidelityReport`, published as JSON
  Schema, golden-tested) checks every report the runner writes: per kind the source count,
  outcomes, distinct targets that still exist and their ratio (fidelity, over records not
  skipped); totals; samples (the first ten records of each kind and about one in sixteen after,
  at most 50 per kind) with the checksum of the command's resolved fingerprint and of the same
  fingerprint read back from the target row; warnings; unsupported kinds; the first 100
  failures. `?format=html` downloads a standalone page (escaped, no scripts, no external
  resources).
- **Routes** under `/api/v1/admin/imports` (admin token scope; site administrators only):
  start (`POST`, an uploaded synthetic file up to 16 MB or a generated one, optionally a dry
  run), list, progress, report and cancel. Events: `import_run.created` and
  `import_run.cancelled` from the routes, `import_run.finished` from the job (no actor,
  `requestedBy` in the payload); all three are audited.
- **The synthetic format** (`import/synthetic.ts`, source `synthetic`): newline-delimited JSON
  with a header naming the source system, then records `{kind, id, ...}` in a vocabulary that is
  deliberately not the target's (`category`, `lead`, `reporter`, `resolved`), and a seeded
  generator that writes fixtures with inactive, deleted and hidden-email people, a status that
  links to a built-in one, gaps in ticket numbers, subtickets, restricted comments, links,
  history, time entries, unknown fields and unsupported kinds (boards, dashboards).
- **Placeholders** (IMP-007): a person whose email the source hides gets
  `imported-<hash>@placeholder.invalid` (unique per source system and id, never deliverable);
  inactive and deleted people become deactivated users, so attribution stays.

## Options considered

| Option | For | Against |
|---|---|---|
| Load through the ticket routes (`Caller`, as bulk operations) | Every check and side effect for free | Rewrites authors, times, numbers and statuses; a transaction per call, so a batch, its external ids and its checkpoint cannot commit together; workflow effects and notifications fire for the past |
| Set-based SQL per batch, history and derived values by the existing helpers (chosen) | Keeps the source's facts; atomic batches make kill and resume exact; one place per kind to extend | The loaders must follow every new rule a write path gains (formulas, side tables, locks do not apply to imports) |
| One transaction for the whole import | Trivially all or nothing | Hours-long transactions, no progress, nothing resumes |
| Checkpoints without per-record rows | Less storage | No dry-run resolution, no per-record outcome, no sampling after a resume |

## Consequences

- New source formats implement `ImportSource` and a `Mapper` and register in `IMPORT_FORMATS`
  (`import/jobs.ts`); new entity kinds add a command, a loader (plan, apply, read back) and a
  place in `ENTITY_KINDS`.
- Kill and resume is a property test (`import/resume.test.ts`): a seeded fixture of 18 tickets
  (about 160 records) imported into fresh databases, killed before 1 to 3 random records, with
  or without a job part per batch, ends with the same snapshot (imported rows keyed by source
  ids, history, counters, change log, report) as the uninterrupted run; 8 runs take about
  50 s. Target ids and rank keys may differ between the runs (a rolled-back batch still uses
  up sequence values), so the snapshot names them by source id and by position.
- Not yet: custom fields, attachments, followers and votes, key aliases of moved tickets,
  releases, areas, boards and the rest of section 3 (M1-088 to M1-094 extend the loaders);
  delta runs by `updated >= last run` (the external ids and checksums are ready for it);
  pause and resume from the console and downloadable logs (IMP-013); throughput: loaders write
  record by record inside the batch (fine for the framework, to be made set-based for the
  1M-ticket runs of M1-091). Imported statuses and ticket types are not added to workflows or
  type sets; the report warns (`status_not_in_workflow`, `type_not_offered`).
