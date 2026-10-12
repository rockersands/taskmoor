# Field storage spike: 200,000 items, 1500 fields

Generated 2026-10-12 10:31 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads, 64 GB), PostgreSQL 16.14, 5 timed runs per query after warm-up. Latency is measured from the client.

## Query latency (p95 ms, p50 in brackets)

| Query | side |
|---|---:|
| Open one item with all its field values | 0.96 (0.54) |
| Select field = option within a space, newest 50 | 1.02 (0.8) |
| Number field > x across the site, newest 50 | 6.07 (5.03) |
| Date field in a 30-day window and a status category, newest 50 | 1.02 (0.79) |
| Select field = option AND number field > x, newest 50 | 4.15 (3.71) |
| Items in a space sorted by a number field, top 50 | 0.63 (0.53) |
| Count items per option of a select field within a space | 2.37 (0.76) |
| User field = person across the site, newest 50 | 0.73 (0.61) |
| Count items site-wide with number field > x | 5.07 (3.86) |
| Set a number field on one item | 0.93 (0.61) |

## Build time and storage

| Candidate | Load s | Index s | Item table MB | Field storage MB | Total MB |
|---|---:|---:|---:|---:|---:|
| side | 20 | 19 | 204 | 1157 | 1361 |

## Tables

| Candidate | Table | Rows | Data MB | Index MB |
|---|---|---:|---:|---:|
| side | item | 200,000 | 183 | 21 |
| side | v_date | 476,189 | 27 | 55 |
| side | v_number | 648,987 | 37 | 81 |
| side | v_option | 2,933,449 | 183 | 406 |
| side | v_text | 1,264,165 | 89 | 190 |
| side | v_user | 502,134 | 29 | 58 |
