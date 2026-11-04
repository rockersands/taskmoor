# ADR-115: The guided tutorial

- Status: Accepted (the user, 2026-11-03, with ADR-114)
- Date: 2026-11-02
- Tasks: `docs/plan/ui-overhaul-tasks.md` (UI-T10 to UI-T13); built as T-161 (AGL-025)

## Context

On 2026-11-02 the user asked for a full tutorial that navigates the tool and shows how it works
through the person making one of everything. It is divided into sections, offered at the first
sign-in, and the person chooses the sections they want. They added that it must be skippable
and that every tutorial stays available again in Settings. Progress is stored per person on the
server. The interface it runs in is ADR-114.

## Decision

- **Sections** (the person picks any): Tracks and tickets; Workflows; Boards and sprints;
  Search and saved searches; Dashboards; Releases; Administration; Import.
  - Workflows shows only to those who may edit workflows (site and configuration
    administrators); Administration and Import only to site administrators (changed in T-161,
    see "As built").
  - Each section makes one real thing in the person's own instance. What they make stays,
    and they may keep or delete it.
- **First sign-in:** a welcome panel at the top of Home (not a modal dialog; see "As built")
  offers the sections as cards to tick, with suggested ones preselected. The choices are Start,
  Not now and Don't offer again. Not now and Don't offer again both leave every section
  available.
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
  - Migration 0084 (exactly; 0085 belongs to another session), `tutorial_progress`: workspace, person,
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
- The migration number is 0084, agreed with the main session.
- Revisit if sections prove too long (split them) or people want a section per role.

## As built (T-161, 2026-11-03)

The code is `apps/web/src/tutorial`; the requirement is AGL-025. Where it differs from the
decision above, this section wins.

- **The offer is a panel in Home, not a modal dialog.** A dialog over the page at sign-in would
  hold back the page the person came for (a deep link, a ticket in an email) and every keyboard
  shortcut that waits for dialogs to close. The panel sits under Home's header, before Your
  tracks. It shows while the server says the offer was never answered and no section was
  started. Start and Not now store `shown`, Don't offer again stores `dismissed`; neither brings
  it back. A progress answer of another shape shows nothing.
- **Who is offered what:** sections carry `everyone`, `setup` or `site`. Workflows is `setup`,
  since configuration administrators edit workflows too; Administration and Import are `site`.
  A step may also be for some people only: someone who may not make a track opens one of theirs
  instead of making one. The server still decides every change.
- **How a step knows it is done:** a route (being on the page), a marker appearing (a form
  opened), or the server accepting a change. For the last, `apiFetch` tells listeners of every
  successful request other than a read, as its method and path (`api/changes.ts`), so the step
  moves on whichever page or control made the thing. Only changes after the step began count.
  Back marks a step to wait for Next; Next is always there, so nothing traps the person.
- **Boards and sprints** no longer makes a board: since ADR-116 each track has one. It moves a
  card on the track's board, then plans and starts a sprint.
- **Where the run lives:** the section showing, its step and what the person opened along the
  way (to offer Take me there and Open what you made) are kept in the tab's session storage, so a
  reload keeps the card. Another tab or device shows nothing until the person resumes from
  Settings, Tutorials; the server keeps each section's state and step, saved at every step.
- **Focus:** the card takes focus when a section starts and after Back, Next and Resume. When a
  step moves on by itself while focus is in a field, a menu or another dialog, focus stays and
  the card's status line announces the step. Escape pauses (in the card, or with nothing else
  focused); pausing and finishing give focus back to where it was.
- **Layout:** the card sits at the end corner and moves to the other corner, or the top, when it
  would cover the ringed control. On a phone it docks across the bottom, and the main area gains
  padding of the card's height so what it covers can scroll above it.
- **Checks:** `steps.test.ts` reads the app's source for every marker a step uses, so a page that
  drops one fails before release; `TutorialProvider.test.tsx` walks every section's steps;
  `e2e/tutorial.spec.ts` walks the offer and the Dashboards section on a desktop and a phone.
