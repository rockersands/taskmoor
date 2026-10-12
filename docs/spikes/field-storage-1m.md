# Field storage spike: 1,000,000 items, 1500 fields

Generated 2026-10-12 21:03 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads, 64 GB), PostgreSQL 16.14, 20 timed runs per query after warm-up. Latency is measured from the client.

## Query latency (p95 ms, p50 in brackets)

| Query | jsonb | side |
|---|---:|---:|
| Open one item with all its field values | 1.36 (0.96) | 1.83 (0.99) |
| Select field = option within a space, newest 50 | 245.94 (3.83) | 6.88 (5.44) |
| Number field > x across the site, newest 50 | 3.85 (1.8) | 1.17 (0.63) |
| Date field in a 30-day window and a status category, newest 50 | 437.3 (300.85) | 97.2 (53.09) |
| Select field = option AND number field > x, newest 50 | 5.12 (3.43) | 11.35 (8.3) |
| Items in a space sorted by a number field, top 50 | 187.88 (41.62) | 1.2 (0.62) |
| Count items per option of a select field within a space | 177.93 (101.63) | 1.97 (0.97) |
| User field = person across the site, newest 50 | 9.29 (1.8) | 2.71 (2.1) |
| Count items site-wide with number field > x | 451.64 (423.02) | 4.37 (3.3) |
| Set a number field on one item | 1.33 (0.56) | 1.71 (0.86) |

## Build time and storage

| Candidate | Load s | Index s | Item table MB | Field storage MB | Total MB |
|---|---:|---:|---:|---:|---:|
| jsonb | reused | reused | 1577 | 0 | 1577 |
| side | reused | reused | 1138 | 7333 | 8471 |

## Tables

| Candidate | Table | Rows | Data MB | Index MB |
|---|---|---:|---:|---:|
| jsonb | item | 999,988 | 914 | 662 |
| side | item | 999,797 | 914 | 224 |
| side | v_date | 2,378,234 | 137 | 389 |
| side | v_number | 3,230,578 | 186 | 556 |
| side | v_option | 14,705,784 | 919 | 2813 |
| side | v_text | 6,281,222 | 444 | 1331 |
| side | v_user | 2,526,151 | 145 | 413 |
