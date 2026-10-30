---
title: "Search and the query language"
audience: users
jira-names: the Jira-compatible dialect's names
sources: apps/web/src/search/SearchPage.tsx, apps/web/src/search/basic.ts, apps/web/src/search/suggest.ts, apps/web/src/search/ResultTable.tsx, apps/web/src/search/ColumnPicker.tsx, apps/web/src/search/columns.ts, apps/web/src/search/SavedSearchBar.tsx, apps/web/src/search/client.ts, apps/web/src/i18n/messages.en.ts, packages/query/src/fields.ts, packages/query/src/functions.ts, packages/query/src/dialect.ts, packages/query/src/dates.ts, packages/query/src/resolve.ts, apps/server/src/search/bind.ts, apps/server/src/search/compile.ts, apps/server/src/routes/search.ts, apps/server/src/routes/search-export.ts, apps/server/src/routes/saved-searches.ts, docs/specs/00-terminology.md, docs/specs/01b-core-work-tracking.md, docs/specs/06-query-language-grammar.md, docs/adr/0010-query-compiler.md, docs/adr/0069-full-text-search.md, packages/query/src/text.ts, apps/server/src/search/text.ts, apps/server/src/search/count.ts, docs/adr/0052-search-results.md, docs/adr/0053-saved-searches.md
accessed: 2026-10-30
attestation: own-words
---
# Search and the query language

**Search** in the navigation finds tickets. It has a basic mode for everyday questions and an
advanced mode where you write a query. The same query language describes boards, list filters,
format rules and dashboard widgets. A search only ever finds tickets you may see.

## Basic search

Press **Basic** at the top of the page and choose:

- **Tracks**: one or more tracks, or none for all of them;
- **Stage**: **New**, **Active**, **Closed**, or none for all;
- **Assigned to**: **Anyone or nobody**, **Me** or **Nobody**;
- **Words**: words that must appear in the ticket's text.

Press **Search**. The results are ordered by the latest change. Your choices become a query:
press **Advanced** to see it and carry on from there. A query that says more than the basic mode
can show stays in the advanced mode, and the page says so.

## Advanced search

Press **Advanced** and type a query in the **Query** box. As you type, the box suggests what can
come next at the caret: fields, operators, values for tracks, stages and people, `AND`, `OR` and
`ORDER BY`. Ctrl+Space asks for suggestions, Tab or Enter takes one, and Enter searches.

The server checks the query as you type. A mistake shows under the box with where it is, for
example "(at column 12, near "stauts")".

The page keeps the query in its address, so you can bookmark a search, send its link, or reload
it.

## Full-text search

`~` finds words. `text ~ "login timeout"` finds tickets where both words appear, in any order,
ignoring case. `text` covers the summary, the description, the environment, the comments you may
read and custom text fields; `summary ~`, `description ~` and `comment ~` look in one place.
`!~` finds the opposite. Words match their other forms in English: `logging` also finds `logs`
and `logged`. A ticket is findable as soon as it is saved.

Inside the quotes of a `~` value:

| Write | Finds |
|---|---|
| `login timeout` | both words, in any order |
| `\"login failed\"` | the words next to each other, in this order |
| `log*` | words that start with `log` |
| `lo?in` | `?` stands for one character (at most two in a word) |
| `login~` | the word, or one typing mistake away from it |
| `-password` | tickets without the word (with at least one other word to find) |
| `*Exception` | a `*` at the start or inside a word finds that text anywhere in summaries and text fields |
| `C\\+\\+` | a backslash makes the next character part of the word |

Order the results by how well they match with `ORDER BY relevance`: the best match comes first.

```text
text ~ "checkout timeout" ORDER BY relevance
```

## The query language

A query is a condition, optionally followed by an order:

```text
track = PAY AND stage != closed ORDER BY priority DESC, updated DESC
```

A clause is a field, an operator and a value. Join clauses with `AND` and `OR`, turn one around
with `NOT`, and group them with parentheses. `NOT` binds tightest, then `AND`, then `OR`.
Keywords, field names and most values are not case sensitive. An empty query finds every ticket
you may see.

A clause never matches a ticket whose field is empty unless it asks for empty values. To include
unassigned tickets, say so:

```text
assignee != currentUser() OR assignee IS EMPTY
```

### Operators

| Operator | Meaning | Fields |
|---|---|---|
| `=`, `!=` | Equals, does not equal | All but text fields and `attachments` |
| `IN (a, b)`, `NOT IN (a, b)` | One of the values, none of them | As `=` |
| `<`, `<=`, `>`, `>=` | Before or after, less or more | Numbers, dates, priorities, releases |
| `~`, `!~` | Contains the words, does not | Text fields |
| `IS EMPTY`, `IS NOT EMPTY` | Has no value, has one (`NULL` means the same) | All |
| `WAS`, `WAS NOT`, `WAS IN`, `WAS NOT IN`, `CHANGED` | Values in the ticket's history | See [History operators](#history-operators) |

On fields that hold several values (labels, areas, releases, people fields, multiple choices)
`=` and `IN` mean "one of its values", and `!=` and `NOT IN` mean "it has values and none of
them is this". On priorities, greater means more urgent: `priority > Normal`. On releases, the
order is the track's release order.

### Values

- Names of statuses, priorities, types, releases, areas, options and close reasons, in any case.
  Quote a value with spaces or punctuation: `status = "In Review"`.
- People by `currentUser()`, email or name: `requester = "ana@example.com"`.
- Ticket keys: `parent = PAY-10`. A track key also matches the keys a track had before.
- Dates: `2026-10-30` or `2026/10/30`, with a time in quotes: `"2026-10-30 14:00"`.
- Durations from now: a sign, a number and `m` (minutes), `h`, `d`, `w`, `M` (months) or `y`,
  such as `-7d` or `+2w`.
- A word that is a keyword (`and`, `or`, `in`, `order` and so on) must be quoted as a value.

Dates are read in the time zone saved in [your account](account.md), or in UTC when it is set
to **Automatic**.

### Fields

| Field | Holds |
|---|---|
| `key`, `parent` | Ticket keys; `parent` is the ticket's parent |
| `track`, `parentTrack`, `trackType`, `trackCategory` | The track, and the track of the parent |
| `type`, `hierarchyLevel` | The ticket type and its level number |
| `status`, `stage` | The status; its stage: `new`, `active` or `closed` |
| `priority`, `closeReason` | Priority and close reason |
| `summary`, `description`, `environment`, `comment`, `text` | Text (use `~`) |
| `assignee`, `requester`, `creator`, `follower`, `voter` | People |
| `followers`, `votes` | How many follow or voted |
| `labels`, `area`, `targetRelease`, `foundInRelease` | Labels, areas and releases |
| `created`, `updated`, `closed` | Date and time |
| `due`, `start` | Due and start day |
| `sprint` | Every sprint the ticket is or was in, by name |
| `visibilityLevel` | The ticket's visibility level |
| `originalEstimate`, `remainingEstimate`, `timeSpent`, `effortRatio` | Time tracking numbers |
| `attachments` | Only `IS EMPTY` and `IS NOT EMPTY` |
| `ticketLink`, `ticketLinkType` | Linked ticket keys, and link types by name or wording |
| `timeEntryComment`, `timeEntryDate` | Notes and days of time entries |
| `savedSearch` | Another saved search's condition (see below) |

Many fields also answer to their display names in quotes, such as `"Due date"` or `"Ticket type"`.
Custom fields are named in quotes, `"Customer tier" = Gold`, or by number, `cf[10] = Gold`.

### Functions

| Function | Gives |
|---|---|
| `currentUser()` | You |
| `membersOf("group")` | The group's members, nested groups included |
| `now()`, `startOfDay()`, `endOfDay()`, and the same for `Week`, `Month` and `Year` | A moment; each takes an increment such as `startOfMonth(-1M)` |
| `currentLogin()`, `lastLogin()` | When you signed in this time, and the time before |
| `followedTickets()`, `votedTickets()`, `ticketHistory()` | Tickets you follow, voted for, or opened lately |
| `updatedBy(user, from, to)` | Tickets the person changed or commented on, optionally in a period |
| `linkedTickets(PAY-12, blocks)` | Tickets linked to a ticket, optionally by link type or wording |
| `ticketsWithWebLinksByGlobalId("id")` | Tickets with that web link |
| `tracksOwnedByUser()`, `tracksWhereUserHasRole(role)`, `tracksWhereUserHasPermission(permission)`, `areasOwnedByUser()` | Tracks and areas by person |
| `standardTicketTypes()`, `subticketTypes()` | Ticket types by level |
| `choiceOption(...)`, `cascadeOption(parent, child)` | Options of a choice field |
| `openSprints()`, `futureSprints()`, `closedSprints()` | Active, planned and completed sprints |
| `shippedReleases(PAY)`, `upcomingReleases(PAY)`, `latestShippedRelease(PAY)`, `earliestUpcomingRelease(PAY)` | Releases of a track |

A function that gives several values takes only `IN` and `NOT IN`: `key IN followedTickets()`.
Weeks run from Sunday to Saturday. On a board, `sprint = @current`, `@next` and `@previous`
name that board's active, next and last completed sprint.

```text
assignee = currentUser() AND due <= endOfWeek() AND stage != closed
updated >= startOfMonth(-1M) AND updated < startOfMonth()
key IN linkedTickets(PAY-12, blocks)
sprint IN openSprints() AND assignee IN membersOf("Payments team")
targetRelease = earliestUpcomingRelease(PAY)
```

### History operators

Taskmoor keeps the full history of every field, so you can ask what a ticket was and how it
changed:

- `WAS`, `WAS NOT`, `WAS IN` and `WAS NOT IN` ask whether the field ever held a value. Narrow
  them with `BY person`, `AFTER date`, `BEFORE date`, `ON date` or `DURING (from, to)`.
- `CHANGED` asks whether the field changed after the ticket was created, with `FROM value`,
  `TO value` and the same `BY`, `AFTER`, `BEFORE`, `ON` and `DURING`.

```text
status WAS IN (New, Active) BEFORE 2026-10-01
assignee WAS currentUser() DURING (2026-10-01, 2026-10-15)
status CHANGED FROM Active TO Closed AFTER -7d
priority CHANGED BY currentUser()
labels CHANGED TO urgent
```

`WAS NOT` is not `!=`: it also finds tickets that never had the value. A status or option that
was renamed still matches under its old name. `updated`, `closed`, `comment`, `text` and the counts
keep no history of their own. Sprint changes are not yet searchable this way;
`sprint = X` already matches every sprint a ticket was in.

### Ordering

End a query with `ORDER BY` and one or more fields, each `ASC` (the default) or `DESC`. Without
it, results come newest first. Priorities sort by urgency, statuses by the workspace's order,
releases by release order, people by name and keys by track and number; empty values come last.
You can order by `key`, `type`, `hierarchyLevel`, `status`, `priority`, `closeReason`, `summary`,
`assignee`, `requester`, `creator`, `followers`, `votes`, `area`, the releases, the dates,
`sprint`, the time tracking numbers and every custom field. Boards and backlogs always use their
rank order.

### Using a saved search in a query

`savedSearch = "Open bugs"` (or its number) stands for that saved search's condition. It takes
`=`, `!=`, `IN` and `NOT IN`, ignores the saved search's order, and refuses searches that refer
to each other in a circle. When two saved searches you can see share a name, your own wins.

### Not available yet

Fields and functions of service tracks and journeys (approvals, SLAs, customer groups, request
forms), `lastViewed`, teams in `membersOf()` and `cascadeOption(parent, none)` are part of the
language but refused with a message that says so.

## The Jira-compatible dialect

Every query box also reads the Jira-compatible names of fields and functions, in any case; there
is nothing to switch. `stage` also takes `"To Do"`, `"In Progress"` and `"Done"`. These two
queries mean the same:

```text
track = PAY AND type = Bug AND targetRelease IN upcomingReleases() AND requester = currentUser()
project = PAY AND issuetype = Bug AND fixVersion IN unreleasedVersions() AND reporter = currentUser()
```

| Native | Jira-compatible names accepted |
|---|---|
| `track`, `parentTrack`, `trackType`, `trackCategory` | `project`, `space`; `parentProject`; `projectType`; `category` |
| `type`, `key` | `issuetype`; `issuekey`, `issue` |
| `requester`, `follower`, `followers` | `reporter`, `watcher`, `watchers` |
| `closeReason`, `closed`, `stage` | `resolution`, `resolutiondate` or `resolved`, `statusCategory` |
| `due`, `created`, `updated` | `duedate`, `createdDate`, `updatedDate` |
| `area`, `targetRelease`, `foundInRelease` | `component`, `fixVersion`, `affectedVersion` |
| `effortRatio`, `timeEntryComment`, `timeEntryDate` | `workRatio`, `worklogComment`, `worklogDate` |
| `visibilityLevel`, `savedSearch` | `level`, `filter` |
| `ticketLink`, `ticketLinkType`, `parent` | `issueLink`, `issueLinkType`, `"Epic link"` |
| `followedTickets()`, `votedTickets()`, `ticketHistory()`, `linkedTickets()` | `watchedIssues()`, `votedIssues()`, `issueHistory()`, `linkedIssues()` |
| `tracksOwnedByUser()`, `tracksWhereUserHasRole()`, `tracksWhereUserHasPermission()`, `areasOwnedByUser()` | `projectsLeadByUser()`, `projectsWhereUserHasRole()`, `projectsWhereUserHasPermission()`, `componentsLeadByUser()` |
| `standardTicketTypes()`, `subticketTypes()` | `standardIssueTypes()`, `subTaskIssueTypes()` |
| `shippedReleases()`, `upcomingReleases()`, `latestShippedRelease()`, `earliestUpcomingRelease()` | `releasedVersions()`, `unreleasedVersions()`, `latestReleasedVersion()`, `earliestUnreleasedVersion()` |

## Saved searches

The **Saved searches** bar on the search page keeps queries for later.

- **Choose a saved search** lists those you can see (others' with their owner's name);
  **Open** shows its query, its columns and its results.
- **Save search** stores the query and the columns under a **Name** of your choice. With one of
  your own open, **Save** writes the current query into it and **Save as new** makes a copy.
- **Share** sets **Who sees this saved search**: **Only me**, **Everyone signed in** or
  **Anyone, also without signing in**, then **Save sharing**. Sharing needs the **Share saved
  searches** permission. Sharing with particular people, groups or tracks is done through the
  [REST API](../admin/rest-api.md); saving here replaces such shares.
- **Star** marks a saved search.
- **Subscribe** emails you its results: **How often** (**Every day**, **Every week** on a chosen
  day, or **Every month** on a day from 1 to 28), **At** an hour, and **Only when something
  matches**. Press **Subscribe by email**; the page says when the first email goes out.

Each email lists up to 50 tickets with a count and a link to the search. The query runs as you,
in your time zone, so it never shows a ticket you may not see. Emails need outgoing mail set up
by your administrator.

## Search results

Results show as a table, fifty tickets at a time; **More results** adds the next fifty. The
count above says how many tickets match. Beyond 10,000 it is an estimate, "About 120,000 tickets",
or "More than 10,000 tickets" when an estimate would not be close enough.

- **Columns** chooses the columns: move them up or down, remove them, **Add a column** (system
  fields and custom fields) and **Default columns** to start again. The key always comes first.
  Your columns are kept in this browser; a saved search keeps its own.
- Cells of the summary, assignee, priority, labels, dates and simple custom fields have an edit
  button. Change the value and press **Save**, or Escape to cancel. The change goes through the
  same checks as on the ticket, and a refusal shows on the cell.
- **Export** offers **Export CSV** and **Export JSON**. The file holds every ticket the query
  finds, not only the ones shown, in the columns shown and the query's order. In CSV, lists are
  joined with "; " and a cell that a spreadsheet would run as a formula starts with an
  apostrophe.
