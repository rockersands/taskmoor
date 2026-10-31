---
title: "The REST API"
audience: admins
jira-names: the Jira-compatible API's paths, and the scripts written for Jira that call them
sources: docs/api/README.md, docs/api/openapi.json, apps/server/src/api/operations.ts, apps/server/src/api/openapi.ts, apps/server/src/api/diff.ts, apps/server/src/tokens/scopes.ts, apps/server/src/tickets/rich-text.ts, apps/server/src/routes/meta.ts, packages/sdk/package.json, packages/sdk/src/client.ts, packages/query/src/fields.ts, apps/server/src/webhooks/model.ts, apps/server/src/webhooks/deliver.ts, apps/server/src/webhooks/payload.ts, apps/server/src/webhooks/subscriber.ts, apps/server/src/routes/webhooks.ts, apps/server/src/main.ts, docs/adr/0016-api-contract-and-compat-shim.md, docs/adr/0017-webhooks.md, docs/adr/0055-webhooks.md, docs/adr/0067-rest-api-v1.md, docs/specs/02a-platform-api-and-integrations.md, apps/server/src/routes/properties.ts, apps/server/src/properties/model.ts, docs/adr/0083-entity-properties.md, packages/api-jira-compat/src/shim/issues.ts, packages/api-jira-compat/src/shim/platform.ts, apps/server/src/compat/register.ts, docs/api/jira-compat/matrix.md, docs/adr/0085-jira-compat-contract-suite.md, docs/adr/0086-jira-compat-shim.md, packages/api-jira-compat/src/shim/agile.ts
accessed: 2026-10-31
attestation: own-words
---
# The REST API

Taskmoor's REST API is the one the web app uses, and your programs can use it too. This page
explains how to call it, which parts are promises, and how webhooks send events from Taskmoor
to other systems. Tokens are covered in [API tokens and service accounts](api-tokens.md), and
AI agents in [The MCP server](mcp.md).

## Stable and internal operations

Every route lives under `/api/v1` and is listed in Taskmoor's OpenAPI 3.1 document, but only
some are promises:

- **Stable operations** keep their meaning for all of v1. They may gain operations, optional
  parameters, response fields and enum values. They do not lose an operation, a parameter or
  a response field, and they do not start requiring something new, until a v2. Each has an
  operation id, such as `getTicket`.
- **Internal routes** serve the web app's screens. They are listed so that nothing the server
  answers is hidden, but they may change in any release.

In the document, each operation carries `x-taskmoor-stability` (`stable` or `internal`) and
`x-taskmoor-access`, which says what it needs: `public` (nothing), a token scope (`read`,
`write`, `admin` or `scim`), or `session` (a signed-in browser).

| Area | Stable operations |
|---|---|
| Instance | `getMeta` |
| Session | `signIn`, `getSession`, `signOut` |
| Tracks | `listTracks`, `createTrack`, `getTrack`, `listTrackTicketTypes` |
| Tickets | `listTickets`, `createTicket`, `getTicket`, `updateTicket`, `deleteTicket`, `getTicketHistory`, `rankTicket`, `listTransitions`, `transitionTicket` |
| Comments | `listComments`, `addComment`, `updateComment`, `deleteComment` |
| Links | `listLinkTypes`, `listLinks`, `addLink`, `removeLink` |
| Time | `listTimeEntries`, `logTime` |
| Search | `search`, `searchLong`, `checkQuery`, `listSavedSearches`, `createSavedSearch`, `getSavedSearch` |
| Boards and sprints | `listBoards`, `createBoard`, `getBoard`, `getBacklog`, `getBoardCards`, `listSprints`, `createSprint`, `startSprint`, `completeSprint`, `addSprintTickets` |
| Releases | `listReleases`, `createRelease`, `getRelease` |
| Reference data | `listFields`, `listPriorities`, `listStatuses` |
| Properties | `list…Properties`, `get…Property`, `set…Property`, `delete…Property` for `Ticket`, `Track`, `User`, `Board` and `Sprint`; `listPropertyIndexes`, `createPropertyIndex`, `deletePropertyIndex` |

Apart from property indexes, administration, reports and dashboards have no stable operations
yet. The administration
routes on the pages of this manual (tokens, webhooks, notification policies, the MCP settings)
work today, but they are internal and may change between releases.

## The OpenAPI document

A running server does not serve its OpenAPI document yet. The document is part of Taskmoor's
source code, as `docs/api/openapi.json` of the release you run, with a generated reference of
every stable operation beside it. Take the document from the same release as your server: it
is rewritten whenever the API changes.

## Authentication

- **API tokens** are for programs. Send one as `Authorization: Bearer <token>`. Its scopes
  decide which routes it reaches, and it never does more than its owner may. See
  [API tokens and service accounts](api-tokens.md).
- **Sessions** are for browsers. `POST /api/v1/session` signs in and sets a cookie. Some
  routes, such as managing your own tokens and your password, take only a session.
- `GET /api/meta` and the sign-in routes need neither.

## Requests and answers

- Bodies are JSON, sent with `Content-Type: application/json`.
- Ids are integers. A ticket is named by its id or its key (`PAY-12`), and a track by its id
  or its key (`PAY`).
- Instants are ISO 8601 in UTC (`2026-10-30T09:00:00.000Z`); calendar days are `YYYY-MM-DD`.
- An answer wraps the resource in a field named after it (`{ "ticket": { ... } }`), and a list
  in a plural field (`{ "tickets": [ ... ] }`).
- Objects may gain fields at any time. Ignore the fields you do not know.
- Many resources carry a `version`. Send it back with a change, and the server refuses the
  change with `409 version_conflict` when someone else changed the resource since you read it.

Creating a ticket, for example:

```http
POST /api/v1/tickets HTTP/1.1
Host: tracker.example.com
Authorization: Bearer <token>
Content-Type: application/json

{ "track": "PAY", "summary": "Accept cards" }
```

## Paging

Operations that return long lists page by cursor:

- They take `limit` and `cursor` and answer with `next`. To read the following page, send that
  `next` back as `cursor`. The last page has `next: null`.
- Most cursors are opaque strings. Comments and time entries page by id, so their `next` is a
  number. Do not build cursors yourself.
- Paging never skips or repeats an item that existed when you started.
- Search (`GET /api/v1/search?q=...`) counts its results on the first page as `total`; above a
  cap the count is marked `exact: false`.

## Errors

A refusal has a status and a body such as `{ "error": "not_found" }`. For bad input, the body
also has `fields`, which says what is wrong with each field.

| Status | Meaning |
|---|---|
| 400 | The request is not valid (`invalid_fields`, `invalid_query`, `invalid_request`, ...) |
| 401 | No session or token, or one that expired or was revoked |
| 403 | The token's scope or the person's permissions do not allow it |
| 404 | No such resource, or one you may not see; the two look the same on purpose |
| 409 | A version conflict, or a state that refuses the change |
| 429 | Too many failed attempts, or over a [rate limit](api-tokens.md#throttling-and-rate-limits); wait as `Retry-After` says |

## Rich text

Descriptions and comments are rich text. The `format` query parameter chooses how you send and
receive them:

- `doc`: the stored document, the default;
- `markdown`: Markdown;
- `adf`: the Jira-compatible document format.

For example, `GET /api/v1/tickets/PAY-12?format=markdown` returns the description as Markdown.

## The TypeScript SDK

The source code includes a typed TypeScript client, `@taskmoor/sdk`, generated from the OpenAPI
document. It covers every stable operation. It is not yet published to a package registry:
build it from the source of your release.

- `createClient({ baseUrl, token })` makes a client that sends the token as a bearer token.
- `call(operationId, { path, query, body })` runs one operation, such as `createTicket`, with
  typed input and output.
- `pages(operationId, ...)` walks a paged operation page by page.
- A refusal throws a `TaskmoorError` with the `status` and the `code`.

## Versioning

- The API's major version is in the path: `/api/v1`. A breaking change to a stable operation
  needs a new major version; Taskmoor's own checks refuse one inside v1.
- `GET /api/meta` needs no sign-in and tells a client the backend's version, the API's version
  and base path, the frontend versions the backend serves, how people sign in, and the
  instance's id and public key. Read it before anything else.

## Entity properties

A property is a JSON document that a program keeps under a key of its own on a ticket, a
track, a person, a board or a sprint: a review state, a sync cursor, a build result. People do
not see properties in the app; programs read and write them through the API.

- `GET /api/v1/tickets/PAY-12/properties` lists a ticket's keys, `GET .../properties/<key>`
  reads one, `PUT .../properties/<key>` with `{ "value": ... }` sets it (201 the first time,
  200 after), and `DELETE` removes it. Tracks, boards and sprints work the same way under
  `/api/v1/tracks/<id or key>`, `/api/v1/boards/<id>` and `/api/v1/sprints/<id>`, and people
  under `/api/v1/users/<id>`, or `/api/v1/users/me` for yourself.
- A key is 1 to 255 characters with no control characters; put it in the path
  percent-encoded. A value is any JSON value of at most 32,768 bytes once written as JSON.
- Reading a property needs what seeing its ticket, track, board or sprint needs. Setting or
  deleting one needs what changing it needs: editing the ticket, administering the track,
  configuring the board, managing the board's sprints. A person's properties are only for
  that person and site administrators. In an archived track the properties can be read but
  not changed (`409 track_archived`).
- Each change sends an event, such as `ticket.property_set` or `ticket.property_deleted`,
  that names the key but not the value; webhooks can subscribe to the ticket ones.

**Making a value searchable.** A site or configuration administrator declares a property
index with `POST /api/v1/admin/property-indexes`:

```json
{ "key": "support", "path": "level", "type": "number", "alias": "supportLevel" }
```

`path` names the value inside the property, with dots between names (empty for the whole
value), and `type` is `number`, `string`, `text`, `date` (a `YYYY-MM-DD` day or an ISO 8601
instant) or `user` (a person's id or email address). The index is filled from the properties
already set, and kept up to date from then on. Queries then read
`ticket.property[support].level`, or the alias, as described in
[Search and the query language](../use/search.md). An array along the path gives one value
per element, and a value of another type is left out of the index without failing the write.
`DELETE /api/v1/admin/property-indexes/<id>` drops an index; the properties stay. Only ticket
properties can be indexed.

The Jira-compatible property routes are not available yet.

## Webhooks

A webhook sends Taskmoor's events to another system as they happen. Only site administrators
manage webhooks, through the API; a token needs the `admin` scope. Taskmoor has no page for
webhooks yet.

### Registering a webhook

```http
POST /api/v1/webhooks HTTP/1.1
Host: tracker.example.com
Authorization: Bearer <administrator token>
Content-Type: application/json

{
  "name": "Payments channel",
  "url": "https://hooks.example.com/taskmoor",
  "format": "json",
  "events": ["ticket.*", "comment.created"],
  "filterQuery": "track = PAY AND priority = Urgent",
  "secret": "a-long-random-shared-secret"
}
```

| Field | Meaning |
|---|---|
| `name` | Unique on the instance |
| `url` | Must be HTTPS, without a user name or password in it. Plain HTTP is accepted only for `localhost`, `127.0.0.1` and `[::1]`, or everywhere when the server runs with `TASKMOOR_WEBHOOK_ALLOW_HTTP=true` |
| `format` | `json` (the default), `slack`, `teams`, `mattermost` or `matrix` |
| `events` | Exact event names, or a family such as `ticket.*` |
| `filterQuery` | Optional. A query in [the query language](../use/search.md); it applies only to events about one ticket |
| `secret` | Optional for `json` (16 characters or more), and then used to sign. For `matrix` it is required and is the room's access token |
| `enabled` | `true` by default |

The secret is write-only: answers only say `hasSecret`. Change a webhook with
`PATCH /api/v1/webhooks/<id>` (send its `version`), and remove it with `DELETE`. Webhooks never
expire.

### Events

| Family | Events |
|---|---|
| `ticket.*` | `created`, `updated`, `transitioned`, `moved`, `deleted`, `restored`, `purged`, `linked`, `unlinked`, `web_link_added`, `web_link_updated`, `web_link_removed`, `property_set`, `property_deleted` |
| `comment.*` | `created`, `updated`, `deleted` |
| `attachment.*` | `created`, `deleted` |
| `time_entry.*` | `created`, `updated`, `deleted` |
| `ticket_type.*` | `created`, `updated`, `deleted` |
| `track.*` | `created`, `updated`, `archived`, `restored`, `deleted`, `undeleted` |
| `release.*` | `created`, `updated`, `reordered`, `shipped`, `unshipped`, `merged`, `deleted` |
| `saved_search.*` | `created`, `updated`, `deleted` |
| `user.*` | `created`, `updated`, `deactivated`, `reactivated` |
| `sprint.*` | `created`, `updated`, `started`, `completed`, `deleted`, `tickets_added`, `tickets_removed` |
| `board.*` | `created`, `updated`, `deleted` |
| Settings | `link_policy.updated`, `time_tracking.settings_updated` |

Sign-ins, sessions, tokens, passwords, second factors and other security events never leave
the instance, whatever a webhook asks for.

### Who sees what

The webhook's owner is the administrator who registered it. An event about a ticket is sent
only when the owner may see that ticket, and only when the ticket matches `filterQuery` as the
owner would run it (so `currentUser()` means the owner). A ticket in the trash is judged as it
was; a purged one reaches only webhooks without a query. Events that are not about one ticket
are not filtered. If the query stops working, for example because a field it names was deleted,
Taskmoor records a failed delivery that says so rather than dropping events. A deactivated
owner's webhook sends no ticket events.

### What is sent

A `json` webhook receives a `POST` with a body like this:

```json
{
  "id": "6f1c2d3e-8a9b-4c5d-9e0f-1a2b3c4d5e6f",
  "event": "comment.created",
  "eventId": "90211",
  "occurredAt": "2026-10-30T09:00:00.000Z",
  "webhook": { "id": 3, "name": "Payments channel" },
  "actor": { "id": 17, "name": "Ana Torres" },
  "subject": { "type": "comment", "id": "512" },
  "data": { "commentId": 512, "ticketId": 4120 },
  "ticket": {
    "id": 4120,
    "key": "PAY-12",
    "summary": "Accept cards",
    "status": "Active",
    "type": "Feature",
    "track": { "id": 2, "key": "PAY" },
    "url": "https://tracker.example.com/#/tickets/PAY-12"
  }
}
```

`data` is the event as Taskmoor records it, and `ticket` is there only for an event about a
ticket. The `slack`, `teams`, `mattermost` and `matrix` formats turn the same facts into one
chat message. A Matrix webhook's `url` is the room's send address, for example
`https://matrix.example.org/_matrix/client/v3/rooms/<room>/send/m.room.message`; Taskmoor adds
the delivery id to it and sends a `PUT`.

Every request carries these headers:

| Header | Value |
|---|---|
| `X-Taskmoor-Event` | The event name, such as `ticket.created` |
| `X-Taskmoor-Delivery` | The delivery id, also the body's `id`. Use it to drop repeats: a replay keeps it |
| `X-Taskmoor-Webhook` | The webhook's id |
| `X-Taskmoor-Signature` | `sha256=` and the hex HMAC-SHA256 of the body's exact bytes, keyed with the secret (`json` with a secret only) |
| `User-Agent` | `Taskmoor-Webhook/1` |

To verify a delivery, compute the HMAC over the raw body before parsing it, and compare it with
the header in constant time. From a shell, with the body saved to a file:

```bash
openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" body.json
```

The hex digest it prints must equal the part of the header after `sha256=`.

### Retries and replay

- A `2xx` answer delivers. Redirects are not followed.
- An answer of `408`, `409`, `425`, `429` or `5xx`, a network error, or no answer within 10
  seconds is retried after 2, 4, 8, 16 and 32 seconds: six attempts in all. Any other answer
  fails at once. `Retry-After` is not read yet.
- Webhooks are sent by the server's worker role.
- `GET /api/v1/webhooks/<id>/deliveries?state=failed` lists deliveries, newest first, with the
  attempts, the last status and the last error.
- `POST /api/v1/webhooks/<id>/deliveries/replay` sends deliveries again with the same id and
  body, either `{ "deliveryIds": [ ... ] }` or `{ "failed": true }` (up to 1,000 at a time).
- Delivered deliveries are kept for 30 days. Failed ones stay until they are replayed or the
  webhook is deleted.

Creating, changing, deleting and replaying webhooks are audit events.

## The Jira-compatible API

Scripts and tools written for Jira's REST API can work with Taskmoor through its Jira-compatible
API, under `/rest/api/2` and `/rest/api/3` on your server's address. Point a script at your
Taskmoor address instead of the Jira one.

**Signing in.** Use an API token (see [API tokens and service accounts](api-tokens.md)):

- as a bearer token: `Authorization: Bearer <token>`; or
- with Basic, as most Jira scripts do: your email address as the user name and the token as
  the password. The email must be the token owner's.

Passwords are not accepted, so a script cannot get past second factors. Browser sessions are not
accepted either, so another site cannot use your session. The token's scopes apply: a `read`
token can search and read but not change anything.

**What works:**

- **Issues:** create, read, edit (with `fields` and `update`), delete; transitions;
  the change history; comments; worklogs; watchers; votes; remote links (with `globalId`);
  issue properties; linking issues.
- **Search:** `/search/jql` with `nextPageToken`, and the older `/search` with `startAt`,
  `maxResults` and `total`. Queries use the Jira-compatible names, as in
  [Search and the query language](../use/search.md).
- **Bulk:**
  - creating and reading many issues;
  - bulk transitions and deletes, run as background tasks that `/bulk/queue/<id>` reports on;
  - bulk label changes that replace the labels.
- **Projects** (Taskmoor's tracks), their components (areas), versions (releases) and roles.
  Also fields, issue types, priorities, resolutions (close reasons), statuses and link types;
  filters (saved searches) and dashboards; the current user, user search, groups and
  permissions; server information.
- **Webhooks:** registering and listing them under `/rest/webhooks/1.0/webhook`, with the
  Jira-compatible event names.
- **The Agile API** under `/rest/agile/1.0`:
  - boards, with their configuration, issues and backlog;
  - sprints: created, read, renamed and given dates; started by setting `state` to `active`,
    completed with `closed` (open issues go to the backlog);
  - issues moved into a sprint or back to the backlog;
  - ranking issues before or after another.

Everything runs as the person the token belongs to, through Taskmoor's own API, so their
permissions, field rules, history and notifications apply as in the app.

**Not yet:**

- attachments;
- bulk label changes that add or remove labels issue by issue (they answer an error);
- wiki markup on version 2. Version 2 carries Markdown for now; plain text reads the same.

`docs/api/jira-compat/matrix.md` in the source of your release lists every operation and its
state. Administrators can switch the compatible API off with `TASKMOOR_JIRA_COMPAT=off` (see
[Configuration](configuration.md)).
