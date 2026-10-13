# ADR-034: Audit log: one hash chain per workspace in monthly partitions

- Status: Accepted
- Date: 2026-10-12
- Backlog: M1-003

## Context

IAM-013 asks for an append-only, hash-chained audit log of sign-ins, security, permission,
configuration, token, export and admin events, searchable, exportable as CSV and JSON,
available through the API, with retention an administrator sets and no 180-day ceiling.
Its acceptance criteria: altering a stored record breaks the chain and the verify command
reports it; retention set to 7 years keeps 7 years; exporting 1M events completes.

Every successful mutation already emits exactly one domain event in its own transaction
(ADR-015, M1-005); subscribers receive them through the job queue, at least once. Postgres is
the only store (ADR-006), migrations are forward-only (ADR-022), and every table carries
`workspace_id` (the fitness test in `packages/db/src/workspace-scope.test.ts`).

## Decision

### What is recorded

- **Domain events.** Audit is the first subscriber of the event bus
  (`apps/server/src/audit/subscriber.ts`). `AUDITED_EVENTS` lists the types it records, today
  the whole catalogue: setup, sessions, users, password links, groups, roles, access policies
  and grants, global grants, track role actors and the audit settings. Each new type must be
  added there or to `NOT_AUDITED` with a reason, or a test fails; ticket activity will mostly
  go to `NOT_AUDITED`, since the ticket history holds it. A record keeps the event's time,
  actor, subject, payload and id (`source_event_id`).
- **Records that are not events** (`AUDIT_ACTIONS` in `audit/record.ts`), written straight to
  the log because they change nothing: refused sign-ins (`session.sign_in_failed`), the
  lockouts they cause (`session.locked_out`), a wrong current password on a password change
  (`user.password_check_failed`), an unknown or used password link
  (`password_link.rejected`), every export of the log (`audit.exported`) and every month
  retention drops (`audit.partition_dropped`). Attempts refused while a lock is in force are
  not recorded, so a flood cannot fill the log; the lockout record stands for them.
- **Client address.** Domain events gain an `ip` column (migration 0006, expand only). A
  preHandler hook opens a request scope (`apps/server/src/request-scope.ts`, an
  AsyncLocalStorage) and `emit` reads the address from it, so no route has to pass it.
- **No secrets.** Event payloads already exclude passwords, hashes, tokens and links. For a
  refused sign-in the typed email is kept only when it looks like an email (contains `@`, no
  spaces); otherwise the record says `emailMalformed`, since it may be a password typed into
  the wrong field.

### Storage

- `audit_event` is partitioned by month on `recorded_at`, the time the record joined the log,
  with `occurred_at` (the event's own time) beside it. Partitions are named
  `audit_event_pYYYYMM` (UTC). The application creates a month's partition when the first
  record needs it and the retention job creates the next month's ahead; creation takes an
  advisory lock so two processes cannot race. The schema snapshot leaves partitions out.
- `recorded_at` is never earlier than the previous record of the same chain, nor than the
  `occurred_at` it records. Within a chain, `seq` order and partition order therefore agree:
  the oldest partitions always hold the start of every chain, which is what lets retention
  drop them whole. Searches by time also bound `recorded_at`, so older partitions are skipped.
- Append-only: a row trigger refuses UPDATE and DELETE (cloned to every partition) and
  statement triggers refuse TRUNCATE on the table and on each partition. The Kysely types mark
  every column as not updatable. Only dropping a whole partition removes records.

### The chain

- One chain per workspace: `seq` counts from 1 without gaps; `prev_hash` is the previous
  record's `hash` (64 zeros before the first); `hash` is SHA-256 over `prev_hash`, a newline
  and the record's canonical JSON (version 1): the fields `action`, `actorId`, `details`, `ip`,
  `occurredAt` and `recordedAt` (ISO 8601 with milliseconds), `seq`, `sourceEventId`,
  `subjectId`, `subjectType` and `workspaceId`, with object keys sorted at every level and no
  whitespace. Details are cleaned before hashing (plain JSON, no NUL, no lone surrogates) so
  they read back from jsonb exactly as they were hashed.
- `audit_chain` holds each chain's head (`head_seq`, `head_hash`, `head_recorded_at`) and its
  checkpoint (`checkpoint_seq`, `checkpoint_hash`, `checkpoint_at`). An append locks the head
  row (`SELECT ... FOR UPDATE`), writes its records and moves the head in one transaction, so
  appends to one chain are serialised and the chain cannot fork, from any process and under
  any isolation level. The lock order is always: head row, then the partition lock, then the
  table.
- An event delivered twice is recorded once: under the head lock, entries whose
  `source_event_id` the chain already holds are skipped.

### Verification

`verifyChain` walks a chain from its checkpoint in one REPEATABLE READ snapshot and reports
the first record that does not verify: `hash` (its fields were edited), `link` (its
`prev_hash` does not match: a record before it was replaced), `missing` (a seq is gone, also
at the end of the log, which the head reveals), `duplicate` (a second record claims a seq) or
`head` (records past the head, or the log ends on another hash). It is served at
`GET /api/v1/audit/verify` and by the operator command `node cli.mjs audit-verify`, which
checks every workspace and exits with 1 when a chain is broken.

### Retention

- One instance-wide setting (`instance_setting` key `audit_retention`, `{ "months": n }`):
  12 by default, 0 keeps everything, at most 1,200. It is instance-wide because partitions
  are shared by all workspaces; per-workspace retention would need sub-partitioning by
  workspace.
- The retention job drops each partition whose month ended at or before the start of the
  month `n` months back: with 84 months on 2026-10-12, September 2019 goes and October 2019
  stays. A record is therefore kept at least `n` months.
- Before dropping, the range of each chain the partition holds is verified. A range that does
  not verify is kept as evidence, and the partitions after it too; the job reports it (an
  error in the worker's log). Otherwise, in one transaction, each chain's checkpoint moves to
  the last record of the partition, and the partition is dropped; an `audit.partition_dropped`
  record follows in each chain.
- The job (`audit.retention`) is queued by the worker role every hour with a key per date, so
  it runs once a day however many workers there are.

### API

Site administrators only (`requireSiteAdmin`):

- `GET /api/v1/audit`: filters `from` and `to` (on `occurred_at`), `actor` (user id),
  `action` (a prefix: `user.` matches every user event), `subject` (`type` or `type:id`);
  newest first, `limit` up to 500, `cursor` from the previous page's `nextCursor`.
- `GET /api/v1/audit/export?format=csv|jsonl` with the same filters: streamed oldest first,
  1,000 records per query and 64 KB per write, so memory stays flat for any size. CSV fields
  that a spreadsheet would run as formulas get a leading apostrophe. The export is recorded
  before the first line leaves.
- `GET /api/v1/audit/verify`: the chain status above.
- `GET` and `PUT /api/v1/audit/settings` (`{ "retentionMonths": n }`): a change emits
  `audit.settings_updated`, which the log records like any other event.

## Measurements (2026-10-12)

One workspace, 1,000,000 records, PostgreSQL 16 (embedded test cluster on an NVMe disk),
Ryzen 7 3700X shared with other test runs; server and client in one Node.js process:

| Step | Time | Memory |
|---|---:|---|
| Append in batches of 4,000 (`appendAudit`) | 71 s, about 14,000 records/s | |
| Verify the whole chain (`verifyChain`) | 34 s | |
| Export as CSV over HTTP (255 MB) | 21 s | RSS 279 MB before, 284 MB peak |
| Export as JSON Lines over HTTP (396 MB) | 22 s | RSS 264 MB before, 269 MB peak |

## Options considered

| Option | For | Against |
|---|---|---|
| Hash chain written by the application under the head row lock (chosen) | Canonical form in one tested TypeScript function; works under any isolation level; the head also reveals a truncated tail | Rows written by other means are not chained (the triggers and types keep writers to `appendAudit`) |
| Hash computed by a BEFORE INSERT trigger | Any insert is chained | A BEFORE trigger may not change the partition key, so it cannot set `recorded_at`; logic in PL/pgSQL is harder to test |
| An advisory lock per workspace instead of the head row | No extra table | A REPEATABLE READ append would read a stale head after waiting and fork the chain; the head is needed anyway to detect a truncated tail |
| Partition by `occurred_at` | Matches what people search by | Delivery order differs from event order, so a month could hold the middle of a chain and dropping it would break verification |
| Write the audit record in the mutation's transaction | Record and change commit together | Every mutation of a workspace would wait on the chain lock; the event already commits with the change and reaches the log at least once |
| Keyed hashes (HMAC with a server key) | Someone with only database access cannot recompute the chain | Key storage, rotation and backup; external anchoring (below) gives the same assurance without a key |
| Export as a background job writing a file | Survives a closed browser | Needs file storage (ADR-020) and a download flow in the admin UI; streaming already exports any size in constant memory |

## Later additions

- With two-factor sign-in (M1-084) a wrong second factor is a refused sign-in with
  `reason: second_factor`; a wrong password when confirming a factor change is a refused
  password check.
- With single sign-on (M1-080) a password refused because the domain enforces single sign-on is
  a refused sign-in with `reason: sso_required`, and a sign-in the provider completed but
  Taskmoor refused (unverified address, a domain the provider does not serve, no account, a
  deactivated account) is `sso.sign_in_refused` with the provider and the reason. Failures
  before the provider vouched for anyone are not recorded, since anyone can produce them.
- Two-factor, single sign-on, provider, track and track category events are all audited.

## Consequences

- Editing, removing or inserting a record within the kept range, and cutting records off the
  end, are detected. Someone with the database owner's rights could rewrite the whole chain
  and its head; the defence is to keep the head hash outside the database: the verify output,
  an unfiltered export (its last line is the export's own record, the head at that moment)
  and, in M2, SIEM streaming (IAM-014) put it elsewhere.
- Appends are serialised per workspace: one short transaction each. A single record takes a
  few milliseconds, so one chain takes hundreds of events per second; batches are much faster
  (see Measurements), and the subscriber can batch events when that matters.
- Verification reads the whole kept chain in the request (34 s for a million records). A
  scheduled verification with a stored result, or one that resumes from the last verified
  record, can come with the admin UI (M1-053) before logs grow much larger.
- IAM-013's optional user activity (ticket views and searches) waits for tickets (M1-006 and
  later); it will be a setting, off by default.
- Acceptance (3) asks for a background job; the streamed export meets its purpose (a million
  records leave in about 20 seconds in constant memory, see Measurements) and a queued export
  to a file can follow with file storage and the audit UI (M1-085).
