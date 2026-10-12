# Field storage spike: 10,000,000 items, 1500 fields

Generated 2026-10-12 21:00 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads, 64 GB), PostgreSQL 16.14, 20 timed runs per query after warm-up. Latency is measured from the client.

## Query latency (p95 ms, p50 in brackets)

| Query | side |
|---|---:|
| Open one item with all its field values | 1.35 (0.98) |
| Select field = option within a space, newest 50 | 6.28 (4.79) |
| Number field > x across the site, newest 50 | 0.93 (0.71) |
| Date field in a 30-day window and a status category, newest 50 | 123.36 (83.31) |
| Select field = option AND number field > x, newest 50 | 95.3 (61.34) |
| Items in a space sorted by a number field, top 50 | 1.71 (0.84) |
| Count items per option of a select field within a space | 7.29 (3.3) |
| User field = person across the site, newest 50 | 2.89 (2.32) |
| Count items site-wide with number field > x | 60.27 (46.29) |
| Set a number field on one item | 1.72 (1.12) |

## Build time and storage

| Candidate | Load s | Index s | Item table MB | Field storage MB | Total MB |
|---|---:|---:|---:|---:|---:|
| side | reused | reused | 11378 | 73337 | 84715 |

## Tables

| Candidate | Table | Rows | Data MB | Index MB |
|---|---|---:|---:|---:|
| side | item | 9,998,325 | 9153 | 2222 |
| side | v_date | 23,798,668 | 1367 | 3888 |
| side | v_number | 32,198,926 | 1850 | 5538 |
| side | v_option | 147,225,104 | 9204 | 28165 |
| side | v_text | 62,711,228 | 4432 | 13292 |
| side | v_user | 25,344,282 | 1456 | 4140 |
