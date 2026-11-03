# ADR-092: The Data Center import of an issue's content: a stage that spills to buckets, content kinds, and fidelity against the fixture

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-091

## Context

M1-091 maps the rest of a Data Center issue (IMP-004; spec 02a section 3): its change history,
comments, time entries, links, attachments, watchers, votes and the keys it had before a move.
It is done when a synthetic import of a million issues reaches 99.9% entity fidelity in under
four hours. M1-089 (ADR-089) already imports each issue as a ticket with its own fields and
custom values. Its stage kept every issue's custom values and labels in memory until the end of
the file, and its report asked this task to check that at a million issues: about five million
value rows, and now as many watchers, votes, comments and change items again.

The importer framework (ADR-048) has kinds and loaders for comments, history, time entries,
links and attachments (M1-086, M1-098), and tickets carry followers and voters. It has no kind
for web links, and nothing writes a ticket's earlier keys. The text of a backup is wiki markup,
which M1-071 (ADR-091) can now read.

## Decision

- **The stage keeps no issue content in memory** (`dc-backup/stage-issues.ts`, `spill.ts`).
  While the backup streams past, the rows that make a ticket (the issue, its custom values,
  labels, watchers and voters) are appended to bucket files by issue id range (16,384 ids a
  bucket), change groups and their items to bucket files by change group id range (65,536 a
  bucket), and comments, work logs, links, remote links and attachment rows to one file each.
  After the file, each bucket is read and joined on its own. Memory holds one bucket, the
  sub-task links (one entry per sub-task), the earlier keys of moved issues, and an index of the
  attachment files. Ids are close to dense in a backup, so ranges keep buckets even; past 4,096
  ranges they fold onto each other, which keeps the number of files bounded. Tickets are written
  in issue id order, parents first, as before. People named by person fields' values, which
  decide whether a deleted person is kept (ADR-081), are read from the ticket buckets once the
  fields are known.
- **Content kinds of their own.** The stage writes `comment`, `history`, `time_entry`, `link`,
  `web_link` and `attachment` records; the mapper is `import/dc-content.ts`. Watchers, voters
  and earlier keys travel on the ticket record. `web_link` is a new framework kind with a loader
  (`import/load-weblinks.ts`) that keeps the rules of the ticket web link routes (http or https,
  lengths) and writes the same history entry. Tickets gain `formerKeys`: rows of the ticket's key
  history that were replaced when it moved, so `resolveTicket` and the query language find the
  ticket by its old key (CORE-023 (3)); a key another ticket holds stays theirs, with a warning.
  The redirects from Jira URLs are M1-128's.
- **History keeps its authors and times, in stored form.** Each change group becomes one history
  entry at its time and by its author (anonymous changes have none). Its items name the backup's
  fields and ids (`status`, `resolution` as `closeReason`, `project` as `track`, `Key` as `key`,
  people by staged id, custom fields as `cf[<id>]` by their name), and the history loader maps
  them as it does Taskmoor's own export (`remap.ts`). As ADR-010 and M1-086 decided, the ticket
  first records every value it has now, and each field's first entry in the source corrects
  that starting value; so a moved ticket starts with its old key and track. Fields Taskmoor's
  history does not follow are left out with `history_field_not_mapped`; an entry with nothing
  left is skipped.
- **Text through `fromWiki`.** Descriptions, environments and comment bodies become documents
  through ADR-091's reader; time entries hold plain text, so their markup is reduced to its
  words (`toPlainText`). Paragraph custom values stay plain text as M1-089 made them, and
  mentions keep the backup's user key, because the markup names people by key and the
  document's mention ids are mapped only when they are Taskmoor ids.
- **Restrictions never widen.** A comment or time entry restricted to a group or role that did
  not import fails with its reason, rather than arriving visible to everyone. One restricted to
  both a group and a role keeps the role, with a warning.
- **Attachments are read from their place in the ZIP.** The stage reads each file under
  `data/attachments` once, for its SHA-256 and sniffed type, and indexes it by the attachment id
  that names it (any folder layout). The record's locator is the entry's local header offset,
  compressed size, method and size; `DcBackupSource.openFile` reads and inflates just that entry,
  and the loader checks the hash as for any import (M1-098). Attachments outside the ZIP (the
  Data Center layout, next to the backup) are not read yet.
- **What the backup does not say is approximated and said.** Links have no time: a link takes the
  later of its two tickets' creation. Web links have no time or author: the import's time.
  Followers and voters keep no time. Times are read as UTC (ADR-081 left a source zone setting
  for later).
- **A tickets-only scope.** `"scope": "tickets"` imports configuration and tickets but counts
  their content as `tickets_only`. M1-089's and M1-092's tests use it, so they stay about fields
  and access.
- **The loaders write in fewer round trips.** At a million issues the import writes about
  6.6 million records, each in its own savepoint (ADR-048). Three changes keep the per-record
  path short without changing what is written: `writeChanges` takes its change set number and
  inserts its rows in one statement (`writeChangeSets`); a batch of tickets writes the starting
  values of all its new tickets at its end, from one read of those tickets and one lookup of the
  names their values had (`customChangesOf`); and the history loader reads each ticket's history
  rows once per batch and keeps that picture up to date, instead of two queries per item. Its
  updates and deletes of starting values name the ticket, so Postgres searches one partition of
  `ticket_change` instead of all of them. The history entries that comments, links, web links
  and attachments add are written together at the batch's end (`deferChanges`), a batch of
  tickets reads the numbers its tracks already gave in one query, history entries and new
  tickets' ranks take their change set and rank numbers from blocks of 250 a batch reads at
  once, and a batch holds 250 records instead of 100 (`DEFAULT_BATCH`).
- **Fidelity against the fixture** (`import/dc-fidelity.ts`). Every ticket, follower, vote,
  earlier key, comment, history entry, time entry, link, web link and attachment the generator
  wrote is found through the import's external ids and compared field by field with what the
  generator's instance says, plus each ticket's starting values. Mismatches are listed per kind.
  The golden test (`dc-content.test.ts`, 3,000 issues, seed 91) checks everything; the large run
  (`dc-import.large.test.ts`, not in `pnpm verify`) checks every issue up to 100,000 and one in
  20 above.
- **The fixture grows, in our own words** (format notes 02d): watchers and voters
  (`UserAssociation`), web links (`RemoteIssueLink`), moved issues (`MovedIssueKey` and a change
  group with `project` and `Key` items), restricted work logs, and wiki markup in descriptions,
  comments and work logs, each from a seed stream of its own so earlier facts do not change.
  The validator checks that each issue's vote and watch counts equal its rows, and that an
  earlier key names a project and a number no issue holds now.

## Options considered

| Option | For | Against |
|---|---|---|
| Buckets by id range, joined one at a time (chosen) | Memory for one bucket; order by id kept; plain files | A second pass over the issue data; disk about the size of `entities.xml` while staging |
| Keep values and associations in memory (M1-089) | Simple | About 1 GB at a million issues and unbounded beyond (IMP-001 (1)) |
| External sort of every row by issue | One general mechanism | More code and passes; the joins only need grouping, not order |
| Stage into Postgres tables | Joins in SQL | Rows written twice; a schema for another product's format (ADR-081) |
| Copy attachment files into the stage | Simple reads | Doubles the disk for attachments, which are the largest part of a backup |
| Content inside the ticket record | One record per issue | A record per issue of unbounded size; no per-comment outcome or resume inside an issue |
| Set-based loading of whole batches | Several times faster | Gives up ADR-048's per-record savepoints and outcomes; a larger change than this task |

## Consequences

- Measured on the golden fixture (3,000 issues, seed 91, six projects): 3,000 tickets, 4,909
  followers, 888 votes, 10 earlier keys, 3,387 comments, 8,708 history entries, 1,078 time
  entries, 260 links, 264 web links and 349 attachments, every one equal to the fixture (100%),
  and every ticket's starting values too; a second run changes nothing. Golden:
  `import/__golden__/dc-content-seed91.fidelity.json`. The test file runs in about 100 s.
- Measured at scale: see "Measurements" below.
- The stage needs disk next to the ZIP for its spill files while it runs (they are removed at
  its end) and keeps the ZIP: the import reads attachments from it.
- M1-128 adds URL redirects on top of the key history rows. Mentions, paragraph values in wiki
  markup, a source time zone and attachments outside the ZIP are left for later.

## Measurements

`dc-import.large.test.ts` on the cloud container (four shared CPUs, Node 22, Postgres 16 on the
same machine), 2026-10-31, with the default batch of 250 records:

| Issues | Records | Stage | Import | Per record | Peak heap | Database | Fidelity |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 20,000 | 114,460 | 11.4 s | 427 s (batch of 100, load average 10 to 18) | 3.7 ms | 213 MB staging, 390 MB importing (RSS 568 MB) | 543 MB | 172,306 of 172,306 |
| 100,000 | 570,016 | 68.8 s | 1,625 s and 1,631 s (load average about 1) | 2.9 ms | 401 MB staging, 257 MB importing (RSS 593 MB) | 2,426 MB | 859,788 of 859,788 |

At 100,000 issues the import's time went to tickets (605 s, 6.0 ms each, with their custom
values, followers, voters and starting values), comments (358 to 451 s, 3.0 to 3.8 ms; a new
comment also updates its ticket's response times through a trigger), history (409 to 518 s,
1.4 to 1.8 ms), attachments (62 to 76 s, 6 to 7.5 ms with the file written to the store), time
entries (40 to 51 s), links (25 to 29 s) and web links (8 s). Every entity of every issue was
checked: none differs from the fixture.

**The million-issue run did not run here.** At the 100,000 rate it would take about 16,300 s,
4.5 hours, plus about 12 minutes of staging, so the four-hour bar is not met on this machine;
and its database (about 24 GB) does not fit the 11 GB of free disk. The import is serial: one
batch at a time, with Node and Postgres taking turns, so the load average stayed near 1 on four
CPUs. What is left: run `TASKMOOR_LARGE_DC_IMPORT=1 pnpm verify --only=tests --
apps/server/src/import/dc-import.large.test.ts` at 1,000,000 issues on a machine with at least
40 GB free and faster cores, and, if it misses four hours there, load content kinds in parallel
batches (each kind after tickets is independent of the others but for history, which runs last)
or set-based (the option above).

**500,000 issues, measured on 2026-11-03** (the user's decision: 500k measured, 1M as an estimate),
on a 16-thread PC with NVMe storage, native Windows, with other work running on the machine.

| Issues | Records | Stage | Import | Per record | Peak memory | Database | Fidelity |
|---|---|---|---|---|---|---|---|
| 500,000 | 2,853,241 | 214 s | 7,108 s (1 h 58 min) | 2.5 ms | 659 MB staging, 474 MB importing (RSS 1,022 MB) | 12.3 GB | 214,411 of 214,411 (every 20th issue) |

Seven records failed. That run did not capture why; the test now reports the reasons. An earlier
run on the same day scored 98.58% because the generator repeated six project keys at 200 projects:
the import refused each second track, as it should, and the generator is fixed.

**The estimate for 1,000,000 issues:** time grew linearly from the 100,000-issue run, so about
5.7 million records at 2.5 ms is 3 h 57 min, plus about 7 minutes of staging, and about 24 GB of
database. That is right at the four-hour bar, on this machine, with no margin.
