# Taskmoor REST API v1

Taskmoor's REST API is what the web app and your programs use. This guide explains how to
call it. The [reference](reference.md) lists every stable operation, and
[openapi.json](openapi.json) is the OpenAPI 3.1 document both are generated from. The design
behind them is [ADR-067](../adr/0067-rest-api-v1.md).

## Contents

- [Stable and internal](#stable-and-internal)
- [Authentication](#authentication)
- [Requests and answers](#requests-and-answers)
- [Paging](#paging)
- [Errors](#errors)
- [Rich text](#rich-text)
- [The TypeScript SDK](#the-typescript-sdk)
- [AI agents (MCP)](#ai-agents-mcp)
- [Changing the API](#changing-the-api)

## Stable and internal

Every route is under `/api/v1` and appears in the document, but only some are promises:

- **Stable operations** (`x-taskmoor-stability: stable`) keep their meaning for all of v1.
  They may gain operations, optional parameters, response fields and enum values. They do not
  lose an operation, parameter or response field, and they do not start requiring something
  new, until a v2. Each stable operation has an id, such as `getTicket`, that the SDK uses.
- **Internal routes** (`x-taskmoor-stability: internal`) serve the web app's screens. They are
  listed so nothing the server answers is hidden, but they may change in any release. Ask for a
  stable operation if you need one.

## Authentication

- **API tokens** are for programs. A person makes one on their Account page, and an
  administrator makes one for a service account. Send it as `Authorization: Bearer <token>`.
  Each token has scopes:
  - `read` allows GET.
  - `write` allows the other methods.
  - `admin` is needed for administration.
  - `scim` is only for the SCIM service.

  A token never does more than its owner may do.
- **Sessions** are for the browser: `POST /api/v1/session` sets a cookie. Some routes, such
  as managing your own tokens and password, need a session and refuse tokens.

Each operation in the reference says what it needs (`access: read`, `write`, `admin`,
`session` or `public`).

## Requests and answers

- Bodies are JSON (`content-type: application/json`).
- Ids are integers.
- A ticket is named by its id or its key (`PAY-12`), and a track by its id or key.
- Instants are ISO 8601 in UTC (`2026-10-30T09:00:00.000Z`); calendar days are `YYYY-MM-DD`.
- Answers wrap the resource in a field named after it (`{ "ticket": { ... } }`), and lists in a
  plural field (`{ "tickets": [ ... ] }`).
- Objects may gain fields at any time: ignore those you do not know.
- Many resources carry a `version`. Send it back with a change and the server refuses the
  change (409 `version_conflict`) if someone else changed the resource since you read it.

## Paging

A paged operation (marked "paged by cursor" in the reference) works like this:

- It takes `limit` and `cursor`, and answers with `next`.
- To read the following page, send that `next` back as `cursor`. The last page has
  `next: null`.
- Most cursors are opaque strings. Comments and time entries page by id, so their `next` is a
  number.
- Do not build cursors yourself.
- Paging never skips or repeats an item that existed when you started.
- Search answers with a count (`total`) on its first page; above a cap the count is marked
  `exact: false`.

## Errors

A refusal has a status and a body such as `{ "error": "not_found" }`. For bad input the body
also has `fields`, which says what is wrong with each field:

| Status | Meaning |
| --- | --- |
| 400 | The request is not valid (`invalid_fields`, `invalid_query`, ...) |
| 401 | No session or token, or an expired one |
| 403 | The scope or the person's permissions do not allow it |
| 404 | No such resource, or you may not see it (the two look the same on purpose) |
| 409 | A version conflict, or a state that refuses the change |
| 429 | Too many requests; wait as `Retry-After` says |

## Rich text

Descriptions and comments are rich text. With `?format=` you choose how they come back and
how you send them:

- `doc`: the stored document (the default).
- `adf`: the Jira-compatible document format.
- `markdown`: Markdown.

## The TypeScript SDK

`@taskmoor/sdk` (`packages/sdk`) is generated from the document and covers every stable
operation with types:

```ts
import { createClient, TaskmoorError } from '@taskmoor/sdk';

const taskmoor = createClient({ baseUrl: 'https://tracker.example.com', token });
const { ticket } = await taskmoor.call('createTicket', {
  body: { track: 'PAY', summary: 'Accept cards' },
});
for await (const page of taskmoor.pages('listComments', { path: { id: ticket.key } })) {
  console.log(page.comments.length);
}
```

A refusal throws a `TaskmoorError` with `status` and `code`.

## AI agents (MCP)

Agents and assistants that speak the Model Context Protocol connect to `/api/v1/mcp` with an
API token, or through `node cli.mjs mcp` over stdio. Their tools call the stable operations above
as the token's owner, so they never do more than the token may; administrators choose the tool
profile and the allowed clients on the MCP settings page, and every call is in the audit log.
See [ADR-068](../adr/0068-mcp-server.md).

## The site and its versions

`GET /api/meta` needs no sign-in. A client reads it before anything else. It gives:
- the backend and API versions;
- the frontend versions the backend serves (`minimum` and `recommended`);
- how people sign in;
- the site's id (`instance.id`) and Ed25519 public key.

Send `?nonce=` with 16 to 128 base64url characters and the site signs it. The signature
covers the lines `taskmoor-meta-v1`, the site's id and the nonce. `verifyInstance` in
`@taskmoor/webconfig` checks it. A backend of release x.y serves frontends of x.y and x.(y-1).
An older one shows "Update required", and one release behind shows an update notice. See
[ADR-070](../adr/0070-meta-endpoint-and-version-window.md).

At each release:
1. Copy the released `openapi.json` over the baseline, so the next release is checked against
   it.
2. Run the previous release's frontend kit and its core end-to-end tests against the candidate
   backend.

## Changing the API

- The contract is written first, in `apps/server/src/api/operations.ts`.
  - Requests use the same zod schemas the routes validate with.
  - Responses are checked against real answers by `apps/server/src/api/contract.test.ts`, which
    calls every stable operation.
- After a change, run `pnpm verify --update`. It rewrites [openapi.json](openapi.json), this
  [reference](reference.md) and the SDK's generated files. Review their diff.
- The check against [the v1 baseline](baseline/openapi-v1.json) fails if a stable operation
  changes in a way that breaks clients (`apps/server/src/api/diff.ts` lists the rules).
- A breaking change needs a new major version, not an edit to the baseline.
