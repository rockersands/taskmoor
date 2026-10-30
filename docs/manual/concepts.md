---
title: "Concepts and terms"
audience: everyone
sources: docs/specs/00-terminology.md, docs/specs/01a-core-work-tracking.md, docs/specs/01b-core-work-tracking.md, docs/adr/0009-configuration-model.md, docs/adr/0039-workflows-as-versioned-data.md, docs/adr/0045-workflow-maps.md, docs/adr/0049-boards.md, docs/adr/0053-saved-searches.md, docs/adr/0054-sprints.md, docs/adr/0060-dashboards.md, apps/server/src/tracks/model.ts, apps/server/src/tickets/hierarchy.ts, apps/server/src/tickets/followers.ts, apps/server/src/routes/tickets.ts, apps/server/src/routes/releases.ts, apps/server/src/routes/priorities.ts, packages/db/src/migrations/0004_authorization.ts, packages/db/src/migrations/0011_ticket_types.ts, packages/db/src/migrations/0018_ticket_fields.ts, packages/db/src/migrations/0024_workflows.ts, apps/web/src/i18n/messages.en.ts
accessed: 2026-10-30
attestation: own-words
---
# Concepts and terms

Taskmoor names the parts of a work tracker in its own words. This page is a short tour of those
parts and how they fit together, from the site down to a single ticket. A glossary at the end
gives each term in one line.

## The site

One Taskmoor installation is a **site**. People, groups, roles, statuses, priorities, close
reasons and hierarchy levels belong to the whole site, so every track sees the same lists.

Two global permissions run it:

- **Run the site** (site administrators): everything, including people and sign-in.
- **Change configuration** (configuration administrators): tracks, ticket types, fields and
  workflows, without managing people.

See [permissions and access](admin/permissions.md) for the rest.

## Tracks

A **track** holds tickets, the configuration they follow and the people who work in it. Each
track has a **track key** of 2 to 10 capital letters or digits that starts with a letter, such as
`PAY`, and a **track owner**. Changing a key later keeps the old one working.

### Track types

A **track type** is a starting set of features. All four types use the same ticket engine.

| Track type | Features turned on when the track is made |
|---|---|
| software | board, backlog, sprints, releases, development, forms, approvals, calendar, timeline |
| business | board, forms, approvals, calendar, timeline |
| service | as business |
| discovery | board, forms, timeline |

Service-desk and discovery features are not in this release yet, so service and discovery
tracks work like the others with their own starting features.

### Shared mode and local mode

Every track is made in one of two modes, and keeps it:

- **Shared mode**: the track uses configuration that other tracks use too (its access policy,
  ticket types, workflows, field rules and so on). Site and configuration administrators change
  that configuration, and a change reaches every track that uses it.
- **Local mode**: the track gets its own copies. Its own administrators change them, and nothing
  they change reaches another track.

[Tracks](admin/tracks.md) covers making and running tracks.

## Tickets and keys

A **ticket** is one piece of tracked work. Its **ticket key** is the track key and a number,
such as `PAY-42`; tickets are numbered in order within their track. A ticket keeps answering to
its old keys when the track key changes or the ticket moves to another track.

Every ticket has a summary (up to 255 characters) and may have a description, an assignee, a
**requester** (the person it is for), dates, labels, estimates, comments, attachments, links to
other tickets and web links. Every change is kept in its history. See
[working with tickets](use/tickets.md).

## Ticket types and the hierarchy

A **ticket type** says what kind of work a ticket is. Each type sits at a **hierarchy level**,
and a ticket's parent sits one level above it.

| Level | Default name | Default ticket types |
|---|---|---|
| 1 | Outcome | Outcome |
| 0 | Standard | Feature, Bug, Chore (software); To-do (business); Idea (discovery) |
| -1 | Subticket | Subticket |

- An **outcome** is a result that several tickets deliver together.
- A **subticket** is a smaller part of one ticket. It always has a parent in the same track and
  moves with it.
- Administrators rename levels and types, add levels above Outcome (for example Objective at
  level 2) and put several types on one level.
- A parent may sit in another track, as long as you may see both tracks.

A **type set** decides which ticket types a track offers, in which order, and which one is
preselected. See [fields, ticket types and layouts](admin/fields.md).

## Workflows, statuses and stages

A **status** says where a ticket is now, such as Active or In Review. Every status belongs to
one of three **stages**, which give it a colour and a meaning:

| Stage | Meaning | Colour |
|---|---|---|
| New | Not started yet | Grey |
| Active | Being worked on | Blue |
| Closed | Finished; reports count it as done | Green |

A **workflow** is a set of statuses and the **transitions** between them, with an initial status
where new tickets start. A transition can have:

- **guards**: who sees it and may run it;
- **checks**: what must hold before it completes;
- **effects**: what happens after it, such as assigning the ticket.

A **workflow map** says which workflow each ticket type follows in the tracks that use the map.
The default workflow goes from New to Active to In Review to Closed, with a Reopen back to New.
See [workflows](admin/workflows.md).

## Close reasons

A **close reason** says why a ticket was closed. The defaults are Completed, Not planned,
Duplicate and Not reproducible. Setting a close reason stamps the ticket's **Closed** time;
clearing it clears the stamp. In the default workflow, the Close transition asks for a close
reason and Reopen clears it.

## Priorities

Priorities rank how urgent a ticket is: **Urgent**, **High**, **Normal** and **Low** by default.
The list belongs to the site; a **priority set** chooses which priorities a track offers and
which one new tickets get. In the default set it is Normal.

## Areas

An **area** is a part of a track's work, such as "API" or "Billing". It has an **area owner**
and a rule for new tickets that name no assignee: give them to the area owner, to the track
owner, or to nobody. A ticket may be in several areas.

## Releases

A **release** is a version of what a track delivers, with a name, dates and a place in the
track's order. Tickets point at releases through two fields:

- **Target releases**: where the work is meant to ship.
- **Found in releases**: where a problem was seen.

A release is upcoming until someone **ships** it; it can also be archived. Shipping can wait for
approvals from named people.

## Boards

A **board** shows tickets as cards in columns, each column holding one or more statuses. A board
reads its tickets from a query, its own or a saved search's, so one board can cover several
tracks.

- A **Scrum** board plans work in sprints from its backlog; a **Kanban** board shows continuous
  flow.
- Swimlanes group cards by query, assignee or parent.
- **Board filters** narrow the cards with one click; several active filters combine.
- Columns can have minimum and maximum work-in-progress limits.

See [boards, sprints and the backlog](use/boards.md).

## Sprints

A **sprint** is a timebox on a Scrum board: it is planned, started and completed. A ticket is in
at most one open sprint at a time; unfinished tickets carry over to the next one.

## Saved searches

A **saved search** is a query in Taskmoor's query language with a name. You can share it with
people, groups or a track, star it, and subscribe to its results by email. Boards and dashboard
widgets can read their tickets from one. See [search and the query language](use/search.md).

## Dashboards and widgets

A **dashboard** is a page of **widgets** in one to three columns. A widget shows one thing, such
as a list of search results, a pie chart, created vs closed tickets or a sprint burndown.
Widgets store only their settings: each person sees the data they may see. See
[dashboards and reports](use/dashboards-and-reports.md).

## Followers

**Followers** are the people who follow a ticket to hear about its changes. By default you follow
the tickets you create, edit or comment on; you can turn that off. People can also vote for a
ticket. See [notifications and your inbox](use/notifications.md).

## Glossary

| Term | Meaning |
|---|---|
| access policy | Who may do what in the tracks that use it |
| area | A part of a track's work, with an owner |
| area owner | The person responsible for an area; may get its new tickets |
| board | Tickets as cards in columns of statuses |
| board filter | A one-click narrowing of a board's cards |
| check | A rule a transition's ticket must pass before the transition completes |
| close reason | Why a ticket was closed |
| Closed | The time a ticket got its close reason |
| configuration set | A shared or track-owned piece of configuration a track names, such as a type set |
| dashboard | A page of widgets |
| effect | Something a transition does after it runs |
| field rule set | Which fields are required or hidden, with help text, per ticket type |
| followers | People told about a ticket's changes |
| found in release | The releases where a problem was seen |
| guard | Who sees a transition and may run it |
| hierarchy level | A ticket type's place in the parent and child ladder |
| layout set | How create, edit and view forms arrange fields, per ticket type |
| local mode | A track that owns its configuration |
| outcome | A level-1 ticket: a result several tickets deliver |
| priority set | The priorities a track offers, and the default |
| release | A version a track ships |
| requester | The person a ticket is for |
| saved search | A named, shareable query |
| shared mode | A track that uses configuration shared with other tracks |
| site | One Taskmoor installation |
| sprint | A timebox on a Scrum board |
| stage | New, active or closed: what a status means |
| status | Where a ticket is in its workflow |
| subticket | A level -1 ticket: part of another ticket |
| target release | The releases a ticket is meant to ship in |
| ticket | One piece of tracked work, such as `PAY-42` |
| ticket type | The kind of work a ticket is |
| track | A container of tickets, configuration and people, such as `PAY` |
| track owner | The person responsible for a track |
| track type | software, business, service or discovery: a starting set of features |
| transition | A move from one status to another |
| type set | The ticket types a track offers, in order |
| widget | One item on a dashboard |
| workflow | Statuses and the transitions between them |
| workflow map | Which workflow each ticket type follows |
