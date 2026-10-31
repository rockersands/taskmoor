# ADR-086: The Jira-compatible API as routes that call the native API in-process, with token sign-in only

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-069, M1-070

## Context

ADR-016 asks for the Jira-compatible API to sit in its own package, use only the core's public
services and never its tables, and be removable without touching anything else. ADR-085 wrote
its contract as operations and cases. M1-069 serves the core:
- issues, with transitions, comments, worklogs, watchers, votes, remote links, properties and
  links;
- search, by token and by offset;
- fields and the rest of the configuration lists;
- people and permissions.

It also serves projects, filters, bulk tasks and webhook registration, because each of those is
a few lines over the native API. Scripts sign in with Basic (an email address and an API token)
or a bearer token (API-002).

## Decision

- **Routes that call the native API.**
  - `packages/api-jira-compat/src/shim` exports `COMPAT_ROUTES`: a method, a path and a
    handler each. A handler gets the request's version, parameters, query and body, and a
    `native(method, path, body)` function.
  - The server (`apps/server/src/compat/register.ts`) registers each route under
    `/rest/api/2` and `/rest/api/3`, or its own path. Its `native` runs the native route
    in-process (`app.inject`) with the caller's token and client address.
  - Every permission check, field rule, history row, event, audit record, rate limit and IP
    allowlist is therefore the native API's own, and the shim never touches the database.
  - The package knows nothing of Fastify. The server can drop it, and `TASKMOOR_JIRA_COMPAT=off`
    switches it off.
- **Sign-in with tokens only.**
  - `Authorization: Bearer <token>`, or Basic with the email address and an API token (or an
    OAuth access token) as the password. With Basic, the email must be the token owner's.
  - Passwords are refused here, because they would get past second factors and sign-in
    throttling.
  - Cookies are not read: a page on another site cannot make a browser call these routes as
    its person.
  - A registered MCP client's token stays bound to the MCP endpoint (ADR-084), so it does not
    work here either.
- **Bodies, mapping:**
  - Ids become strings, and a person's account id is their Taskmoor id as a string.
  - Statuses carry the three status categories by stage.
  - Instants are written as `2026-10-31T09:00:00.000+0000`.
  - Custom fields are `customfield_<id>`.
- **Bodies, rich text:** version 3 carries the Jira-compatible document format (native
  `?format=adf`). Version 2 carries **Markdown** until M1-071 adds wiki markup; plain text reads
  the same in both. Search answers the stored document, which the shim converts with
  `@taskmoor/richtext`.
- **Bodies, edits and errors:**
  - `fields` and `update` (add, remove and set for labels; set for the rest) become one native
    change.
  - An unknown field is refused by name, never ignored (API-003 (2)).
  - Native refusals become `errorMessages` and `errors`, with field names in Jira's
    vocabulary.
  - A body with a JSON content type may be empty.
- **Search.**
  - Token search passes the native cursor as `nextPageToken`.
  - The older offset search pages through native cursors to the offset, and takes the total
    from the native count on the first page.
  - The query is passed as it is: the native query language reads Jira-compatible names
    (QRY-003).
- **Deleted is deleted.** A ticket in the trash answers 404, as a deleted issue does.
- **Not done yet:**
  - Bulk label edits that add or remove per issue, since native bulk edits set values. They
    answer a clear 400, never a wrong result.
  - Wiki markup (M1-071).
  - Attachments.
  - `expand` sections beyond what the issue already carries.
  - The link direction (`inwardIssue` takes the outward phrase) is marked `verify` until a
    script confirms it.

## The Agile API (M1-070)

`shim/agile.ts` serves `/rest/agile/1.0` on the native board and sprint API, the same way:
- boards, their configuration (columns with their statuses, the filter), their issues (the
  board's own query) and their backlog;
- a board's sprints by state;
- sprints created, read and changed. A `state` of `active` starts a future sprint, and `closed`
  completes an active one, moving open issues to the backlog;
- issues moved into a sprint, and back to the backlog;
- rank before or after an issue, in the order given;
- an issue read through the Agile API.

Issues there have the version 2 shape. Three choices:

- The native API gained `GET /api/v1/sprints/:id`, with the sprint's board rules, since the
  Agile API reads a sprint by its id alone.
- "Back to the backlog" names no sprint, so the shim finds each issue's open sprint among the
  scrum boards the caller sees, one search per open sprint. That is enough for M1 instances. A
  native "remove from any sprint" would make it one call if a large instance needs it.
- Agile estimation fields and epics (the parent of an issue at the level above) are left to the
  issue's own fields: `parent` and `timetracking`.

## Options considered

| Option | For | Against |
|---|---|---|
| Routes over the native API in-process (chosen) | One set of rules; no database access; removable | An extra in-process hop per native call; some operations need several calls |
| Handlers calling the core's stores directly | Fewer hops | A second set of permission, history and event rules: what ADR-016 forbids |
| A separate proxy process over HTTP | Fully separate | Another process to run, and the caller's address and limits to carry across |
| Accept cookies too | Browser tools would work | Cross-site requests from any page; no Jira-compatible client needs it |

## Consequences

- The compatibility matrix reads 71 of 72 operations complete (57 after M1-069, the Agile API
  with M1-070). Only bulk label edits that add or remove per issue are missing.
- Each new native capability makes its compatible operation a few lines. When a script needs
  more, the contract gets the case first (ADR-085).
- Costs are visible: a compatible create makes three native calls (the project, its ticket
  types, the create). The offset search walks cursors, which is fine for the page sizes scripts
  use.
