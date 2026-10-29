# ADR-053: Saved searches: sharing, references and subscriptions

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-063

## Context

QRY-011 asks for saved searches with an owner, a description and a star, the share scopes of
spec 01b section 1.7 (private, a person, a group, a track with all members or chosen roles, any
signed-in person, public), saved-search references with cycle detection and an administrator's
owner change. QRY-012 asks for their results emailed on a schedule (daily, weekly, monthly or
cron) to a person or a group, each member seeing only what they may browse, optionally only when
something matches. AGL-001 puts boards on saved searches; ADR-049 reserved
`board.saved_search_id` beside `filter_query`. The query language already knows the field
`savedSearch` (Jira-compatible `filter`, `request`, `savedFilter`, `searchRequest`) but could not
run it. The permission filter of every search lives inside the compiled statement (QRY-008).

## Decision

- **Tables (migration 0051).** `saved_search` (owner, name unique per owner ignoring case,
  description, query text, result `columns`, version), `saved_search_share` (one row per scope:
  `user`, `group`, `track` with an optional `role_id`, `any_user`, `public`; no row is private),
  `saved_search_star`, `saved_search_subscription` (a person or a group; `daily`, `weekly`,
  `monthly` or `cron`, hour, minute, weekday, day of month, cron text, time zone, only if results,
  `next_run_at`, last run, last count and last error) and `board.saved_search_id` with a check
  that exactly one of it and `filter_query` is set. A saved search a board uses cannot be deleted
  (409 `in_use` naming the boards).
- **Who sees one** is one SQL predicate (`savedSearchVisible`, `apps/server/src/search/saved.ts`):
  the owner, or a share that reaches the person (their id, a group they are in through nesting,
  a role actor of the track, directly or through a group, every signed-in person, or public).
  Anonymous visitors see only public ones; what a public search shows them depends on what the
  access policies grant to "anyone". Site administrators read, edit and delete every saved
  search, and only they change the owner. A saved search a person cannot see answers 404, like
  one that does not exist.
- **Sharing needs the global permission** `share_saved_searches` (granted to every signed-in
  person by default since migration 0004); keeping or removing existing shares does not. A track
  share needs the sharer to browse the track (a hidden track reads as not found). Group
  subscriptions need `manage_group_subscriptions`.
- **References are expanded before resolution, as the runner.** `prepareSearch` and the boards'
  `bindCondition` call `expandSavedSearches`: `savedSearch = "name"`, `= id`, `IN (...)`, `!=` and
  `NOT IN` become the referenced search's condition (an OR for several, negated for the negative
  forms; ORDER BY of the referenced search is ignored; a search without a condition matches
  every ticket), recursively. Names resolve before ids; of several visible searches of one name
  the person's own wins, otherwise the reference is ambiguous and must use the id. The expansion
  is AST to AST, so the resolver, binder and compiler are unchanged, and every span of the copied
  condition points at the reference, so errors highlight what the person wrote. Refusals are
  QueryErrors at the reference: a cycle (`Saved searches refer to each other in a cycle: "A" →
  "B" → "A"`), a chain deeper than 10, an operator other than `=`, `!=`, `IN`, `NOT IN`, and a
  saved search that does not exist or that the runner cannot see, with one message for both.
- **Saving checks the query as its owner would run it,** with the saved search itself on the
  reference stack, so a change that would lead back to it is refused (QRY-011 (2)) and nothing is
  stored. Running a saved search is running its query through `/api/v1/search`: there is no
  separate "run as owner" path, so nobody sees a ticket through a shared search that they could
  not find with the same query (QRY-008). A shared query naming a track the runner cannot browse
  fails for them as "Unknown track", exactly as typing it would.
- **Subscriptions** (`apps/server/src/search/subscriptions.ts`) run every minute in the worker
  when SMTP is configured, through the same transport as the notification mailer (M1-057). A
  due subscription is claimed by a compare-and-set that moves `next_run_at` on, so two workers
  never send one run twice. Recipients are the person, or every active member of the group,
  nested groups included; each is skipped unless they can see the saved search, and the query
  runs as them (their ticket filter, their time zone, `currentUser()` is them). The email lists
  up to 50 tickets (key, summary, status), the capped count and a link
  `#/search?savedSearch=<id>`. "Only if results" skips an empty run. A recipient whose query fails
  is skipped and the subscription keeps the error.
- **Schedules** (`search/schedule.ts`) are all five-field cron on the subscription's wall clock:
  daily, weekly and monthly are written as cron (monthly days 1 to 28 from the API), and cron
  takes `*`, numbers, lists, ranges and steps with cron's rule for two restricted day fields. The
  next run skips whole days and hours that cannot match, so a search never walks minute by
  minute through a year.
- **Boards** take `source: {savedSearchId}` beside `source: {query}`; the board's condition is
  `savedSearch = <id>` expanded as the viewer, so a board follows changes to its saved search.
  Creating or changing one checks that the editor sees the saved search (`not_found` otherwise).
  The board settings page keeps a board on its saved search while its query reads
  `savedSearch = <id>`.
- **Events**: `saved_search.created`, `.updated` (changes, shares as scope keys, owner), `.deleted`,
  `.subscribed` (recipient ids and schedule, never an address), `.unsubscribed` are audited;
  `.starred` and `.unstarred` are personal and not audited. Routes take the default token scopes
  (read for GET, write otherwise).

## Consequences

- Sharing with people, groups and tracks is API-only for now; the search page offers only me,
  everyone signed in and anyone. System saved searches (My open tickets and the rest of section
  1.7), an admin page of all shared saved searches, importing subscriptions from Jira (QRY-012
  (3)), group subscription emails batched per member and HTML rendering through the notification
  templates are left for later.
- Shares are not revoked when a person leaves a group or track: visibility is read live at every
  use, so it follows membership without bookkeeping.
- A saved search's columns are stored and applied when it is opened, which is the first
  server-side column set ADR-052 waited for; the person's default columns stay in the browser.
