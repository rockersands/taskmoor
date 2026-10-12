# Search pre-filter overhead: 200,000 items

Generated 2026-10-12 10:34 UTC, 20 timed runs per query, p95 with `space_id = ANY(allowed)` against the same query without it. Budget: 20% overhead.
Worst case: 154%.

| Query | Allowed share | Unfiltered p95 ms | Filtered p95 ms | Overhead |
|---|---:|---:|---:|---:|
| space-newest | 0.1 | 0.65 | 0.74 | 14% |
| space-newest | 0.5 | 0.65 | 0.73 | 12% |
| space-newest | 0.9 | 0.65 | 0.77 | 18% |
| mine-open | 0.1 | 37.97 | 21.08 | -44% |
| mine-open | 0.5 | 37.97 | 32.25 | -15% |
| mine-open | 0.9 | 37.97 | 35.4 | -7% |
| status-priority-in | 0.1 | 0.83 | 2.11 | 154% |
| status-priority-in | 0.5 | 0.83 | 1.23 | 48% |
| status-priority-in | 0.9 | 0.83 | 1.04 | 25% |
| recent-bugs | 0.1 | 0.61 | 0.73 | 20% |
| recent-bugs | 0.5 | 0.61 | 0.71 | 16% |
| recent-bugs | 0.9 | 0.61 | 0.61 | 0% |
