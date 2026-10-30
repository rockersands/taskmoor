# ADR-082: Load tests with k6 against the real server, and a sizing table computed from them

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-104

## Context

M1-104 asks for load tests at 50, 500 and 2,000 users and a sizing table generated from their
results. NFR-003 asks for 500 concurrent active users with 25% writes under 500 ms p95 for
interactive requests on the reference cluster, and spec 05b section 3 sets p95 targets per
action. The search bench (M1-037) already loads a generated dataset into the product schema.

## Decision

- **k6 drives real HTTP** against the server started as in production (`main.ts`, the API and
  worker roles, rate limits on), on the bench cluster's database with a `pnpm gen` dataset
  loaded by the search bench's loader. k6 is a development tool on the operator's machine
  (AGPL-3.0, never shipped or linked); `pnpm load` checks that it is on the PATH.
- **People, not requests.** Each virtual user is a person with an API token and membership of
  the 40 largest tracks; it ramps up, then repeats a step and rests 5 to 15 seconds: open a
  ticket 40%, search 15%, read a board of about 2,000 cards 10%, read a history 10%, edit 12%,
  comment 10%, create 3%. A quarter of requests write, as NFR-003 says. Per-action trends give
  the p95s compared with the targets.
- **Sizing from measured cost.** During each tier the runner reads the server's and
  PostgreSQL's CPU time (`ps`) and the server's peak memory. CPU seconds per request, times the
  request rate of a tier of people, at 60% use, gives the cores of each; `docs/ops/load-tests.md`
  is generated from `docs/ops/data/load-<label>.json` and never edited by hand.
- **The tools fix what the bench loader skips.** The loader writes with triggers off, so the
  runner fills the track and ticket key histories that lookups by key read.

## Options considered

| Option | For | Against |
|---|---|---|
| k6 against the real server (chosen) | Real HTTP, auth, rate limits, the worker; widely known scenario format | One more tool to install; numbers depend on the machine |
| In-process requests with `app.inject` | No tool; deterministic | Skips the network, the HTTP stack and concurrency between processes |
| Locust or Gatling | Mature | Python or JVM next to a Node repository |

## Consequences

- The numbers are this machine's, with k6, the server and PostgreSQL sharing it: they show
  where time goes and the cost per request, not the reference cluster's capacity. Rerun on the
  target hardware before sizing a production install.
- A board of 5,000 cards and the 10M-ticket dataset are M1-117's runs; this test uses 100,000
  tickets so it fits the development machine.
- PostgreSQL's CPU time is read from the processes alive at the start and the end of a tier,
  so a backend that ends in between takes its time with it; a tier can even read negative.
  The server's figure, the one the sizing leans on, does not have that gap.
- First run (2026-10-30, 100,000 tickets, M3 Pro): every target met at 50 and 500 people; at
  2,000 people (169 requests a second, one API process at about 5 ms of CPU each) only ticket
  creation, at 236 ms, was over its 200 ms target.
- Writes add history, comments and tickets to the bench database; a run starts from whatever
  the last one left, which grows slowly and does not change the shape of the results.
