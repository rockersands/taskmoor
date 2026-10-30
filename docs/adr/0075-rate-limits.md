# ADR-075: Rate limits as in-process token buckets, with usage counted per minute

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-066

## Context

API-010 asks for configurable token-bucket limits per token, app, user and address, plus a
per-ticket write limit; 429 with `Retry-After` when a limit is exceeded; a dashboard of the top
20 clients by requests over the last hour and day; and defaults that never throttle one person
under 20 requests a second. Spec 02a section 1.1 adds the `RateLimit-*` headers. ADR-006 keeps
Postgres the only store, and the API runs as several stateless processes behind a balancer
(ADR-023). Sign-in already has its own Postgres-backed lockout (`throttle.ts`), which stays.

## Decision

- **Buckets in each API process's memory** (`ratelimit/limiter.ts`). A bucket holds up to
  `burst` requests and refills `rate` a second. Clients are an API token (each on its own), a
  signed-in person (all their sessions together) and, for requests with neither, the address.
  "App" in API-010 is an API token today: service accounts and OAuth clients (M1-107) act through
  tokens. Writes (POST, PUT, PATCH, DELETE) under `/api/v1/tickets/:id` also take from a bucket
  of that ticket, whoever sends them, so one loop cannot flood a ticket's history and its
  followers. The meta endpoint is exempt; it answers before anyone signs in.
- **The hook runs after authentication**, so a token or a person is limited as itself. Every
  answer carries `RateLimit-Limit` (the burst), `RateLimit-Remaining` and `RateLimit-Reset`
  (seconds until full); a refusal is 429 `rate_limited` with the scope and `Retry-After`.
- **Limits per workspace** in `rate_limit_policy` (migration 0059), defaults until a site
  administrator changes them: tokens and people 50 a second with a burst of 200, addresses 20
  and 100, one ticket's writes 10 and 40. Each process reads them at most every 30 seconds and
  at once after a change through it. `PUT /api/v1/admin/rate-limits` emits
  `rate_limits.updated`, which the audit log records.
- **Usage per client and minute** (`ratelimit/usage.ts`): each process counts requests, errors
  (400 and above) and refusals in memory and adds them to `api_usage` every 10 seconds and when
  it stops. `GET /api/v1/admin/api-usage?window=hour|day` answers the 20 busiest clients with
  names (a token with its owner); the housekeeping loop keeps eight days. The **API usage and
  limits** page under Settings shows both and edits the limits.
- **Opt-in in `buildApp`**: the server turns the limits on; tests that make thousands of
  requests leave them out, and the rate limit tests pass their own clock.

## Options considered

| Option | For | Against |
|---|---|---|
| In-process buckets (chosen) | No write per request; no new store; microseconds | A client may reach the limit once per process; counts restart with a process |
| A Postgres row per bucket, updated per request | Exact across processes | A write on every request, contention on hot clients; more load than the requests it limits |
| Redis or another shared store | Exact and fast | A second store against ADR-006; one more thing to run and back up |

## Consequences

- With N API processes a client may send up to N times its limit; the defaults leave room for
  that, and the page says each process counts on its own. If exact limits across processes are
  needed, buckets can move to Postgres in batches (take a share of the bucket per process) without
  changing the policy table or the headers.
- A restarted process forgets its buckets: a client gets a fresh burst. Acceptable: the limits
  protect the service from runaway clients, not a quota to bill.
- The per-ticket bucket is keyed by the key or id the route was given, so the same ticket by key
  and by id fills two buckets; both are limited.
- Usage lost when a process crashes is at most its last 10 seconds.
