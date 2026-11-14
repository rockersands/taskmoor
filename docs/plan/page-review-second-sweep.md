# Page review: the second sweep (2026-11-14)

T-258. A fresh sweep of every route on `main` at `488632e0` (164 routes and states; phone routes captured by the window with touch emulation kept, so they show what a phone shows). Four readers checked each earlier fault in `page-review-findings.md` and looked for new ones; a second reader checked every new fault against the images, and only the confirmed ones are listed here. A fifth reader went through the measurements.

| Group | Earlier faults fixed | Still there or changed | New, confirmed (medium / low) |
|---|---|---|---|
| The track sections | 25 | 7 | 20 (7 / 13) |
| Your work and planning | 39 | 10 | 22 (6 / 14) |
| Administration and setup | 34 | 9 | 17 (2 / 15) |
| Account, stand-alone pages and states | 21 | 1 | 10 (1 / 9) |
| All | 119 | 27 | 69 |

No earlier phone fault was a capture artefact once phones were captured by the window: the flat band under long pages and the different top bar do not appear. Sideways scroll is 0 at every width, axe finds nothing, and the 126 small controls the probe counts are all timeline key links and one-day bars on two routes (judged false positives in the measurements' review, but see the timeline rows below). Every failed request and console error is expected (sign-in checks, not-found routes). One measured fault is real: the file input on the import page has an unclear name.

## The track sections

### The earlier faults

| ID | Verdict | Evidence |
|---|---|---|
| TR-1 | Fixed | track-list--375--dark/light and track-list-es--375--light: stacked rows (key; summary across the full width; then status, assignee, priority mark). No words break mid-word. The page is 6744 css tall (it was 8474). |
| TR-2 | Fixed (not in a real phone picture) | Window captures show no flat band. track-list--375--light--10 ends at 'Show more', 'New ticket...' and 'Add ticket' over the normal gradient. track-kanban-board--375--dark--7 shows the gradient down to the bottom edge. The earlier band came from the full-page capture. (The kanban page's extra height has a different cause, listed as a new fault.) |
| TR-3 | Fixed (not in a real phone picture) | One-window pages (track-outcomes--375--dark, track-statistics-velocity--375--dark, track-not-found--375--dark, all 812 tall) have the same top bar as long pages: hamburger, +, a 'Search' field, ?, theme, avatar, all at the same sizes. The narrower field and larger controls came from the capture. |
| TR-4 | Fixed | The tab strip scrolls the current tab into view: Outcomes (track-outcomes--375--dark), Statistics at the right end (every statistics 375 shot), List (track-list--375--dark). A tab cut at the edge and fading out ('comes', 'Timelin', 'Cale' in Spanish) shows that more tabs exist. |
| TR-5 | Fixed | On phones a single 'Report' select replaces the pills (D5). track-statistics--375--dark: the chart card starts at about 585 css, inside the first window. |
| TR-6 | Fixed | track-statistics--1280--light: group labels sit in their own column at x=288. Every pill row, wrapped 'Ticket statistics' included, starts at x=440. |
| TR-7 | Fixed | Phones show the touch wording on board, kanban board, backlog, calendar and timeline. Examples: track-board--375 'Drag a card by its grip to another column, or tap the grip for a menu of every move'; track-timeline--375 'Drag a bar to move it, or tap it to set its dates'. The first kanban card is at about 655 css. Desktop keeps the keyboard paragraph. |
| TR-8 | Changed | track-list--1280--light: dates no longer wrap, but the longest ones are now cut at the card's right edge ('Sep 15, 2026, 12:00 PM' and 'Aug 29, 2026, 12:00 PM' lose most of 'PM' at x about 1243; Spanish fits). Summary is still a column of about 200 px (x 495-695) that wraps to 4 lines (MOB-52). Key holds about 200 px for a 60 px key. Names wrap ('Chen / Wei'). The pencils still sit right against the next column's content (assignee pencil at x about 970, priority mark at about 1012). |
| TR-9 | Changed | Keys are whole at both widths ('MOB-21', 'MOB-30'), only summaries end in an ellipsis, and the month reads 'November 2026'. At 1280 the today line (x=758) now runs along the left edge of the 'No dates' chips (760-833). At 375 (light and dark) the today line at 2x x about 457 still runs through every 'Earlier' chip (chips x 340-475) and crosses its 'r'. |
| TR-10 | Fixed | track-timeline--1280: the card's right edge is at x about 1243, like its neighbours. The opacity is kept as built (T-213). |
| TR-11 | Fixed | track-statistics-sprint-report--375--dark--2: key and summary on the first row, then status and the estimate dash together on a second row, under an 'Estimate' heading. |
| TR-12 | Fixed | track-statistics-time-in-status--375--dark--2 and release-burndown--375--dark--2: the first column fits ('In Review' on one line), no cell breaks mid-word, and the cut header ('Averag', 'A') fades out at the card's edge (the D2 cue). The two-dimensional table still has a problem; see the new faults. |
| TR-13 | Changed | Fixed on sprint report and velocity (both widths): a 'No estimates to add up' card. Still there on track-statistics-release-burndown--1280: '0 remaining of 2; 2 done. All the work is done.' sits over a flat zero line, and 'Work per sprint' draws 0/0 bars with Completed 0 for both sprints. The same on outcome-burndown--1280: '12 remaining of 15; 3 done' over bars and a table of 0 completed. |
| TR-14 | Fixed | track-statistics-sprint-report--1280: no bare totals. Two cards fill the row (y 655-907). |
| TR-15 | Fixed | track-statistics-release-report--1280/375: 'Shipped on Aug 18.' with no forecast sentence. The Releases page says 'Shipped on Aug 18, 2026'. |
| TR-16 | Fixed | track-outcomes--375--dark: 'MOB-49' stays on one line with the flag beside it. track-outcomes and track-releases--1280 use the same thin bar and row divider. |
| TR-17 | Fixed | track-calendar--375--dark: only days with items, headed 'Sun, Nov 8', 'Thu, Nov 12', 'Sat, Nov 14' and so on. Page is 1009 css. |
| TR-18 | Fixed | track-calendar--1280--light: the two chips on Nov 14 read 'Sprint 1' and 'Sprint 2' (x 975-1100, y 644 and 663). Start chips still begin with 'Starts:'. |
| TR-19 | Fixed (measured) | axe is empty on all four calendar captures (and on every capture in the group). |
| TR-20 | Fixed (measured) | No small control on track-backlog, board-backlog or the Spanish backlogs at 375. Small controls in the group are now only on track-timeline. |
| TR-21 | Still there | measurements: track-timeline--375--light/dark, buttons 'MOB-8', 'MOB-49' and 'MOB-53: Nov 14, 2026 to Nov 14, 2026' are 28x44. |
| TR-22 | Changed | Keys line up now (track-backlog--1280: MOB-11 with no priority icon starts at the same x as MOB-10), and the sprint report's summaries sit in a table column at x=399. On the backlog, summaries still start where the key ends: MOB-2 at x about 508, MOB-31 at about 516, MOB-32 at about 518. |
| TR-23 | Fixed | track-board--1280, track-kanban-board--1280, track-board-es--1280: the Closed column fades out at the right edge (cards 'Offline queue is s…' fade from x about 1180 to 1240). |
| TR-24 | Fixed | board-settings--1280--light: every checked box is terracotta and every box is the same size (the first box at y about 778 matches the 'Fields on cards' boxes at about 2895). In dark (control-chart--1280--dark) the unchecked boxes are dark with a light border, not flat grey squares. |
| TR-25 | Still there | board-settings--1280--light 'Estimate with': 'A number field, such as story points'. board-settings-es: 'Un campo numérico, como los puntos de historia'. The catalogue on main still has it at messages.en.ts line 5711. |
| TR-26 | Fixed | The purpose line now reads 'How this board works: its columns, swimlanes and filters, what a card shows and its sprints.' |
| TR-27 | Fixed | track-templates--1280/375: the tab bar is shown, the title is 'Ticket templates' under 'Mobile apps', the line speaks of 'this track, those for every track included', and there is no back pill. No tab is selected there (see the new faults). |
| TR-28 | Fixed | The help mark sits beside the title on Summary, Board, Backlog, List, Timeline, Outcomes, Releases, Files and links, Statistics, Ticket templates, Board settings and Tracks. On phones it stays on the title's line, about 30 css to the right of the title. |
| TR-29 | BLOCKED (T-240), skipped | Still mixed, for the record: the backlog side panel says 'due 2026-10-13' and Releases says 'Due on Oct 13, 2026'. |
| TR-30 | Fixed | track-summary--1280: every tile's number is at y=425 whether its label wraps or not. The cards form a 2x2 grid, and on phones the fifth tile spans the row. |
| TR-31 | No fix needed (data), skipped | |
| TR-32 | Fixed | 'Show the numbers' has a chevron and its table stays closed (statistics--1280 y=1090, release-burndown--1280 y=939). time-in-status shows its table with no disclosure line. |
| TR-33 | Fixed | track-statistics-control-chart--1280--dark: the '1' in 'Tickets in the average' (x=714, y=577) is as clear as the select text. Also clear at 375 dark. |
| TR-34 | Still there | On main, the English catalogue has 32 straight-apostrophe words against 113 curly. Example: line 66 "this track's outcomes" beside line 260 'This track’s tickets'. Seen in one place: the tracks-new dialog has 'project's' and 'ticket's' straight (y=116) and 'track’s' curly (y=452). |

Count: 25 fixed, 4 changed (TR-8, TR-9, TR-13, TR-22), 3 still there (TR-21, TR-25, TR-34), 1 blocked (TR-29), 1 no fix needed (TR-31). Remaining: 7.

### New faults (confirmed)

| Severity | Where | What | Evidence |
|---|---|---|---|
| medium | track-kanban-board--375--dark/light (windows 5-7) | On a phone the Kanban columns stretch to the tallest column's height (Closed, 24 cards). Below New's last card, the one visible column scrolls past more than a screen and a half of empty column frame before the page ends. This is not the old flat-band capture artefact (TR-2): these are window captures, and the column's border, glass and the next column's cards are visible the whole way down. | track-kanban-board--375--dark--5.png: the last card in New (WEB-68) ends at 2x y≈968, which is about 3332 css (window 5 starts at 4x712). In --7.png the empty New frame runs from the top to its bottom border at 2x y≈1540, about 4446 css, while the neighbouring column still shows cards (WEB-… 'Re… pay…') at y≈265-560. measurements.json gives a page height of 4488 and 7 windows. |
| medium | track-list--1280--light/dark | The fix for TR-8 stopped the Updated dates from wrapping, so the longest dates are now cut at the card's right edge with no cue. | Crop of track-list--1280--light at x 850-1280, y 900-1020: 'Aug 29, 2026, 12:00 PM' ends as '12:00 P' plus a partial M at the card edge (x≈1243). 'Sep 15, 2026, 12:00 PM' (MOB-31), 'Sep 15, 2026, 6:00 PM' and 'Sep 16, 2026, 12:00 AM' (MOB-11) are cut the same way. Shorter dates such as '4:00 AM' fit. |
| medium | track-not-found and board-not-found, all four shots each (the shared D4 NotFoundPage) | The primary 'Go to Home' button shows its label underlined and pinned to the top of the pill, while 'Go to Search' beside it is a normal centred button. The fault is probably in the shared not-found component, so other not-found pages likely show it too. | track-not-found--1280--light: 'Go to Home' is underlined, its text at y≈167-182 in a pill spanning y≈167-201. 'Go to Search' is centred at y=185. board-not-found--375--dark: the underlined label is at 2x y≈365-395 in a pill spanning 2x y≈362-446. 'Go to Search' is centred at y≈406. |
| medium | track-statistics-recently-created (and the other day-bucketed reports whose axis ends 'Nov 14': time-to-close, release-report, outcome-report) against track-calendar and track-list | The reports and the rest of the track disagree on what day it is. The reports put tickets created on the evening of Nov 13 (local time) on Nov 14, and their axes run to Nov 14. The calendar marks today as Nov 13. A UTC day boundary would explain this. I did not check the cause. | track-statistics-recently-created--1280--light: bar '5' on Nov 14 (x≈1200) and 0 on Nov 13. The list shows MOB-49 to MOB-53 created 'Nov 13, 2026, 9:47 PM'. track-calendar--1280--light marks 13 as today (x≈850, y≈624). The time-to-close, release-report and outcome-report axes also end at 'Nov 14'. The sweep files are stamped Nov 13 22:01 local. |
| medium | track-statistics-outcome-report--1280 (and 375) | The outcome report's chart is titled 'Release progress'. Its tiles count tickets while the chart adds up estimate points, and the axis names no unit, so the numbers seem to contradict each other. | Card for MOB-1: tiles Done 1, Still open 7, Open without an estimate 4. The chart below is headed 'Release progress', with Completed ending at 3 and Scope at 15 and no unit on the axis. The table's estimates add up to the chart: 3+8+1+3 = 15, and the closed MOB-21 = 3. |
| medium | track-statistics-two-dimensional--375--light/dark | On a phone the two-dimensional table shows only Urgent, High and Normal. Low, None and Total are off the card's edge, and the only cue is one stroke of the 'L' of Low. This is the TR-12 fault on a route the earlier review did not list, and the TR-12 cue does not show here. | track-statistics-two-dimensional--375--dark: the header shows 'Urgent High Normal' and then a single upright stroke at 2x x≈690, y≈1005. The rows end at Normal (12, 10, 3, 3, 28). At 1280 the same table has Low, None and Total (row totals 20, 19, 8, 6, 53). |
| medium | track-timeline--375--light/dark (and plan-timeline--375) | The ticket key links in the timeline's name column are 20 css tall touch targets. They are new since TR-9's fix made the keys readable. TR-21 listed only the 28x44 bars. | measurements.json, small[] for track-timeline--375--light/dark: 56 entries, of which 53 are links 79-107 x 20 ('MOB-1' 87x20, 'MOB-2' 107x20…). The rest are the three 28x44 bars. plan-timeline--375 has 123 such links. track-timeline--375--dark.png shows the underlined keys (MOB-1, MOB-5, MOB-9…) as single text lines about 20 css tall above the summaries. |
| low | track-statistics-time-to-close--1280 | The report draws a flat line on 0h, ending in the label '0h', with no explaining empty state like the control chart's. It looks like closing took no time rather than showing there is no data. | A blue line along the 0h axis from Oct 16 to Nov 14 with an end dot labelled '0h' at x≈1163-1180, y≈850. The axis shows only 0h and 1h. The summary tile 'Closed in the last 7 days' reads 0. |
| low | track-statistics-ticket-statistics--1280 | The Share bars are equal ticks of about 3 px for every share, so they show nothing. | An enlarged crop at x 1100-1240, y 660-780 shows identical short blue ticks beside 38%, 36%, 15% and 11% (x≈1178-1185). |
| low | track-statistics-two-dimensional--1280 | The Urgent column's header and numbers are left-aligned while every other column is right-aligned. | 'Urgent' and its values 2, 1, 0, 0, 3 start at x≈575. High, Normal, Low, None and Total end flush right (High values end at x≈787). |
| low | track-statistics-group-by--1280 | The Closed group's progress label wraps to three lines, '6 of / 6 / done', while the other groups' labels stay on one line. | x≈1187-1225, y≈1507-1560, beside the full bar at x≈1134-1180. New reads '0 of 20 done' on one line at y=645. |
| low | track-statistics-sprint-report--1280 (and sprint-report-closed, board-sprint-report; 375 stacks them) | TR-13's fix shows two identical 'No estimates to add up' cards side by side, with nothing saying which chart each one replaces. | Two cards at x 288-757 and 774-1243, y 655-907, each with the same picture, the heading 'No estimates to add up' and the same paragraph. |
| low | track-statistics-release-report--1280/375 | Once Completed equals Scope, its line disappears under the Scope line. The axis starts Aug 22, after the 'Shipped on Aug 18' shown above it. The late start may come from the seed data. | The blue Completed line rises at x≈392-402 to y=729 and then only the orange Scope line shows to x=1163 ('2'). The axis labels start at 'Aug 22', and the card says 'Shipped on Aug 18.' |
| low | track-calendar--375--light/dark | After the D9 change, the day-list card has almost no inner padding. Each ticket chip is about 44 css tall with its text at the top and the lower half empty. | track-calendar--375--dark: card border at 2x x≈25, chips from x≈34 (about 4 css). The heading 'Sun, Nov 8' sits about 10-12 css below the card top (2x y≈995 to 1005-1030). Chip 'Starts: MOB-50…' spans 2x y≈1040-1125 with its text at y≈1062. |
| low | track-statistics-workload-pie, -user-workload, -ticket-statistics 1280 | Copy problems. The empty state drops the measure's option label mid-sentence with its capital ('No ticket here has any Remaining estimate.'). The tables head the first column 'Value' instead of naming the field. | workload-pie--1280--light y≈645: 'No ticket here has any Remaining estimate.' The string is messages.en.ts:5013 'No ticket here has any {statistic}.'. ticket-statistics--1280--light: the header reads 'Value' over New, Active… with Field = Status (messages.en.ts:5000 'dashboards.widget.value'). |
| low | messages.en.ts (seen on track-summary 'Customize' against board-settings) | The English catalogue mixes US and British spellings. | Counted in apps/web/src/i18n/messages.en.ts: 'Customize' 2, 'customize/customizes' 2 and 'color' 1, against 'Colour' 5, 'colour(s)' 5 and 'neighbour(ing)' 2. Also 'organization' 3 against 'organisation' 3, and 'summarize' 2 against 'Summarise' 2. The track-summary--1280 button reads 'Customize'. |
| low | track-list--1280 (en, es) against track-list--375 | At desktop width an unassigned ticket has a blank Assignee cell. The phone list writes 'Unassigned'. | track-list--1280--light: MOB-45, MOB-22, MOB-6 and others have an empty Assignee cell (only the pencil). track-list--375--light--10: MOB-22 reads 'Active  Unassigned'. |
| low | tracks-new--1280--light/dark | The New track dialog's fields and help text stop at x≈780 inside a dialog that reaches x≈1000, so the right fifth of the dialog is empty. Its intro line and the Close button span the full width. | The Key, Track name, Configuration and Start from fields span x 301-780, and the help text wraps at x≈775. The dialog spans x 280-1000, and Close is at x≈943. |
| low | track-summary--1280 (also kanban-summary, local-summary) | TR-30's grid now fills its rows, but each summary card stretches to its row neighbour's height and leaves large empty areas. | track-summary--1280--light: By stage spans y 462-762 and its content ends at y≈645, so about 115 px are empty. Open by type spans y 780-1230 and its content ends at y≈1065, so about 165 px are empty. PL-37 is the same fault on plan-summary. |
| low | track-backlog--375 against track-statistics-*--375 | Checkboxes on neighbouring phone pages come in two sizes: the backlog's selection boxes are drawn about 44 css, the statistics filter box about 28 css. This may be deliberate, since the backlog boxes are touch targets, but nothing else ties the two together. TR-24 covered colour and size on board settings only. | track-backlog--375--dark: the sprint and row boxes span 2x x≈66-153 and 178-265 (about 44 css). track-statistics-workload-pie--375--dark: the 'Open tickets only' box spans 2x x≈32-88 (about 28 css). |

## Your work and planning

### The earlier faults

| ID | Verdict | Evidence |
|---|---|---|
| PL-1 | Fixed | Phone result tables are stacked rows (key, summary, then status, assignee, priority): search-results--375--dark--2/--3, plan-list--375--dark--2. No mid-word breaks. Page heights 7365 (search) and 6848 (plan list) css px, down from 8410 and 8207. |
| PL-2 | Fixed | plan-capacity--1280--light shows four periods (Nov 2 to Dec 27) and 'Open, no due date' (x 1092-1243) inside the card, with Earlier and Later controls (y=363). |
| PL-3 | Fixed | state-command-palette--1280--light and --375--dark: the palette is opaque and the whole page, top bar included, is veiled. |
| PL-4 | Already fixed (T-250); skipped | Ticket 'Updated Nov 13, 2026, 9:48 PM' matches its comment's time, not the capture time. |
| PL-5 | Fixed | plan-timeline--1280--light: keys whole ('WEB-1', 'WEB-39'), month 'November 2026' whole (x≈581), 'No dates' chips start right of the today line (x≈758). On the phone each row shows key and summary. |
| PL-6 | Fixed | 'Earlier' markers on rows dated before the range (1280: x 582-650 on WEB-1, WEB-21, WEB-39, WEB-2). |
| PL-7 | Fixed (picture) | The chart's last row fades at its lower edge (1280 y≈1000; phone window 2 y≈1100). Keyboard reach of the scroller cannot be seen in pictures. |
| PL-8 | Still there | Measured: MOB-8, MOB-49 and MOB-53 bars are 28x44 on plan-timeline--375 (light and dark). |
| PL-9 | Fixed | The tutorial is a 'Getting started' link (1280 y=210). On the phone 'Your tracks' starts at about 300 css px, and the page is 2452 css px, down from 4278. |
| PL-10 | Changed | Dates now stay on one line, but at 1280 the Updated column is cut at the card's right edge: 'Aug 29, 2026, 12:00 P' on MOB-2, MOB-31, MOB-3, MOB-30 (search-results--1280--light x≈1243; plan-list--1280--light the same, WEB-53 '12:00 A'). Key takes about 190 px for 60 px keys while Summary is about 190 px and wraps to 4 lines (MOB-52). |
| PL-11 | Fixed (wording) | Search reads 'Sorted by Created, latest first'; plan list 'Sort by: Newest created first'. Row order (MOB-53 to 49, then 8, 46, 32) fits creation order. `aria-sort` cannot be seen in pictures. |
| PL-12 | Fixed | search-saved--1280: the picker shows 'Sweep search'. search-saved-es--375--light--2: the picker text is whole. |
| PL-13 | Fixed (measured) | No small controls are measured on search, search-results or search-saved at 375, English or Spanish. |
| PL-14 | Changed | Each row's box now has a visible label, 'On the wallboard' (dashboards--1280--light x≈1096, y=354). The capture has no box ticked, so whether a start control appears was not seen. |
| PL-15 | Changed | The wallboard now has its own frame, with no sidebar and no 'Show the numbers'; legend values sit beside their labels. But each card's content is spread out with large empty areas: 'Introduction' title at y=272 and its one line at y=457 in a card from y 97 to 775; a 170 px donut at y 480-650 in a 605x680 card. Body text is about 20 px. Phone: about 270 px of empty space between the title and the first card. |
| PL-16 | Fixed | All five pages read '<Thing> not found', one sentence, 'Go to Home' and 'Go to Search', and nothing is marked in the sidebar. Measured h1s: 'Ticket not found', 'Dashboard not found', 'Plan not found', 'Bulk change not found', 'Release not found'. (Button styling: see new faults.) |
| PL-17 | Changed | The current tab is now scrolled into view (plan-settings--375 shows Calendar to Settings, with Settings selected). There is still no overflow cue: plan-summary--375--dark cuts 'Cap' at the right edge (y≈576). In plan-summary-es--375--light, Resumen to Calendario end at x≈700 with nothing cut, so nothing hints at the other tabs. On Settings the first tabs are hidden off the left edge with no cue. |
| PL-18 | Fixed | On the phone a single 'Filters' button (plan-summary--375--dark y≈744); tiles start at about 557 css px instead of 700. |
| PL-19 | Fixed (measured) | axe reports no rules on any plan-calendar capture. |
| PL-20 | Fixed | No 'Set on the ticket once it is created.' rows and no Close reason. Assignee, Parent, Target releases, Found in releases and Areas are now real inputs (create--1280--light y 808-1560). The page is longer: 1909 px at 1280 and 2361 css px on a phone. |
| PL-21 | Fixed | Create sits in a sticky foot that shows on first view (state-create-dialog--1280--light x 302-391, y=720; --375--dark y≈1555). The foot is see-through: see new faults. |
| PL-22 | Fixed (as seen) | The open icon list is opaque in both captures. The sweep opened the Track list, not Ticket type, but both use the same icon menu (1280 x 302-633, y 280-475; phone y 592-1048). |
| PL-23 | Changed | An amber warning now reads 'The bulk edit finished with problems: 1 ticket was changed, and 1 ticket was not…' (bulk--1280--light y=187), and the failed ticket is listed with its reason. It still does not say what the change was, and nothing links to the changed ticket or back to the list. |
| PL-24 | Fixed (measured) | axe and the names check report nothing on ticket, ticket-es or state-ticket-print. |
| PL-25 | Fixed | On the phone Details comes before Activity (ticket--375--dark--4 Details, --6 Activity). |
| PL-26 | Fixed (measured) | No small controls measured on ticket, ticket-outcome, ticket-es or the popup states at 375. |
| PL-27 | Changed | The print layout drops the top bar, sidebar, toolbars, buttons and comment box (state-ticket-print--1280--light). Still printed: 'Changes are saved as you type.' (y=226), date inputs with calendar icons (x=1226, y 804/871), and the dark canvas on the dark skin (state-ticket-print--375--dark). Priority prints with no value: see new faults. |
| PL-28 | Fixed | The tutorial cards are gone from Home (collapsed to the link, D10). |
| PL-29 | Fixed | The Home track badge reads 'SWEEPL' in full. |
| PL-30 | Fixed | inbox--1280--light: Type and Track are the same width with their labels beside them. inbox--375--dark: both labels sit above full-width selects. |
| PL-31 | Fixed | The Key column reads '0/1 subtickets closed'. |
| PL-32 | Changed | Star now carries a star outline icon, but Subscribe is still a plain button with no state shown (search-saved--1280--light action row). |
| PL-33 | Fixed | search--1280--light: 'Words', 'Assigned to', 'Tracks' and 'Stage' share one label style. |
| PL-34 | Fixed | The plan list's Columns is a pop-over button beside Download, as on search, and both lists end with 'Show more'. |
| PL-35 | Fixed | The widget is titled 'Tickets by Status' (dashboard--1280--light). |
| PL-36 | Fixed | plans--1280--light: h1 'Plans', sidebar 'Plans'. |
| PL-37 | Fixed | Tiles end at y≈513 and cards start at y≈531. The 'By stage' and 'By track' cards end at their content (y≈730 / 680). |
| PL-38 | Fixed | On calendar and capacity at 375 the title has its own line (y≈847), and Previous/Next (or Earlier/Later) sit together beneath it. |
| PL-39 | Fixed | The rows read 'Unassigned' and 'Assigned to someone', and the explanation no longer names 'Elsewhere'. |
| PL-40 | Fixed | Shipped releases read 'Shipped on Aug 18, 2026' and 'Shipped on Aug 4, 2026', and rows within each track are in date order (plan-releases--375--dark--2). The filters stay, as the triage left them. |
| PL-41 | Fixed | Shared checkbox style (x=332), no box inside a box, 'Only me', and 'Delete plan' in danger red (x 394-501, y=1182). The date shows '01/01/2024' with 'That is Monday, January 1, 2024.' beneath. The phone checkbox shape is a new fault. |
| PL-42 | Fixed | Track uses the same icon menu as Ticket type (create--1280--light x 288-484, y=296). The phone toolbar shows six icons and a '…' menu. Dates use the browser's format (the format itself waits on T-240). |
| PL-43 | Fixed (to the triage's rule) | create, bulk and the five not-found pages mark nothing. Ticket and release mark 'Tracks', as the triage chose. |
| PL-44 | Changed | Fixed: undo and redo in the description toolbar (1280 x≈663/691, y≈249 in the displayed scale); Points reads 'None'; the two Add buttons look the same; the help mark sits beside the title on the phone. Still there: each checklist item takes three rows on the phone (ticket--375--dark--2 y 740-1310: name, then the select and Edit, then Move and Remove). |
| PL-45 | Fixed | The child's 'New' status sits at the row's end beside the summary (ticket-outcome--375--dark--2 y≈600). |
| PL-46 | Fixed | The dialog is opaque and the board fully veiled. Only the strip below the dialog's lower edge shows the board, under the veil (y 778-795). |
| PL-47 | Changed | The menu now starts with a row 'Now: New' (1280 y=239; phone y≈610), but 'Active' still carries the filled highlight (1280 y=275; phone y≈690). That is the same look the Track list uses for the current value ('API Platform API' in state-list-in-create-dialog), so the menu still reads as if Active were current. |
| PL-48 | Fixed | The phone tip now says 'Details, after the description and the ticket's tools… Activity comes last', and it sits in the page flow (y 420-720), pushing the buttons down instead of covering them. |
| PL-49 | Fixed | The phone placeholder reads 'Type a command or a page', with no Ctrl K. |
| PL-50 | Fixed (measured) | release-not-found makes one failed request (/releases/999999), down from three. |

### New faults (confirmed)

| Severity | Where | What | Evidence |
|---|---|---|---|
| medium | search-results--1280--light, search-saved--1280, search-*-es--1280, plan-list--1280--light, plan-list-es--1280 | The Updated column is clipped at the card's right edge, so times lose their last letter. This looks like a side effect of the PL-10 fix: dates no longer wrap, and the table now cuts them off. | Crop of search-results--1280--light (x 980-1280, y 1300-1700): 'Aug 29, 2026, 12:00 P' and 'Sep 15, 2026, 12:00 P' clipped at the card edge, x≈1243. Crop of plan-list--1280--light (x 950-1280): 'Sep 14, 2026, 11:00 P' and 'Sep 13, 2026, 12:00 A' clipped the same way. |
| medium | state-create-dialog--1280--light, --375--dark (state-list-in-create-dialog shares the dialog) | The create dialog's new sticky foot is see-through, so the form shows behind the Create button. This goes against D3 (opaque dialogs) and against PL-21's intent. | 1280 light: the Environment editor's side borders (x 321 and 958) run behind the foot down to y≈743, next to Create at y=720. 375 dark: the Environment toolbar icons (I, S, <>, link, H2) show at x 220-590, y≈1550, beside Create. |
| medium | ticket-, dashboard-, plan-, bulk-, release-not-found (the shared NotFoundPage, all skins and widths) | The primary 'Go to Home' button has an underlined label that sits near the top of the button, unlike every other button, including 'Go to Search' beside it. | ticket-not-found--1280--light: the label is underlined at y≈174 in a button spanning y 167-202, while 'Go to Search' is centred at y=185. plan-not-found--375--dark: label at y≈333, against y≈360 for 'Go to Search'. |
| medium (measured) | plan-timeline--375--light/dark | Under a coarse pointer, the key links in the phone timeline's Ticket column are 20 px tall. This is in addition to PL-8's 28 px bars. | measurements.json, plan-timeline--375--dark: pointer coarse=true, 126 small controls. They are 70 WEB-n links and 53 MOB-n links, each 87-107x20, plus the 3 bars at 28x44. The links are visible as the underlined keys at y≈1430/1518/1605 (2x). |
| medium | plan-settings--375--dark--2, --375--light | On a phone the plan settings checkboxes are stretched into tall rectangles, while Search uses square boxes. This regression came with the PL-41 shared-checkbox change: the 44 px coarse-pointer height is applied to the box itself. | plan-settings--375--dark--2: the boxes for OPS, SWEEPL, WEB, Sweep search and Sweep team measure about 28x43 css px (e.g. x 92-148, y 155-240 and y 1058-1145). search--375--dark: the Tracks and Stage boxes are about 28x28 css px. |
| medium | state-ticket-print (all four) | In the new print layout, Priority prints its label with no value. On screen the value is a button, and the print layout drops it. | state-ticket-print--1280--light: 'Priority' at y=701 with nothing under it, then 'Labels' at y=730. ticket--1280--light shows the 'Normal' priority button in Details. The print also still shows the 'Changes are saved as you type.' editor frame and the date inputs with calendar icons (not part of this claim). |
| low (arguably medium: an option is hidden) | search--375--light/dark | The Tracks checkbox group is clipped at its lower edge: only the top of the last option's box shows, and its label 'WEB Web app' cannot be seen. The uneven wrapping was already listed (PL-33), so only the clipping is new. | search--375--dark: the last box shows only its top edge at y≈1168-1182, with no label, above 'Stage' at y=1224. API, MOB/OPS and SWEEPL show in full above it. |
| low | plan-summary--375 (also plan-timeline--375) | On a phone there is loose vertical spacing before the content: an empty band between the tabs and Filters, Filters and Download on separate rows, and a further gap before the tiles. | plan-summary--375--dark: tabs at y≈576, Filters at 744, Download at 872, '123 tickets in this plan' at 1015, tiles from 1115 (2x). The bands between tab bottom ≈615 and Filters top ≈700, and between link ≈1035 and tiles ≈1115, are each about 40 css px. plan-timeline--375--dark is the same down to Filters at 744. |
| low | plan-timeline--375--dark | The today line runs through the new 'Earlier' edge marker. This is PL-5's overlap appearing on the marker added for PL-6. | The 'Earlier' marker spans x 340-475, y≈1448 (2x); the today line at x≈458 crosses its last letter. |
| low | plan-calendar--375--dark--2 | Phone calendar ticket chips are stretched to the grip button's height, so each one-line chip is twice its text height, with the text at the top. | 'Starts: MOB-50 …' chip y≈645-730 (2x) with its text at y≈668; the same on MOB-51, MOB-52 and MOB-50 rows (e.g. y 1462-1547). Sprint chips without a grip are one line high. |
| low | release--1280--light, release--375--dark (release page) | 'Copy as Markdown' and 'Download Markdown' are offered while the release notes are empty. 'Add to a release across tracks…' is a full-width bar, unlike other secondary buttons and unlike D27's normal-button treatment of Ship. | 1280: 'No closed tickets yet: the notes fill in as tickets close.' at y=804, with both Markdown buttons at y=844. The bar spans x 305-1226 at y=516. 375 dark: the bar spans the card width at y≈1224. |
| low | plan-releases--1280--light, --375--dark--2 | A release with no tickets reads '0 of 0 tickets closed'. | plan-releases--1280--light: Sweep 3.0 row, y=555, 'Due on Dec 14, 2026 · 0 of 0 tickets closed'. |
| low (measured) | plan-not-found (all four) | A missing plan also gets a second 404 for its choices. The reported wording 'after the 404' is not right: PlanPage requests the plan and its choices in parallel. The effect is the one PL-50 removed for releases: an extra failed request and console error. | measurements.json: failed = 404 /api/v1/plans/999999 and 404 /plans/999999/choices, in varying order. apps/web/src/plans/PlanPage.tsx: client.get (≈line 104) and client.choices (≈line 128) run in separate mount effects, and the choices request does not wait for the plan. |
| low | ticket--375--dark--6, state-create-dialog--375--dark (ticket-outcome--375 alike) | On a phone the editor toolbars put the new '…' button alone on a second row. The Activity tab 'All' also wraps alone onto a second row. The toolbar part follows on from PL-42: the overflow menu now exists, but its button still wraps. | ticket--375--dark--6: Comments, History and Time entries at y≈381, with 'All' alone at y≈476; the comment toolbar has B I S <> link H2 at y≈1198 and '…' alone at y≈1288. state-create-dialog--375--dark: '…' alone at y≈1148. |
| low | ticket--1280--light, ticket--375--dark--6 | Under each comment, a round button shows only '+' with no word or emoji hint. It is the reaction button (accessible name 'Add a reaction', comments.react), but sighted users cannot tell what it does. | ticket--1280--light: displayed x=282, y=1579, above Copy link, Edit and Delete. ticket--375--dark--6: a circle at y≈873 above Copy link. |
| low | ticket-outcome--1280--light, --375--dark--2 | The ticket type for a new ticket under an outcome is a native select, while Create uses the icon menu for the same choice. | ticket-outcome--1280--light: 'Ticket type' select 'Feature' at x 309-406, y=901. create--1280--light: Ticket type is the icon menu at x 772-900, y=296. |
| low | state-command-palette--375--dark | The phone palette shows nine commands, and the list ends exactly on an item boundary, so nothing shows that more follow. Account, the appearance choices, Sign out and the administration entries are out of view. | Last visible item 'Create ticket' at y≈1068, palette edge at y≈1115. styles/shell.css .palette-list sets max-height: 50vh; overflow-y: auto. App.tsx (≈lines 373-478) adds account.title, palette.appearance.*, palette.signOut and admin commands after Create ticket. |
| low | home--1280--light | In 'You follow', each row's type and priority icons sit straight after the summary instead of in one column. | Icons at x≈870, 920, 1100, 910 and 905 for MOB-50, 53, 52, 51 and 49, while 'New' is aligned at x≈1201. |
| low | inbox--1280--light | The count line starts in lowercase: 'nothing unread'. It is the eyebrow above the title, not a line under it. Other eyebrows are capitalised ('Hello, Eval Admin.', 'Plan of Eval Admin'). | inbox--1280--light y=97 'nothing unread' above 'Inbox'. messages.en.ts:4387 inbox.unreadCount '{count, plural, =0 {nothing unread} one {# unread} …}'. |
| low | dashboards--1280--light | The 'Yours' and 'Wallboard' card headings differ in size. | 'Yours' about 24 px at y=309; 'Wallboard' about 16 px at y=436. |
| low | dashboard--1280--light, dashboard--375--dark | 'Make it everyone's home' is offered next to 'Who sees it: Only me'. The server makes the default dashboard visible to everyone, so after the click the select would misstate who sees it. On the phone the donut sits at the left of the card, with the right half empty. | 1280: the button at y=218 next to the 'Only me' select. DashboardPage.tsx ≈281 shows it to admins whatever the visibility. apps/server/src/routes/dashboards.ts:118 lets everyone see d.is_default. Phone: donut at x 58-395 (2x), x 400-700 empty, y 1070-1400. |
| low | create--1280--light, create--375--dark--4 | Original estimate, Remaining estimate and Points have no hint about the expected format, while Assignee, Parent and Labels have hints. | create--1280--light: empty inputs at y 1582-1774 with no hint lines. Hints at y=871 ('Type a name to find someone.'), y=963 and y=1126. |

## Administration and setup

### The earlier faults

| ID | Verdict | Evidence |
|---|---|---|
| AD-1 | Fixed | admin-audit--375--dark: stacked rows, 'Nov 13, 2026, 9:49:03 PM / Eval Admin Track changed / About: Track 1 · From 127.0.0.1'. No mid-word breaks. Page 5738 px tall (was 6010). |
| AD-2 | Changed | admin-audit--1280--light: action codes are plain words ('Ticket template created', 'Service account created') and times stay on one line. Subjects are still ids ('Track 1', 'Person 10', 'Bulk change 1'), which the triage left for an API change. A new problem is under New faults: the table is now narrow. |
| AD-3 | Fixed | admin-api-usage--375--dark: Busiest clients as stacked rows ('Eval Admin / Requests 2,792 Errors 0 / Refused by the limits 0'). No axe findings in measurements.json for any capture in the group. |
| AD-4 | Fixed (measured) | measurements.json lists no name problems on admin-workflow-published or -draft (the probe records any control whose visible words are missing from its name, which an empty name would trigger). The page text now says 'with the mouse or with Tab and Enter' (1280 y≈1038). |
| AD-5 | Fixed | admin-workflow-published--1280--light: labels shown whole, e.g. 'New (from any status)', 'In Review (from any status)', 'Closed (from any status)' (y≈656-912). |
| AD-6 | Fixed at 1280; phone not seen | state-grip-menu-layout--1280--light: the menu is opaque, and the chips do not show through its options. Both 375 captures failed ('locator.waitFor: Timeout 5000ms exceeded.' in stateFailed), so the phone menu was not captured. |
| AD-7 | Fixed | state-invite-form (1280 y≈127; 375 y≈163): 'Eval Admin invited you, at sweep.person@example.com.' The empty 'as ,' clause is gone. |
| AD-8 | Fixed | admin-network-access: plain text 'You are connecting from 127.0.0.1. While the list is off, every address gets in.' No amber warning. |
| AD-9 | Fixed | admin-identity-providers--375--dark: the redirect address wraps inside its block ('http://localhost:8090/api/v / 1/auth/oidc/callback', y≈540-560). It breaks inside 'v1', which is minor. |
| AD-10 | Fixed | tracks-new--1280--light: veiled page, opaque dialog x≈280-1000 with 'Close' (x≈943, y≈85). tracks-new--375--dark: a full-screen sheet with 'Close'. |
| AD-11 | Changed | Short admin pages are no longer 1696 px tall: admin 876, admin-teams 800, admin-group-people 800, admin-groups 800 (closed groups). The list does not stay in place on a long page (D18 asked for a sticky list): see New faults. |
| AD-12 | Fixed | admin-group-people--1280 and admin-group-integrations--1280: the open group's heading is highlighted and expanded ('INTEGRATIONS AND AI', y≈434). |
| AD-13 | Fixed | admin--375--dark and every sub-page at 375: the 'Administration pages' bar is at the top (y≈80-140), with a chevron at x≈348. |
| AD-14 | Fixed | admin-visibility, -permission-explainer, -ticket-templates, -audit-es at 375: the '›' ends line one ('Inicio de sesión y seguridad ›'), and the current page starts line two on its own. |
| AD-15 | Fixed | manage-track-layouts--1280: 'Administration › Your tracks › Tracks you run › SWEEPL › Layout sets' with the eyebrow 'SWEEPL · Sweep local track'. manage-track-configuration-sets--375 shows the same. |
| AD-16 | Changed | Danger style now on 'Deactivate' and 'Erase…' (admin-users), 'Delete' (admin-permissions roles, admin-workflows statuses), 'Delete set' (layouts) and 'Deactivate' (service accounts). 'Revoke tokens' cannot be checked: the site has no tokens, and the action is hidden. The global permission rows' 'Remove' on Permissions is still a plain button (1280 x≈1127-1205). No confirmation dialog was captured. |
| AD-17 | Fixed | admin-users--1280: the Eval Admin row has the same two-line layout as the others. |
| AD-18 | Changed | Lists are full width now (to x≈1243), and forms open from 'New …' buttons on Groups, Teams, Visibility, Tracks, Templates, Roles, Fields and Layouts. Still mixed: Groups shows '2 members, 0 groups inside' but Teams shows '0 members · No lead'. Frontends still has the whole 'Add a frontend' form inline at its foot (1280 y≈600-1070). Permissions still has the inline 'Give' form for global permissions (y≈1130-1360). The button sits in two places: see New faults. |
| AD-19 | Changed | Most add actions are filled 'New …' buttons ('New role', 'New access policy', 'New layout set', 'New field rule set'). Some are still plain or worded differently: 'Add a person' (users), 'Add a status' and 'Add to workflow' (workflows), 'Add a limit' and 'Add a rate' (small plain buttons at the card foot on AI limits, y≈440 and y≈1283), 'Give'. |
| AD-20 | Fixed | A help mark is now present on the six group pages, Tracks you run, Permission explainer, Security, System status, API usage and limits, Trash, the workflow page, People of SWEEPL and the track's Configuration sets. AI usage lacks one, but it was not on the earlier list: see New faults. |
| AD-21 | Fixed | admin-layouts--1280--light: the selected 'Create' radio is terracotta, like the radios on Imports and Security. |
| AD-22 | Fixed (part capture artefact) | admin-ai--375--dark: boxes about 28 px (x≈33-61, y≈349-427), the same size as the boxes on network access and security in this run. The earlier mismatch may have come from mixing touch and non-touch captures; whether it did is not established. |
| AD-23 | Not seen | The type set form now opens from 'New type set' and is closed in the capture. No small controls are measured, but the checkboxes were not on screen. |
| AD-24 | Fixed (measured) | measurements.json lists no small controls on admin-mcp--375 or manage-track--375. On manage-track--375 the link 'All the tracks you run' sits in its own 44 px row (y≈380-410). |
| AD-25 | Fixed | admin-configuration-sets: 'Default for business and service tracks', 'Default for discovery tracks', 'Default for software tracks'. |
| AD-26 | Fixed | admin-workflow-maps: 'Workflow for every other type: Default workflow; no type of its own; 4 tracks'. |
| AD-27 | Skipped (no fix: seed data) | Unchanged: 'A draft nobody has published.' beside 'Version 1 published' (admin-workflows--1280). |
| AD-28 | Fixed | admin-workflow-published--1280: the breadcrumb ends at 'Default workflow', there is no extra 'All workflows' link, and 'Name and description ›' has a chevron (y≈324). |
| AD-29 | Fixed | admin-workflows--375--dark--2: each status has Edit, Up, Down and Delete on one line. |
| AD-30 | Fixed | workflow-not-found: h1 'Workflow not found', 'Nothing is at this address. The link may be mistyped or out of date.', 'Go to Home' and 'Go to Search'. A new styling problem is under New faults. |
| AD-31 | Fixed | admin-tokens: 'No API tokens yet. Tokens show here once a person or a service account creates one.' No bulk revoke is shown. |
| AD-32 | Fixed | admin-guardrails: 'Most used: 4 of 50 in Default access policy, for "See the track"'. Inputs read '20,000', '15,000', '10,000'. There is one 'Save the limits' (1280 y≈1510). |
| AD-33 | Fixed | admin-system--1280: 'Connected' is a green badge (x≈878-960, y≈612). Times carry their zone: 'Every day at 02:30 UTC', 'Nov 14, 2026, 8:30 PM CST'. |
| AD-34 | Fixed | admin-imports: the app's 'Choose a file' button and 'No file chosen yet.' (1280 y≈577; 375 window 2 y≈108). Its accessible name is a new problem: see New faults. |
| AD-35 | Changed | At 1280 both MCP cards span x≈605-1243 (width fixed). On admin-mcp--375--dark--2 the stdio command still breaks inside the port: 'TASKMOOR_URL=http://localhost:809 / 0' (y≈697-712). |
| AD-36 | Fixed | admin-frontends: 'Serves the app itself, at the server's version, 0.0.0-dev.' |
| AD-37 | Changed | Preview field wells now have visible edges. The two selects still do not line up: 'Fields and rules of' at 1280 y≈852 against 'Preview as' at y≈907. The track select is still cut: 'No particular track (shared fields...' at 1280, and '...(shared fields, d...' on admin-layouts--375--dark--2, y≈588. |
| AD-38 | Fixed | admin-ai-limits--1280: the intro ends at y≈581 and the first row's top is at y≈596. |
| AD-39 | Fixed | admin-security: 'A sign-in lasts 14 days' and 'Sign out after it goes unused for 3 days', each a number with a unit select. |
| AD-40 | Still there | settings-tutorials--1280: 'For administrators' on Workflows (x≈965, y≈340), 'For site administrators' on Administration and Import (y≈970). The catalogue still has `tutorial.setupOnly` 'For administrators' and `tutorial.adminOnly` 'For site administrators'. |
| AD-41 | Fixed | state-update-required: no hard seams. A pixel scan down the left edge finds only the drawn waves at the foot (1280 light y≈671/721). There are no jumps at the old places (1280 y≈551; 375 y≈122, 356 and 710). |
| AD-42 | Still there (faked state) | state-update-required: 'This version of the app (0.0.0-dev) no longer works with the server, which runs 0.0.0-dev.' state-update-notice: 'This app is version 0.0.0-dev and the server runs 0.0.0-dev.' Whether real equal versions can reach these states was not checked. |
| AD-43 | Fixed | state-invite-form--1280: the column spans x≈336-943 on a 1280 page, so it is centred. On 375 the two radios are 44 px apart (y≈279 and y≈323). |
| AD-44 | Fixed | 'Workflows on this site', 'Use AI on this site', 'The whole site' (guardrails), 'How this site is doing' (system). No 'workspace' or 'instance' was seen in the group. |
| AD-45 | Fixed | admin-es--1280: 'TRACKS Y CONFIGURACIÓN' on one line (y≈618). The app sidebar shows 'Planes'. 'Tracks' stays, as D36 decided. |

### New faults (confirmed)

| Severity | Where | What | Evidence |
|---|---|---|---|
| medium | state-grip-menu-layout--1280--light (every long admin page at 1280) | The admin side list does not stay in place. It scrolls away with the page, so the sticky list that D18 asked for is not working. | In the 800 px window shot the list card runs up under the top bar: 'Workflows' shows faintly at y≈25 and the card ends at y≈393. The app sidebar in the same shot stays at y≈85. Cause in the code at 488632e0: admin.css:97 sets `.admin-nav-side { position: sticky }`, but surfaces.css:1351 sets `.glass-card { position: relative }`. The two selectors have the same specificity and surfaces.css is imported after admin.css (main.tsx), and the aside has both classes (AdminLayout.tsx:69), so the `relative` rule wins. Full-page 1280 shots cannot show stickiness, so this window shot is the only evidence in the run. |
| medium | workflow-not-found--1280--light, --375--dark | 'Go to Home' is underlined and its label sits at the top of the primary pill. 'Go to Search' beside it is centred and not underlined. | 1280: underlined label at y≈224 in a pill spanning y≈216-252. 'Go to Search' is centred at y≈235. 375: the same, with the label at y≈320 in a pill spanning y≈311-353. |
| low | admin-imports (all four shots) | The styled file button (the AD-34 fix) shows 'Choose a file', but its accessible name is 'Upload a file into the folder'. The visible words are not in the name. | measurements.json, in all four captures: role textbox, name 'Upload a file into the folder', visible 'choose a file', leftOut ['choose']. axe reports nothing. The field label above the button does match the name, so this is low. |
| low | every admin page at 1280 | The admin side list card starts lower than the breadcrumb, the title and the app sidebar, and lines up with none of them. | admin-imports, manage-track and workflow-not-found at 1280: the list card's top is at y≈173. The app sidebar's top is at y≈85, the breadcrumb at y≈100 and the h1 at y≈154. |
| low | admin-groups, admin-tracks against admin-teams, -visibility, -ticket-templates, -service-accounts, -users (1280 light) | The 'New …' button from D11 is placed in two ways. On some pages it is on the title row at the right. On others it is below the description at the left. | Groups 'New group' and Tracks 'New track' are at the right, x≈1010-1110, beside the description. Teams 'New team', Visibility 'New visibility policy', Templates 'New template', Service accounts 'New service account' and People 'Add a person' are below the description at x≈605. |
| low | admin-users--1280--light | In every person row, 'Erase…' wraps onto its own line. | Each row has Make site administrator, New password link, Deactivate and Data on one line, with Data ending at x≈1165. 'Erase…' sits alone below at x≈621 (for example y≈594 in the first row). The page has 9 people, not seven. |
| low | admin-workflows--1280--light | The row buttons do not form columns when a row has no Up, no Down or no Delete. | Most status rows have Edit at x≈950. Open (no Up) has Edit at x≈1011 and Closed (no Down) at x≈1030. In the workflows card, Default workflow (no Delete) has Edit at x≈1068 and Sweep draft at x≈983. The 375 shot was not checked. |
| low | admin-system--1280--light | The data directory path breaks inside a folder name. | Storage, Data directory: '/Users/…/.cache/dem' on one line and 'o/data' on the next (y≈838-855). |
| low | admin-ai--1280--light | The hint mentions per-track settings 'below' that are not on the page. The settings card is also narrower than the cards on neighbouring pages. | 'AI stays off, and its controls hidden, everywhere except the tracks you turn it on for below.' is followed only by Provider and 'Save AI settings'. The track list may appear only once AI is turned on; that is not established. The card spans x≈605-1083; the MCP settings card spans x≈605-1243. |
| low | admin-ai-usage--1280--light | The title has no help mark. Its neighbours have one. | h1 'AI usage' at y≈154 has no mark. AI limits and prices, API usage and limits, Guardrails and API tokens each show the mark. The earlier AD-20 list did not name AI usage. |
| low | admin-imports--1280--light | 'Start another import' shows before any import has started, while the New import form is already open. | The button is at y≈1138, below the open New import card and above 'Earlier imports' and 'No imports yet.'. |
| low | admin-layouts--1280--light (and the layout editor in state-grip-menu-layout) | The create-form preview shows 'Close reason' and the other fields that can only be set after creation. D30 removed these from the real create form, so the preview does not match the form people get. | 'Preview of the create form for Outcome' lists Close reason at about y≈1477, plus Target releases, Found in releases, estimates and Points. The preview says it is 'The form as the server will give it'. At 488632e0, CreateTicketPage.tsx:811 leaves out after-creation fields, Close reason among them (PL-20, D30). 'Close reason' is also a chip that can be placed on the Create form layout. |
| low | admin-guardrails--1280--light | The limit inputs start at a different x on each row. | Each input is right-aligned under its own label, so the left edges are at x≈1028, 1038, 1073, 1015, 1036, 912, 990, 1035 and 1083. |
| low | manage-track--375--dark | On a phone, the text line that holds the inline link 'Open Permissions' has a much larger gap above it. | 'access policy. Open Permissions' is about 31 px below the line above it (y≈762-793). The other lines are about 18 px apart. The likely cause is the coarse-pointer 44 px minimum height on `.people-page .page-note a` (admin.css ≈815, the AD-24 fix). manage-track-configuration-sets was not checked. |
| low | state-invite-form--1280--light, tracks-new--1280--light | The fields stop well short of the right edge of their card or dialog. | Invitation: name, password fields and Continue end at x≈805 in a card that runs to x≈943. New track: the fields end at x≈781 in a dialog that runs to x≈1000, while the hint text runs to x≈822. |
| low | workflow-not-found--1280--light | The app sidebar does not mark Administration on this page, although the admin list marks 'Workflows'. The breadcrumb ends at a plain 'Workflows'. | 'Administration' at y≈484 has no highlight. On manage-track and admin-imports it is highlighted. The admin list highlights 'Workflows' at y≈460. |
| low | admin-tokens--1280--light (and 375) | The count line repeats the empty state beneath it, and a filter is offered when there is nothing to filter. | 'Show: All tokens', then '0 tokens' at y≈393, then the illustration and 'No API tokens yet' at y≈556. |

## Account, stand-alone pages and states

### The earlier faults

None of the AC faults was BLOCKED or marked no-fix in the triage (all are in G1, except AC-8 in G5).

| ID | Verdict | Evidence |
|---|---|---|
| AC-1 | Fixed (the Spanish case itself is not pictured) | account-notifications--375 now shows one bordered row per event with the Email and Inbox boxes under the name (window 2: 'Someone mentions you', 'A track group is shared with you or set on you' wraps by whole words). No sideways scroll at 375 or 360 anywhere in the group. The run has no account-notifications-es capture: the Spanish choice took only account-es, which is now the Profile tab. |
| AC-2 | Fixed | signed-out-tracks: h1 'Sign in to continue', 'You need to sign in to see this page.', sign-in form in the reduced frame. Only failed call is 401 /session; no /track-groups call. |
| AC-3 | Fixed | unknown-route: final `/no-such-page`, h1 'Page not found', 'Nothing is at this address. The link may be mistyped or out of date.', Go to Home and Go to Search; the sidebar marks nothing. |
| AC-4 | Fixed | No hard edge on any one-screen stand-alone page at 1280 or 375: the waves sit at the foot of the window (375 image px y≈1290-1624) on sign-in, setup, password, invite, unsubscribe, oauth and state-password-form. A scan for flat-to-flat colour jumps at the page sides of every phone window in the group found none. The remaining edge is at exactly y=800 on state-setup-form--1280 (see Notes). |
| AC-5 | Fixed | setup-no-link: 'This site is already set up. Sign in with your account.' with 'Go to sign in'; byte-identical to setup-invalid-link. |
| AC-6 | Fixed | 'Go to sign in' in the header (1280 x=828-943, y=22-57) on setup-*, password-*, invite-*, unsubscribe-*, oauth-consent-* and state-password-form. None is spelled 'Sign in' or 'Go to sign-in'. |
| AC-7 | Fixed | No intro line on any link error page. For example, password-invalid-link shows only 'Choose a password' and the error card. (track and board: see AC-8.) |
| AC-8 | Fixed (G5) | track-not-found: h1 'Track not found', 'No track has the key NOSUCH, or you cannot see it.', no tabs. board-not-found: h1 'Board not found'. Both offer Go to Home and Go to Search. |
| AC-9 | Fixed | /account/notifications is its own tab. The 'Notifications' heading shows clear at 1280 y=257 and at 375 image y=556, with nothing over it. |
| AC-10 | Fixed | sign-in-sso-error: the alert opens the card above Email (1280 y=163-240), not between Password and the button. The wording is a new fault, below. |
| AC-11 | Fixed | The notification boxes are the app's terracotta boxes at 1280 (x≈1094-1114 and 1174-1194) and peach at 375 dark, matching the radios and the rest of the app. |
| AC-12 | Fixed | The phone boxes are 56 image px (28 px) in rows about 104 image px apart (window 2). The probe found no small controls. |
| AC-13 | Fixed | The sign-in pages carry only 'Taskmoor' at the top left, with no Sign in link. |
| AC-14 | Fixed (seen in the pictures; aria-invalid cannot be measured from images) | Both fields have a red outline. 'That email and password do not match.' sits under Password (1280 y=322-362), and the D15 line 'Forgot your password? Ask a site administrator for a new password link.' is shown before and after the failure. A smaller mark is a new fault, below. |
| AC-15 | Fixed | The no-link and invalid-link texts now differ: unsubscribe 'This address has no unsubscribe link in it…' and 'This unsubscribe link is not valid any more…'; oauth 'This address names no request from an app…' and 'This request has expired or was already answered…'. password and invite tell the reader to ask 'a site administrator'. The SSO alert still says 'your administrator' (new fault, below). |
| AC-16 | Changed (partly fixed) | All stand-alone cards are now 607 px wide (x=336-943). Inside them, the forms still differ. On sign-in, the fields and the full-width Sign in button are 448 px (x=357-805), leaving a 138 px empty strip, while state-password-form's fields and button fill the card (x=357-923). On sign-in-sso-error, the alert spans x=357-923 but the fields below span 357-805. state-setup-form puts 'Finish setup' outside its cards at x=336-943. On Account, 'Save profile' is now content width (x=309-437); the other tabs' buttons are not pictured. |
| AC-17 | Fixed | Account is now tabs (Profile, Notifications, Security, API tokens, Your data) at their own addresses. account is 1035 px tall at 1280 (was 4153), and each tab has its own intro ('Your name, email, time zone and language, and how Taskmoor looks for you.'). |
| AC-18 | Fixed | Appearance says 'How Taskmoor looks for you, on every device where you sign in. A choice saves at once.', and Notifications says 'Changes save at once.' |
| AC-19 | Fixed in the source; not pictured | The run captures no Your data tab. The catalogue has the reader's own text in the second person ('Download everything Taskmoor keeps about you: your profile…', `messages.en.ts` line 1280, and `account.intro.data`). The third-person text stays for the administrator's version (line 1282). |
| AC-20 | Fixed in the source; not pictured | The run captures no API tokens tab. `TokensSection.tsx` line 119 shows the empty state as the title alone, `tokens.none` 'You have no API tokens.'. |
| AC-21 | Fixed | signed-out-guarded shows the reduced frame with no sidebar, and 'You need to sign in to see this page.' |
| AC-22 | Fixed | The 'token.' line is gone: setup-no-link now says 'already set up' on one line at 1280 (y=162). |

Phone pictures that may have been capture artefacts (flat band, different top bar, wider controls), checked on the new window captures:
- Flat band: not on a real phone picture. Every phone window of the group has a smooth page background, and the stand-alone pages end in the wave layer at the foot of the window. The one remaining edge is inside the notifications card (new fault 7), not under the page.
- Top bar: the signed-in phone pages (account, account-notifications, unknown-route, imported-link-unknown) all show the same floating bar: menu, +, Search, ?, theme and avatar. It stays stuck on later windows (`stuckTop: 52`).
- Controls looking wider: the stand-alone buttons are full width at 375 by design (Sign in, Save password and sign in, Finish setup). The notification boxes are 28 px, as account.css asks under a coarse pointer. Nothing looks wider than its rule.

### New faults (confirmed)

| Severity | Where | What | Evidence |
|---|---|---|---|
| medium | unknown-route, track-not-found, board-not-found (the shared not-found page; seen in unknown-route 1280 light and 375 dark, track-not-found 1280 light, board-not-found 375 dark) | On the not-found page, the primary 'Go to Home' button shows its label underlined and pushed against the top edge instead of centred. The secondary 'Go to Search' beside it is centred and has no underline. This is new: the previous run had no not-found page (AC-3). | 1280 light: the button fills about y=167-202, and 'Go to Home' is underlined at y~168-183, while 'Go to Search' is centred at y=185. 375 dark (image px): the button is y~362-446 and its underlined label is at y~365-395, on the top edge. Search is centred at y~406. The same on track-not-found 1280 light and board-not-found 375 dark. |
| low | sign-in-sso-error (all) | One sign-in card names two different people to ask: the single sign-on alert says 'your administrator', and the forgotten-password line under the form says 'a site administrator'. The fault is real, but the reader cites the wrong decision. D24 covers the link pages only. The 'site administrator' wording comes from D12 ('site', 'site administrator') and D15. | 1280 light: the alert at y~184 reads 'There is no account for you here yet. Ask your administrator to create one.' The line at y~428 reads 'Forgot your password? Ask a site administrator for a new password link.' The previous AC-10 covered only where the alert sat (it now sits above the form), not this wording. |
| low | state-sign-in-wrong-password (all) | After a failed sign-in, the email field and the text part of the password field turn red, but the eye (show password) part of the password field keeps the plain grey outline. The field looks half-marked. The previous AC-14 ('neither field marked') is now fixed except for this part. | Crop of 1280 light at x=640-840, y=255-315: the red outline ends at the divider at x~767, and the eye segment x~767-805 has a grey outline. 375 dark: a peach outline up to image x~587, and the eye segment to x~675 is grey. |
| low | imported-link-unknown (all), against unknown-route and track-, board-not-found | The imported-link miss does not follow the not-found pattern the other pages now share (D4). Its button is spelt differently ('Go to search' against 'Go to Search'). It has only one way on and no 'Go to Home'. The error is a red alert box, not the plain line under the title. The intro above the error still describes the working page (the problem the user's D24 removed from the link pages). | 1280 light: h1 'Opening a link from your earlier tracker', intro 'Where a link from an earlier tracker leads, now that its work was imported here.', a red box 'Nothing that was imported matches this link, or you may not see it.' at y~165-207, and a single secondary 'Go to search' at x~289-405, y~245-280. The not-found pages show 'Go to Home' (primary) and 'Go to Search' at y~167-202. The previous AC-8 only praised this page for having a way on. |
| low | sign-in, sign-in-sso-error, state-sign-in-wrong-password against password-*, setup-*, unsubscribe-* (1280 and 375) | The product name and the page heading sit at different heights on pages that share the stand-alone frame. Only the link pages carry the 'Go to sign in' button in the header row, which makes that row taller. Following 'Go to sign in' from a link page makes the name and heading jump up. | 1280 light: on sign-in and sign-in-sso-error, 'Taskmoor' is at y~30 and h1 'Sign in' at y~81. On password-invalid-link and unsubscribe-invalid-link, 'Taskmoor' is at y~39 and the h1 at y~98, with 'Go to sign in' at x~828-942, y~22-57. 375 dark setup-no-link: 'Taskmoor' at image y~86, beside the button. |
| low | account (all), account-es | On the Appearance cards, an unselected radio looks like a hollow ring on one card and a filled grey disc on the other. It is the same control drawn over a light or a dark preview, and which card gets the disc swaps with the skin. The disc can read as half-selected. | Crop of 1280 light at y=802-842: a hollow white ring with a grey outline on Light (x~884), and a solid grey disc on Dark (x~1193). account--375--dark--2: a solid grey disc on Light (image ~615,873) and a hollow dark ring on Dark (~615,1230). |
| low | account-notifications (all) | The two checkboxes under the Email radios ('Hold email during quiet hours', 'Tell me about changes I make myself') do not line up with the radios, either the controls or their labels. The page intro and the card intro say almost the same thing. | 1280 light: the radios are at x~309-329 with labels at x~337, and the boxes at x~313-333 with labels at x~344. 375 dark (image px): the radios are at x~66-106 with labels at 123, and the boxes at x~75-129 with labels at 153. Page intro: 'When Taskmoor tells you about changes, and whether by email, in your inbox or both.' Card intro: 'How Taskmoor tells you about changes to the tickets you work on and follow. Changes save at once.' |
| low | account--375, account-notifications--375, account-es--375 | At phone width the account tab strip runs past the screen. In English the last visible tab, 'API tokens', looks almost whole with only a faint fade, and nothing shows that 'Your data' exists. In Spanish the cut 'Tokens d…' at least shows that the strip goes on. D2 accepted a fade as the cue on the board, but here the fade falls on a label that looks complete, so it does not work as a cue. | account--375--dark and account-notifications--375--dark: tabs Profile, Notifications, Security, then 'API tokens' at image x~575-715 with its last letters faded, and no 'Your data'. account-es--375--light: 'Tokens d' cut at x~605-725, and 'Tus datos' is not visible. |
| low | account-notifications--375--dark--2, --375--light--2 | In the second phone window, the notifications card changes colour sharply across its full width a little below the top bar: navy to rust in dark, white to peach in light. Window 3 does not show it. These are window captures with touch emulation, not the old full-page artefact. The cause is not established (possibly the glass card's backdrop on a tall element). It is not AC-4, which was the stand-alone frame. | dark--2: a hard horizontal change inside the card at image y~225-240, through the 'Someone mentions you' block, with the gutter x<24 staying navy. light--2: the same rows go from near-white to peach. dark--3 shows a smooth card throughout. |
| low | password-*, invite-*, unsubscribe-*, oauth-consent-* invalid and no-link pages (setup-no-link's 'already set up' is information, not an error) | The link pages show their error as plain grey text in a glass card, and it is not an alert (alerts=[] in the measurements). The sign-in errors in the same frame are red alert boxes, and the not-found pages expose their message as an alert. The link-page errors look and are announced differently from the others. | password-invalid-link 1280 light: grey text 'This link is invalid, has expired or was already used. Ask a site administrator for a new one.' in a plain card at y~133-208. unsubscribe-invalid-link: the same style. In measurements.json, alerts=[] on every setup, password, invite, unsubscribe and oauth-consent capture. The alerts are filled on state-sign-in-wrong-password (red box at y~322-362), sign-in-sso-error, unknown-route and the track- and board-not-found pages. |

## The measurements

Source: `.cache/sweep/run-2026-11-14/measurements.json` (690 captures, 0 errors, 0 not settled,
0 pictures not as a phone). Every one of the 346 phone captures reported `pointer: coarse`, 1 touch
point, innerWidth 375, DPR 2.

**The earlier run's file is gone.** `.cache/sweep/run-2026-11-08/measurements.json` is not on disk
(`.cache/sweep` holds only `run-2026-11-14`, and no other copy turned up in the worktrees). The
earlier figures below come from `docs/plan/page-review-findings.md` ("Measurements of the whole run"
and "Across the run") and the triage file. Nothing was edited apart from this file.

### Summary

| Category | Distinct now (before) | Real faults | Not faults |
|---|---|---|---|
| Sideways scroll 375 / 360 / 1280 | 0 / 0 / 0 (account-es 13 px at 375, 28 px at 360) | 0 | none |
| Small controls (phone, coarse) | 126 (20) | 0 confirmed | 126: all on the two timelines, all probe artefacts (pseudo-element press areas) |
| axe serious/critical | 0 nodes (64) | 0 | none |
| Console errors | 3 (3) | 0 | 3: 'Failed to load resource' for expected 401, 404 and 400 |
| Failed requests | 16 (20) | 0 | 16: all expected (signed out, not-found, invalid links, wrong password) |
| Names leaving out visible words | 7 (16) | 1 (admin-imports file input) | 6: the Appearance radios (English and Spanish) |

Also seen (not asked): 2 failed states, `state-grip-menu-layout` at 375 light and dark
(`locator.waitFor: Timeout 5000ms exceeded`), so that state has no phone picture or measurement.
`routesNotInTheList` still holds `#/cross-track-releases`.

### Sideways scroll

`sideways.over` is 0 on all 690 captures, and `sideways360.over` is 0 on every phone light capture.
The earlier Spanish overflow on account-es and account-notifications-es (table
`.notification-events`, 13 px at 375 and 28 px at 360) is gone: account-es now measures scrollWidth
375 at 375 and 360 at 360.

### Small controls (under 44 px, phone, coarse pointer)

### Where they are

Only 4 of the 344 measured phone captures have any: track-timeline and plan-timeline at 375, both
skins. Every other route reports none.

| Route (375, light and dark) | Key links | One-day bars | Total distinct |
|---|---|---|---|
| track-timeline | 53 (`MOB-n`, 79-107 x 20) | 3 (`MOB-8`, `MOB-49`, `MOB-53`: "... Nov 14, 2026 to Nov 14, 2026", 28 x 44) | 56 |
| plan-timeline | 123 (`MOB-n` and `WEB-n`, 79-107 x 20) | the same 3 | 126 |

The summary's 126 distinct items are plan-timeline's set; track-timeline's 56 are a subset. Each
ticket key counts as its own item because the name differs, so the 126 are **two kinds of control**,
the row's key link and the one-day bar.

### Why the count rose

Not because of the new phone pictures. The probe (`measureControls` in `tools/sweep/probe.mjs`) is
unchanged since 58db9742 and was already measured under a coarse pointer before: the earlier run's
timeline bars measured 28 x 44, and 44 is the touch height (`.timeline-bar` is 24 px without touch).
The probe measures each control's `getBoundingClientRect()`, widened by its `<label>`s. It does not
count a `::before` or `::after` that enlarges the press area.

The rise comes from G4 (3c2aaa64, 2026-11-13, "Timelines and calendars read whole on every
screen"), which changed the phone timeline after the earlier run:

- **Key links.** Before G4, `.timeline-key` under `(pointer: coarse)` had `min-height: 44px` and
  `align-self: stretch`, so it measured 44 tall and was never listed. G4 puts the summary under the
  key on phones (`timeline.css` 650-680). The nested `@media (max-width: 767px) { @media (pointer:
  coarse) }` block (`timeline.css` 736-760) sets `.timeline-key { min-height: 0 }` and moves its
  press area to `.timeline-key::after { position: absolute; inset: 0 }`. Its containing block is
  `.timeline-label`, which is `position: sticky`, 9.5rem (152 px) wide and one row
  (`--timeline-row: 44px`) tall. The toggle sits above it with `z-index: 1`. The link's own box is
  20 px tall, but a finger anywhere on the 152 x 44 name cell, except the toggle, presses the link.
  The images agree: in track-timeline--375--dark.png and plan-timeline--375--dark.png each row is
  88 device px (44 CSS px) tall, with the key over its summary filling the cell.
- **One-day bars** (TR-21, PL-8). `.timeline-bar::after` gets `width: max(100%, 44px)` under
  coarse (`timeline.css` 702-709). The story `ThinBarOnATouchScreen` checks with `elementFromPoint`
  that a press 6 px past either end lands on the bar. The probe still sees the 28 px box. These bars
  were already in the earlier run's list (28 x 44) and stay there for the same reason.

### Real faults or not

| Control | Routes | Measured | Press area under coarse | Verdict |
|---|---|---|---|---|
| Timeline key link (`.timeline-key`), 123 distinct | track-timeline, plan-timeline 375 | 79-107 x 20 | the 152 x 44 name cell through `::after` | Not a fault (probe artefact). Gap: no story or e2e checks the phone press area, because the stories' touch rules leave out the nested block (comment at `timeline.css` 731-735). |
| One-day bar (`.timeline-bar`), 3 distinct | track-timeline, plan-timeline 375 | 28 x 44 | 44 x 44 through `::after`, tested | Not a fault (probe artefact; TR-21 and PL-8 fixed) |

No real small-control faults on this run. The earlier run's list is cleared on every route, at 0 on
search, search-results, search-saved, admin-configuration-sets, admin-mcp, ticket, ticket-es,
track-backlog, track-backlog-es, manage-track and admin:

| Earlier item | Fault | Now |
|---|---|---|
| Search stage checkboxes New, Active, Closed (and Spanish Nuevo, Activo) | PL-13 | gone |
| admin-configuration-sets type checkboxes Bug, Chore, Idea, To-do | AD-23 | gone |
| admin-mcp radios 275 x 34/38; manage-track "All the tracks you run" 18-21 px | AD-24 | gone |
| ticket child key links 62 x 18, parent link 309 x 36, Activity tab "All" 42 x 44 | PL-26 | gone |
| backlog "Sprint report" link 90 x 21 | TR-20 | gone |
| "System" link 43.9 x 44 (admin pages) | none listed | gone |
| timeline bars 28 x 44 | TR-21, PL-8 | fixed in the app; the probe still lists them |

Two ways to stop the false positives: let the probe sample `document.elementFromPoint` over a
44 x 44 square centred on the control, or count an absolutely positioned `::after` or `::before`.
A story or e2e check for the phone key's press area would close the test gap.

### axe (serious and critical)

0 rules, 0 nodes on all captures (was 64 nodes). Gone: label-content-name-mismatch on the calendar
"Starts:" chips (TR-19, PL-19: track-calendar, plan-calendar, state-grip-menu-calendar) and the
checklist buttons (PL-24: ticket, ticket-es, state-ticket-print). Also gone:
scrollable-region-focusable on admin-api-usage at 375 (AD-3).

### Console errors

All three are the browser's own "Failed to load resource" line, which it logs for any non-2xx
response. The app cannot silence it except by not making the request. There are no uncaught errors
and no CSP errors.

| Error | Captures | Routes | Expected? |
|---|---|---|---|
| ... status of 401 (Unauthorized) | 80 (20 routes x 4) | invite-invalid-link, invite-no-link, oauth-consent-invalid, oauth-consent-no-request, password-invalid-link, password-no-link, setup-invalid-link, setup-no-link, sign-in, sign-in-password, sign-in-sso-error, signed-out-guarded, signed-out-home, signed-out-tracks, state-invite-form, state-password-form, state-setup-form, state-sign-in-wrong-password, unsubscribe-invalid-link, unsubscribe-no-link | Yes: the session check while signed out (and the wrong password) |
| ... status of 404 (Not Found) | 44 (11 routes x 4) | board-not-found, bulk-not-found, dashboard-not-found, invite-invalid-link, oauth-consent-invalid, password-invalid-link, plan-not-found, release-not-found, ticket-not-found, track-not-found, workflow-not-found | Yes: not-found routes and invalid links |
| ... status of 400 (Bad Request) | 4 | unsubscribe-invalid-link | Yes: a malformed unsubscribe token |

The earlier run's 400 x 24 came mostly from `/tracks/MOB/fields` on the statistics reports
(T-251, fixed). Only the unsubscribe 400 remains.

### Failed requests

| Request | Routes | Expected? | Note |
|---|---|---|---|
| 401 GET /api/v1/session | the 20 signed-out routes above | Yes | session check while signed out |
| 401 POST /api/v1/session | state-sign-in-wrong-password | Yes | wrong password |
| 400 GET /api/v1/unsubscribe?token=... | unsubscribe-invalid-link | Yes | invalid token. A 404 would match the other invalid links, but 400 is defensible for a malformed token. |
| 404 POST /api/v1/password-links/inspect | password-invalid-link | Yes | |
| 404 POST /api/v1/invitations/inspect | invite-invalid-link | Yes | |
| 404 GET /api/v1/oauth/requests/not-a-real-one | oauth-consent-invalid | Yes | was 401 before sign-in. Now 404 as the user decided on 2026-11-13: tell a signed-out visitor at once that the request is unknown. |
| 404 GET /api/v1/tickets/MOB-999999 | ticket-not-found | Yes | |
| 404 GET /api/v1/tracks/NOSUCH | track-not-found | Yes | |
| 404 GET /api/v1/tracks/NOSUCH/summary-layout | track-not-found | Yes | fired in parallel at mount by `TrackSummaryPage.tsx` (l. 101-110), not after the first 404; harmless |
| 404 GET /api/v1/boards/999999 | board-not-found | Yes | |
| 404 GET /api/v1/releases/999999 | release-not-found | Yes | was 3 requests (also /notes, /overview), now 1 |
| 404 GET /api/v1/dashboards/999999 | dashboard-not-found | Yes | |
| 404 GET /api/v1/plans/999999 | plan-not-found | Yes | |
| 404 GET /api/v1/plans/999999/choices | plan-not-found | Yes | fired in parallel at mount by `PlanPage.tsx` (l. 128); harmless |
| 404 GET /api/v1/bulk-operations/999999 | bulk-not-found | Yes | |
| 404 GET /api/v1/workflows/999999 | workflow-not-found | Yes | the page shows the generic "Nothing is at this address" alert, not a workflow-specific one |

None looks like a bug. Gone since the earlier run: 400 GET /tracks/MOB/fields on five statistics
routes (T-251), 401 GET /track-groups on signed-out-tracks, and the release follow-ups /notes and
/overview. New not-found routes (board, bulk, dashboard, ticket, workflow) add their own expected
404s.

### Names leaving out visible words (WCAG 2.5.3)

| Control | Routes | Name | Visible words | Verdict |
|---|---|---|---|---|
| File input (textbox) | admin-imports 1280 and 375 | "Upload a file into the folder" | "Choose a file" (the button-styled label wrapping it) | **Real fault, low.** In `admin/imports/ImportWizard.tsx` ~l. 320-336 (AD-34's own file button), `aria-labelledby` points only at the field label `${id}-upload-label`, so the visible button text "Choose a file" is not in the name. Someone using voice control who says "Choose a file" finds nothing. Fix: give the "Choose a file" text an id and add it to `aria-labelledby`, or name the input "Choose a file to upload into the folder". |
| Radio "System" / "Light" / "Dark" | account 1280 and 375 | the option's name | the name plus its hint ("light or dark following the setting of your device", ...) | Not a fault: named by the visible name (`aria-labelledby`) and described by the hint (`aria-describedby`, `AppearanceSection.tsx` l. 79-80). The name contains the visible label. The probe counts the whole wrapping label's text. |
| Radio "Sistema" / "Claro" / "Oscuro" | account-es 1280 and 375 | the same in Spanish | the same | Not a fault, as above |

Gone since the earlier run: the eight unnamed workflow-diagram buttons on admin-workflow-published
and -draft (AD-4), and the ticket's checklist "edit" button (PL-24).

### Real faults per category

- Sideways scroll: 0
- Small controls: 0 (126 distinct items flagged, all two timeline controls whose press area is a pseudo-element; one test gap on the phone key's press area)
- axe: 0
- Console errors: 0 (3 expected)
- Failed requests: 0 (16 expected)
- Names leaving out visible words: 1 (admin-imports file input; 6 Appearance radios not faults)

