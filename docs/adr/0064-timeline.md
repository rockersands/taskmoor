# ADR-064: The timeline reads dates and roll-ups in one request and reschedules through tickets

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-048

## Context

AGL-015 asks for a Gantt timeline of one track: parent-child nesting, parent dates set by hand
or rolled up from children, Scrum children dated by their sprint, dependency lines from links,
zoom by weeks, months and quarters, sprint and release markers, drag to reschedule, side-panel
editing and progress roll-up. Its checks: a parent's rolled-up bar spans its earliest child
start to its latest child due; dragging a bar updates start and due dates; roll-ups stay on for
tracks of over 10,000 tickets. M1-048 adds a render budget: 2,000 tickets in under 1.5 s.
Tickets already have start and due days, a parent and a level (M1-007, M1-011), links with
types (M1-019) and sprints (ADR-054).

## Decision

- **One read** (`GET /api/v1/tracks/:keyOrId/timeline`, `routes/timeline.ts`): the track's
  tickets the viewer sees through the search compiler (`track = KEY`), in rank order, the first
  5,000. A ticket's days are its own; one without any that sits in a sprint takes the sprint's
  start and end (an open sprint first, else the latest) and says so (`dated: 'sprint'`).
- **Roll-ups in the database**: one recursive statement over every visible ticket of the
  track gives each ticket with children the earliest start and latest due of all its
  descendants (their own or sprint days) and how many of them are closed. It never depends on
  the 5,000 listed, so roll-ups stay on for any size (measured: 12,001 tickets, p95 400 ms
  under load).
- **Dependencies** are links whose type's outward phrase is "blocks" (the shipped Blocks type
  and any custom type that reads the same), between listed tickets. **Markers**: sprints with
  dates of boards in the track's space, and the track's releases with a date that are not
  archived.
- **Rescheduling is the ticket's own change**: the web sends `PATCH /tickets/:key` with
  `startDate` and `dueDate`, so the "Schedule tickets" permission, history and events apply as
  anywhere. A bar moved keeps the days it had (a ticket with only a due day keeps only that);
  one dated by its sprint gets days of its own. The timeline is read again after every change.
- **Web** (`apps/web/src/timeline`, `#/tracks/<KEY>/timeline`, linked from the summary): a
  sticky column of tickets (children under parents, collapsible, each parent with "n of m
  closed") beside lanes that scroll together; bars in the chart blue, sprint days hatched,
  roll-ups outlined with the closed share filled, sprints as bands, releases as dashed lines,
  today marked; elbow lines for dependencies (dashed in the danger colour when the blocked
  ticket starts before its blocker is due). Drag a bar to move it or its ends to change one
  day; Alt with the left or right arrow moves a focused bar a day (a week with Shift); a bar,
  or "No dates" on an unscheduled ticket, opens a side panel with both days, where its days
  come from and its dependencies. Rows are 44px everywhere; phones get a narrower column and
  the panel below. Zoom: 28, 8 or 3 pixels a day. No virtualisation: 2,000 rows render under
  the 1.5 s budget (story `TwoThousandTickets`, Chromium, both skins).

## Options considered

| Option | For | Against |
|---|---|---|
| Roll-ups in one recursive statement (chosen) | Right for any track size; one round trip | A second pass over the track per read |
| Roll-ups in the browser from the listed tickets | No server work | Wrong once a track has more than the listed tickets (AGL-015 (3)) |
| Stored roll-up dates kept by triggers | Fast reads | Writes on every date change up the tree; drift to repair |
| A timeline-specific reschedule route | Could move many at once | A second path for date rules, permission and history |

## Consequences

- A parent's own days and its roll-up can disagree; the bar shows its own days and the panel
  says its children's span. Rolling a parent's own days to its children on demand is later.
- Dependency lines are drawn between listed tickets only; links to tickets beyond the first
  5,000 or in other tracks do not show.
- Saved timeline views (AGL-020), cross-track timelines and dragging rows to change parents
  come later.
