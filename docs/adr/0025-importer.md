# ADR-025: Importer: staged and idempotent, streaming DC XML, Cloud REST with the customer's token

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-022

## Context

Leaving Jira is the product's first job. Atlassian's migration assistant drops dashboards,
cross-project boards and filters, subscriptions, webhooks and global permissions; Data Center
backups are multi-gigabyte XML files that contain characters XML forbids; Cloud sites can only
be read through a rate-limited REST API with the customer's own token (IMP-001, IMP-002,
IMP-004 to IMP-011, IMP-013). A 50 GB backup must import in under 4 GB of memory.

## Decision

- **Three readers, one pipeline.** A DC/Server backup reader (ZIP with `entities.xml`,
  `activeobjects.xml` and `data/`), a Cloud REST reader (token-paged search, bulk fetch,
  per-item changelog, comments, worklogs and attachments, honouring `Retry-After`) and, in M2,
  a direct DC database reader. All three emit the same stream of source rows.
- **Streaming XML with byte-level cleaning.** The XML reader streams the file through a cleaner
  that removes NUL, other C0 controls, U+FFFE, U+FFFF and numeric references to them before
  decoding, logging each removal with its offset, then through a SAX parser (saxes) that builds
  one row per entity element and never holds more than the current row. Rows go to a staging
  schema in Postgres through COPY.
- **Staged and idempotent.** Stage 1 loads raw rows keyed by (source system, entity, source id).
  Stage 2 normalises configuration (ADR-009; IMP-005), maps users (IMP-007), converts rich text
  (ADR-014; IMP-008) and translates queries (IMP-006). Stage 3 writes the target tables through
  the public services, upserting by source key, so a rerun updates instead of duplicating, a
  crash resumes from the last checkpoint, and a cutover window syncs `updated >= last run`
  (IMP-009). Every stage records counts for the fidelity report (IMP-010).
- **Keys survive.** Track keys, ticket numbers and moved-ticket aliases are kept and Jira URL
  patterns redirect (IMP-011).
- **Runs as jobs** (ADR-015) from a wizard and the CLI with progress, pause, resume, cancel and
  logs (IMP-013), and only against the customer's own site with the customer's own token.

## Measurements (spike, 2026-10-12)

A synthetic 5.00 GB backup in the backup's shape (27.4 million entity rows, long text as child
elements, 2,700 forbidden characters and references injected), parsed through the cleaner and
saxes on one core ([report](../spikes/xml-5g.md)):

| Measure | Result | Budget |
|---|---:|---:|
| Parse time | 2.6 min (32 MB/s) | under 20 min |
| Peak RSS | 303 MB | under 512 MB |
| Rows and text lost | 0 | 0 |
| Forbidden characters and references removed | 2,696 of 2,696 | all, logged |

At this rate a 50 GB backup parses in about 26 minutes with the same memory, so the target-side
writes, not the parser, set the import time.

## Options considered

| Option | For | Against |
|---|---|---|
| Streaming SAX with a byte cleaner (chosen) | Constant memory; forbidden bytes handled before the parser sees them; lossless | Row assembly is ours (about 60 lines) |
| DOM or `xml2js` | Simplest code | Loads the file into memory; a 5 GB file needs tens of GB |
| Pre-clean the file with a separate pass | Cleaner and parser decoupled | Doubles the I/O and the disk space; the stream does it in one pass |
| Native expat binding | Faster | Native addon per platform (ADR-005); the pure parser already meets the budget by 7x |

## Consequences

The staging schema makes every reader testable against the same fixtures, and the fidelity
report is produced from staging counts, so "99.9% entity fidelity" (IMP-010) is measured, not
claimed. Entity coverage grows reader by reader with a golden fixture backup per Jira version
in the design-partner corpus.
