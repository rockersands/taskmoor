# Field storage spike: 1,000,000 items, 1500 fields

Generated 2026-10-12 07:43 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads, 64 GB), PostgreSQL unknown, 20 timed runs per query after warm-up. Latency is measured from the client.

## Query latency (p95 ms, p50 in brackets)

| Query | jsonb | side | eav |
|---|---:|---:|---:|
| Open one item with all its field values | 0.88 (0.57) | 1.08 (0.5) | 1.48 (0.92) |
| Select field = option within a space, newest 50 | 20.86 (3.92) | 54.35 (8.72) | 31.68 (7.81) |
| Number field > x across the site, newest 50 | 5.53 (2.5) | 20.73 (7.86) | 115.1 (61.13) |
| Date field in a 30-day window and a status category, newest 50 | 655.19 (549.93) | 11.95 (3.85) | 8.98 (3.19) |
| Select field = option AND number field > x, newest 50 | 1515.47 (5.36) | 67.39 (20.39) | 46.05 (25.03) |
| Items in a space sorted by a number field, top 50 | 267.9 (52.01) | 55.24 (9.53) | 3731.54 (290.94) |
| Count items per option of a select field within a space | 235.79 (132.02) | 601.36 (103.68) | 3957.52 (3625.75) |
| User field = person across the site, newest 50 | 27.45 (2.3) | 67.68 (4.58) | 21.11 (5.26) |
| Count items site-wide with number field > x | 637.56 (586.07) | 31.98 (21.09) | 30.22 (22.18) |
| Set a number field on one item | 1 (0.55) | 0.83 (0.53) | 0.71 (0.28) |

## Build time and storage

| Candidate | Load s | Index s | Item table MB | Field storage MB | Total MB |
|---|---:|---:|---:|---:|---:|
| jsonb | 23 | 82 | 1576 | 0 | 1576 |
| side | 248 | 122 | 1019 | 3612 | 4631 |
| eav | 194 | 120 | 373 | 3541 | 3915 |

## Tables

| Candidate | Table | Rows | Data MB | Index MB |
|---|---|---:|---:|---:|
| jsonb | item | 999,986 | 914 | 662 |
| side | item | 999,865 | 914 | 105 |
| side | v_date | 2,378,234 | 100 | 143 |
| side | v_number | 3,230,555 | 161 | 222 |
| side | v_option | 14,706,454 | 729 | 1130 |
| side | v_text | 6,281,221 | 371 | 497 |
| side | v_user | 2,526,151 | 107 | 152 |
| eav | item | 999,812 | 268 | 105 |
| eav | value | 29,141,468 | 1519 | 2022 |
