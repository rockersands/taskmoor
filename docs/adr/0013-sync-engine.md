# ADR-013: Sync engine: in-house change log with a commit-ordered sequence

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-019

## Context

Perceived speed is the main reason people prefer Linear-style tools: the client holds a local
copy of what the user may see, renders from it, applies mutations optimistically and receives
others' changes within a second (NTF-008). The installable app must queue changes offline and
replay them on reconnect (MOB-001). The research suggested Linear's pattern (a server
authoritative change log with a monotonic sequence, permission-scoped sync groups, an
IndexedDB cache and an outbox) and named two products that package it: Zero (Rocicorp) and
ElectricSQL.

## Decision

- **A change log in Postgres** (`sync.change_log`): every mutation appends one row per changed
  entity with the track, entity, id, operation and a JSON delta, in the same transaction as the
  change. A sequence is taken under a short advisory lock immediately before the append, so
  sequence order is commit order and a client that has seen `seq` has seen everything below it.
  Permission tables write to the log too, which is what invalidates the caches of ADR-012.
- **Bootstrap, then follow.** A client bootstraps the entities of its sync groups (the tracks
  it may browse, plus its own user-scoped data) in id-ordered pages and records the log
  position it started from; afterwards it pulls `seq > last` for those groups, woken by
  `NOTIFY` over the realtime connection, with a poll as fallback. Visibility levels and
  ticket-level grantees are applied when the delta is read, so a client never receives a row it
  may not see.
- **Optimistic mutations with an outbox.** The client applies a mutation locally, queues it with
  a (client id, mutation id) pair, and sends it; the server applies each pair at most once and
  returns the resulting sequence, so a replay after a crash or an offline period is idempotent.
  Conflicts on the same field resolve last-write-wins with the overwritten value kept in
  history (NTF-008); rich text merges through Yjs (ADR-014).
- **Shared code.** The mutation functions live in a package used by both client and server
  (ADR-005), so the optimistic result and the authoritative one come from one implementation.
- **Retention.** The log is partitioned by month (ADR-006); a client whose position is older
  than the retained window bootstraps again.

## Measurements (spike, 2026-10-12)

200,000 tickets, the largest track holding 51,835 ([report](../spikes/sync.md)):

| Measure | Result |
|---|---:|
| Bootstrap of 51,835 tickets (51 MB of JSON lines) | 2.6 s, 20,000 rows/s |
| Mutations, 8 concurrent writers, lock-ordered log | 1,392 per second |
| Sequence gaps or reordering | 0 |
| Append-to-follower latency under that load, p50 / p95 / max | 0 / 1 / 724 ms |
| Append-to-follower latency idle, p50 / p95 / max | 1 / 1 / 2 ms |
| Offline outbox of 1,000 mutations, first run / replay | 1.35 s / 0.38 s, 0 applied twice |

The budget (a change visible elsewhere within 1 s at p95) holds with a wide margin; 1,400
mutations per second on one connection pool exceeds the plan's 1,000 jobs per second target.

## Options considered

| Option | For | Against |
|---|---|---|
| In-house change log (chosen) | Measured within budget; no extra service; permissions from ADR-012 applied in the same SQL; one schema we own | Client cache, delta application and conflict handling are ours to write (M1-031, M1-032) |
| Zero (Rocicorp) | Mature client cache and query engine; Apache-2.0 | A `zero-cache` service with a SQLite replica fed by logical replication; permissions re-expressed in its own language, duplicating ADR-012; a second service in every install |
| ElectricSQL | Shape-based partial replication over HTTP; Apache-2.0 | An Elixir sync service (Docker) as a second stateful service; row-level permissions through shapes do not express role, group and visibility-level rules without duplication |
| PowerSync | Polished SDKs | Core under FSL, not an OSI licence (ADR-002) |

Zero and ElectricSQL were assessed on fit, not benchmarked: each adds a service that
ADR-006 and the install targets rule out, and each would carry a second copy of the
permission model. If a later milestone wants their client-side query engines, they can be
revisited behind the same change log.

## Consequences

Every write path must append to the log, enforced by a fitness test over the mutation
functions. The realtime role (ADR-021) relays `NOTIFY` to WebSocket clients. The lock
serialises the tail of mutating transactions; if a site ever exceeds the measured throughput,
the log can be sharded by track with one sequence per shard.

## Implementation (M1-031)

- **Triggers write the log** (migration 0036): row triggers on `ticket` and `track` append one
  row per change with a snapshot (a ticket without its rich text, which clients read when they
  open it); a ticket that changes track leaves a delete in its old track's group and an upsert in
  the new one; a change to `authz_epoch` appends one workspace row per transaction. Every write
  path reaches the log, bulk rewrites included, without the application's help. Other entities
  (statuses, fields, comments) join when clients need them (M1-032).
- **Numbered at commit.** Rows are written without a sequence; a deferred constraint trigger
  takes a transaction-scoped advisory lock and numbers the transaction's rows as it commits.
  Sequence order is therefore commit order, and the lock is held only from the numbering to the
  end of the commit, after the transaction's own row locks, so it cannot deadlock with them (a
  lock taken at the first append and held to commit could). Readers read the top position
  before the rows, so nothing numbered meanwhile is skipped.
- **Permissions when read** (`apps/server/src/sync/log.ts`): sync groups are the tracks the
  person may browse or browse tickets of through a ticket-level grant, plus the workspace group.
  Each ticket row is judged with the person's current permissions against its own snapshot
  (`ticketPermissions`, ADR-012): one they may see comes with its data, any other as a bare
  removal of its id. An `authz` row tells the client its groups or visibility may have changed,
  and it bootstraps again.
- **API:** `GET /api/v1/sync/groups`, `GET /api/v1/sync/bootstrap?track=&after=` (id-ordered
  pages and the position to follow from, read before the first page) and
  `GET /api/v1/sync/changes?after=`. Websocket push, the client store and the outbox are M1-032.
- **Retention** deletes rows older than 30 days (per workspace, `change_log_floor`) hourly in
  batches instead of the monthly partitions this ADR planned: rows are written by triggers,
  which cannot create a month's partition on demand. `floor_seq` records the highest sequence
  removed; a client behind it is answered `resync` and bootstraps again.
- **Tests:** a property test runs random creates, edits, level changes, moves, trash and
  membership changes while three replicas bootstrap and follow; at the end each replica holds
  exactly what its person may see, and no replica ever received a ticket its person may not
  see, judged by a plain model of the test's memberships (a mutation that lets hidden tickets
  through fails it). A second test shows a transaction that writes first and commits last gets
  the higher sequence, and that trimming makes old positions resync.

## Implementation (M1-032)

- **Mutations at most once** (migration 0037, `apps/server/src/sync/mutations.ts`): any
  POST, PUT, PATCH or DELETE that carries `taskmoor-client-id` and `taskmoor-mutation-id`
  first inserts a pending `mutation_receipt` for (person, client, mutation). A later request
  with the same pair gets the stored answer back (`taskmoor-replayed: true`) without running
  again; while the first is still running it is answered 409 `mutation_in_progress` (after
  five minutes `mutation_outcome_unknown`), and the same ids on another method or path 409
  `mutation_id_reused`. A 5xx answer deletes the receipt, so the client may retry; anything
  else is kept for seven days with its status, body and the log position after it, which every
  answer carries in `taskmoor-position` (the "resulting sequence" above). Requests without the
  headers are unchanged.
- **Push** (`apps/server/src/sync/socket.ts`, the `realtime` role): `GET /api/v1/sync/socket`
  is a websocket for signed-in people from the same origin only (anything else is closed with
  4401). It sends the workspace's log position when it opens and whenever it moves, and
  answers `ping`. It sends positions, never rows: the client reads `/sync/changes`, where
  permissions are applied (M1-031), so the socket cannot leak what a person may not see.
  Instead of `NOTIFY` (which needs a connection held outside the pool) one poller per
  workspace with open sockets reads the top position every 250 ms.
- **Client** (`apps/web/src/sync/`): `store.ts` keeps tickets (indexed by track and number),
  the position, the synced tracks, a client id and the outbox in IndexedDB, one database per
  person, deleted at sign-out. `engine.ts` bootstraps when there is no position, then follows
  on every pushed position (every 30 s when there is no socket; reconnects back off from 1 to
  30 s); an `authz` row or a `resync` answer bootstraps again. `mutate()` stores the entry
  first, applies the optimistic change to the local copy, then sends the outbox in order; a
  network failure keeps the entry for the next attempt (reconnect, `online`), a refusal drops
  it, is reported, and the truth comes back through the log. The ticket page reads the local
  copy first and the server's answer replaces it. A person with a local copy starts offline
  and catches up when the server answers; without one, the first bootstrap is retried after a
  pause that doubles from 2 seconds to a minute, and at once when the browser comes back
  online, while the app works from the network.
- **Not yet:** the optimistic function is given by the caller rather than shared with the
  server (the "Shared code" point waits for the ticket view, M1-051, which is the first screen
  that edits through the outbox); conflicts are last-write-wins as the server applies them.
- **Tests:** the server replays a mutation once, refuses reused and in-flight ids, pushes a
  position within a second of a change, and closes anonymous and cross-site sockets. The
  engine converges with a fake server through pages, pushes, an authorization change and a
  trimmed log; starts offline from a local copy, and retries a first bootstrap that could not reach the server; sends an offline outbox exactly once when answers are lost and resent; and keeps
  its copy in IndexedDB (`fake-indexeddb`). The e2e test opens a ticket with the sync API
  blocked (from the server, best of three under 300 ms) and from the local copy (under 100 ms),
  and sees the position move after an edit. These timings are on the e2e instance; the bench
  generator loads its own schema, not the application's, so the same measurement on a
  bench-sized workspace belongs to the load tests (M1-104).
