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

## Consequences

- Any page can put its own actions in the palette; the ticket view is the first.
- Recent follows the person across browsers, unlike browser storage, at the cost of a write per
  ticket opened (an upsert and a trim of one person's rows).
- Not yet: Recent in the sidebar, starred tickets and a worked-on list (AGL-019), the
  recommended list (mentions arrive in the inbox, M1-058), templates that keep custom fields.
