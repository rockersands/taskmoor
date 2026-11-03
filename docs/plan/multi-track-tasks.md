# Multi-track: tasks

One plan that brings together work from several tracks and saved searches, so someone leading
several teams can see it in one place without changing how those teams work. It stays in 1.0.

## Handoff (2026-11-03, paused)

**State: paused by the user before any code was written.** Too much was running in parallel, and
this work waits on tickets. This file is the only change on `claude/multi-track`, which branches
from `claude/ui-overhaul` at `a480e99`. Restart from the merged UI branch once the earlier branches
are on `main`; this branch can be dropped, as long as this file is carried over.

- **Done:** read the code named below and wrote down what a restart needs.
- **Half-done:** nothing. No migration, route, string, page or sidebar entry exists.
- **Not run:** no test, build or gate. This file is the only change, so there was nothing to run.
- **Not yet moved:** PLN-001 to PLN-009 are still M2 in `docs/specs/requirements-index.csv` and the
  spec. The move to M1 (ticket MT-01) goes with the work, so that nothing lists them for M1 before
  they exist.

### Numbers to check on restart

- **Migrations:** the range given was 0094 to 0099, but 0094 is taken on the UI branch
  (`0094_board_kind_decides_backlog`). That leaves 0095 to 0099, one for each of the five stages
  that need tables, with none spare. Check again before committing: other branches hold 0085, 0087
  and 0091.
- **ADR-122**, with a section per stage. **PLN-012** is free for the first version's requirement.

### What the code already gives (read, not built on)

Nothing in this section has been tried in code. The search behaviour notes come from reading it, and
the "planned" items are untested.

- **Viewer enforcement:** `compileQuery` in `apps/server/src/boards/data.ts` returns a condition on
  ticket `k` that already includes the viewer's filter. Planned: every plan view compiles through
  it, so a plan gives no access.
- **A plan's query:** planned as text composed per viewer from the sources they may see:
  `track IN (...)` for tracks they may browse, each visible saved search's condition in brackets,
  joined by `OR`. The same text feeds the views and the links, so numbers match their searches.
  - Print the saved search's condition with `printQuery` and no `orderBy`. Do not compose
    `savedSearch = 12`: in `search/saved.ts` a name wins over an id, so a saved search named "12"
    would be read instead.
  - A plan with no visible source must find nothing. An empty query means every ticket the viewer
    sees, so use a condition that matches nothing (`key IS EMPTY`, untested).
  - A saved search whose query no longer runs (`import_problem`) is left out and flagged, so it does
    not take the plan down.
- **Sharing:** `apps/server/src/sharing/shares.ts` takes a third `ShareTable` with a few lines. It
  checks the existing "Share dashboards and saved searches" permission, so no new permission is
  needed.
- **Timeline:** the query block in `apps/server/src/routes/timeline.ts` can become a function taking
  `where`. Its link query already works across tracks. `TimelinePage.tsx` splits into a view that
  takes its data and a reschedule call. Rows are a fixed 44px, so windowing for 10,000 rows is simple.
- **Parent ids:** the track timeline returns `parentId` even when the viewer cannot see the parent.
  The plan path should return null there. Outcome grouping can then climb only through listed tickets.
- **List:** `ListPage.tsx` builds its base query from a track key; pass the base query in as a prop.
  `ResultTable` needs no change. Grouping by track and outcome has to be added to `GROUP_FIELDS`.
- **Calendar:** the same split as the timeline, in `routes/list-views.ts` and `CalendarPage.tsx`.
- **Summary:** model it on `routes/track-summary.ts`. Use one group-by statement rather than a count
  per number, and test that each number equals its search.
- **Refusals:** both pages say one generic "failed" line today. Plain words need a map from the
  ticket route's error codes.
- **Sidebar:** there is no planning section. `NAV_GROUPS` has `you`, `work` ("Plan and track") and
  `manage`, so the entry goes under `work`.
- **Also needed for a new route or table:**
  - events: `events/catalogue.ts` and `events/contract.test.ts`
  - audit: `audit/subscriber.ts`
  - API document: `docs/api/openapi.json` and `reference.md` (every route is listed, internal ones too)
  - personal data: `privacy/export.ts` for plans a person owns; check `privacy/erase.ts`
  - database: `packages/db/src/upgrade-fixtures.ts` and the schema golden
- **Push with an explicit target:** a worktree made with `-b` from `origin/claude/ui-overhaul` tracks
  that branch, so use `git push -u origin claude/multi-track:claude/multi-track`.

### Questions for the user

1. **Size limit:** PLN-001 says no ticket cap, and 50,000 tickets over 300 tracks opening in under
   3 s. The brief says to state a limit of 10,000. Proposed: a plan may hold any number, each view
   lists the first 10,000 and says so, and PLN-012 records the limit. PLN-001's 50,000 is still to
   be measured.
2. **Boards as sources:** PLN-001 names boards, tracks and saved searches; the brief names tracks and
   saved searches. Under ADR-116 a board belongs to one track, so proposed: no board sources, and
   reword PLN-001.
3. **Filters:** one value per filter (one track, one assignee) at first, or several from the start?
   Proposed: one value at first.

### Tickets, in order

Each is its own commit and ADR-122 section, with a one-line note to the coordinator when done. Clean
room: our own spec only, no Atlassian site, product or connection. A plan gives no access in any part.

| Ticket | What | Spec | Migration |
|---|---|---|---|
| MT-01 | Plans with sources and sharing; Summary, Timeline, List and Calendar; group and filter in the address; the size limit; sidebar entry. Move PLN-001 to PLN-009 to M1. Includes the test that a viewer never sees a ticket they may not see | PLN-001, new PLN-012 | 0095 |
| MT-02 | Dependencies view: lines and badges, late ones red, blockers outside the plan | PLN-006 | none expected |
| MT-03 | Teams and capacity, individual capacity | PLN-005, PLN-009 | 0096 |
| MT-04 | Releases across tracks | PLN-007 | 0097 |
| MT-05 | Program board, edited in real time with the existing sync and Yjs tools where they fit | PLN-008 | 0098 |
| MT-06 | Draft changes and scenarios | PLN-002, PLN-003 | 0099 |
| MT-07 | Auto-scheduler, previewed as draft changes | PLN-004 | none expected |
| MT-08 | Duplicate a plan, a link to any view, CSV and image export | our own wording | none expected |

PLN-010 (hierarchy grid) and PLN-011 (baselines) are not in this scope unless the coordinator says so.

**Every ticket delivers:** spec, ADR, routes with events, contract scenarios, audit decisions and
scope classes, tests citing requirement IDs, en and es strings, shared glass styles and motion tokens
(respecting reduced motion), stories with axe, phones, an e2e spec, the manual page
(`docs/manual/use/multi-track.md`, in `nav.json`).
