# ADR-052: Search results: columns, inline edit and streaming export

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-042

## Context

QRY-014 asks for inline edit in results (2) and column sets that persist per person (3);
QRY-015 asks for export of results as CSV and JSON among other formats, without a row cap. The
backlog's done condition for M1-042 is a 100,000-row export streaming in under 60 s and an
inline edit e2e. The search page of M1-041 (ADR-010, "Query editor") listed results as links;
the search route of M1-037 pages a compiled statement by keyset, with the person's permission
filter inside it (QRY-008). Ticket edits already have one route, `PATCH /api/v1/tickets/:id`,
which checks permissions, status and field locks (M1-029), values and versions, and emits the
ticket's event.

## Decision

- **The export reuses the search route's statement.** `GET /api/v1/search/export?q=&format=
  csv|json&columns=` (`apps/server/src/routes/search-export.ts`) prepares the query with
  `prepareSearch` and `searchPerson`, as the search route does, and walks `compiled.page` by
  keyset, 500 ids per page, each page its own read-only statement under the search timeout.
  Each page of tickets is read with `searchViews` (moved out of the search route, unchanged), which
  applies the permission filter again: an export holds exactly the tickets the search shows
  the person, in the same order. The compiler is not changed.
- **Streamed, never held.** The response is a `Readable` over an async generator that reads the
  next page only when the client has taken the previous one, so memory is one page whatever
  the result size. A query error (400 `invalid_query`), an unknown column (400) and signed-out
  callers (401) are answered before the first byte; a failure later ends the download early.
- **Columns** are the results list's ids: `key` (always first), `summary`, `track`,
  `ticketType`, `parent`, `status`, `assignee`, `requester`, `creator`, `priority`,
  `closeReason`, `visibilityLevel`, `labels`, `targetReleases`, `foundInReleases`, `areas`,
  `startDate`, `dueDate`, `closedAt`, `createdAt`, `updatedAt`, `description`, `environment`,
  `followerCount`, `voteCount` and `cf[N]` for custom fields the person's queries may name
  (shared fields and local fields of tracks they see; another id is refused, so a header
  cannot reveal a hidden field's name). Without `columns`, the default list columns.
- **CSV** has a header of column ids (custom fields by their names), one line per ticket, cells
  as text (references by name, lists joined with "; ", rich text as its words), RFC 4180
  quoting, CRLF line ends, and the formula guard of the audit export (`csvField`): text
  starting with =, +, -, @, tab or carriage return gets a leading apostrophe. Numbers are
  written as numbers. **JSON** is an array of tickets as the search route shows them,
  projected to the columns (`id` and `key` always), written a page at a time.
- **A read route**: no domain event; a GET, so an API token needs the read scope with no entry
  in `tokens/scopes.ts`.
- **The results list is a table** (`ResultTable`) in the person's columns. Wide tables scroll
  inside their own focusable region, never the page (ADR-033). The **column picker**
  (`ColumnPicker`) lists the shown columns with Move up, Move down and Remove buttons (focus
  stays on the moved column, a status line says where it went) and adds a system column or a
  custom field from a select: keyboard and touch alike, 44px targets on coarse pointers.
- **Columns are kept per person in the browser** (localStorage under
  `taskmoor.search.columns.<user id>`, every read and write in try/catch; unknown entries are
  dropped). No server-side preference exists for this yet; column sets kept on the server, per
  person and per saved search (QRY-014 (3)), come with saved searches (M1-063), which can take
  this list as the person's default.
- **Inline edit calls the ticket route.** Summary, assignee (unassigned, me, or the current
  one: there is no people picker yet, as in the ticket view), priority, labels, start and due
  dates, and custom text, URL, number, date and labels fields edit in place; other columns
  are read-only. The cell sends `PATCH /api/v1/tickets/:id` with the ticket's `version`, and
  the ticket it returns replaces the row. A refusal shows on the cell (`role="alert"`, the
  input `aria-invalid`): a lock in the words of `useLockText`, a permission, an invalid value,
  or a stale version (someone changed the ticket since the search).
- **Export links** on the search page download the query that produced the results in the
  shown columns (`<a download>` to the export route, so the browser streams it to disk).

## Measurements

`TASKMOOR_LARGE_EXPORT=1 pnpm verify --only=tests -- apps/server/src/routes/search-export.large.test.ts`:
100,000 tickets of one track exported by a member (permission filter in every statement),
seven columns including a custom field, read through a real socket, on the 4-CPU development
container with other sessions' tests running beside it (2026-10-29, three runs):

| Run | CSV (8.6 MB) | JSON (28.5 MB) | First byte | Live heap growth |
|---|---|---|---|---|
| Without heap sampling | 5.4 s | 5.0 s | 114 ms / 32 ms | not measured |
| Heap sampled every 250 ms after a forced collection, load average about 7 | 8.7 s | 14.8 s | 117 ms / 85 ms | 2.2 MB / 2.0 MB |
| The same, load average about 3.5 (final code) | 5.8 s | 6.4 s | 84 ms / 52 ms | 2.3 MB / 2.1 MB |

The test samples the heap after a forced collection, so it counts live objects only: about
2 MB, far less than the files, as streaming requires. The 60 s budget holds with a wide
margin; the forced collections themselves slow the sampled runs.

## Consequences

- An export is not a background job: QRY-015 (1) (500,000 rows as a job with a download link)
  and the Excel, Word-compatible and XML formats remain, as does "all fields" (every column at
  once) and the CSV round trip through the CSV importer (QRY-015 (2)).
- Exports are not audited; a later decision may record them as the audit export does.
- The export passes the person's time zone, session and permitted tracks to `prepareSearch`
  as the search route does (`searchPerson`, M1-038), so functions and dates read the same in
  both; a change there reaches both.
