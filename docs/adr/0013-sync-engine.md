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
