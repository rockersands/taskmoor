# ADR-115: The guided tutorial

- Status: Proposed (a draft for the user's review, with ADR-114)
- Date: 2026-11-02
- Tasks: `docs/plan/ui-overhaul-tasks.md` (UI-T10 to UI-T13)

## Context

On 2026-11-02 the user asked for a full tutorial that navigates the tool and shows how it works
through the person making one of everything. It is divided into sections, offered at the first
sign-in, and the person chooses the sections they want. They added that it must be skippable
and that every tutorial stays available again in Settings. Progress is stored per person on the
server. The interface it runs in is ADR-114.

## Decision

- **Sections** (the person picks any): Tracks and tickets; Workflows; Boards and sprints;
  Search and saved searches; Dashboards; Releases; Administration; Import.
  - Workflows, Administration and Import show only to site administrators.
  - Each section makes one real thing in the person's own instance. What they make stays,
    and they may keep or delete it.
- **First sign-in:** a welcome dialog offers the sections as cards to tick, with suggested ones
  preselected. The choices are Start, Not now and Don't offer again. Not now and Don't offer
  again both leave every section available.
- **Settings → Tutorials** (and Help → Tutorials) lists every section with its state (Not
  started, In progress, Done, Skipped), to start, resume or do again at any time. Home links
  there too ("Take the tour").
- **During a section:**
  - A floating glass coach card shows the step, why it matters and Back, Next, Pause and Skip
    section, with a step counter.
  - The control to use is highlighted by a ring, and the rest of the page is dimmed but stays
    usable.
  - Steps that need the person to act (create a track, drag a card) wait for it and move on
    by themselves.
  - Escape pauses. Pausing keeps the place.
  - The card is a non-modal dialog that takes focus, so screen readers and keyboards follow
    it.
  - On phones the card docks at the bottom.
  - Targets are marked with `data-tutorial="<step>"` attributes, so restyling a page does not
    break the tutorial.
- **Progress is stored per person on the server:**
  - Migration 0084 (or the next free one at merge), `tutorial_progress`: workspace, person,
    section, state, step, updated at, plus one row for the offer (shown or dismissed).
  - `GET /api/v1/account/tutorial` and `PUT /api/v1/account/tutorial/:section`, session-only
    like the other self routes.
  - Each mutating route meets the server's standing requirements: a strict body schema, an
    authenticated person acting only on their own progress, a domain event with its contract
    scenario, and coverage in the route tests.
  - No other server code changes.
- **Strings and checks:** every string is in the catalogues with a Spanish draft. The picker,
  the offer and the coach card get stories (axe in both skins) and tests by role and name. An
  e2e test walks the offer and one full section. The manual gains a "Tutorials" page.

## Options considered

| Option | For | Against |
|---|---|---|
| Our own coach card and step engine (chosen) | Waits for real actions; strings in our catalogue; works under the strict CSP; styled by the tokens | We write and test the step engine |
| Product tour library (external) | Ready-made steps | Most inject styles (breaks the strict CSP of ADR-080), do not wait for real actions, and are not translated through our catalogue |
| Progress in the browser only | No migration | The user asked for server storage; it would not follow the person to another device |
| Recorded videos or a static guide | No code in the app | Does not teach in the person's own instance; goes stale with every change |

## Consequences

- The tutorial depends on `data-tutorial` markers. A test walks each section's steps against the
  stories, so a removed marker fails before release.
- What a person makes in a section is real data in their instance. The coach card says so at
  the start, and the last step offers the page to delete it.
- The migration number is 0084 unless the main session takes it first; the task file records
  the final number before the merge.
- Revisit if sections prove too long (split them) or people want a section per role.
