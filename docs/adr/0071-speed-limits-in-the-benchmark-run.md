# ADR-071: Speed limits are measured in the gate and enforced in the benchmark run

- Status: Accepted
- Date: 2026-10-30
- Backlog: none (asked for by the user)

## Context

Many requirements carry a time budget, and their tests asserted it. Examples: a permission
check under 10 ms at p95, a ticket edit with 1,500 fields under 50 ms, a ticket opening from
the local copy under 100 ms, a push arriving within a second.

`pnpm verify` runs about 4,300 tests side by side, often while other worktrees run theirs. On
a loaded laptop a correct change can miss a millisecond budget, and those misses were the gate's
main source of false failures. Each one cost a rerun, and the authz and field-storage tests
already ran up to three rounds to dodge them. The user asked for the speed limits to move out of
the routine gate and into the benchmark check.

Large-scale tests (10k to 1M items) were not part of the problem. They sit behind their own
switches (`TASKMOOR_LARGE_*`) and run when their ticket is built.

## Decision

- A speed limit is written as `expectWithinBudget(measured, budget, what)`:
  - from `@taskmoor/testkit/budget` in Vitest;
  - from `apps/web/e2e/budget.ts` in Playwright;
  - from `apps/web/src/test/budget.ts` in stories.
- **Routine runs measure without failing.** Node tests and e2e append each measurement to
  `.verify/budgets.jsonl`. `pnpm verify` clears that file at the start and ends with a note
  listing the limits this machine missed. Tests that ran several rounds to get under a budget
  run one round.
- **`pnpm bench:check` enforces them.** After checking spike results against their budgets and
  baseline, it runs every test file that holds a speed limit with `TASKMOOR_ENFORCE_BUDGETS=1`,
  which fails on a miss. `--e2e` adds the end-to-end specs; `--no-tests` skips this part. It
  belongs to the nightly job and to a quiet machine before a release.
- **Correctness stays in the gate.** A test keeps its other assertions:
  - "the push arrives" still fails when it never arrives, and only "within a second" waits for
    the benchmark;
  - "the recompute catches up" still has to happen.
  - Waits that were the limit itself (the e2e socket poll) get a longer timeout outside the
    benchmark run.

## Options considered

| Option | For | Against |
|---|---|---|
| Measure in the gate, enforce in the benchmark run (chosen) | The gate fails only on real breakage; budgets keep a home where timing means something | A slowdown shows up a night later, not on the change itself; the gate's note narrows that gap |
| Keep the limits in the gate and retry | Nothing to change | Reruns waste minutes per ticket and still fail under load |
| Loosen every limit tenfold | One run | The budgets in the spec stop meaning anything |
| Delete the timing assertions | Fastest gate | The requirements' budgets lose their only test |

## Consequences

- A new test with a time budget uses the helper, never a bare `toBeLessThan` on a duration.
- Whoever runs a release, or the nightly job when CI is back, runs `pnpm bench:check`. The
  spike baseline and the test budgets are then judged on the same quiet machine.
