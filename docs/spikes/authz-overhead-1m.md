# Search pre-filter overhead: 1,000,000 items

Generated 2026-10-12 21:03 UTC, 20 timed runs per query, p95 with `space_id = ANY(allowed)` against the same query without it. Budget: 20% overhead.
Worst case: 274%.

| Query | Allowed share | Unfiltered p95 ms | Filtered p95 ms | Overhead |
|---|---:|---:|---:|---:|
| space-newest | 0.1 | 0.49 | 0.56 | 14% |
| space-newest | 0.5 | 0.49 | 0.85 | 73% |
| space-newest | 0.9 | 0.49 | 0.94 | 92% |
| mine-open | 0.1 | 0.64 | 0.88 | 38% |
| mine-open | 0.5 | 0.64 | 0.89 | 39% |
| mine-open | 0.9 | 0.64 | 1.3 | 103% |
| status-priority-in | 0.1 | 0.74 | 2.77 | 274% |
| status-priority-in | 0.5 | 0.74 | 1.35 | 82% |
| status-priority-in | 0.9 | 0.74 | 1.14 | 54% |
| recent-bugs | 0.1 | 0.64 | 0.89 | 39% |
| recent-bugs | 0.5 | 0.64 | 0.97 | 52% |
| recent-bugs | 0.9 | 0.64 | 0.93 | 45% |
