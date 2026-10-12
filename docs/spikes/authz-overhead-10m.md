# Search pre-filter overhead: 10,000,000 items

Generated 2026-10-12 21:02 UTC, 20 timed runs per query, p95 with `space_id = ANY(allowed)` against the same query without it. Budget: at most 10 ms added.
Most added: 3.54 ms (relative worst case 632%).

| Query | Allowed share | Unfiltered p95 ms | Filtered p95 ms | Overhead |
|---|---:|---:|---:|---:|
| space-newest | 0.1 | 0.56 | 1.3 | 132% |
| space-newest | 0.5 | 0.56 | 2.77 | 395% |
| space-newest | 0.9 | 0.56 | 4.1 | 632% |
| mine-open | 0.1 | 0.67 | 0.91 | 36% |
| mine-open | 0.5 | 0.67 | 2.31 | 245% |
| mine-open | 0.9 | 0.67 | 3.44 | 413% |
| status-priority-in | 0.1 | 0.99 | 2.34 | 136% |
| status-priority-in | 0.5 | 0.99 | 2.73 | 176% |
| status-priority-in | 0.9 | 0.99 | 4.46 | 351% |
| recent-bugs | 0.1 | 0.64 | 1.96 | 206% |
| recent-bugs | 0.5 | 0.64 | 3.05 | 377% |
| recent-bugs | 0.9 | 0.64 | 4.14 | 547% |
