# Permission engine spike: 100,000 users, 30,000 spaces

Generated 2026-10-12 10:25 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads), PostgreSQL 16.14. 2,000 random (user, space, permission) checks per candidate, one at a time, latency from the caller. 5,000 groups, 600 policies, 341,755 memberships, 304,705 role actors, 48,019 grants, 754,479 OpenFGA tuples.

Budget: check p95 under 10 ms (IAM-012).

| Candidate | Check p50 ms | Check p95 ms | Check max ms | Allowed-spaces p50 ms | p95 ms | Median spaces | Load s | Mismatches |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| inprocess-cold | 1.14 | 1.47 | 12.8 | 95.41 | 122.62 | 24120 | 5.166 | 0 |
| inprocess-cached | 0 | 0 | 0.1 | 95.41 | 122.62 | 24120 | 5.166 | 0 |
| openfga | 8.83 | 15.9 | 147.94 | 205.82 | 249.01 | 24120 | 146.947 | 0 |
