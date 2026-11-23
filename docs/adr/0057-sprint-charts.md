# ADR-057: Sprint charts computed from report events, drawn as plain SVG on chart tokens

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-060

## Context

RPT-001 asks for the Scrum board reports: burndown, burnup, the sprint report and velocity,
with scope-change markers. Its first acceptance check: a burndown of a fixture sprint matches
hand-computed values at each day, including scope added mid-sprint. M1-060's done-when: golden
dataset outputs match expected numbers. M1-059 (ADR-056) made every past state a fold of report
events, and M1-044 (ADR-054) already writes the sprint's scope changes with the estimates of the
moment. The web had no charts yet; M1-061 (control chart, cumulative flow), M1-062 (release and
outcome burndowns) and M1-064 (dashboard widgets) will draw more of them, so the first charts set
the form for all of them. ADR-033 asks for phones without sideways scrolling; ADR-024 for axe in
both skins and identity that is never color alone.

## Decision

- **Computed from events only.** `apps/server/src/reports/sprint-charts.ts` is a pure function of
  the sprint, the board's estimation statistic, the done statuses (the rightmost column) and the
  report events of every ticket ever in the sprint. It returns the start, every step after the
  start with its cause (added, removed, completed, reopened, estimate), the value at the end of
  each local day, the guideline from the starting remaining to zero at the planned end, and the
  end. A past day never changes when tickets are edited later.
- **The value of a ticket** is 1 (ticket count), the original estimate or a number field. With
  time tracking on and the original estimate as the statistic, the remaining estimate burns down,
  so logged work lowers the line. The sprint's own completion rows are ignored: completing a
  sprint ends the chart, it does not empty it.
- **Days are the viewer's days.** Day ends are local midnights in the query's time zone, else the
  person's, else UTC (`instantOf`, so half-hour and +14 zones work). Answered on 2026-11-16
  (T-280): the person's zone is the one saved on their account, else the device's the web app
  sends; the account's now comes before the device's (`viewerTimeZone`, ADR-010 "One clock per
  person").
- **Visibility.** Only tickets the viewer can see count, in the burndown and in velocity, so a
  chart never leaks the size of hidden work.
- **Velocity** reads `sprint_change` snapshots of the last N closed sprints (default 7, at most
  50): committed is the sum at the start, completed the sum at completion, by the board's
  current statistic, oldest first, with the average completed.
- **Drawn as plain SVG in React** (`apps/web/src/reports`): `LineChart` and `ColumnChart` measure
  their box and draw at its width, so they never scroll sideways. The marks follow one
  form: 2px lines, an end dot ringed in the surface color with the last value beside it,
  columns of at most 24px with a 2px gap and a 4px rounded data end, hairline grids, round
  ticks in the displayed unit, a legend from two series on, a crosshair or band with every
  value on hover, and a `details` table with the numbers for keyboards, screen readers and
  print. Category labels wrap to two lines, or thin out to every k-th, before they collide.
  Where a later data line has the same two values as an earlier one from one point to the next,
  that stretch of the earlier line is drawn again, 6px wide, beneath both, so neither hides the
  other; the rest of every line keeps the 2px form (T-359: quiet days at 0 and 0 widen only
  themselves on Created vs closed, never the whole line).
- **Chart tokens.** `--color-chart-1`, `--color-chart-2` and `--color-chart-guide` in
  `tokens.css`, chosen per skin (light `#2a78d6` and `#eb6834`, dark `#3987e5` and `#d95926`),
  checked for lightness band, chroma, colorblind separation and contrast against each skin's
  surface. Text wears text tokens, never a series color. Series hues are assigned in fixed order.

## Options considered

| Option | For | Against |
|---|---|---|
| Plain SVG components on chart tokens (chosen) | No dependency; full control of marks, labels and table; theming is CSS | Each new form is written by hand |
| A charting library (Recharts, visx, ECharts) | Many forms ready | Bundle weight; its own theming and accessibility model to override; harder to keep labels from colliding at phone widths |
| Server-rendered images | Same picture everywhere | No hover, no table, no skins; a request per resize |
| Burndown from daily snapshots | Cheap reads | Steps inside a day are lost; snapshots can drift from the history (ADR-056) |

## Consequences

- Golden tests compare the chart computation with hand-computed days (UTC and Kiritimati), and
  the routes with a fixture sprint that adds scope mid-sprint, changes estimates and hides a
  track from one viewer.
- New forms (M1-061, M1-062, M1-064) reuse `chart.ts` (round ticks, measured width), the chart
  classes in `charts.css` and the tokens; a third series hue is added to the tokens, validated
  the same way, before any chart needs it.
- Velocity uses the board's current statistic for every sprint. The snapshots hold the ticket,
  the original and remaining estimates and the board's number field of the moment, so a switch
  between ticket count and time recomputes past sprints exactly, while a switch to another number
  field keeps past sprints on the field they had.
- Not yet: scope-change markers on the line (the steps carry the causes; the sprint report
  lists the tickets added after the start), velocity per team (RPT-001 (2)), and a sprint
  selector on the report page.
