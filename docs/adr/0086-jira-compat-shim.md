# ADR-086: The Jira-compatible API as routes that call the native API in-process, with token sign-in only

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-069

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
  - The Agile API (M1-070).
  - Wiki markup (M1-071).
  - Attachments.
  - `expand` sections beyond what the issue already carries.
  - The link direction (`inwardIssue` takes the outward phrase) is marked `verify` until a
    script confirms it.

## Options considered

| Option | For | Against |
|---|---|---|
| Routes over the native API in-process (chosen) | One set of rules; no database access; removable | An extra in-process hop per native call; some operations need several calls |
| Handlers calling the core's stores directly | Fewer hops | A second set of permission, history and event rules: what ADR-016 forbids |
| A separate proxy process over HTTP | Fully separate | Another process to run, and the caller's address and limits to carry across |
| Accept cookies too | Browser tools would work | Cross-site requests from any page; no Jira-compatible client needs it |

## Consequences

- The compatibility matrix reads 57 of 72 operations complete. Every family outside the Agile
  API is complete except bulk label edits.
- Each new native capability makes its compatible operation a few lines. When a script needs
  more, the contract gets the case first (ADR-085).
- Costs are visible: a compatible create makes three native calls (the project, its ticket
  types, the create). The offset search walks cursors, which is fine for the page sizes scripts
  use.
