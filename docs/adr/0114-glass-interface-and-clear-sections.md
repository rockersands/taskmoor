# ADR-114: The glass interface and clear sections

- Status: Accepted (the user, 2026-11-03: the direction yes, closer to Liquid Glass; "Manage" kept;
  the Tracks directory yes; the layout editor and board columns in scope; 2026-11-03: a full
  Administration panel in place of the Settings hub)
- Date: 2026-11-02 (accepted 2026-11-03)
- Tasks: `docs/plan/ui-overhaul-tasks.md` (UI-T01 to UI-T09, UI-T15 to UI-T21); the tutorial is ADR-115

## Context

On 2026-11-02 the user asked for the whole web interface to be reworked: "way more
understandable and usable", with inspiration from work trackers in general and from translucent,
layered interfaces, drag and drop, light and dark modes, sections that are clear, and every
panel saying what it is for. The tutorial they asked for at the same time is ADR-115.

A review of the running app (`pnpm demo`) found:

- **Sections are unclear.** The sidebar is one flat list. Tracks leads to "This area is under
  construction". Settings is a single page of some 30 links in two headings. A track's own pages
  (summary, list, calendar, timeline, releases) are plain underlined links in the title row.
- **No page says what it is for.** Home has three cards and a greeting. A board shows its
  columns with no word on what moving a card does. An empty Scrum board says "No tickets on this
  board match" when the real reason is that no sprint is running.
- **Controls carry equal weight.** On a ticket, the workflow's moves (Send to review, Close)
  look exactly like Follow, Vote, Clone and Keyboard shortcuts. Fields in the side panel are bare
  browser controls.
- **Drag and drop is partial.** Board cards, the backlog, calendar dates and file drops on a
  ticket can be dragged, each with a keyboard path. Dashboard widgets and board columns move only
  with buttons.

ADR-036 (skins and the soft visual language) and ADR-024 (stories and axe) stay in force. This
ADR builds on them.

## Decision

### 1. Navigation and information architecture

The sidebar is grouped into three labelled sections. Each page also has a one-line purpose shown
under its title.

| Section | Page | Its one line |
|---|---|---|
| Your work | Home | Your work in one place: what is assigned to you, what you opened lately and what you follow. |
| | Inbox | Mentions of you and changes to the tickets you follow, newest first. |
| Plan and track | Tracks | Every track you can see: open one for its summary, list, board, calendar, timeline and releases. A board has no sidebar link of its own: each track has one, in its tabs (ADR-116). |
| | Search | Find tickets with filters or the query language, and save the searches you reuse. |
| | Dashboards | Charts and lists that sum up the work at a glance, for you or a team. |
| Manage | Settings | Your own account, how Taskmoor looks for you and your tutorials. |
| | Administration | How this instance is doing and what is waiting for you. Shown to site and configuration administrators. |

- **Tracks** becomes a real page: a directory of tracks (key, name, type, owner) with a search
  box. Inside a track, a tab bar holds Summary, List, Board, Backlog, Calendar, Timeline and
  Releases, so a track's pages read as one place.
  It offers **New track** (a dialog with the form Administration uses) to those the server lets make
  one: shared configuration for site and configuration administrators, local for
  `create_local_tracks`, which the session reports. A person with neither sees no button.
- **Settings** is personal: Account, Appearance and Tutorials.
- **Administration** is a section of its own, separate from Settings, with its own navigation (the
  user's decision, 2026-11-03: a full panel in 1.0; it replaces the Settings hub first planned
  here). It sits under **Manage** for those allowed to see it, and its groups are:
  - People and access: People, Groups, Teams, Invitations, Access policies, Visibility policies and
    the permission explainer.
  - Tracks and setup: Tracks, Workflows, Workflow maps, Fields, Configuration sets, Layout sets,
    Priorities, Notification policies, and which sets a track uses.
  - Sign-in and security: Security, Identity providers, Directories, Network access, Audit log.
  - Integrations and AI: API tokens, Service accounts, MCP, Frontends, Webhooks, AI, AI usage,
    limits and prices.
  - System: System status, Backups, API usage, Imports, Trash, Guardrails.
- **Who sees it:** a site administrator sees every group. A configuration administrator sees only
  the setup pages, and those must work in the web app without the API, which they need today.
- **What a configuration administrator needs:** the session says whether the person holds Change
  configuration, and two reads open for them, only to give a track's role: `GET /api/v1/groups`, and
  `GET /api/v1/people/lookup` (a name and an id; the list of people stays with site administrators).
- **The overview page** opens the section: system health, pending invitations and recent security
  alerts. Invitations have no read on this branch yet (they come with `claude/track-invites`), so the
  panel lists people who have an account, no password and no sign-in so far, from `GET /api/v1/users`.
- **Controls that only the API has today get pages**, in this order: visibility policies and the
  permission explainer; webhooks; AI limits and prices; which layout, priority, visibility and
  notification sets a track uses. The rest of what the manual marks as API-only is listed in
  `docs/plan/ui-overhaul-tasks.md`.
- Each administration page has a breadcrumb back to its group, and admin routes keep their paths.
- **The top bar** keeps New ticket, the command palette and the person's menu. It gains a
  light and dark toggle and a **Help** menu: Tutorials, Keyboard shortcuts and the Manual.
- **Names** follow `docs/specs/00-terminology.md`. No Atlassian term appears in the interface.

### 2. Layout and density

- Desktop first, and it still works on phones (ADR-033):
  - The sidebar is 240 px, can collapse to a 72 px rail, and becomes a drawer below 768 px.
  - Content runs up to about 76 rem wide.
  - Nothing scrolls sideways except a board's columns, inside their own scroll region.
- **Page header** on every page: an optional line above the title (where the page sits, for
  example "Platform API · Bug"), the title, the purpose line, a "What is this for?" button and
  the page's actions on the right (under the title on phones).
- **Comfortable density** by default: 12 to 16 px inside cards and 44 px touch targets under a
  coarse pointer.
  - Board cards show the key, summary and one line of facts (type, assignee, priority, days in
    the column), with a round "⋯" menu button.
  - Board columns are 16 to 22 rem wide.
  - A compact density is a later option, not part of this work.
- **Hierarchy of actions:** one primary action per area (a filled pill in the skin's primary
  tint); a workflow's moves are primary on a ticket; everything else is a quiet glass pill.

### 3. Visual language: glass

The soft language of ADR-036 stays (pastel tones, large radii, pills and circles). Surfaces
become **translucent glass**:

- **Tokens** (`tokens.css`, per skin):
  - `--glass-surface` (cards and panels, about 65 % opaque), `--glass-surface-strong` (menus,
    popovers, the drawer, dialogs, about 86 %) and `--glass-surface-sunken` (wells such as board
    columns).
  - `--glass-edge` (a hairline that catches the light), `--glass-highlight` (an inner top
    highlight) and `--glass-tint-accent`.
  - `--glass-blur` (22 px), `--glass-blur-strong` (32 px) and `--glass-saturate`.
- **The canvas** is a soft generated picture per skin (the user's choice, 2026-11-02): pale
  dawn in light, dusk in dark, under a dim layer (`--canvas-dim`), so the glass has colour to pick
  up. The two pictures and the empty-state illustration are listed with their prompts in
  `docs/plan/ui-assets-provenance.md`. **They still need the user's check of Gemini's terms**
  before a release; if that fails, the CSS glows in the history of `tokens.css` come back.
- **Depth** has three levels: the canvas; glass panels (top bar, sidebar, cards); and floating
  glass (menus, popovers, dialogs, the tutorial's coach card) with the strongest blur and
  shadow-3.
- **Contrast is kept:**
  - Glass alphas are chosen so text over the darkest point of the canvas still meets ADR-036's
    ratios.
  - `contrast.test.ts` composites each glass token, with its sheen, over pixels measured from
    the canvas picture, and text directly on the canvas against each area's lightest and darkest
    pixel, and holds them to WCAG AA. Replacing a picture without measuring it fails the test.
  - Without `backdrop-filter`, or under `prefers-reduced-transparency: reduce`, every glass
    token falls back to the skin's opaque surface. Under `forced-colors` the edges become
    system colours.
- **Closer to Liquid Glass** (the user, 2026-11-03). Glass is clearer (about 52 % opaque for
  cards and chrome, 78 % for floating surfaces) and carries three more layers, all tokens:
  - `--glass-sheen`: a gradient of light across the surface, under its tint
    (`--glass-fill` and `--glass-fill-strong` combine the two).
  - `--glass-rim`: a 1 px ring, bright where the light falls (top left) and nearly gone on the
    far side, drawn as a masked pseudo-element on the floating surfaces.
  - `--glass-highlight`: inner light on the top, sides and inside.
  - The current navigation item is a lens of brighter glass; filled pills carry a gloss that
    fades halfway down; the search field and quiet pills are clear glass.
  - Sheen and rim turn off with the opaque fallbacks and in forced colours.
- **Thick glass** (the user, 2026-11-03: "more glasslike"; of two strengths they chose the
  stronger, Deep), working from how a slab of glass behaves, in our own design:
  - Refraction at the rim: `shell/glassLens.ts` draws an SVG displacement filter per surface size
    and radius and sets it as `--glass-lens`, used in `backdrop-filter`. It splits red, green and
    blue slightly, so the colour at the edge comes from what is really behind the glass. Only
    Chromium draws this (confirmed by what the user's Chrome showed); other browsers, and people
    who ask for less transparency or forced colours, keep the blur and the sheen.
  - Refraction goes where something passes under the glass: the top bar, and menus, dialogs and
    help popovers that do not sit inside another glass surface. Chromium paints the filter solid
    grey on a backdrop with nothing in it, so the clear part of a control has a slight blur over
    its colour and no bend. Cards and panels over the smooth canvas
    and the sidebar show none, so they do not pay for it, and board cards have no blur at all.
  - Thickness: light on the edge facing the light, a darker inner edge opposite, a rim whose
    strength varies around the shape, and a contact shadow beneath (`--glass-highlight`,
    `--glass-rim`, `--glass-contact`).
  - Glass over colour: the current place in the sidebar, the selected tab and the light and dark
    switch have a coloured part under a clear part; filled pills are a dome over their colour.
  - Blur is low (4 px on cards, 5 px on the top bar, 12 px on floating surfaces). The top bar's text uses the full text colour, as
    bright fills pass under it. `contrast.test.ts` holds all of it to WCAG AA.
  - An empty state shows one generated illustration of stacked cards (the user's choice,
    2026-11-02) in place of its small icon.
- **Geometry:** radii 10, 16, 24 and 32 px and pills, as ADR-036.
- **Motion:** see section 11. A dragged card's column tints and a line marks the drop place; under
  `prefers-reduced-motion` nothing moves, and state changes still show by colour and outline.
- **Shared filter controls** (the user, 2026-11-03, after testing the demo): `filter-chip` (a tick
  and a heavier label when on, never colour alone), `Popover` (`shell/Popover.tsx`: over the content,
  closed by Escape or a click outside with focus back on its button, docked at the bottom of the
  screen below 768 px), `glass-check` and `thin-scroll`, for any page to reuse.
- **Fields** (the user, 2026-11-03: no more flat beige) are one rule in `forms.css` on the token
  `--field-surface`: clear glass, opaque where glass falls back, with `--color-field-border` at 3:1
  beside the canvas, any glass and any opaque surface. `contrast.test.ts` holds it.
- **Own assets only.** Icons are original line drawings on a 24 px grid (`shell/icons.tsx`).
  Nothing is taken from Apple's or Atlassian's assets, screenshots, colours or layouts. The
  translucent depth is the idea we borrow, not any asset.

### 4. Light and dark

- Both skins of ADR-036 stay, and each gains the glass tokens.
- The new top-bar button switches between light and dark in one press.
- Account, Appearance keeps the full choice (System, Light, Dark), saved with the account.
- Every story keeps running its axe checks in both skins.
- **The Dark Reader extension** repaints every colour, removes the canvas and so hides the glass
  (found in the user's Chrome). The boot script (`public/skin-boot.js`) detects it from what it
  leaves on the page, adds `<meta name="darkreader-lock">`, and switches to the dark skin unless
  the person chose a skin here (the user's rule, 2026-11-03). Tried in the user's Chrome: the
  extension removed its styles before the page's first paint, with a choice of Light, of Dark and
  of System. If a later version of the extension stops honouring the lock, remove this and do
  nothing about it.

### 5. Empty states that explain

`EmptyState` (icon, what is missing, how it fills, the next step) replaces bare "No ..."
sentences. Examples:

- Assigned to you: "When someone assigns you a ticket, or you choose Assign to me on one, it
  shows here." With the action "Find a ticket".
- A Scrum board without a running sprint: "No sprint is running", why, and the action "Open the
  backlog".
- Boards, dashboards, saved searches and releases with none yet: what one is, and the button
  that makes the first one.

### 6. Inline help: "What is this for?"

- A round help button beside each page title and each panel title opens a short explanation
  under it.
  - It is a disclosure, not a hover tooltip, so it works by touch, keyboard and screen reader.
  - Its name is "What is {name} for?".
  - Escape or a press elsewhere closes it.
- The longer text links to the page of the manual where one exists.

### 7. Drag and drop, always with a keyboard path

| What | Drag | Keyboard or button path |
|---|---|---|
| Board cards (between columns and within one) | kept, restyled | Alt+arrows and the card's ⋯ menu (kept) |
| Board columns (order) | new, on the board and in settings | Move left and Move right in the column's menu |
| Backlog ranking and sprint planning | kept, restyled; by finger too (section 12) | each ticket's grip menu, the selection's menus, Alt+arrows |
| Dashboard widgets | new (section 12) | Move up, down, left and right buttons (kept), Alt+arrows on them |
| Files on a ticket | kept, the whole ticket accepts a drop (section 12) | Attach files button and paste (kept) |

Every drop is announced in a live region, as the board does now.

### 8. The layout editor

Layout sets (`/api/v1/layout-sets`) arrange the create, edit and view forms per ticket type and
had no web page. A page under Settings, Configuration sets edits them:

- Fields are dragged from a palette into tabs and sections (the main column or the side column)
  and reordered within and across them; a section can be "Hide when empty".
- "Show only the fields I placed" is `others: "omit"`.
- A live preview shows the form for the chosen ticket type and operation (create, edit, view).
- Every drag has a keyboard path: a Move menu on each field and section, and Alt with the arrow
  keys; each move is announced.
- The layout editor and the field rules page link to each other, and each says how they
  combine: layouts decide where fields appear and in what order; field rules decide whether a
  field is required, hidden or has help text; a hidden field never appears even when a layout
  places it, and a required field always appears.

### 9. Board columns

On the board and in its settings, columns are added, renamed, reordered by drag (and by Move
left and Move right) and given a minimum and a maximum. The limit stays 30 per board
(`MAX_COLUMNS`); the page says so when it is reached.

### 10. Strings, accessibility and tests

- Every string is in `messages.en.ts` with a Spanish draft in `messages.es.ts`.
  `pnpm i18n:check` stays clean.
- New components (`PageHeader`, `HelpTip`, `EmptyState`, `ThemeToggle`)
  get stories (axe in both skins) and tests by role and name.
- e2e specs change only where names or roles change, never weakened.
- The manual gains a "Getting around" page. Pages that change are updated in the same task.

### 11. Motion: watery (the user, 2026-11-03)

The user asked for a "watery" look across the whole app, always when animating. This is our own
design from general ideas: fluid easing, a slight overshoot and settle, surfaces that swell and melt
as if liquid. It is the default for new work.

- **Tokens** (`styles/tokens.css`): the durations `--motion-fast`, `--motion-base` and `--motion-slow`
  (120, 180 and 280 ms, so it never delays work); `--ease-soft` (fluid, for colours, fades and what
  leaves), `--ease-settle` (a little past the mark and back) and `--ease-swell` (past the mark, a small
  rebound, then still). The last two are a damped spring sampled in CSS `linear()`, with a plain
  `cubic-bezier()` where a browser lacks it. `--lift` and `--lift-small` are how far a card lifts.
- **Classes** (`styles/motion.css`): `motion-swell`, `motion-settle`, `motion-rise`, `motion-slide`,
  `motion-dock`, `motion-drop`, `motion-bulge`, `motion-fade` and `motion-collapse`. New work uses a
  class or joins a list in that file, and `shell/Motion.stories.tsx` shows them all.
- **Transforms and opacity only.** No animating of height, width, top, left, filter, backdrop-filter
  or box-shadow. A surface swells by `scale` and `translate`, from slightly under 1, with its
  transform origin near what opened it. A small control or a column may still fade a colour: that is
  paint on one element. A fold's height changes at once; only its contents move.
- **Cheap on a big board.** No `will-change` anywhere. Only the one card that has just dropped
  animates, and its class goes when it ends.
- **Leaving never waits.** `leaveMotion` (`shell/motion.ts`) removes the real surface at once, for
  focus, screen readers and tests, and lets an empty copy of its box melt for 120 ms.
- **Off under reduced motion.** One rule at the end of `tokens.css` sets the durations to 0 ms and the
  lifts to nothing under `prefers-reduced-motion: reduce` and in print. There are no per-page rules. The
  glass's `prefers-reduced-transparency` handling is separate and unchanged.
- **Glass:** a region holding glass (a tab's contents) moves by transform with no fade, and a
  dialog's backdrop fades on a layer of its own, because opacity on an ancestor cuts glass off from what
  lies behind it, and Chromium then paints a lens filter solid grey.
- **Tests run still.** Story tests and Playwright ask for reduced motion: axe measures colour as it
  is at that moment, and a test measuring a surface mid-swell would get a scaled box.
- **The check:** `styles/motion.test.ts` fails on a duration or easing that is not a token, on another
  property being animated, on `will-change` and on a second reduced-motion rule. Its exceptions are a
  short named list, each with a reason, and its header says what it does not catch.

### 12. Drag and drop beyond the board (T-162, 2026-11-03)

Section 7 carried out for the backlog, dashboard widgets and files on a ticket, with the board's
habits: the place a drop would land is outlined, the page says what is in hand and what happened,
Escape cancels, and every move also has a menu or keys. Requirements: AGL-008 and AGL-009 (the
backlog), RPT-004 (dashboards), CORE-021 (attachments), NFR-005 and NFR-007; no new one was needed.

- **Pointer events, not the browser's drag and drop, for things the page moves.** A finger never
  starts a native drag on most phones, so the backlog leaves it and the widgets never take it up.
  `shell/pointerDrag.ts` follows one press: it becomes a drag after 6 px (a shorter press is a click
  as usual), Escape cancels it and goes no further (an open dialog stays open), the pointer near the
  top or bottom of the scrolling area scrolls it (a finger's drag cannot scroll the page itself), no
  text is selected on the way, and the click a drag ends with is swallowed. What is under the
  pointer is asked of the page (`elementFromPoint`, with `data-drop-*` attributes on the targets),
  so a mouse, a pen and a finger take one path. Board cards keep the native drag of ADR-049 for now;
  moving them onto this follower would give them a finger drag too (an open question below).
- **One grip.** `shell/MoveMenu.tsx` is the grip the Tracks page's groups had (CORE-034), moved to
  the shell and shared: a button a mouse or a finger drags, which pressed opens a menu of the same
  moves, with Alt and the arrow keys stepping it. It is 44 px under a coarse pointer and carries
  `touch-action: none`, so a finger on it drags rather than scrolls; elsewhere a finger scrolls.
- **The backlog.** A mouse drags a row from anywhere but its controls, a finger by its grip; a
  ticket that is part of the selection takes the whole selection, in order. The section and the
  place are outlined as on the board (`is-drop-target`, `is-drop-before`), the outcome or release
  under the pointer likewise, and a label with the ticket's key and summary (or the count) follows
  the pointer. The status line says what is in hand, then what the server did, or that the tickets
  stayed where they were. Each ticket's "Move to…" select became its grip's menu: up, down, to the
  top, to the bottom, and to each other sprint or the backlog. A drop calls exactly what the menus
  call (`addTickets`, `removeTickets`, `rank`, `setParent`, `addRelease`), so the server's rank and
  sprint rules judge it, and a refusal reads as it does for the menus.
- **Dashboard widgets.** While a dashboard or a track's Summary is edited, a widget drags by its
  grip (mouse or finger) or by its title (mouse) to a place in any column; an empty column says it
  takes a drop. The Up, Down, Left and Right buttons stay, and Alt with an arrow key on any of a
  widget's buttons makes the same move with the keyboard left on the button of that arrow. Every
  move is announced with where the widget now is ("Alpha is now in column 2, 1 of 2."), and a drop
  where it already was says it stayed. Nothing is saved until **Save dashboard**; the server checks
  the layout and its version then, as before.
- **Files on a ticket.** The whole ticket view, on its page and in the pop-up, takes files
  (`attachments/FileDrop.tsx`): while files from outside are over any part of it, an outline goes
  round the whole ticket with a card naming it and the size limit, or saying why nothing can be
  attached (no permission, a status lock, files turned off). A file let go anywhere goes to the
  attachments panel as a chosen file would (the same size check, one upload each) and the panel
  comes into view. A drag that carries no files, such as text or a link, is left to whatever is
  under it. The ticket takes a refused drop too, so the file never opens in the browser in place of
  the page. The outline is hidden from screen readers; a live region says the same words. **Attach
  files** and pasting stay the keyboard's way.
- **Nothing new on the server.** No route, event, migration or audit decision changes: every drop
  is a call that already existed, with its event and audit entry.
- **Tests.** Component tests drive pointer events (`setViewportWidth` for phones); stories drag in
  a real browser and are checked by axe in both skins, mid-drag and dropped; `e2e/drag-and-drop.spec.ts`
  drags by mouse on a desktop and by touch input through the DevTools protocol on a phone, as
  `e2e/track-groups.spec.ts` does.
- **Open question for the user.** Whether board cards (and calendar entries) should move onto the
  same pointer follower, so a finger drags them on a phone as it now drags backlog tickets and
  widgets; their menus and keys already work there. A backlog row, like a board card, no longer
  selects its summary as text, since a mouse drags the row from it.

## Options considered

| Option | For | Against |
|---|---|---|
| Glass layer on the ADR-036 tokens (chosen) | One token system; both skins; opaque fallback for free; small CSS diff per page | `backdrop-filter` costs GPU on very large boards (kept off the 5,000-card cells: cards use the strong, near-opaque glass) |
| A new design system and component library | Uniform from scratch | Rewrites 57 pages at once; risks the M1 release; drops ADR-036's measured contrast |
| Keep the opaque soft look, only fix navigation and help | Least work | The user asked for translucent depth explicitly |

## Consequences

- Every page moves to `PageHeader`, so every page states its purpose. A page without one shows
  in review.
- Glass makes contrast depend on what sits behind a surface. The composited contrast test and
  the opaque fallbacks hold the line, and axe still runs on every story.
- Settings, Administration and Tracks change structure. Links to `#/settings` and `#/tracks` keep
  working, and admin routes keep their paths.
- Revisit if blur proves slow on low-end hardware (then lower `--glass-blur` or go opaque per
  surface), or if the user prefers a denser default.
