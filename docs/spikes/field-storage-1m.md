# Field storage spike: 1,000,000 items, 1500 fields

Generated 2026-10-12 08:40 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads, 64 GB), PostgreSQL 16.14, 20 timed runs per query after warm-up. Latency is measured from the client.

## Query latency (p95 ms, p50 in brackets)

| Query | jsonb | side | eav |
|---|---:|---:|---:|
| Open one item with all its field values | 0.86 (0.62) | 0.47 (0.42) | 0.75 (0.62) |
| Select field = option within a space, newest 50 | 17.97 (3.99) | 0.75 (0.46) | 0.71 (0.52) |
| Number field > x across the site, newest 50 | 5.81 (2.69) | 36.29 (17.82) | 53.37 (19.59) |
| Date field in a 30-day window and a status category, newest 50 | 554.89 (385.2) | 11.4 (6.32) | 21.35 (10.01) |
| Select field = option AND number field > x, newest 50 | 5.41 (4.85) | 35.2 (28.47) | 53.71 (41.24) |
| Items in a space sorted by a number field, top 50 | 240.25 (45.92) | 0.59 (0.43) | 3789.61 (3615.2) |
| Count items per option of a select field within a space | 230.89 (134.03) | 6.95 (3.81) | 3766.75 (3631.67) |
| User field = person across the site, newest 50 | 11.38 (2.28) | 0.61 (0.4) | 0.86 (0.48) |
| Count items site-wide with number field > x | 616.17 (579.07) | 21.35 (16.53) | 27.42 (21.42) |
| Set a number field on one item | 0.8 (0.49) | 0.74 (0.53) | 0.5 (0.41) |

## Build time and storage

| Candidate | Load s | Index s | Item table MB | Field storage MB | Total MB |
|---|---:|---:|---:|---:|---:|
| jsonb | 10 | 92 | 1576 | 0 | 1576 |
| side | 149 | 144 | 1019 | 5781 | 6801 |
| eav | 106 | 672 | 373 | 5878 | 6251 |

## Tables

| Candidate | Table | Rows | Data MB | Index MB |
|---|---|---:|---:|---:|
| jsonb | item | 999,932 | 914 | 662 |
| side | item | 1,000,166 | 914 | 105 |
| side | v_date | 2,378,234 | 137 | 276 |
| side | v_number | 3,230,555 | 186 | 403 |
| side | v_option | 14,705,676 | 919 | 2036 |
| side | v_text | 6,281,116 | 444 | 942 |
| side | v_user | 2,526,151 | 145 | 293 |
| eav | item | 999,879 | 268 | 105 |
| eav | value | 29,121,092 | 2282 | 3596 |
