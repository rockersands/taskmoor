# Job queue spike: 20,000 jobs, 8 workers

Generated 2026-10-12 08:00 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads), PostgreSQL 16.14, fsync on. In-house workers claim 25 jobs per round trip. Latency is enqueue to handler start, measured with the process clock.

| Candidate | Enqueue s | Drain s | Jobs/s | Backlog latency p95 ms | Wake p50 ms | Wake p95 ms | Wake max ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| inhouse | 0.5 | 1.1 | 18018 | 1150 | 7 | 10 | 45 |
| graphile | 0.8 | 14.6 | 1367 | 14010 | 8 | 12 | 28 |

Backlog latency is the wait in a pre-filled queue, so it grows with the backlog; wake latency is
what a user would feel: one job enqueued while the workers are idle.
