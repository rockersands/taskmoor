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
  - Refraction goes where something passes under the glass: the top bar, and (until D3, below made
    them opaque) menus, dialogs and help popovers that do not sit inside another glass surface. Chromium paints the filter solid
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

- **The shared pieces, as built (T-143, T-144, 2026-11-04).** One look, in one place:
  - `styles/shared.css`, loaded by the app, the stories and the Builder, before any page's styles:
    `.page` (the width of about 76 rem and the rhythm; `.page-full` for what needs it all),
    `.button-secondary` and `.button-quiet` (one quiet glass pill under two names, which also says
    `aria-pressed` by a heavier word and an edge), `.button-danger`, `.data-table` (hairlines of
    `--glass-edge` between rows, a quiet head) and `.badge` with its variants.
  - `styles/forms.css`: every field's shape with no specificity, `.form-label`, one look for
    `.form-error`, `.board-problem` and a `.page-note` that is an alert, and `.form fieldset`: a
    slab on the canvas, a well with no blur of its own inside other glass.
  - `styles/surfaces.css`: `.glass-scroller` beside `.glass-card` for a card that scrolls, its rim
    inside it. Dialogs (`.create-dialog`, `.ticket-dialog`) were floating glass, with the strong fill,
    the rim and the lens where it works; they are opaque since D3 (below).
  - `EmptyState` always draws the one picture; `compact` is the words alone, for a short list inside
    a card. `PageHeader` can take focus through `titleRef`.
  - Tokens: `--radius-mark` (4 px) for marks too small for the radii of this section (a key cap, a
    swatch, a bar, a code span; the 2 to 6 px these used before now read one value), `--space-half`
    (2 px) and one scale of font weights (400, 550, 600, 700; what was 500 is 550 and what was 650
    is 600). The gloss and the lens's shadow are tokens too.
  - `--glass-surface-strong` in the light skin went from 66 % to 68 %: `contrast.test.ts` now holds a
    dialog over the page's dim layer, and accent text fell just short at 66 %.
  - The Builder (ADR-088) and the stand-alone pages open with `PageHeader` and sit on the same
    cards. The Builder's single file now carries `surfaces.css` as well; its picture and the canvas
    are inline in that file, so they reach it offline.
  - `.account-section` and `.facts` beside `.glass-card` are the cards of the administration pages
    and of Account: they place what is inside, the glass comes from `.glass-card`. A row inside one
    is a well on `--glass-surface-sunken`. `.token-badge` and `.session-badge` share `.badge`.
  - `styles/design.test.ts` is the guard, and `styles/design-offenders.ts` lists what is still to
    fix; when OFFENDERS is empty the sweep is done. The guard says at its head what it cannot check.
    OFFENDERS is empty. The guard also holds: links in the accent, the token ADR-036 gave them, from
    one `a` rule in `shell.css`; every `--hit-target` beside a `--hit-target-touch` under a coarse
    pointer; a page header inside `.page`, or a stand-alone page's own root; a header on a route
    page's failures; "none yet" sentences under any class. Stories measure the row links on touch
    (`test/touch.ts`), and every story fails if glass that blurs sits inside a `.glass-card`.
  - A card inside a card is a well: Account's sections stand on the canvas, the workflow import
    report is a well in the list's card, and the first-run offer's tutorial cards are wells
    (`nested`), and so are the track cards in an open group's bubble. A dashboard widget's summary
    sections were wells already.
  - `EmptyState compact` draws no picture, so a short "none yet" inside a panel uses it too. What
    stays a sentence is in `ALLOWED.bareEmpties`: a hint, a fact, a menu line or a drop zone, none of
    them an empty list.
  - A timeline's head has rows that never cross: months, ticks, then a row for sprints and a row for
    releases where there are any.
- **Menus, pop-overs, the command palette and dialogs are opaque** (the user, 2026-11-13, D3 of the
  page review, T-220; this replaces the floating glass above for them). Menu text was hard to read
  over the page beneath. They are drawn on one opaque `--overlay-fill` (the skin's raised surface)
  with no blur, and keep the rim, the highlight and shadow-3; one rule at the end of the glass
  details in `surfaces.css` holds `.shell-drawer`, `.help-tip-body`, `.user-menu-popup`,
  `.icon-select-list`, `.rt-mentions`, `.popover`, `.palette`, `.create-dialog` and
  `.ticket-dialog`, and `design.test.ts` fails when one of them ends on anything else in the order
  the app loads its stylesheets, or a variant gives one glass back. The lens is left on the top bar.
  - Why not a blur behind an opaque fill: an element with a `backdrop-filter` is the containing block
    of every fixed element inside it. The palette and its veil sat inside the top bar, so the veil
    covered only the bar (a story measured 1174 × 46 px of a 1200 × 900 window) and the palette blurred
    nothing; a dialog opened from a glass card was held to the card. With no blur on overlays, a
    dialog opened inside one (over the ticket pop-up) is placed by the window.
  - `ModalDialog`, the palette and the keyboard shortcuts dialog render at the end of the page's body
    through `shell/OverlayLayer.tsx` (a React portal), so nothing they are opened from holds them.
    Other dialogs on `.ticket-dialog-backdrop` should move onto it as their pages are next touched.
  - `DialogHead` gives a `ModalDialog` the create dialog's title row with **Close**.
- **Destructive actions** (D13): `button-danger-quiet` is the first step of Deactivate, Erase,
  Delete and Revoke tokens, the quiet pill's shape in the danger colours; `shell/DangerAction.tsx`
  opens a question in its place that says what will happen, with the action by name as
  `.button-danger` beside Cancel, focus on Cancel.
- **Check boxes and radios** are one control, drawn by `forms.css` with no specificity: a clear well
  with the 3:1 field edge when off, the accent with a tick or a dot when on, 20 px; the system's own
  under forced colours. The browser's box was flat grey in the dark skin.

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
| Board cards (between columns and within one) | kept, restyled; by finger too (section 12, T-162b) | Alt+arrows and the card's Move menu, on its grip (kept) |
| Board columns (order) | new, on the board and in settings | Move left and Move right in the column's menu |
| Backlog ranking and sprint planning | kept, restyled; by finger too (section 12) | each ticket's grip menu, the selection's menus, Alt+arrows |
| Dashboard widgets | new (section 12) | Move up, down, left and right buttons (kept), Alt+arrows on them |
| Files on a ticket | kept, the whole ticket accepts a drop (section 12) | Attach files button and paste (kept) |
| Calendar entries (to another day) | kept; by finger too (section 12, T-162b) | Alt+arrows (kept) and each entry's grip menu (new) |

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

**As built (T-163, UI-T15, 2026-11-03):**

- **Where:** **Administration** > **Tracks and setup** > **Layout sets** (`#/admin/layouts`;
  `?set=<id>` opens a set), beside Configuration sets, under the name section 1 gives it. Settings
  became Administration before this was built, so "under Settings, Configuration sets" means this
  place. Site and configuration administrators use it; the command palette offers it.
- **The server judges.** Saving is the existing `PATCH /api/v1/layout-sets/:id` with every layout
  of the set (one `layout_set.updated` event, audited as before); adding and deleting are the
  existing routes. The page keeps a draft the right shape (each field once, at most 20 tabs and
  20 sections) and nothing more: a tab with no name is said at once, everything else is the
  server's answer.
- **The live preview** is one new route, `POST /api/v1/layout-sets/:id/preview`: a ticket type, an
  operation, a track or none, and the draft layouts (or none, for the saved ones). It checks the
  draft with the same schema and `checkLayouts` a save uses, resolves it with the code the forms use
  (`resolveDefinition`, `layoutFor` in `fields/layouts.ts`), and lists the placed fields the form
  leaves out and why (`hidden`, `not_applicable`, `computed`). It stores nothing, so it emits no
  event (exempt in the contract test as a read), is not audited, and its scope class is `read`
  (`READ_ONLY_ROUTES`). Its OpenAPI entry is internal. No migration and no new requirement ID:
  CORE-008 (forms) and CORE-013 (layouts) cover it. The preview waits 250 ms after a change, keeps
  the last good form while the server refuses a draft, and says why. Anyone who reads the set
  may preview its saved layouts, but a draft comes only from those who may change the set (a
  `403` otherwise), and the ticket type must be one the person sees (`unknown_ticket_type`
  otherwise, as for one that does not exist): a draft's verdict tells a hidden local-mode track's
  own field or type from one that does not exist, which only those who could save it learn, as a
  save already told them.
- **Refusals in the person's words.** The server's `detail` is English with the request's paths
  in it, so the page never shows it as it comes: `layouts/refusal.ts` tells the refusals the
  editor can meet (a field placed twice, a field that no longer exists or belongs to another
  track, a tab name, too many tabs or sections, a ticket type gone) by the place and words the
  server's schema and `checkLayouts` use, in the catalogue's words, and anything else in general
  terms. The server's tests pin those places.
- **Drags** use pointer events, so a mouse and a finger work alike (HTML drag and drop has no
  touch): a grip turns a press into a drag after 6 px, shows a glass chip under the pointer, marks
  the drop place with the focus colour and scrolls the window near its top or bottom. A field drops
  into a section, beside a field or back on the list of fields not placed; a section onto a section
  or into a tab; a tab onto a tab.
- **The keyboard path** is the grip itself, a menu button as the person's menu is: Enter, Space or
  Down opens the same moves (Move earlier, Move later, Move to a section or tab, Put in, Take off
  the layout); Alt with an arrow moves one place, a field across sections and tabs at an edge.
  Focus follows what moved, a polite status says where it is now, and a grip with nowhere to go
  says so in a disabled item.
- **Phones and room:** the parts take their shape from the editor's own width (container queries,
  the first in the app): the preview sits beside the layout from 52 rem, else under it; the fields
  not placed are a list beside the tabs from 46 rem of layout, else rows of chips above them.
  Grips are 44 px under a coarse pointer.
- **Unsaved work** is guarded: the router's leave guard asks before a link, a command, Back or
  Forward leaves the page (the full ticket page's rule and dialog, with its own words), the browser
  asks before a reload, and the set list is locked until the draft is saved or discarded. So is
  adding a set, since a new set opens in the draft's place; one added while a draft was begun
  meanwhile is listed and not opened.
- **Was open, now decided (T-163a, below):** a local-mode track's administrators who are neither
  site nor configuration administrators were refused by the page, though the server let them
  change their own sets. The preview offers the tracks that use the set, or none; any other track
  is through the API.

**A track's own administrators (T-163a, the user's decision of 2026-11-04):**

- **Who sees what.** Site and configuration administrators keep every set on **Layout sets** and
  **Configuration sets**, as before. Someone who runs a local-mode track sees that track's own sets
  and nothing else: never a shared set, never another track's. The rule is the web app's
  (`sets/trackScope.tsx`); the server stays the judge of every read and change, and nothing about
  it changed: its tests now pin that such a person changes their own track's layout and field rule
  sets and its type set's types, and is refused (`403`) every change to a shared set, every change
  to the sets of a track they are only a member of, and answered `404` for any set of a track they
  do not see. A shared set they may still read, as everyone signed in may. The same tests pin that
  nothing opens to anyone else: someone who runs a shared-mode track makes no set for it
  (`409 track_not_local`), changes no shared set and puts none on the track (`403`), and an ordinary
  member of a local-mode track changes nothing of it (`403`).
- **Where.** Each local-mode track has its own pages beside its **Manage** page:
  `#/manage/tracks/<id>/layouts` (`?set=<id>` opens a set) and
  `#/manage/tracks/<id>/configuration-sets`. **Manage** on such a track links to both, under **Its
  own configuration**; a shared-mode track's page has no such links, since it owns no sets.
  Administration places these pages under **Tracks you run**, which is the group such a person
  sees. The shared pages, `#/admin/layouts` and `#/admin/configuration-sets`, show someone who runs
  tracks and is no administrator the local-mode tracks they run, each a link to its own page, and
  no set. A track they do not run, one in shared mode and an archived one each get a sentence
  instead of sets; the sentence for an archived track also reaches someone who runs it, since the
  tracks someone runs leave archived ones out. An administrator who opens a track's own page sees
  only its sets too.
- **Layouts on a track's page.** The list holds the track's own sets; a new set belongs to the
  track (`trackId` on create). The fields offered are those that reach the track
  (`GET /api/v1/fields?trackId=`), the ticket types those its type set offers, and the preview uses
  that track's fields and rules alone, saying so, with no choice of track. **Use this set for
  <key>** makes the track use a set it owns (`PATCH /api/v1/tracks/:id` with `layoutSetId`, the
  existing route and its one `track.updated` event); going back to a shared set stays with
  administrators, as the server holds, and the button's hint says so. The set the track uses opens
  first.
- **Configuration sets on a track's page.** The track's own type set, read by its id
  (`GET /api/v1/type-sets/:id`; the list of every type set stays for administrators), with the
  shared ticket types and the track's own to choose from. No type set is added or deleted there:
  the server keeps a track's own type set for as long as the track. The field rule sets it owns,
  added for it, changed, deleted when unused and made the track's with **Use this set for <key>**
  (`fieldRuleSetId`), with the fields that reach it. A save keeps the rules the page has no row
  for, such as one for a shared field that does not reach the track. Each page links to the other's
  track page.
- No new route, migration, event or requirement ID: CORE-003, CORE-005, CORE-008, CORE-013 and
  IAM-030 cover it. Tests: the server's in `routes/layouts.test.ts`; the pages' component tests and
  stories, with the track administrator's session; `e2e/layouts-track-admin.spec.ts` signed in as
  someone who runs one track, on a desktop and a phone.

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
Board cards (AGL-002, AGL-009) and calendar entries (AGL-017) followed in T-162b.

- **Pointer events, not the browser's drag and drop, for things the page moves.** A finger never
  starts a native drag on most phones, so the backlog leaves it and the widgets never take it up.
  `shell/pointerDrag.ts` follows one press: it becomes a drag after 6 px (a shorter press is a click
  as usual), Escape cancels it and goes no further (an open dialog stays open), the pointer near the
  top or bottom of the scrolling area scrolls it (a finger's drag cannot scroll the page itself), no
  text is selected on the way, and the click a drag ends with is swallowed. What is under the
  pointer is asked of the page (`elementFromPoint`, with `data-drop-*` attributes on the targets),
  so a mouse, a pen and a finger take one path. Board cards and calendar entries moved onto it
  too (T-162b, below), and with them the follower learned to scroll sideways: the pointer within
  56 px of the left or right edge of the nearest area that scrolls sideways (a board's columns)
  scrolls it, faster the nearer, in physical left and right whatever the writing direction. A page
  never scrolls sideways (ADR-033), so where no such area holds the press nothing does. They also
  made a lost release matter, since a mouse presses them from almost anywhere: the mouse let go in
  another window, or under the browser's own menu, sends the page no `pointerup`. A later move with
  no button held, or a new press from the same pointer, ends the press with nothing moved and is
  never read as a drop. A finger is not asked: the browser always ends or takes back a touch.
- **One grip.** `shell/MoveMenu.tsx` is the grip the Tracks page's groups had (CORE-034), moved to
  the shell and shared: a button a mouse or a finger drags, which pressed opens a menu of the same
  moves, with Alt and the arrow keys stepping it. It is 44 px under a coarse pointer and carries
  `touch-action: none`, so a finger on it drags rather than scrolls; elsewhere a finger scrolls.
  A grip with no moves to offer opens no empty menu: it carries `aria-disabled` and no
  `aria-haspopup`, a press, Enter or an arrow opens nothing, and it still drags, since a drop may
  have somewhere to go that the menu does not list (an outcome or a release on the backlog).
  Calendar entries use it too. A board card's grip is its own Move button with the same dots and
  the same `touch-action: none`, as its menu opens in the card's own flow, which a long column
  keeps drawn and never clips (T-193).
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
- **Nothing moves when a drag starts (T-143's gate).** Picking something up on the calendar or the
  backlog shows no new line above the days or rows: what is in hand is said to a screen reader and
  shown by the label under the finger, as on a board. A line appearing there moved the page, so the
  day under the finger was another one.
- **Board cards (T-162b; the user's decision of 2026-11-04 on T-162a).** Cards leave the browser's
  drag of ADR-049 for the same follower, so a finger drags them on a phone. A mouse drags a card
  from anywhere but its pencil (and never while its title is edited); a finger or a mouse drags it
  by its grip, the Move button, which now shows the six dots and keeps its name ("Move PAY-42"),
  its place at the card's corner (in a row under the card on a touch screen, 44 px) and its menu,
  opened by a press. Elsewhere on a card a finger scrolls the board, so the columns still scroll
  under a finger. Held near the left or right edge of the columns, they scroll along, and
  snapping to a column's start is off while a card is in hand, as it would undo the small steps.
  The cell and the place are outlined as before (`is-drop-target`, `is-drop-before`), the card
  fades where it was, a label with its key and title follows the pointer, and the board's live
  region says what is in hand, then what the server did, or that the card stayed where it was (let
  go where it was, outside any cell, or after Escape). A drop sends the same move as before, so the
  transition, the "which transition" question, the form a workflow rule asks for, the seamless
  moves and refusals of ADR-116 and the rank all come from the move route, unchanged. Cells carry
  `data-drop-column` and `data-drop-lane`. On a large board (T-193) the card in hand stays drawn
  wherever the page scrolls, and a drag draws no other card: the label is moved by hand rather
  than drawn, and only the card in hand and the cells under the pointer change.
- **Calendar entries (T-162b).** An entry is its link and a grip at its end: over the link's end
  under a mouse, as a card's pencil and grip are, so a narrow day keeps its width for the ticket's
  name. On a touch screen it always shows at 44 px: beside the link where the day has room for both,
  and on its own row under the link where it has not, as in the seven columns of a tablet or a
  landscape phone, so the name keeps the day's width there too and an entry grows taller instead.
  A mouse drags the link itself; a finger or a mouse
  drags the grip, and elsewhere a finger scrolls the page. The grip,
  pressed, opens a menu of the moves Alt and the arrows make: one day earlier or later, one week
  earlier or later. That is also the way to reschedule with one finger and no drag at all, which
  the calendar lacked (WCAG 2.5.7). The grip shows while the pointer or the keyboard is on its
  entry, and always on a touch screen, where it is 44 px; its menu opens towards the later days on
  Monday to Wednesday and towards the earlier ones otherwise, so it stays on the page. The day under
  the pointer is outlined, the entry fades, a label follows the pointer, and the status line says
  what is in hand, then the new day or that it stayed. The rescheduling rules are unchanged: a due
  day takes its start along, keeping the length; a start pushes the due day along only when it
  would pass it. A move by the keys or the menu keeps the keyboard on the entry, link or grip, on
  its new day (before, the entry was drawn again on that day and the focus was lost).
- **Nothing new on the server for T-162b either.** The board's move route and the ticket route
  judge every drop as they judge the menus and keys, with their events and audit entries.
- **Tests for T-162b.** `BoardPage.test.tsx`, `BoardCell.test.tsx` and `CalendarPage.test.tsx`
  drive pointer events by mouse and by finger (a finger on a card or an entry moves nothing, on the
  grip it drags), Escape, a drop where it was, and a drag over a 5,000-card board drawing only the
  card in hand; `pointerDrag.test.ts` the sideways scrolling and a lost release; the `CardInHand`,
  `CardDropped`, `EntryInHand`, `EntryDropped`, `EntryGripMenu` and `EntryOnATouchTablet` stories
  run axe in both skins, the last measuring the entry at a day's width with the touch rules on; and
  `e2e/board-drag.spec.ts` and `e2e/list-calendar.spec.ts` drag with a real finger through the
  DevTools protocol on the mobile project (to a column off the screen, the columns scrolling along;
  to the next day), and with a mouse or the grip's menu on the desktop one. `e2e/board-large.spec.ts`
  times a drop from the pointer's release.
- A backlog row, like a board card and a calendar entry, no longer selects its text, since a mouse
  drags it from there.

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
