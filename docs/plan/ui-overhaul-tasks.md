# Interface overhaul and guided tutorial: tasks

## Where this stands (2026-11-03, local session)

The user accepted the look and said to build the rest. ADR-116 records one place per track, one board
per track, a column is a status, and moves that ask for nothing by default.

Done and on the branch: Deep glass, Soft canvas, illustration (UI-T02); Help menu (UI-T03); tutorial
storage (UI-T10, migration 0084); one board per track (migration 0088); the free-moving default
workflow (migration 0089); one column per status; column reach and fix, closing column, removing a
column that holds cards (UI-T16, most of it); the ticket's one status control; track tab bar, directory
and sidebar (UI-T04); Files and links; board person filter; search basic filters; Statistics, every
report of a track in its tabs; a customizable Summary (migration 0090, `track_summary_layout`).

Known gaps from that work:

- An import can put sprints on a Kanban board when a track's first source board is Kanban.
- `apps/web/e2e` specs that make boards through the old page or POST free boards, and those clicking
  the old transition buttons, need updating; `person-and-basic-filters.spec.ts` has not passed yet.
- Running e2e rebuilds `apps/web/dist`: restart the demo straight after, or its page breaks.

The Administration panel is built (UI-T05, UI-T17 to UI-T20): five groups, an overview, a page per group,
breadcrumbs, and four new pages. Not there yet: Invitations (from `claude/track-invites`, when the branches
join: its page goes in the People and access group of `admin/sections.ts`, its pending list replaces the
overview's "not signed in yet" panel), and pages for layout sets (UI-T15), priorities and notification policies
(UI-T21), which join Tracks and setup with their pages. UI-T21's list stays for the user.

Next, in order: every page on
PageHeader (UI-T06); column and widget drag (UI-T08, rest of UI-T16); layout editor (UI-T15); tutorial
(UI-T11 to UI-T13); phones and accessibility (UI-T09); manual (UI-T14).

## Review of the closer pass (2026-11-02, local session)

The closer Liquid Glass pass was shown in the user's Chrome on the home page, a board and a ticket,
light and dark. **The user accepted the look on 2026-11-03 and said to build the rest.**

- **The user's choice (2026-11-02): the Soft canvas and the illustration stay,** in both skins. The
  preview switch and the pictures not chosen are gone. **The generated images still need the
  user's check of Gemini's terms** (`docs/plan/ui-assets-provenance.md`).
- **Thick glass (ADR-114): the user chose the stronger strength, Deep,** and that controls do not
  truly bend their colour is fine for now. The switch is gone.
- **Dark Reader (the user's decision):** detected in `public/skin-boot.js`, which adds the lock and
  takes over with the dark skin unless the person chose one (ADR-114, section 4). The static lock
  is gone.
- **Approved by the user, to build: the board create form's query field.** "Tickets
  (una consulta)" on `#/boards` confused the user, who did not know what to put in it or why it is
  required. Its hint's example, `track = SHOP`, names a track the demo does not have (it has API,
  MOB, OPS and WEB). Proposed: a track picker by default that fills in the query, and the raw query
  only under an "advanced" choice.
- **To fix later:** in the create dialog, Escape stops working after Create, because the disabled
  submit button drops focus (`tickets/CreateTicketDialog.tsx`; found by the ticket templates work).
- **An empty state's own icon is hidden:** callers still pass one and the illustration stands in
  for all of them. Clean up the prop in UI-T06 if the one picture stays.
- **Still unclear after the pass, for later tasks:** a ticket opened from a board lights up Tracks
  in the sidebar and has no link back to the board (UI-T04); a board's columns stop well short of
  the page's width at 1920 px (UI-T07, UI-T16); the keyboard hint under a board's title competes
  with its purpose line (UI-T07); the ticket's side panel still has Details and Information with
  no word on the difference (UI-T07); a ticket's content stops short of the right of a wide screen.

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
- **Gate (not complete):** passed on this branch: `pnpm verify --only=lint,types`; the web
  component tests (`--project=web`, 782 passed); the stories and tests of `shell`, `home`,
  `tutorial`, `boards` and `tickets` in both skins (190 passed); `docs-check` and `next-task`
  tests; `pnpm i18n:check`; `pnpm run docs`. Not run to the end: the full `pnpm verify --e2e`. It
  started on fe9066d and the cloud container was killed partway (exit 137, likely memory), so
  the database suites, the other stories and Playwright e2e are unverified. Run the full gate
  first in the local session, before anything goes to `main`.
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
| UI-T02 | Glass tokens and fallbacks in both skins; composited contrast test | done (the test found dark muted text at 4.36 under the sheen's brightest corner; the sheen went from 12 % to 9 %) | Glass tokens in `tokens.css` with the opaque fallbacks; `contrast.test.ts` composites each glass token over the canvas and its glows at WCAG AA in both skins | 265af8b (tokens only) |
| UI-T03 | Shared pieces: PageHeader, HelpTip, EmptyState, ThemeToggle, Help menu | in progress (PageHeader, HelpTip, EmptyState, ThemeToggle with tests and stories; Help menu to do) | Each has a story (axe in both skins) and tests by role and name; Help menu built as an APG menu button like the person's menu | 265af8b (components, no stories yet) |
| UI-T04 | Navigation in sections, Tracks directory and track tabs | in progress | Sidebar grouped (done in the prototype); Tracks lists every visible track; a track's pages share one tab bar; NavList and AppShell tests and stories updated | 265af8b (groups only) |
| UI-T05 | Administration panel: its own section and navigation, separate from personal Settings (decided by the user 2026-11-03 for 1.0; replaces the Settings hub) | done, e2e not run; Invitations wait for the branch | Five groups as in ADR-114: People and access; Tracks and setup; Sign-in and security; Integrations and AI; System. A site administrator sees all of them. A configuration administrator sees only the setup pages, and those work in the web app without the API, with tests for both roles. An overview page shows system health, pending invitations and recent security alerts. Every page has a breadcrumb back to its group; admin routes keep their paths; e2e that open admin pages still pass. The invite permission and track managers' page from `claude/track-invites` moves into the panel when the branches join | |
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
| UI-T17 | Administration: visibility policies and the permission explainer (first new page) | done | Policies and levels managed in the web app; the explainer answers who can do what and why; story, tests; `admin/permissions.md` updated | |
| UI-T18 | Administration: webhooks (second) | done | Create, change, delete and see deliveries in the web app, site administrators only; story, tests; `admin/rest-api.md` updated | |
| UI-T19 | Administration: AI limits and prices (third) | done | Limits and the price table managed in the web app; story, tests; `admin/ai-usage.md` updated | |
| UI-T20 | Administration: which sets a track uses (fourth) | done (a plain picker; making layout, priority and notification sets stays in UI-T15 and UI-T21) | A track's layout, priority, visibility and notification sets chosen in the web app; the "API only" rows in `admin/fields.md` go. Needs a list to choose from, so it joins UI-T15 (layouts), UI-T17 (visibility) and the priority and notification pages in UI-T21 | |
| UI-T21 | Administration: the rest of what the manual marks API-only; the user decides which are in 1.0 | todo | Each item below has a page, or a line saying why it stays in the API | |

### UI-T21: other controls `docs/manual/admin` marks as API-only

Beyond UI-T17 to UI-T20 and the layout sets of UI-T15:

| Control | Manual page |
|---|---|
| Ticket types and levels | `fields.md` |
| Priorities and priority sets | `fields.md` |
| Formula fields, field contexts' scopes and defaults, child options of a two-level list, field type settings | `fields.md` |
| Notification policies; the batch window and digest hour | `notifications.md` |
| Areas of a track | `tracks.md` |
| Status mapping when a workflow map switch affects tickets (the web app refuses the switch) | `tracks.md` |
| Renaming a group; adding a service account to a group | `people-and-groups.md`, `api-tokens.md` |
| Roles in a user or group field of the ticket (People in field, Groups in field) | `permissions.md` |
| Sharing saved searches and dashboards with people, groups and tracks | `permissions.md` |
| The backup schedule (the page only reads it) | `backups.md` |
| The AI provider's key (other ways to set it exist; check whether the AI page covers it) | `ai.md` |

Left out as developer features, not administration: track and ticket properties and the REST API
itself (`rest-api.md`). Found by searching for "through the API", "API only" and "no web page", so
a control described in other words could be missing.

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
4. UI-T04, UI-T05, UI-T06: Tracks directory and tabs, the Administration panel, every page on
   PageHeader; then UI-T17 to UI-T21, its new pages.
5. UI-T15 (layout editor) and UI-T16 (board columns), then UI-T08 (widget drag).
6. UI-T12, UI-T13: the first-run offer and the coach card, on UI-T10's routes.
7. UI-T09 and UI-T14: the phone and accessibility pass, the manual.
