# ADR-047: The in-app inbox, mentions and activity streams

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-058

## Context

NTF-003 asks for a real-time inbox with read and unread state, snooze, filters by type and
track, and a Priority tab of direct asks (mentions, assignments, approvals), where marking an
item read also marks the matching email digest entry read, and a mention appears within 2 s.
NTF-005 asks for mentions of users and teams in descriptions and comments that notify the
mentioned people who can view the ticket and warn the author about those who cannot; naming a
person in a People field does not notify them. The backlog's measure is stricter: the inbox
updates less than a second after an event, and a mention notifies exactly once (e2e). The task
also names activity streams per ticket and per track.

What existed: the notification subscriber (ADR-041) writes one `notification` row per domain
event, person and channel (`email`, `inbox`), unique on that triple, after checking the
person may see the ticket and, for a comment, read it (ADR-044). The mailer (M1-057) sends the
email rows. Mention nodes are `{ type: 'mention', attrs: { id, label } }` in stored documents,
and the editor already warns at "@" about people who cannot see the ticket (`canView`). The
realtime socket (ADR-013, M1-032) pushes change log positions, polled every 250 ms. The ticket
history (`ticket_change`) records every change, comment and time entry and is never truncated.

## Decision

- **Mentions are product events outside policies** (spec 01c section 3). A change's new
  mentions travel in its domain event: `mentions: { users, groups }` on `ticket.created` (the
  description and environment it starts with), `comment.created`, `comment.updated` (only
  those the edit added) and `ticket.transitioned` (its comment). `ticket.updated` already
  carries both documents of a rich text change; the subscriber diffs them. Ids only, never
  text. A mention id `"42"` is a person, `"group:7"` a team (a group, its nested groups
  included); other ids (foreign account ids from imports) name nobody.
- **Exactly once.** Mentioned people get one `mentioned` notification per change and channel:
  never the writer, only if they may see the ticket and, for a comment, read it, and only if
  they keep the channel on (preferences cover `mentioned` like any event). A person both
  mentioned and named by the policy gets the mention instead of the policy's notification on
  that channel (a channel muted for mentions falls back to the policy's event), so the unique
  (event, person, channel) row holds. Redelivery writes nothing. An edit notifies only the
  mentions it added; removing and re-adding someone in a later edit is a new mention.
- **Warnings.** Ticket create and edit answers and comment create and edit answers carry
  `mentionWarnings` when someone mentioned will not be told: `cannot_view`, `cannot_read` (a
  restricted comment), `unknown`; for a team, the count of members left out (up to 500 checked).
  Names are given only to writers who may browse users and groups (as the editor's mention
  list requires); others get the ids. The comments panel shows the warnings after posting; the
  editor's own `canView` warning stays.
- **Direct asks** are stored: `notification.direct` is true for a mention and for an assignment
  to the recipient. The Priority tab lists them. Approvals join when they exist (M2).
- **The inbox** reads `inbox` rows (`/api/v1/inbox`): newest first by
  `coalesce(snoozed_until, created_at)` with a keyset cursor, views all, priority and snoozed,
  unread only, by event and by track, unread counts of the inbox and of Priority (capped at
  1,000). **Every item is judged again when shown**, in the statement: the list predicate of
  ADR-012 on the ticket (outside the trash) and the comment rule of ADR-044 for items about a
  comment; a transition's comment is quoted only when readable. Counts use the same rule, so a
  ticket that becomes hidden leaves the badge too.
- **Read, unread, snooze.** `PATCH /api/v1/inbox/:id` and `POST /api/v1/inbox/read` (up to the
  newest item seen). Reading marks the same notification's email row read, and the mailer no
  longer sends notifications already read (NTF-003 (2)). A snooze hides the item until its
  time (at most a year ahead) and brings it back unread at the top; `null` puts it back at once.
  One domain event per change (`inbox.item_updated`, `inbox.marked_read`), not audited.
- **Realtime.** `inbox_state` holds a counter per person, bumped in the transaction of every
  change to their inbox (the subscriber's insert, read, unread, snooze). The realtime socket's
  existing 250 ms poll also reads the counters of connected people (one primary-key read per
  workspace) and sends `{"type":"inbox","version"}`; the page reads the inbox again. The
  worker's idle wait drops from 500 to 200 ms so the whole path (relay, subscriber, poll, read)
  fits in a second.
- **Activity streams** come from the ticket history: one entry per change set and ticket,
  newest first, with comment excerpts only for readable comments and rich text values left out
  (a line of their text since T-309). `GET /api/v1/tickets/:id/activity` (kinds all, comments,
  history, time; an All page also carries time entries, see Changes) and
  `GET /api/v1/tracks/:id/activity` (the visible tickets of a track, each ticket's history read
  by its primary key through a lateral join, merged by id). Pages never split a change set.

## Options considered

| Option | For | Against |
|---|---|---|
| Mentions in the event payload (chosen), diff of documents for `ticket.updated` | Exact per change; works for every write path that emits the event (PATCH, bulk, co-editing) | Comment and create routes compute them |
| The subscriber reads the current document | No route changes | A later edit before the event is handled double-notifies or misses; comment edits have no "before" |
| A separate `mention` notification beside the policy's | Simple rows | Two inbox items for one change; breaks the unique (event, person, channel) row |
| `LISTEN`/`NOTIFY` for inbox pushes | Instant | A connection outside the pool per process (as ADR-013 noted); the poll is well inside budget |
| Track activity from `domain_event` | One table | Events are pruned by retention; history is not |

## Consequences

- Measured on the e2e instance (two browsers, the API server's worker loop at its production
  idle wait): a mention shows in an open inbox 239 to 348 ms after the comment is written when
  the machine is quiet, 840 to 850 ms during the full e2e run on a machine shared with other
  suites (load average 14 on 4 CPUs); `inbox.spec.ts` fails above a second. The notification
  subscriber runs before the audit subscriber so its job is not queued behind the audit chain.
- At size (`routes/inbox.large.test.ts`, `TASKMOOR_LARGE_INBOX=1`): one person with 50,000
  inbox items over 2,000 tickets, a tenth about comments they may not read; p95 of 30 reads:
  first page with counts 15 to 25 ms, counts alone 13 to 18 ms, a later page 14 to 25 ms. The
  track's activity over the same 2,000 tickets (20,000 changes): 120 ms per page of 50. With
  stale planner statistics (right after a bulk load, before autovacuum) the first page took
  about 250 ms: the planner started from the tickets instead of the inbox index.
- New write paths that create rich text with mentions must put `mentions` in their event
  (comments, creates) or carry both documents (`ticket.updated`). Custom rich text fields
  (paragraph type) do not notify mentions yet.
- Search, boards and the ticket view (M1-051) can link to `#/inbox`; the shell's nav has the
  entry, and the page filters by type and track. No unread badge in the navigation yet.
- A track's activity costs one index probe per visible ticket of the track (120 ms at 2,000
  tickets): for tracks of tens of thousands of tickets the history needs a way to be read by
  track newest first (an index over a stored track, kept right through moves) before the
  activity widget of dashboards (RPT) builds on it.

## Changes (T-309, 2026-11-14)

- The ticket's All tab reads `GET /api/v1/tickets/:id/activity?kind=all` page by page. The
  history alone does not give time entries as that tab shows them: an import writes entries
  and no history rows, and a row says neither whose work it was nor when it started, nor
  follows the entry's visibility. So a `kind=all` page also answers `timeEntries`, read from
  `time_entry` (those the reader may see, as the time entries list shows them), newest first by
  when the work started, `limit` of them at most, back to the oldest history row of the page
  (the last page: back to the start). The rest of the stream stays the history's.
- An All page's cursor names both where the history stopped and the time entry it stopped at:
  `<row>.<µs>.<entry>` (the entry's start in microseconds since the epoch, then its id; row
  `0` once the history is read). The next page goes on after that entry, so each time entry
  comes once whatever order the history rows' times are in (an import's, two writes at once),
  and the pages go on until both are read. Other kinds take only a row id.
- A rich text change (description, environment) carries a line of each side's text in
  `display` (80 characters at most, null with no document), never the document, so a reader
  can tell a change set, changed or cleared it.
