# ADR-046: The home page, the create dialog and a palette that reaches every action

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-052

## Context

M1-052 asks for a create dialog that honours layouts per ticket type, ticket templates, a home
page (assigned, recent, followed) and a full command palette: "palette reaches 30 actions
keyboard-only". AGL-018 asks that every action of the ticket view's menu is in the palette and
for a Recent list in navigation; AGL-019 for a page of assigned, worked-on and viewed tickets.

What existed: the create form at `#/create` (M1-012) already asks the backend for the layout of
a track and type and shows its refusals per field; the palette held fixed navigation commands;
search with the permission filter in the statement arrived with M1-037; followers with M1-015.
Nothing recorded which tickets a person opened.

## Decision

- **The palette takes commands from the page that shows.** `PaletteCommandsProvider` holds
  commands by owner; a page calls `usePaletteCommands(owner, commands)` while mounted. The
  setter never changes identity (pages do not render again when another page's commands change).
  Commands carry `values` for their label (a ticket key). The ticket view adds each transition,
  assign to me, unassign, follow or stop following, vote or take it back, comment, edit the
  summary, its activity tabs, copy the link and its shortcuts; signed in, the app adds the skins
  and sign out. Matches on the label come before matches on a keyword only.
- **Creating is a dialog over the page**, opened by a New ticket button in the top bar, C outside
  fields and the palette. It is the same form component as `#/create` (kept for links) in a
  dialog variant: focus moves in and comes back, Tab stays inside, Escape and the backdrop close.
- **A ticket template is a ticket.** "Start from a ticket" copies a ticket's track, type,
  summary, description, environment, priority, labels and dates into the form; people, releases
  and custom fields stay the new ticket's own. No template objects: a saved ticket serves, and
  CORE-004 (track templates, M2) is a different thing.
- **The home page has three lists.** Assigned is a search (`assignee = currentUser() AND stage
  != closed ORDER BY updated DESC`); followed and recently opened are `GET
  /api/v1/me/followed-tickets` and `GET /api/v1/me/recent-tickets`. Both read tickets through
  the same filter as search (browse permission, ticket grants, visibility levels, not in the
  trash): following or having opened a ticket gives no access of its own.
- **Visits are personal history in `ticket_visit`** (migration 0046): one row per person and
  ticket with the last time, the latest 50 kept. The ticket view records a visit with `PUT
  /api/v1/me/recent-tickets/:id`, which emits no domain event (exempt in the contract test, like
  other personal or transient state): a visit changes nothing anyone else sees, and an event per
  page view would swamp the log, the audit trail and sync.

### Your tracks: the tracks a person belongs to (T-194, 2026-11-03)

Home's **Your tracks** (T-089h, ADR-114) first listed every track the person could see. It now
lists the tracks they belong to, which the server decides: `GET /api/v1/tracks?member=true`
(`tracks/membership.ts`) keeps, among the tracks the caller may see, those where

- they hold a role, given to them or to a group they are in (nested groups included);
- they are the owner (the track's lead, whom the default policy lets run it);
- a team of theirs (ADR-076) owns one of the track's areas that is not archived, or the track's
  board belongs to that team.

Seeing is not belonging: a track open to anyone or to everyone signed in, a grant of the access
policy to the person or a group (a policy is often shared by many tracks, so such a grant says
nothing about one track), and the rights of site and configuration administrators all leave a
track out. A team still grants nothing: it only says who works on a track the person may already
see, so belonging never shows a hidden track.

- **A filter, not a flag:** the list keeps paging and counting right. A page holds at most 500,
  and a person can belong to more: whoever makes a track joins the role that runs it, so an
  administrator who made 600 shared tracks belongs to all 600. Home therefore never relies on the
  first page alone for the tracks opened lately.
- **The tracks opened lately are asked for by key:** Home sends the keys this browser remembers
  (at most twelve; the list takes 50) as `GET /api/v1/tracks?member=true&keys=…`, and the server
  answers those the person still belongs to and may see. The first page (`limit=500`, by key)
  fills the rest of the section. Two requests in parallel, never a walk through every page; a
  key the browser kept that is no longer theirs simply does not come back.
- **The order stays in the browser:** the latest opened first (`tracks/recentTracks.ts`, local
  storage), then by name among the first page. Unlike recent tickets it does not follow the
  person to another browser; the manual says so.
- **In no track,** the section says so and leads to the Tracks page, with New track beside it for
  those who may make one. With more than six, **All tracks** leads there too.

## Consequences

- Any page can put its own actions in the palette; the ticket view is the first.
- Recent follows the person across browsers, unlike browser storage, at the cost of a write per
  ticket opened (an upsert and a trim of one person's rows).
- Not yet: Recent in the sidebar, starred tickets and a worked-on list (AGL-019), the
  recommended list (mentions arrive in the inbox, M1-058), templates that keep custom fields.
