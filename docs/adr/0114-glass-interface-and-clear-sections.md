# ADR-114: The glass interface and clear sections

- Status: Accepted (the user, 2026-11-03: the direction yes, closer to Liquid Glass; "Manage" kept;
  the Tracks directory and the Settings hub yes; the layout editor and board columns in scope)
- Date: 2026-11-02 (accepted 2026-11-03)
- Tasks: `docs/plan/ui-overhaul-tasks.md` (UI-T01 to UI-T09); the tutorial is ADR-115

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
| Plan and track | Tracks | Every track you can see: open one for its summary, list, board, calendar, timeline and releases. |
| | Boards | A board shows tickets as cards in columns, one column per step of the work. |
| | Search | Find tickets with filters or the query language, and save the searches you reuse. |
| | Dashboards | Charts and lists that sum up the work at a glance, for you or a team. |
| Manage | Settings | Your account and tutorials for everyone; administration for site administrators. |

- **Tracks** becomes a real page: a directory of tracks (key, name, type, owner) with a search
  box. Inside a track, a tab bar holds Summary, List, Board, Backlog, Calendar, Timeline and
  Releases, so a track's pages read as one place.
- **Settings** becomes a hub of grouped cards, each with one line on what it holds:
  - Personal: Account, Appearance, Tutorials.
  - People and access: People, Groups, Teams, Access policies, Security, Identity providers,
    Directories.
  - Work configuration: Tracks, Workflows, Workflow maps, Fields, Configuration sets.
  - Data: Imports, Trash, Guardrails.
  - Integrations: API tokens, Service accounts, MCP, Frontends, Network access, AI.
  - Monitoring: System status, Audit log, API usage, AI usage.

  Each admin page gets a breadcrumb back to its group.
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
  - No real refraction filter: SVG displacement in `backdrop-filter` works in one engine only.
  - An empty state shows one generated illustration of stacked cards (the user's choice,
    2026-11-02) in place of its small icon.
- **Geometry:** radii 10, 16, 24 and 32 px and pills, as ADR-036.
- **Motion:**
  - A settling curve (`--ease-settle`) at 120, 180 or 280 ms: cards lift 1 to 2 px on hover,
    popovers fade and rise 4 px, a dragged card's column tints and a line marks the drop place.
  - Under `prefers-reduced-motion` nothing moves; state changes still show by colour and
    outline.
- **Own assets only.** Icons are original line drawings on a 24 px grid (`shell/icons.tsx`).
  Nothing is taken from Apple's or Atlassian's assets, screenshots, colours or layouts. The
  translucent depth is the idea we borrow, not any asset.

### 4. Light and dark

- Both skins of ADR-036 stay, and each gains the glass tokens.
- The new top-bar button switches between light and dark in one press.
- Account, Appearance keeps the full choice (System, Light, Dark), saved with the account.
- Every story keeps running its axe checks in both skins.
- The page carries `<meta name="darkreader-lock">`: it has its own skins, and an extension that
  repaints pages (found in the user's Chrome on 2026-11-02) replaces every colour, removes the
  canvas and so hides the glass. A person who wants another look uses the skins.

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
| Backlog ranking and sprint planning | kept, restyled | kept (move menus, Alt+arrows) |
| Dashboard widgets | new | Move up, down, left and right buttons (kept) |
| Files on a ticket | kept, the whole ticket accepts a drop | Attach files button (kept) |

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
- Settings and Tracks change structure. Links to `#/settings` and `#/tracks` keep working, and
  admin routes keep their paths.
- Revisit if blur proves slow on low-end hardware (then lower `--glass-blur` or go opaque per
  surface), or if the user prefers a denser default.
