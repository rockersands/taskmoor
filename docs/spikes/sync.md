# Sync engine spike, in-house change log: 200,000 items

Generated 2026-10-12 10:30 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads), PostgreSQL 16.14.

Budget (M0-019): bootstrap of 50k items and delta p95 measured; NTF-008 wants a change on another screen within 1 s (p95).

| Measure | Value |
|---|---:|
| Bootstrap: spaces / rows / MB | 1 / 51,835 / 51.2 |
| Bootstrap time | 2.584s (20,060 rows/s) |
| Mutations | 20,000 from 8 writers in 14.365s (1,392/s) |
| Sequence gaps | 0 |
| Delta latency under load p50 / p95 / max ms | 0 / 1 / 724 |
| Delta latency idle p50 / p95 / max ms | 1 / 1 / 2 |
| Outbox replay: queued / first run s / second run s / applied twice | 1000 / 1.353 / 0.384 / 0 |
