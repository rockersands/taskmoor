# ADR-094: The Cloud REST importer: a resumable fetch into a staging table, throttled as the source asks

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-095

## Context

IMP-002 asks for an importer that reads a Jira Cloud site over its REST API with the customer's
own token: token-paged search, bulk fetch, each issue's changelog, comments and worklogs,
honouring `Retry-After` and burst limits, and running only against the customer's own site.
IMP-007 asks for people matched by account id or email, an administrator's CSV where addresses
are hidden, and SCIM-provisioned accounts, with placeholders for anyone unmatched. The task is
done when a replay against synthetic API fixtures and the 429 and `Retry-After` tests are green.

The clean room (ADR-003) forbids signing in to or calling an Atlassian product, even to look at
answers. Taskmoor serves a Jira-compatible API of its own (ADR-085, ADR-086, M1-070), written
from public descriptions in our own words, so a populated Taskmoor is a source the importer can
read exactly as it reads any such server, and the answers it gives can be recorded as fixtures.

The importer framework (ADR-048) reads a source a page at a time inside each batch's
transaction, holding the run's row lock. A remote source cannot be read that way: a request may
wait minutes for a `Retry-After`, page tokens of a search may expire, an issue's comments come
from another request than the issue, and parents must load before their children whatever order
the search gives. The Data Center importer solved the same problem with a stage beside the ZIP
(ADR-081); a remote source has no file, and the worker that resumes may be another machine.

## Decision

- **Fetch first, into the database.** A source may now have `prepare(until)`, which the run
  calls before its first batch, a job part at a time (`'more'` hands over to the next part). The
  Cloud source's `prepare` is a fetch (`import/cloud/fetch.ts`) that stages records in
  `import_staged` (migration 0071) and commits where it got to in `import_run.fetch_state` with
  every page: `config` (custom fields, issue types, priorities, resolutions, statuses, link
  types, projects with versions and components), `search` (ids by `/search/jql` with
  `nextPageToken`, each page's issues by `/issue/bulkfetch`), `details` (changelog, comments,
  worklogs, a few issues per commit), `agile` (boards with their configuration, sprints and the
  issues in each), `people` (anyone seen without an address, looked up by account id) and
  `order` (each issue's depth, so parents load first). Staging is an upsert, so a page staged
  twice changes nothing; a page token the server refuses restarts the search. The extract stage
  then reads staged records by `(depth, ordinal)` like any other source, and the rows go with
  their run.
- **The same kinds as the other importers.** The mapper (`import/cloud/source.ts`) turns the
  compatible API's JSON into the framework's commands: people, statuses by category, priorities,
  resolutions as close reasons, issue types by level, link types, projects as tracks, versions as
  releases, components as areas, custom fields by type (the built-in type keys through the
  backup importer's table, `taskmoor:<type>` from a Taskmoor source, apps' fields as read-only
  text), tickets with their fields and custom values in stored form, comments and descriptions in
  the document format with mentions kept, worklogs as time entries, changelog entries as
  history. Two kinds are new to the framework, with loaders in `import/load-agile.ts`: `board`
  (columns with their statuses, the board's query, linked by name within its track) and
  `sprint` (state, dates, goal, tickets; a closed sprint's tickets kept closed, one open sprint
  per ticket).
- **Throttled as the source asks** (`import/cloud/client.ts`). `429` and `503` wait for
  `Retry-After`, in seconds or as an HTTP date, capped at 15 minutes, and the wait holds back
  every request of the run, not only the refused one. Without the header, and after other `5xx`
  answers and network errors, exponential backoff with jitter (half fixed, half random; from one
  second, doubling to a cap of a minute), eight attempts in all. Other refusals fail at once. At
  most `concurrency` requests (default 4) are in flight. A request that keeps failing stops the
  attempt; the job's next attempt resumes from the committed fetch state, so pages already staged
  are not asked for again. The run's report counts the throttling and the retried failures as
  source notes.
- **The token is an importer secret.** The route seals it with the pepper ring (`sealSecret`,
  as LDAP bind passwords and webhook secrets are kept), stores only the sealed value in the run's
  settings and never shows it again; it is opened only to build the `Authorization` header. A
  transport receives that header apart from the request, so recordings never hold it, and errors
  name the method and path only. Tests make their tokens at run time.
- **People mapping as a mode of the source.** `email` (the default) links or creates by address.
  `csv` takes an administrator's file of source person (account id or address) to Taskmoor
  address. `scim` links only to people provisioned over SCIM with the same address. A user
  command may now say `link: 'existing' | 'scim'`: the loader links to such a person and never
  creates or changes one; nobody found gives a deactivated placeholder and the warning
  `person_unmapped`, so the report and the records list name everyone left to map.
- **Fixtures recorded from Taskmoor, replayed without a network.** `testing/compat-source.ts`
  builds a Taskmoor with synthetic tracks, fields, tickets, history, comments, time, boards and
  sprints. `cloud.test.ts` imports it in process and checks that the target holds what the
  source holds; with `TASKMOOR_RECORD_CLOUD_FIXTURES=1` it records the exchanges
  (`replay.ts`, requests and answers only) into `__fixtures__/compat-source.json`. `replay.test.ts`
  imports from that file into fresh databases. Atlassian hosts are refused whenever tests run:
  by the client's transport, by the import route and by the recorder. A customer's own run may
  name their site.
- **Two small fixes to the compatible API** found by reading it as a client: a board's
  `location` (the shim read the native board's track from the wrong place), and the schema of a
  field with several values, now an array of its type.

## Options considered

| Option | For | Against |
|---|---|---|
| Fetch into a staging table, then import (chosen) | Network waits outside the batch transaction; resumable per page on any worker; parents first; the extract stage unchanged | Staging rows cost space (about the source's JSON size); a second read pass |
| Read the API inside `read()` with page tokens as cursors | No staging | A `Retry-After` of minutes inside a locked transaction; tokens expire; comments and children out of order |
| Stage into files beside the run, as the backup importer does | Same code shape as ADR-081 | Another worker may resume without the files; nothing to clean up with the run |
| Fixtures written by hand | Full control of shapes | Written from what we think the API answers, not what a server answers; drift from the shim |
| Fixtures recorded from Taskmoor's own compatible API (chosen) | Real answers of a server that speaks the API; synthetic data; clean room | Shapes are as faithful as the shim is; a shim gap is an importer blind spot |
| One context per field, options from issue values (chosen) | The compatible API this reads has no context or option listing | Unused options, disabled options and per-project contexts do not come along |

## Consequences

- Measured on the committed fixture (97 recorded exchanges, 22 tickets in two tracks, eight
  custom fields, 11 comments, 7 worklogs, 54 changelog entries, two boards and two sprints): the
  replay import has no failures and the target matches the source field by field; a second run
  changes nothing; with 429 (`Retry-After: 7`), 503 (an HTTP date 30 seconds ahead), three 429s
  without the header (backoff 750, 1,500 and 3,000 ms with fixed jitter), two 500s and a network
  failure that ends the first attempt at the third search page, the retry resumes with the stored
  page token and the target equals the clean run's. The in-process run against the live source
  compares every ticket, comment, time entry, history entry, board and sprint of the two
  workspaces.
- Changing what the fetch asks for (page sizes, fields) makes the replay miss: record again with
  `TASKMOOR_RECORD_CLOUD_FIXTURES=1`, run `pnpm format` and `pnpm verify --update`, and review
  the fixture and golden diffs.
- Not yet: links between issues and attachments (the compatible API's issue has no `issuelinks`
  and the shim serves no attachments), watchers and votes, filters and dashboards, issue type
  and permission schemes, comment visibility, custom field history, contexts and options as the
  site has them, a 1M-item run at 20 to 50 requests per second (IMP-002 (1)), delta runs
  (M1-096), the wizard and CLI (M1-097), and removing a finished run's sealed token.
- A placeholder made for an unmapped person keeps the content an earlier run gave it; a later run
  with a better mapping links the person's record, not content already imported.
