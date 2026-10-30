# ADR-060: Dashboards as owned pages of typed widgets, shared like saved searches

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-064

## Context

RPT-004 asks for personal and shared dashboards with configurable layouts, an administrator's
default dashboard, wallboard mode, sharing to people, groups, roles, everyone signed in or the
public, and embed links; its first check: a widget shows only tickets the viewer may browse, even
on a shared dashboard. RPT-005 asks for the widget catalog of spec 01c section 1.2, each widget
with a rendering test; M1-064 scopes it to about fifteen core widgets plus track summary pages.
Saved searches (ADR-053) already have the sharing model, and the general and agile reports
(ADR-057 to ADR-059) already compute what most widgets show.

## Decision

- **Tables (migration 0054).** `dashboard` (owner, name, description, layout of one to three
  columns, `widgets` as a JSON array, `is_default`, version) and `dashboard_share` with the
  scopes of `saved_search_share`. The share code is one module for both
  (`apps/server/src/sharing/shares.ts`), and sharing needs the same global permission, which the
  terminology already names "Share dashboards and saved searches".
- **Visibility**: the owner, those a share reaches, every signed-in person for the default
  dashboard, anonymous visitors for public ones; site administrators see all. Otherwise 404, as
  for a dashboard that does not exist. The owner and site administrators change and delete one;
  only site administrators change its owner. Site and configuration administrators choose the
  default (`PUT /api/v1/dashboards/default`); the default cannot be deleted while it is one.
- **Widgets are typed settings, not stored results.** Each kind has a schema
  (`dashboards/model.ts`): a query, fields to group by, a board, a period, a row count, text or
  links. They are checked on save (unknown kinds, bad settings, duplicate ids and unsafe links
  are refused by path, defaults are filled in, ids are made for new ones), kept in order with
  their column, and a widget beyond a smaller layout's last column moves to it. Nothing a
  widget stores grants anything: its data is computed as the viewer from these settings.
- **Core widgets (sixteen)**: introduction, quick links, search results, assigned to me,
  followed tickets, created vs closed, recently created, average age, time to close, pie chart,
  ticket statistics, two-dimensional statistics, sprint burndown, sprint health, days remaining
  in the sprint, average time in status. The rest of section 1.2 follows in later tickets.
- **Widget data** comes from `GET /api/v1/dashboards/:id/widgets/:widgetId`
  (`dashboards/widgets.ts`): lists run through the search runner as the viewer, counts and
  periods through the general reports (ADR-059, with average age and time to close added and
  one-field counts as two-field counts against a constant axis), sprint widgets through the
  burndown (ADR-057) on a board the viewer sees, time in status through the flow reports
  (ADR-058). Windows are the viewer's last N days. A widget that cannot show anything says why
  (`unavailable`: board not found, not a Scrum board, no active sprint, a field that does not
  group); a bad query answers 400 `invalid_query` like a search.
- **Copying** makes the person's own dashboard from one they see, without its shares.
- **Events** `dashboard.created`, `.updated` (changes; widget settings only as changed),
  `.deleted` and `.default_set` (on the workspace) are audited.

## Options considered

| Option | For | Against |
|---|---|---|
| Widgets as JSON on the dashboard (chosen) | One row read per page; order and columns with the data; one version guards edits | No SQL over widget settings (none is needed) |
| A widget table | Per-widget updates | Two writes to reorder; no gain in reads |
| A separate share model for dashboards | Independence | Two copies of the same rules to keep in step |
| Widgets that store a snapshot of their data | Fast wallboards | Shows data to people who may not see it; stale |

## Consequences

- RPT-004 (1) holds by construction: there is no path from a widget to data except running its
  settings as the viewer.
- Signed embed links, per-share edit rights, wallboard rotation settings stored on the server,
  and dashboard import (RPT-004 (3)) come later.
