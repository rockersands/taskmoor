# Interface overhaul and guided tutorial: tasks

Branch `claude/ui-overhaul` (side session). This file is how the user and the main session
follow this work; `backlog.csv` and `progress.csv` stay with the main session.

- Decisions: [ADR-114](../adr/0114-glass-interface-and-clear-sections.md) (the interface),
  [ADR-115](../adr/0115-guided-tutorial.md) (the tutorial). Both Proposed until the user agrees.
- Numbers held by this branch: ADR-114, ADR-115 (ADR-116 if a third is needed), migration
  **0084** for `tutorial_progress`. If the main session has taken 0084 by the merge, this branch
  moves to the next free number and updates this line.
- States: todo, in progress, done, blocked.

| ID | Title | State | Done when | Commits |
|---|---|---|---|---|
| UI-T01 | Direction: ADR drafts and a prototype of Home, a board and a ticket, with screenshots for the user | in progress (waiting for the user's answer) | The user agrees the direction or names changes; ADR-114 and ADR-115 move to Accepted | 265af8b, 2678f9f |
| UI-T02 | Glass tokens and fallbacks in both skins; composited contrast test | in progress | Glass tokens in `tokens.css` with the opaque fallbacks; `contrast.test.ts` composites each glass token over the canvas and its glows at WCAG AA in both skins | 265af8b (tokens only) |
| UI-T03 | Shared pieces: PageHeader, HelpTip, EmptyState, ThemeToggle, Help menu | in progress | Each has a story (axe in both skins) and tests by role and name; Help menu built as an APG menu button like the person's menu | 265af8b (components, no stories yet) |
| UI-T04 | Navigation in sections, Tracks directory and track tabs | in progress | Sidebar grouped (done in the prototype); Tracks lists every visible track; a track's pages share one tab bar; NavList and AppShell tests and stories updated | 265af8b (groups only) |
| UI-T05 | Settings hub in groups, breadcrumbs on admin pages | todo | Settings shows the six groups of ADR-114 as cards with one line each; every admin page links back to its group; e2e that open admin pages still pass | |
| UI-T06 | Every page on PageHeader with a purpose line and explaining empty states | todo | No page renders a bare `page-title` heading; each has its purpose line and, where useful, "What is this for?"; empty lists use EmptyState | |
| UI-T07 | Board, backlog and ticket view in the glass language | in progress | Board and ticket header done in the prototype; backlog, reports, ticket side panel fields and activity follow; BoardPage, BacklogPage and TicketPage tests and stories updated | 265af8b (board and ticket header) |
| UI-T08 | Drag and drop with a keyboard path: board columns, dashboard widgets; restyle the existing drags | todo | Columns reorder by drag and by Move left/right; widgets by drag and by the existing buttons; every drop announced; tests for both paths | |
| UI-T09 | Phones and accessibility pass across the app | todo | No sideways scroll at 360 px on every page; 44 px targets under a coarse pointer; axe clean in both skins on every story; `pnpm verify --e2e` green | |
| UI-T10 | Tutorial progress on the server: migration 0084, `GET` and `PUT /api/v1/account/tutorial` | todo | Table type in `schema.ts`, schema golden reviewed; routes session-only with a strict body, own progress only, a domain event and its contract scenario, route tests | |
| UI-T11 | Tutorial picker and Settings, Tutorials page | in progress | Page and picker built (prototype, no storage); then reads and saves progress, starts, resumes and replays a section; story and tests | 265af8b (page without storage) |
| UI-T12 | First-run offer: Start, Not now, Don't offer again | todo | Offered once at a person's first sign-in; skipping leaves every section in Settings, Tutorials; story, tests and an e2e | |
| UI-T13 | Coach card and the steps of the eight sections | todo | Card highlights `data-tutorial` targets, waits for real actions, Back, Next, Pause, Skip, Escape pauses, docks on phones; a test walks every section's steps; one section end to end in e2e | |
| UI-T14 | Manual and HANDOFF | todo | A "Getting around" page and a "Tutorials" page in `docs/manual`; changed pages updated; HANDOFF says what changed and what is next | |
