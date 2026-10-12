# ADR-016: Contract-first native API and a separate Jira-compatible shim

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

Every UI action must be reachable through a versioned public API (API-001) with cookie, token
and OAuth authentication (API-002). Scripts written for Jira expect `/rest/api/2`,
`/rest/api/3` and `/rest/agile/1.0` (API-003). The clean-room rules (ADR-003) and counsel's
review ask that compatibility code stays legally separable from the product.

## Decision

- **The OpenAPI 3.1 document is the contract.** Request and response schemas are Zod schemas
  with OpenAPI metadata, validated at runtime on every route; the document is generated from
  them into `docs/api/openapi.json`, committed, and CI fails on an unreviewed diff. Clients
  (CLI, SDK, MCP tools, Builder) are generated from the document, never hand-written.
- **Shape:** `/api/v1/...`; cursor pagination with an optional approximate total (QRY-009);
  `Idempotency-Key` on creates; RFC 9457 problem details; field names from the native
  vocabulary (track, ticket, type) with the legacy names accepted in queries (QRY-003);
  rate limits returned as headers, never as surprise 429s on reads.
- **Versioning:** the backend serves N and N-1 (API-018); breaking changes wait for a major.
  Additive changes do not bump the version.
- **The Jira-compatible shim is its own package** (`packages/api-jira-compat`), built only on
  the public services of the core (never on tables), enabled by a setup toggle (default on for
  imported instances), and removable from the image without touching anything else. It serves
  wiki markup on v2, ADF on v3 and the Agile endpoints; unknown parameters return a Jira-style
  error, never a silent wrong result. A recorded fixture suite of real client traffic is its
  conformance test.

## Options considered

| Option | For | Against |
|---|---|---|
| Contract-first REST with a separate shim (chosen) | Generated clients; reviewable contract; shim can be withdrawn on legal advice | Two API surfaces to keep green |
| Code-first with generated documentation | Less ceremony | Contract drifts with code; clients regenerate on every change |
| GraphQL as the primary API | Flexible reads | Permission-aware cost control is hard; the Jira client base speaks REST |
| Serve Jira's paths natively as the only API | One surface | Freezes Jira's vocabulary and mistakes into the product; legally inseparable |

## Consequences

Each route carries its schemas, so documentation, validation and client code share one source.
The contract snapshot is part of the definition of done; the shim's fixture suite is the test
that counts for compatibility claims.
