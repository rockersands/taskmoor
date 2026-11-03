# Interface overhaul and guided tutorial: tasks

## Handoff (2026-11-03, from the cloud session)

The work continues in a local session on the user's PC. Start there with: read `CLAUDE.md`,
`HANDOFF.md` and this file, then continue the UI overhaul on `claude/ui-overhaul`.

- **The user's answers (2026-11-03), all given:** the direction is right, but follow the look of
  Liquid Glass more closely (the user suggests Gemini image generation through Claude in Chrome
  for visual assets, which the cloud session could not reach); keep "Manage" as the sidebar
  heading; add the Tracks directory and split Settings into grouped cards; the layout editor
  (UI-T15) and board columns (UI-T16) are part of this work. ADR-114 and ADR-115 are Accepted.
- **What is proposed and not yet reviewed in a browser:** the closer Liquid Glass pass (sheen,
  rim, navigation lens, glossy pills, four-glow canvas) in `apps/web/src/styles/tokens.css` and
  `apps/web/src/styles/surfaces.css`. The user has not seen it yet: show it in their Chrome first.
- **Half-done, and where:**
  - UI-T02: tokens done; the composited contrast test is not written (`styles/contrast.test.ts`).
  - UI-T03: `shell/PageHeader.tsx`, `HelpTip.tsx`, `EmptyState.tsx`, `ThemeToggle.tsx` done with
    tests and stories; the Help menu is not built.
  - UI-T04: sidebar groups done (`shell/NavList.tsx`, `NAV_ITEMS` in `App.tsx`); no Tracks page.
  - UI-T07: board (`boards/BoardPage.tsx`, `styles/boards.css`) and ticket header
    (`tickets/view/TicketPage.tsx`, `styles/ticket-view.css`) done; backlog, reports and the
    ticket side panel not.
  - UI-T11: `tutorial/TutorialPicker.tsx` (test, story) and `tutorial/TutorialsPage.tsx`
    (`#/settings/tutorials`) without storage; the Start buttons do nothing yet.
  - Everything else is todo; nothing of UI-T10 (server storage) or UI-T15 (layout editor) is on
    the branch.
- **Gate:** see the last commit on the branch and HANDOFF for which steps passed.
- **Numbers:** ADR-114 (interface), ADR-115 (tutorial), ADR-116 spare; migration **0084** exactly
  for `tutorial_progress`.
- **See the work:**
  - `corepack pnpm install`, then `corepack pnpm demo` (embedded PostgreSQL; on Linux as root use
    the system PostgreSQL and `TASKMOOR_TEST_DATABASE_URL`, see HANDOFF), open
    http://localhost:8080, set a password with a printed link; `?locale=en` for English.
  - The demo serves the built frontend: after a change, `corepack pnpm --filter @taskmoor/web
    build` and restart the demo.
  - Pages to look at: `/home`, `/boards` (make a Kanban board with the query `track = WEB`),
    `/tickets/API-12`, `/settings/tutorials`; the sun/moon button switches light and dark.
  - Screenshots without a browser: Playwright (`require('playwright')`), sign in at `/sign-in`,
    save the storage state, then `page.screenshot` per page at 1440×1000 and at 390×844 with
    `hasTouch`; set `localStorage['taskmoor.appearance']` and `data-skin` for a skin.
  - Storybook: `corepack pnpm --filter @taskmoor/web storybook` (Shell/PageHeader,
    Shell/ThemeToggle, Tutorial/TutorialPicker, Home/HomePage).


Branch `claude/ui-overhaul` (side session). This file is how the user and the main session
follow this work; `backlog.csv` and `progress.csv` stay with the main session.

- Decisions: [ADR-114](../adr/0114-glass-interface-and-clear-sections.md) (the interface),
  [ADR-115](../adr/0115-guided-tutorial.md) (the tutorial). Both Accepted by the user on 2026-11-03.
- Numbers held by this branch: ADR-114, ADR-115 (ADR-116 if a third is needed), migration
  **0084** for `tutorial_progress`, exactly (0085 and ADR-113 belong to the ticket-templates
  session).
- States: todo, in progress, done, blocked.

| ID | Title | State | Done when | Commits |
|---|---|---|---|---|
| UI-T01 | Direction: ADR drafts and a prototype of Home, a board and a ticket, with screenshots for the user | done | The user agrees the direction or names changes; ADR-114 and ADR-115 move to Accepted | 265af8b, c4e6b60 |
| UI-T02 | Glass tokens and fallbacks in both skins; composited contrast test | in progress (Liquid Glass tokens done; composited contrast test to do) | Glass tokens in `tokens.css` with the opaque fallbacks; `contrast.test.ts` composites each glass token over the canvas and its glows at WCAG AA in both skins | 265af8b (tokens only) |
| UI-T03 | Shared pieces: PageHeader, HelpTip, EmptyState, ThemeToggle, Help menu | in progress (PageHeader, HelpTip, EmptyState, ThemeToggle with tests and stories; Help menu to do) | Each has a story (axe in both skins) and tests by role and name; Help menu built as an APG menu button like the person's menu | 265af8b (components, no stories yet) |
| UI-T04 | Navigation in sections, Tracks directory and track tabs | in progress | Sidebar grouped (done in the prototype); Tracks lists every visible track; a track's pages share one tab bar; NavList and AppShell tests and stories updated | 265af8b (groups only) |
| UI-T05 | Settings hub in groups, breadcrumbs on admin pages | todo | Settings shows the six groups of ADR-114 as cards with one line each; every admin page links back to its group; e2e that open admin pages still pass | |
| UI-T06 | Every page on PageHeader with a purpose line and explaining empty states | todo | No page renders a bare `page-title` heading; each has its purpose line and, where useful, "What is this for?"; empty lists use EmptyState | |
| UI-T07 | Board, backlog and ticket view in the glass language | in progress | Board and ticket header done in the prototype; backlog, reports, ticket side panel fields and activity follow; BoardPage, BacklogPage and TicketPage tests and stories updated | 265af8b (board and ticket header) |
| UI-T08 | Drag and drop with a keyboard path: board columns, dashboard widgets; restyle the existing drags | todo | Columns reorder by drag and by Move left/right; widgets by drag and by the existing buttons; every drop announced; tests for both paths | |
| UI-T09 | Phones and accessibility pass across the app | todo | No sideways scroll at 360 px on every page; 44 px targets under a coarse pointer; axe clean in both skins on every story; `pnpm verify --e2e` green | |
| UI-T10 | Tutorial progress on the server: migration 0084 (exactly), `GET` and `PUT /api/v1/account/tutorial` | todo | Table type in `schema.ts`, schema golden reviewed; routes session-only with a strict body, own progress only, a domain event and its contract scenario, route tests | |
| UI-T11 | Tutorial picker and Settings, Tutorials page | in progress (picker with test and story; page without storage) | Page and picker built (prototype, no storage); then reads and saves progress, starts, resumes and replays a section; story and tests | 265af8b (page without storage) |
| UI-T12 | First-run offer: Start, Not now, Don't offer again | todo | Offered once at a person's first sign-in; skipping leaves every section in Settings, Tutorials; story, tests and an e2e | |
| UI-T13 | Coach card and the steps of the eight sections | todo | Card highlights `data-tutorial` targets, waits for real actions, Back, Next, Pause, Skip, Escape pauses, docks on phones; a test walks every section's steps; one section end to end in e2e | |
| UI-T14 | Manual and HANDOFF | todo | A "Getting around" page and a "Tutorials" page in `docs/manual`; changed pages updated; HANDOFF says what changed and what is next | |
| UI-T15 | Layout editor page under Settings, Configuration sets (confirmed by the user 2026-11-03) | todo | A page for layout sets (`/api/v1/layout-sets`): drag fields into tabs and sections (main or side column), reorder them, mark a section "hide when empty"; "show only the fields I placed" maps to `others: "omit"`; a live preview per ticket type and per operation (create, edit, view); a keyboard path for every drag; the field rules page and this one link to each other and each explains what it does and how the two combine; manual `admin/fields.md` updated (the "no web page yet" line goes); story, tests and an e2e | |
| UI-T16 | Board columns easy to manage (confirmed by the user 2026-11-03) | todo | On the board and in its settings: add, rename, reorder by drag (and by Move left/right), set minimum and maximum; the limit stays 30 (`MAX_COLUMNS` in `apps/server/src/boards/model.ts`) and the page says so when it is reached; tests for drag and keyboard paths. Overlaps UI-T08's column drag | |

## Next session: start here

The user asked to wrap up on 2026-11-03; the work stops here with everything committed and the
gate green (see HANDOFF). In order:

1. UI-T02: composite each glass token over the canvas and its four glows in
   `apps/web/src/styles/contrast.test.ts` (both skins, WCAG AA for text and muted text).
2. UI-T03: the Help menu (Tutorials, Keyboard shortcuts, Manual) as an APG menu button; reuse the
   keyboard handling of `session/UserMenu.tsx` (extract a shared hook).
3. UI-T10: the server storage. A helper had started it and was stopped before committing
   anything; start again from ADR-115. The four checks every mutating route must pass: an event
   with a scenario in `events/contract.test.ts`, the OpenAPI entry (`api/openapi.test.ts`), the
   token scope class (`tokens/scopes.test.ts`, session only) and the account-route session check
   (`routes/identity.test.ts`). Migration 0084 exactly.
4. UI-T04, UI-T05, UI-T06: Tracks directory and tabs, the Settings hub, every page on PageHeader.
5. UI-T15 (layout editor) and UI-T16 (board columns), then UI-T08 (widget drag).
6. UI-T12, UI-T13: the first-run offer and the coach card, on UI-T10's routes.
7. UI-T09 and UI-T14: the phone and accessibility pass, the manual.
