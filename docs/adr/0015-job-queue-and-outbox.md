# ADR-015: Job queue and transactional outbox in Postgres

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-021

## Context

Background work (notifications, automation rules, indexing, imports, webhooks) needs a queue.
Self-hosting must stay "Postgres only": no broker, no Postgres extension beyond the standard
contrib set, so the design works on managed Postgres too. The plan's budget is 1,000 jobs per
second sustained.

## Decision

An in-house queue table in Postgres, claimed with `FOR UPDATE SKIP LOCKED`:

- Workers claim a batch of jobs in one statement, run them, and mark the batch done in one
  statement. Idle workers `LISTEN`; enqueue sends `NOTIFY`, with a poll as a fallback.
- Every job may carry an idempotency key with a unique index that stays in place after the job
  completes, so a duplicate submission is dropped forever, not only while the job is queued.
- Failures retry with exponential backoff up to a per-job maximum; the error is kept on the row.
- Business changes that must produce work write the job in the same transaction as the change.
  For targets outside the database (webhooks, email, external queues) a transactional outbox
  row is written instead, and a relay publishes it with the event ID as the idempotency key, so
  a relay crash after publishing causes a duplicate that the key absorbs.

`packages/spikes/src/queue` holds the prototype and the tests that prove exactly-once delivery
under concurrent workers, key deduplication after completion, retry and give-up, and the
outbox crash case. The M1 implementation moves it into the server with a proper migration.

## Measurements (spike, 2026-10-12)

20,000 jobs, 8 workers, fsync on, PostgreSQL 16.14, Ryzen 7 3700X
([report](../spikes/queue.md)):

| Candidate | Drain jobs/s | Wake-up p50 / p95 ms |
|---|---:|---:|
| In-house (batches of 25) | 18,018 | 7 / 10 |
| Graphile Worker 0.18 | 1,367 | 8 / 12 |

Both wake an idle worker in about 10 ms. Draining a backlog, the batched in-house queue is
13 times faster than Graphile Worker, which claims and completes one job per round trip. The
budget of 1,000 jobs per second holds with a wide margin on one machine.

## Options considered

| Option | For | Against |
|---|---|---|
| In-house SKIP LOCKED queue (chosen) | Fastest; batching; keys that outlive completion; one schema we own | We maintain it (about 200 lines plus tests) |
| Graphile Worker | Mature, cron, job keys, admin tooling | Per-job round trips; its own schema and migrations; job keys dedupe only while queued |
| pgmq | Queue semantics in SQL | Needs an extension that standard images and most managed Postgres offerings lack |
| Redis, RabbitMQ, NATS | Proven brokers | A second stateful service for every self-hoster |

## Implementation (M1-005)

`apps/server/src/events`: tables `domain_event` and `job` (migration 0005).

- **One domain event per mutation**, written with `emit` in the mutation's own transaction and
  typed by the catalogue (`catalogue.ts`: type, subject kind, zod payload). Payloads never carry
  secrets. A changed payload is a new version of the type, not an edit, because events outlive
  releases. Since M1-003 an event also keeps the client address of the request that caused it
  (`ip`, from the request scope; null for the CLI and jobs).
- **The outbox is the event table.** `EventBus.relayOnce` claims unpublished events with SKIP
  LOCKED and enqueues one job per interested subscriber keyed `event:<subscriber>:<event id>`,
  then marks them published, in one transaction; a relay run twice enqueues nothing twice.
- **The worker role** loops: relay, run a batch of jobs, release jobs locked for more than ten
  minutes (a dead worker), then wait half a second when idle. LISTEN/NOTIFY can replace the
  wait when latency matters.
- **Subscribers** register in `subscribers.ts`; the audit log (ADR-034) is the first.
- **Fitness test** (`contract.test.ts`): every POST, PUT, PATCH and DELETE route has a scenario
  that must leave exactly one event of its declared type with a valid payload, or a stated
  exemption (read-only POSTs); every catalogue type must be produced by some route.

## Consequences

Queue depth, failures and latency become ordinary SQL for the admin pages and the Prometheus
exporter. Long-running jobs need heartbeat and lock expiry (M1). Fairness between tenants and
priority lanes are added when a feature needs them, by extending the claim query.
