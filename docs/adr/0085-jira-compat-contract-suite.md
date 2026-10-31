# ADR-085: The Jira-compatible API's contract as our own operations and synthetic cases, with a generated matrix

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-068

## Context

The Jira-compatible API (API-003 to API-007, spec 02a section 1.2) keeps scripts and tools
written for Jira working. ADR-016 put it in its own package and named "a recorded fixture suite
of real client traffic" as its conformance test. API-014 asks for a matrix of each endpoint's
state, generated from test results and never edited by hand.

The clean-room rules (ADR-003) forbid two things:
- copying Atlassian's documentation text or files;
- signing in to or using an Atlassian product to build or test.

Recording traffic against a real Jira is therefore out. What we may use is what public pages
say an operation does, restated in our own words with a link to the page.

## Decision

- **A package of its own,** `packages/api-jira-compat`, holding three things:
  - `operations.ts`: 72 operations across the nine M1 families (issues, search, bulk, projects,
    configuration, filters and dashboards, users, webhooks, agile). Each one has:
    - its method and path, on version 2, version 3 or once;
    - a summary and description in our own words;
    - `sources`: the public pages it was learnt from (developer pages, the Data Center REST
      reference, the knowledge base; a test checks the domains);
    - `verify`: what those pages left open;
    - the request and response bodies as loose zod schemas, naming only the fields scripts rely
      on. Rich text is wiki markup on v2 and the document format on v3.
  - `cases.ts`: synthetic cases in the order a script would work. The suite:
    - learns who the caller is;
    - creates its own issues;
    - edits, transitions, comments, logs time, watches, links and sets properties;
    - searches by token and by offset;
    - runs bulk operations;
    - reads projects and configuration;
    - saves a filter and registers a webhook;
    - plans a sprint on a board;
    - deletes an issue.

    Each case runs on every version its operation has. Later cases use what earlier ones
    captured; a case whose inputs are missing is skipped, not failed.
  - `runner.ts`: runs the cases against any target, and checks each answer's status, its body
    against the schema (a refusal must be a Jira-compatible error) and the case's own check. It
    gives each operation a state:
    - `complete`: every case passed;
    - `partial`: some passed;
    - `failing`: none passed, but the server answers;
    - `missing`: answers are 404, 405 or 501 without a Jira-compatible error body;
    - `untested`: every case was skipped.
- **Generated outputs:**
  - `docs/api/jira-compat/openapi.json`: our own OpenAPI document of the compatible API, with
    `x-sources` and `x-verify` per operation.
  - `docs/api/jira-compat/matrix.md`: the API-014 matrix, written by
    `apps/server/src/compat/conformance.test.ts` from a run against this repository's server.
  - Both are goldens; a change shows in review.
- **A command:** `pnpm conformance compat --url=... --project=...` (the token from
  `TASKMOOR_TOKEN`) runs the suite against a running Taskmoor and prints the states. It refuses
  Atlassian hosts.
- **This amends ADR-016:** the conformance test is this suite of written cases, not recorded
  Jira traffic.
  - Recordings may join later, but only of scripts run against Taskmoor, such as the design
    partners' scripts in the beta (M1-119). They then become cases like the others.
  - API-003 (1) asks for at least 500 request and response pairs. Its count is of planned
    runs: about 160 today. It grows with M1-069 and M1-070 as each operation gets the cases its
    shim needs.

## Options considered

| Option | For | Against |
|---|---|---|
| Written operations and synthetic cases with sources (chosen) | Clean room by construction; runs anywhere; states per operation; grows with the shim | Shapes are as good as the public pages; `verify` marks the doubts until scripts confirm them |
| Record traffic from a real Jira | Exact shapes | Forbidden by ADR-003 |
| Take Atlassian's published OpenAPI file | Complete | Copying their document; forbidden by ADR-003 |
| Only test the shim from inside its own code | Simple | No runnable suite to report per endpoint or to run against an install |

## Consequences

- Today the matrix reads 31 operations missing and 41 untested, since nothing is served yet.
  M1-069 (core API), M1-070 (agile) and M1-071 (rich text) turn them complete, one by one.
- Every new compatible route comes with its cases here first: the suite says what "done"
  means for it.
- A wrong guess in a shape is caught when a design partner's script disagrees. Its `verify`
  note says where to look.
