# Taskmoor API v1.0.0 reference

Generated from [openapi.json](openapi.json) by `apps/server/src/api/reference.ts`; do not edit
it by hand. How to authenticate, page, read errors and what "stable" promises are in the
[API guide](README.md).

## Contents

- [Boards](#boards)
- [Bulk changes](#bulk-changes)
- [Comments](#comments)
- [Instance](#instance)
- [Links](#links)
- [Reference](#reference)
- [Releases](#releases)
- [Search](#search)
- [Session](#session)
- [Tickets](#tickets)
- [Time](#time)
- [Tracks](#tracks)
- [Schemas](#schemas)
- [Internal routes](#internal-routes)

## Boards

### The boards the caller may see

`GET /api/v1/boards`, operation `listBoards`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `trackId` | query | integer | no |  |

Responses:

- 200: The boards, by name. Body: `boards` (array of [BoardSummary](#schema-boardsummary)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).

### Make a board from a query

`POST /api/v1/boards`, operation `createBoard`, access: write.

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `description` | string | no |  |
| `kind` | `"scrum"`, `"kanban"` | yes |  |
| `trackId` | integer or null | no |  |
| `source` | object or object | yes |  |
| `subFilter` | object or null | no |  |
| `columns` | array of object | no |  |
| `swimlanes` | object | no |  |
| `boardFilters` | array of object | no |  |
| `boardFilterDisplay` | `"buttons"`, `"dropdown"` | no |  |
| `cardRules` | object | no |  |
| `sprintSettings` | object | no |  |
| `adminIds` | array of integer | no |  |

Responses:

- 201: The new board. Body: `board` ([Board](#schema-board)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 409: The resource changed or is in a state that refuses this; read it again.

### Read a board’s configuration

`GET /api/v1/boards/{id}`, operation `getBoard`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The board’s id. |

Responses:

- 200: The board and the statuses its columns may take. Body: `board` ([Board](#schema-board)), `statuses` (array of object).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### A Scrum board’s open sprints and backlog

`GET /api/v1/boards/{id}/backlog`, operation `getBacklog`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The board’s id. |
| `limit` | query | integer | no |  |

Responses:

- 200: Sprint sections, then the backlog, in rank order with totals. Body: [Backlog](#schema-backlog).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### A board’s columns, lanes and cards

`GET /api/v1/boards/{id}/data`, operation `getBoardCards`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The board’s id. |
| `filters` | query | string | no |  |
| `limit` | query | integer | no |  |
| `sprints` | query | string | no |  |

Responses:

- 200: The cards the caller may see, in rank order. Body: [BoardData](#schema-boarddata).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### A Scrum board’s sprints

`GET /api/v1/boards/{id}/sprints`, operation `listSprints`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The board’s id. |
| `state` | query | `"future"`, `"active"`, `"closed"` | no |  |

Responses:

- 200: Its sprints in order. Body: `sprints` (array of [Sprint](#schema-sprint)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### Plan a sprint

`POST /api/v1/boards/{id}/sprints`, operation `createSprint`, access: write.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The board’s id. |

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | no |  |
| `goal` | string | no |  |
| `startAt` | string or null | no |  |
| `endAt` | string or null | no |  |

Responses:

- 201: The new future sprint. Body: `sprint` ([Sprint](#schema-sprint)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

### Complete a sprint

`POST /api/v1/sprints/{id}/complete`, operation `completeSprint`, access: write.

Its unfinished tickets go to the backlog, a future sprint or a new one.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The sprint’s id. |

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `moveTo` | any | yes |  |

Responses:

- 200: The closed sprint and where its tickets went. Body: `sprint` ([Sprint](#schema-sprint)), `completed` (integer), `carriedOver` (integer).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

### Start a sprint

`POST /api/v1/sprints/{id}/start`, operation `startSprint`, access: write.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The sprint’s id. |

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | no |  |
| `goal` | string | no |  |
| `startAt` | string | no |  |
| `endAt` | string | no |  |

Responses:

- 200: The active sprint. Body: `sprint` ([Sprint](#schema-sprint)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

### Move tickets into a sprint

`POST /api/v1/sprints/{id}/tickets`, operation `addSprintTickets`, access: write.

From the backlog or another open sprint, in one operation.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The sprint’s id. |

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `tickets` | array of integer or string | yes |  |

Responses:

- 200: How many were added, and whether after its start. Body: `added` (integer), `afterStart` (boolean).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

## Bulk changes

### The caller’s latest bulk changes

`GET /api/v1/bulk-operations`, operation `listBulkOperations`, access: read.

Responses:

- 200: The 50 most recent, newest first. Body: `bulkOperations` (array of [BulkOperation](#schema-bulkoperation)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).

### Start a bulk change

`POST /api/v1/bulk-operations`, operation `createBulkOperation`, access: write.

Transitions, moves, edits or deletes many tickets as one task, given as ids or keys or as a query whose results are the tickets. Each ticket goes through the same checks as a change of its own. The workspace limits how many tickets one operation may change (10,000 by default, the `tickets_per_bulk_operation` guardrail).

Body:

A any.

Responses:

- 202: Started; poll the operation for its progress. Body: `bulkOperation` ([BulkOperation](#schema-bulkoperation)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 409: The resource changed or is in a state that refuses this; read it again.

### A bulk change’s progress

`GET /api/v1/bulk-operations/{id}`, operation `getBulkOperation`, access: read.

Readable for 14 days after it finishes.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The bulk operation. |

Responses:

- 200: The operation. Body: `bulkOperation` ([BulkOperation](#schema-bulkoperation)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### Cancel the rest of a bulk change

`POST /api/v1/bulk-operations/{id}/cancel`, operation `cancelBulkOperation`, access: write.

Tickets already in hand finish; the ones not reached are skipped.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The bulk operation. |

Responses:

- 202: Cancelling. Body: `bulkOperation` ([BulkOperation](#schema-bulkoperation)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

### Each ticket’s result in a bulk change

`GET /api/v1/bulk-operations/{id}/items`, operation `listBulkItems`, access: read.

In the order the tickets were given, a page at a time: pass the answer’s `next` as `after`. Filter by `outcome` to read only the failures, say.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The bulk operation. |
| `outcome` | query | `"done"`, `"failed"`, `"skipped"`, `"pending"` | no |  |
| `after` | query | integer | no |  |
| `limit` | query | integer | no |  |

Responses:

- 200: A page of results. Body: `items` (array of [BulkItem](#schema-bulkitem)), `next` (integer or null).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

## Comments

### A ticket’s comments, a page at a time

`GET /api/v1/tickets/{id}/comments`, operation `listComments`, access: read, paged by cursor.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |
| `cursor` | query | integer | no |  |
| `limit` | query | integer | no |  |
| `order` | query | `"asc"`, `"desc"` | no |  |
| `format` | query | string | no |  |

Responses:

- 200: A page of the comments the caller may see. Body: `comments` (array of [Comment](#schema-comment)), `next` (integer or null).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### Comment on a ticket

`POST /api/v1/tickets/{id}/comments`, operation `addComment`, access: write.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |
| `format` | query | `"doc"`, `"adf"`, `"markdown"` | no | The rich-text format of bodies, in and out; the stored document by default. |

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `body` | any | yes |  |
| `visibility` | object or object or null | no |  |

Responses:

- 201: The new comment. Body: `comment` ([Comment](#schema-comment)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

### Delete a comment

`DELETE /api/v1/tickets/{id}/comments/{commentId}`, operation `deleteComment`, access: write.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |
| `commentId` | path | string | yes | The comment’s id. |

Responses:

- 204: Deleted.
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

### Change a comment

`PATCH /api/v1/tickets/{id}/comments/{commentId}`, operation `updateComment`, access: write.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |
| `commentId` | path | string | yes | The comment’s id. |
| `format` | query | `"doc"`, `"adf"`, `"markdown"` | no | The rich-text format of bodies, in and out; the stored document by default. |

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `body` | any | no |  |
| `visibility` | object or object or null | no |  |

Responses:

- 200: The comment as it is now. Body: `comment` ([Comment](#schema-comment)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

## Instance

### What this instance is and which clients it works with

`GET /api/meta`, operation `getMeta`, access: public.

Needs no sign-in and holds no secret: the backend and API versions, the frontend versions it serves, how people sign in, and the instance’s id and public key. With a nonce, the instance signs it, so a client can check it reached the instance it expects.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `nonce` | query | string | no | 16 to 128 base64url characters the instance signs, chosen afresh by the caller. |

Responses:

- 200: The instance. Body: [Meta](#schema-meta).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 403: The session or token may not do this (its scope, or the person’s permissions).

## Links

### The kinds of link between tickets

`GET /api/v1/link-types`, operation `listLinkTypes`, access: read.

Responses:

- 200: The link types, and whether linking is on. Body: `enabled` (boolean), `linkTypes` (array of [LinkType](#schema-linktype)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).

### A ticket’s links

`GET /api/v1/tickets/{id}/links`, operation `listLinks`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |

Responses:

- 200: Its links to the tickets the caller may see. Body: `links` (array of [Link](#schema-link)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### Link a ticket to another

`POST /api/v1/tickets/{id}/links`, operation `addLink`, access: write.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `linkTypeId` | integer | yes |  |
| `ticket` | integer or string | yes |  |
| `direction` | `"outward"`, `"inward"` | no |  |

Responses:

- 201: The new link. Body: `link` ([Link](#schema-link)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

### Remove a link

`DELETE /api/v1/tickets/{id}/links/{linkId}`, operation `removeLink`, access: write.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |
| `linkId` | path | string | yes | The link’s id. |

Responses:

- 204: Removed.
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

## Reference

### The custom fields the caller may see

`GET /api/v1/fields`, operation `listFields`, access: read.

Responses:

- 200: The fields. Body: `fields` (array of [Field](#schema-field)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).

### The priorities, in order

`GET /api/v1/priorities`, operation `listPriorities`, access: read.

Responses:

- 200: The priorities. Body: `priorities` (array of [Priority](#schema-priority)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).

### The statuses, in order

`GET /api/v1/statuses`, operation `listStatuses`, access: read.

Responses:

- 200: The statuses with their stages. Body: `statuses` (array of [Status](#schema-status)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).

## Releases

### Read a release

`GET /api/v1/releases/{id}`, operation `getRelease`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The release’s id. |

Responses:

- 200: The release with its approvers. Body: `release` ([Release](#schema-release)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### A track’s releases, in its order

`GET /api/v1/tracks/{id}/releases`, operation `listReleases`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The track’s id. |
| `archived` | query | `"exclude"`, `"include"`, `"only"` | no |  |

Responses:

- 200: Its releases with their progress. Body: `releases` (array of [Release](#schema-release)), `mayManage` (boolean).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### Add a release to a track

`POST /api/v1/tracks/{id}/releases`, operation `createRelease`, access: write.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The track’s id. |

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `description` | string | no |  |
| `startDate` | string or null | no |  |
| `releaseDate` | string or null | no |  |
| `requireApprovals` | boolean | no |  |

Responses:

- 201: The new release. Body: `release` ([Release](#schema-release)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

## Search

### The saved searches the caller owns or that are shared with them

`GET /api/v1/saved-searches`, operation `listSavedSearches`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `filter` | query | `"visible"`, `"mine"`, `"starred"` | no |  |
| `q` | query | string | no |  |

Responses:

- 200: The saved searches. Body: `savedSearches` (array of [SavedSearch](#schema-savedsearch)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).

### Save a search

`POST /api/v1/saved-searches`, operation `createSavedSearch`, access: write.

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `description` | string | no |  |
| `query` | string | yes |  |
| `columns` | array of string or null | no |  |
| `shares` | array of any | no |  |

Responses:

- 201: The saved search. Body: `savedSearch` ([SavedSearch](#schema-savedsearch)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 409: The resource changed or is in a state that refuses this; read it again.

### Read a saved search

`GET /api/v1/saved-searches/{id}`, operation `getSavedSearch`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The saved search’s id. |

Responses:

- 200: The saved search. Body: `savedSearch` ([SavedSearch](#schema-savedsearch)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### Run a query, a page at a time

`GET /api/v1/search`, operation `search`, access: read, paged by cursor.

The query language of the search page. Pages follow `next`; the first page carries a count unless asked not to: exact up to 10,000, then an estimate within 10% (`approximate`) or a lower bound.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `q` | query | string | no |  |
| `limit` | query | integer | no |  |
| `cursor` | query | string | no |  |
| `fields` | query | string or array of string | no |  |
| `count` | query | boolean or `"true"`, `"false"` | no |  |
| `archived` | query | boolean or `"true"`, `"false"` | no |  |

Responses:

- 200: A page of the tickets the query finds, as the caller may see them. Body: `tickets` (array of [SearchTicket](#schema-searchticket)), `next` (string or null), `total` ([SearchTotal](#schema-searchtotal)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).

### Run a query too long for a URL

`POST /api/v1/search`, operation `searchLong`, access: read, paged by cursor.

The same as `GET /api/v1/search`, with the parameters in the body. It changes nothing.

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `q` | string | no |  |
| `limit` | integer | no |  |
| `cursor` | string | no |  |
| `fields` | string or array of string | no |  |
| `count` | boolean or `"true"`, `"false"` | no |  |
| `archived` | boolean or `"true"`, `"false"` | no |  |

Responses:

- 200: A page of tickets. Body: `tickets` (array of [SearchTicket](#schema-searchticket)), `next` (string or null), `total` ([SearchTotal](#schema-searchtotal)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 409: The resource changed or is in a state that refuses this; read it again.

### Check a query without running it

`GET /api/v1/search/check`, operation `checkQuery`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `q` | query | string | yes |  |

Responses:

- 200: Valid, with the fields it names; or where it goes wrong. Body: [QueryCheck](#schema-querycheck).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).

## Session

### Sign out

`DELETE /api/v1/session`, operation `signOut`, access: session.

Responses:

- 204: The session is over.
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 409: The resource changed or is in a state that refuses this; read it again.

### Who is calling

`GET /api/v1/session`, operation `getSession`, access: read.

The signed-in person, and for a token its id and scopes.

Responses:

- 200: The caller. Body: `user` ([SignedInUser](#schema-signedinuser)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).

### Sign in with an email and a password

`POST /api/v1/session`, operation `signIn`, access: public.

Starts a browser session (a cookie). Programs use API tokens instead; a second factor, when required, is asked for by the answer.

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `email` | string | yes |  |
| `password` | string | yes |  |

Responses:

- 200: Signed in, or a second factor is needed. Body: `status` (string), `user` ([SignedInUser](#schema-signedinuser)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 409: The resource changed or is in a state that refuses this; read it again.

## Tickets

### List tickets, a page at a time

`GET /api/v1/tickets`, operation `listTickets`, access: read, paged by cursor.

For queries, use search; this lists a track’s tickets by rank.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `format` | query | `"doc"`, `"adf"`, `"markdown"` | no |  |
| `track` | query | string | no |  |
| `parent` | query | string | no |  |
| `cursor` | query | string | no |  |
| `after` | query | string | no |  |
| `limit` | query | integer | no |  |

Responses:

- 200: A page of tickets. Body: `tickets` (array of [Ticket](#schema-ticket)), `next` (string or null).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).

### Make a ticket

`POST /api/v1/tickets`, operation `createTicket`, access: write.

In a track the caller may create tickets in; the track’s field rules apply.

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `track` | integer or string | yes |  |
| `ticketTypeId` | integer | no |  |
| `summary` | string | no |  |
| `description` | any | no |  |
| `environment` | any | no |  |
| `parent` | integer or string or null | no |  |
| `assigneeId` | integer or null | no |  |
| `requesterId` | integer | no |  |
| `startDate` | string or null | no |  |
| `dueDate` | string or null | no |  |
| `priorityId` | integer or null | no |  |
| `closeReasonId` | integer or null | no |  |
| `labels` | array of string | no |  |
| `targetReleaseIds` | array of integer | no |  |
| `foundInReleaseIds` | array of integer | no |  |
| `areaIds` | array of integer | no |  |
| `originalEstimate` | string or number or null | no |  |
| `remainingEstimate` | string or number or null | no |  |
| `fields` | object | no |  |
| `visibilityLevelId` | integer or null | no |  |

Responses:

- 201: The new ticket. Body: `ticket` ([Ticket](#schema-ticket)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 409: The resource changed or is in a state that refuses this; read it again.

### Move a ticket to the trash

`DELETE /api/v1/tickets/{id}`, operation `deleteTicket`, access: write.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |

Responses:

- 204: In the trash; it can be restored until it is purged.
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

### Read a ticket

`GET /api/v1/tickets/{id}`, operation `getTicket`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |
| `format` | query | `"doc"`, `"adf"`, `"markdown"` | no | The rich-text format of bodies, in and out; the stored document by default. |

Responses:

- 200: The ticket. Body: `ticket` ([Ticket](#schema-ticket)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### Change a ticket’s fields

`PATCH /api/v1/tickets/{id}`, operation `updateTicket`, access: write.

Only the fields given change. Send `version` to be refused (409) if someone changed it since you read it.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ticketTypeId` | integer | no |  |
| `summary` | string | no |  |
| `description` | any | no |  |
| `environment` | any | no |  |
| `parent` | integer or string or null | no |  |
| `assigneeId` | integer or null | no |  |
| `requesterId` | integer | no |  |
| `startDate` | string or null | no |  |
| `dueDate` | string or null | no |  |
| `priorityId` | integer or null | no |  |
| `closeReasonId` | integer or null | no |  |
| `labels` | array of string | no |  |
| `targetReleaseIds` | array of integer | no |  |
| `foundInReleaseIds` | array of integer | no |  |
| `areaIds` | array of integer | no |  |
| `originalEstimate` | string or number or null | no |  |
| `remainingEstimate` | string or number or null | no |  |
| `fields` | object | no |  |
| `visibilityLevelId` | integer or null | no |  |
| `statusId` | integer | no |  |
| `version` | integer | no |  |

Responses:

- 200: The ticket as it is now. Body: `ticket` ([Ticket](#schema-ticket)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

### A ticket’s changes, a page at a time

`GET /api/v1/tickets/{id}/history`, operation `getTicketHistory`, access: read, paged by cursor.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |
| `order` | query | `"desc"`, `"asc"` | no |  |
| `cursor` | query | string | no |  |
| `limit` | query | integer | no |  |

Responses:

- 200: A page of changes. Body: `changes` (array of [Change](#schema-change)), `next` (string or null).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### A ticket’s read-only info: first response, participants, time in status

`GET /api/v1/tickets/{id}/info`, operation `getTicketInfo`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |

Responses:

- 200: The info fields. Body: `info` ([TicketInfo](#schema-ticketinfo)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### Rank a ticket before or after another, or at an end

`PUT /api/v1/tickets/{id}/rank`, operation `rankTicket`, access: write.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `before` | integer or string | no |  |
| `after` | integer or string | no |  |
| `position` | `"top"`, `"bottom"` | no |  |

Responses:

- 200: The ticket with its new rank. Body: `ticket` ([Ticket](#schema-ticket)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

### The transitions a ticket may take now

`GET /api/v1/tickets/{id}/transitions`, operation `listTransitions`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |

Responses:

- 200: Its transitions. Body: `transitions` (array of [Transition](#schema-transition)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### Move a ticket through a transition

`POST /api/v1/tickets/{id}/transitions`, operation `transitionTicket`, access: write.

With the values its form asks for, such as a close reason.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `transitionId` | integer | yes |  |
| `fields` | object | no |  |
| `comment` | any | no |  |
| `commentVisibility` | object or object or null | no |  |
| `version` | integer | no |  |

Responses:

- 200: The ticket in its new status. Body: `ticket` ([Ticket](#schema-ticket)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

## Time

### Time logged on a ticket, a page at a time

`GET /api/v1/tickets/{id}/time-entries`, operation `listTimeEntries`, access: read, paged by cursor.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |
| `cursor` | query | integer | no |  |
| `limit` | query | integer | no |  |

Responses:

- 200: A page of time entries. Body: `timeEntries` (array of [TimeEntry](#schema-timeentry)), `next` (integer or null).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### Log time on a ticket

`POST /api/v1/tickets/{id}/time-entries`, operation `logTime`, access: write.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The ticket: its id or its key, such as `PAY-12`. |

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `duration` | string or number | yes |  |
| `startedAt` | string | no |  |
| `description` | string | no |  |
| `visibility` | object or object or null | no |  |
| `remainingEstimate` | any | no |  |

Responses:

- 201: The new time entry. Body: `timeEntry` ([TimeEntry](#schema-timeentry)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.
- 409: The resource changed or is in a state that refuses this; read it again.

## Tracks

### List the tracks the caller may browse

`GET /api/v1/tracks`, operation `listTracks`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `archived` | query | `"exclude"`, `"include"`, `"only"` | no |  |
| `categoryId` | query | integer | no |  |
| `type` | query | `"software"`, `"business"`, `"service"`, `"discovery"` | no |  |
| `mode` | query | `"shared"`, `"local"` | no |  |
| `q` | query | string | no |  |
| `after` | query | string | no |  |
| `limit` | query | integer | no |  |

Responses:

- 200: The tracks, by key. Body: `tracks` (array of [Track](#schema-track)), `next` (string or null).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).

### Make a track

`POST /api/v1/tracks`, operation `createTrack`, access: write.

Shared-mode tracks need a site or configuration administrator. A `template` adds its type, features and first board; `copyFrom` takes another shared track’s configuration.

Body:

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `key` | string | yes |  |
| `mode` | `"shared"`, `"local"` | yes |  |
| `name` | string | yes |  |
| `description` | string | no |  |
| `type` | `"software"`, `"business"`, `"service"`, `"discovery"` | no |  |
| `ownerId` | integer | no |  |
| `categoryId` | integer or null | no |  |
| `icon` | string or null | no |  |
| `color` | string or null | no |  |
| `accessPolicyId` | integer | no |  |
| `typeSetId` | integer | no |  |
| `features` | object | no |  |
| `template` | `"scrum"`, `"kanban"`, `"bug-tracking"`, `"business"`, `"blank"` | no |  |
| `copyFrom` | integer | no |  |

Responses:

- 201: The new track, and the board a template made. Body: `track` ([Track](#schema-track)), `board` ([BoardSummary](#schema-boardsummary)).
- 400: The request is not valid: see `error` and, for fields, `fields`.
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 409: The resource changed or is in a state that refuses this; read it again.

### Read a track

`GET /api/v1/tracks/{id}`, operation `getTrack`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The track: its id or its key. |

Responses:

- 200: The track. Body: `track` ([Track](#schema-track)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

### The ticket types a track offers

`GET /api/v1/tracks/{id}/ticket-types`, operation `listTrackTicketTypes`, access: read.

| Parameter | In | Type | Required | Meaning |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes | The track: its id or its key. |

Responses:

- 200: Its types in set order, and the one new tickets take by default. Body: `defaultTypeId` (integer or null), `ticketTypes` (array of [TicketType](#schema-tickettype)).
- 401: No session or token, or an expired one.
- 403: The session or token may not do this (its scope, or the person’s permissions).
- 404: There is no such resource, or the caller may not see it.

## Schemas

### Schema: Backlog

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `sprints` | array of object | yes |  |
| `backlog` | object | yes |  |
| `truncated` | boolean | yes |  |

### Schema: Board

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `name` | string | yes |  |
| `description` | string | yes |  |
| `kind` | `"scrum"`, `"kanban"` | yes |  |
| `location` | object or object | yes | Where the board lives: a track, or a person’s own space. |
| `columns` | array of object | yes |  |
| `version` | integer | yes |  |

### Schema: BoardData

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `columns` | array of object | yes |  |
| `lanes` | array of object | yes |  |
| `cards` | array of object | yes |  |
| `truncated` | boolean | yes |  |

### Schema: BoardSummary

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `name` | string | yes |  |
| `description` | string | yes |  |
| `kind` | `"scrum"`, `"kanban"` | yes |  |
| `location` | object or object | yes | Where the board lives: a track, or a person’s own space. |

### Schema: BulkItem

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `position` | integer | yes |  |
| `ref` | string | yes | The ticket as it was given: an id or a key. |
| `key` | string or null | yes | The ticket key, when the reader may see the ticket now. |
| `outcome` | `"done"`, `"failed"`, `"skipped"`, `"pending"` | yes |  |
| `statusCode` | integer or null | yes |  |
| `error` | any | yes |  |

### Schema: BulkOperation

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `action` | `"edit"`, `"move"`, `"transition"`, `"delete"` | yes |  |
| `params` | any | yes | What the operation applies, as it was asked. |
| `status` | string | yes | `queued`, `running`, `done` or `cancelled`. |
| `cancelRequested` | boolean | yes |  |
| `total` | integer | yes |  |
| `succeeded` | integer | yes |  |
| `failed` | integer | yes |  |
| `skipped` | integer | yes |  |
| `pending` | integer | yes |  |
| `userId` | integer | yes |  |
| `createdAt` | string | yes |  |
| `startedAt` | string or null | yes |  |
| `finishedAt` | string or null | yes |  |

### Schema: Change

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `changeSet` | string | yes |  |
| `at` | string | yes |  |
| `actor` | [PersonRef](#schema-personref) or null | yes |  |
| `field` | string | yes |  |
| `from` | object | yes |  |
| `to` | object | yes |  |
| `transitionId` | integer or null | yes |  |

### Schema: Comment

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `author` | [PersonRef](#schema-personref) or null | yes |  |
| `body` | any | yes | Rich text, in the format the request asked for. |
| `visibility` | object or null | yes |  |
| `version` | integer | yes |  |
| `createdAt` | string | yes |  |
| `updatedAt` | string | yes |  |

### Schema: Error

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `error` | string | yes | A short code, such as `not_found` or `invalid_fields`. |
| `fields` | object | no | For `invalid_fields`: what is wrong with each field, by name. |

### Schema: Field

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `name` | string | yes |  |
| `type` | string | yes |  |

### Schema: Link

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `type` | object | yes |  |
| `direction` | `"outward"`, `"inward"` | yes |  |
| `phrase` | string | yes |  |
| `ticket` | object | yes |  |
| `createdAt` | string | yes |  |

### Schema: LinkType

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `name` | string | yes |  |
| `outward` | string | yes |  |
| `inward` | string | yes |  |
| `isCopy` | boolean | yes |  |

### Schema: Meta

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `product` | `"taskmoor"` | yes |  |
| `version` | string | yes | The backend’s version. |
| `api` | object | yes |  |
| `frontend` | object | yes | The oldest frontend this backend serves (older ones must update) and the one it was built with (older ones should). Null on a development build, which takes any frontend. |
| `instance` | object | yes |  |
| `signIn` | object | yes |  |
| `signature` | object | no |  |

### Schema: MetaProvider

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `name` | string | yes |  |
| `protocol` | `"oidc"`, `"saml"` | yes |  |
| `issuer` | string | yes | OpenID Connect: the issuer URL. SAML: the identity provider’s entity ID. |
| `clientId` | string or null | yes | OpenID Connect only. |
| `ssoUrl` | string or null | yes | SAML only: where sign-in requests go. |
| `startUrl` | string | yes | Opens sign-in with this provider. |

### Schema: PersonRef

A person, by id and display name.

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `name` | string | yes |  |

### Schema: Priority

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `name` | string | yes |  |
| `description` | string | yes |  |
| `order` | integer | yes |  |

### Schema: QueryCheck

A object or object.

### Schema: Release

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `trackId` | integer | yes |  |
| `name` | string | yes |  |
| `description` | string | yes |  |
| `startDate` | string or null | yes |  |
| `releaseDate` | string or null | yes |  |
| `shipped` | boolean | yes |  |
| `archived` | boolean | yes |  |
| `progress` | object | yes |  |
| `overdue` | boolean | yes |  |

### Schema: SavedSearch

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `name` | string | yes |  |
| `description` | string | yes |  |
| `query` | string | yes |  |
| `owner` | [PersonRef](#schema-personref) | yes |  |
| `shares` | array of any | yes |  |
| `starred` | boolean | yes |  |
| `editable` | boolean | yes |  |
| `version` | integer | yes |  |
| `createdAt` | string | yes |  |
| `updatedAt` | string | yes |  |

### Schema: SearchTicket

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `key` | string | yes |  |
| `number` | integer | no |  |
| `track` | object | no |  |
| `ticketType` | object | no |  |
| `parent` | object or null | no |  |
| `status` | object | no |  |
| `summary` | string | no |  |
| `description` | any | no | Rich text, in the format the request asked for. |
| `environment` | any | no |  |
| `assignee` | [PersonRef](#schema-personref) or null | no |  |
| `requester` | [PersonRef](#schema-personref) or null | no |  |
| `creator` | [PersonRef](#schema-personref) or null | no |  |
| `startDate` | string or null | no |  |
| `dueDate` | string or null | no |  |
| `priority` | object or null | no |  |
| `closeReason` | object or null | no |  |
| `closedAt` | string or null | no |  |
| `visibilityLevel` | object or null | no |  |
| `labels` | array of string | no |  |
| `targetReleases` | array of any | no |  |
| `foundInReleases` | array of any | no |  |
| `areas` | array of any | no |  |
| `followerCount` | integer | no |  |
| `voteCount` | integer | no |  |
| `timeTracking` | object | no |  |
| `fields` | object | no | Custom field values by field id. |
| `rank` | string | no | The global rank key: tickets sort by it. |
| `version` | integer | no | Send it back with a change to guard against a lost update. |
| `createdAt` | string | no |  |
| `updatedAt` | string | no |  |
| `trash` | object or null | no | Set while the ticket is in the trash. |

### Schema: SearchTotal

Exact up to 10,000; beyond, an estimate from a sample, or "more than 10,000" when no sample is precise enough.

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `count` | integer | yes |  |
| `exact` | boolean | yes | The count is exact. |
| `approximate` | boolean | no | The count is an estimate, within 10% of the true count 99 times in 100. With neither flag, the count is a lower bound: there are more. |

### Schema: SignedInUser

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `email` | string | yes |  |
| `name` | string | yes |  |
| `isSiteAdmin` | boolean | yes |  |
| `timeZone` | string or null | yes |  |
| `locale` | string or null | yes |  |

### Schema: Sprint

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `boardId` | integer | yes |  |
| `name` | string | yes |  |
| `goal` | string | yes |  |
| `state` | `"future"`, `"active"`, `"closed"` | yes |  |
| `sequence` | integer | yes |  |
| `startAt` | string or null | yes |  |
| `endAt` | string or null | yes |  |
| `startedAt` | string or null | yes |  |
| `completedAt` | string or null | yes |  |
| `version` | integer | yes |  |

### Schema: Stage

The stage of a status: to do, in progress or done.

A `"new"`, `"active"`, `"closed"`.

### Schema: Status

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `name` | string | yes |  |
| `description` | string | yes |  |
| `stage` | [Stage](#schema-stage) | yes |  |
| `order` | integer | yes |  |

### Schema: Ticket

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `key` | string | yes | The track key and the number, such as `PAY-12`. |
| `number` | integer | yes |  |
| `track` | object | yes |  |
| `ticketType` | object | yes |  |
| `parent` | object or null | yes |  |
| `status` | object | yes |  |
| `summary` | string | yes |  |
| `description` | any | yes | Rich text, in the format the request asked for. |
| `environment` | any | yes |  |
| `assignee` | [PersonRef](#schema-personref) or null | yes |  |
| `requester` | [PersonRef](#schema-personref) or null | yes |  |
| `creator` | [PersonRef](#schema-personref) or null | yes |  |
| `startDate` | string or null | yes |  |
| `dueDate` | string or null | yes |  |
| `priority` | object or null | yes |  |
| `closeReason` | object or null | yes |  |
| `closedAt` | string or null | yes |  |
| `visibilityLevel` | object or null | yes |  |
| `labels` | array of string | yes |  |
| `targetReleases` | array of any | yes |  |
| `foundInReleases` | array of any | yes |  |
| `areas` | array of any | yes |  |
| `followerCount` | integer | yes |  |
| `voteCount` | integer | yes |  |
| `timeTracking` | object | yes |  |
| `fields` | object | yes | Custom field values by field id. |
| `rank` | string | yes | The global rank key: tickets sort by it. |
| `version` | integer | yes | Send it back with a change to guard against a lost update. |
| `createdAt` | string | yes |  |
| `updatedAt` | string | yes |  |
| `trash` | object or null | yes | Set while the ticket is in the trash. |

### Schema: TicketInfo

Read-only info fields, computed from comments and history. Only comments everyone who sees the ticket may read count.

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `firstResponse` | string or null | yes | When someone other than the requester first commented. |
| `lastComment` | string or null | yes |  |
| `daysSinceLastComment` | integer or null | yes |  |
| `participants` | array of [PersonRef](#schema-personref) | yes | The requester, the assignee and everyone who wrote a comment. |
| `timeInStatus` | array of object | yes |  |

### Schema: TicketType

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `name` | string | yes |  |
| `description` | string | yes |  |
| `icon` | string or null | yes |  |
| `color` | string or null | yes |  |
| `level` | object | yes |  |
| `trackId` | integer or null | yes |  |

### Schema: TimeEntry

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `author` | [PersonRef](#schema-personref) or null | yes |  |
| `startedAt` | string | yes |  |
| `duration` | integer | yes | Seconds. |
| `description` | string | yes |  |
| `createdAt` | string | yes |  |
| `updatedAt` | string | yes |  |

### Schema: Track

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `key` | string | yes |  |
| `name` | string | yes |  |
| `description` | string | yes |  |
| `type` | `"software"`, `"business"`, `"service"`, `"discovery"` | yes |  |
| `mode` | `"shared"`, `"local"` | yes |  |
| `owner` | [PersonRef](#schema-personref) or null | yes |  |
| `archived` | boolean | yes |  |
| `features` | object | yes |  |
| `createdAt` | string | yes |  |
| `updatedAt` | string | yes |  |

### Schema: Transition

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | integer | yes |  |
| `name` | string | yes |  |
| `to` | object | yes |  |
| `layout` | array of string | yes | The fields its form asks for. |

## Internal routes

The document also lists 395 internal routes (`x-taskmoor-stability: internal`): they serve
the web app and may change in any release, so programs should not rely on them.
