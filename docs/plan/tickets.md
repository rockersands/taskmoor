# In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). Tickets: everything asked for in the local session

Started 2026-11-03. One ticket per thing the user asked for or decided, so nothing from the
conversation lives only in a chat. Bigger tasks are in `backlog.csv`, and each branch has its own
task file with the details. The coordinator keeps this file current. The same tickets are in the tool
itself, on the demo: the Backend (BE), Front (FE) and Flutter (FL) tracks, each ticket starting with
its T number. On their boards, Done is Closed, On branch is In Review, In progress is Active, and
the rest are New, with the state and section as labels. This file is the record: the demo can be
reset.

States:

- **Done**: on `main`, or nothing left to do.
- **On branch**: built and pushed on its branch, not merged. The full gate has not passed on it.
- **In progress**: someone is working on it now.
- **To do**: agreed, not started.
- **You**: waiting on the user.
- **Later**: agreed for after 1.0.

Work runs in waves, the user's decision on 2026-11-03: a ticket waits here rather than start beside too much else. First the finished branches merge, then the front work, then the rest.

A ticket is only Done on `main` after a green full gate. `main` holds the first waves since 2026-11-03: ticket templates, easier updates, invitations and manager pages, Google sign-in (not yet tried with real Google), and the front work so far. "On branch" means what its sub chat
reported, and the coordinator checked that it was pushed.

## Setup and repository

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-001 | Everything lives on one NVMe drive and runs on native Windows | Done | Decision recorded; this PC has no WSL Ubuntu |
| T-002 | Old copies of the repository cleared from other drives | You | In the Recycle Bin; the user empties it |
| T-003 | Repository renamed to `Rockersands/taskmoor` | Done | Remote and docs updated |
| T-004 | The user's Gmail address and local paths removed from tracked files | Done | M1 branch; new commits use the no-reply address |
| T-005 | Rewrite git history to remove the old address and paths, once, with a backup | You | Just before going public; needs `git-filter-repo` and one force-push, each confirmed; also drop the `Claude-Session:` links from commit messages (T-032a) |
| T-006 | Tests run on native Windows | Done | M1-144, on `main` |
| T-007 | Job queue uses the database's clock | Done | On `main` |
| T-009 | A leftover test process (vitest, PIDs 40468 and 30628) that a sub chat could not stop | Done | Closed with the user's permission |
| T-008 | Keep every request as a ticket, here and in the tool itself | In progress | This file, and tracks BE, FE and FL on the demo |

## Getting to 1.0

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-010 | Full gate, then fast-forward `main` | Done | `main` at `3ad14a3`; repeats for each merge |
| T-011 | Fix the flaky keyboard e2e test | Done | Passed 20 of 20 |
| T-012 | Fix the flaky MCP consent e2e test | Done | Passed 10 of 10 |
| T-013 | Look into the AI settings Strict mode test that needed its retry | Done | Late answers overwrote unsaved settings; fixed |
| T-013a | Look into the boards and sprints e2e tests that need their retry in full gates | Done | On `main` (2026-11-08): the boards and sprints retries were the board's first-read race, fixed on 2026-11-03 (7e215734); they passed 282 runs since with no retry. Also fixed: the board-drag finger test (waits for the swipe's scroll to settle) and the tutorial's Dashboards test (waits for the last save). The proxy idea is Windows-only and unchecked: keep the trace if a board or sprint test retries there |
| T-013b | Rerun the 1M import after the two fixes | To do | Optional; those fixes have only quick tests so far |
| T-014 | 500k-issue import | Done | 100% of sampled entities in 1 h 58 min; ADR-092 |
| T-015 | Find out why records failed in the large imports | Done | Reserved words as generated keys, and sprints too large for one statement; both fixed; the seven at 500k fit the first cause, as the key BY appears by then, though that run did not capture reasons |
| T-016 | Try the 1M-issue import on this PC | Done | 3 h 58 min, 100% of sampled entities; ADR-092 |
| T-017 | Close M1-091 with the results | Done | In progress.csv |
| T-018 | Merge the finished branches, each with a full gate | Done | Templates, updates, invitations, Google, ticket tools and UI are on `main` |
| T-019 | Fuzz stages (1, 2, 4, 8 hours) | To do | The user's decision: after all merges, about 15 hours |
| T-020 | Release 1.0 (M1-120) | To do | LTS, changelog, signed release files |
| T-021 | Sign the air-gap bundle and release files with the key from Drive | To do | The user allows it; never committed; local copy removed afterwards |
| T-022 | Run the checks only a real release can do | To do | `docs/plan/easy-updates-tasks.md`: Docker, GitHub, Linux, a real signature |
| T-023 | Run the bash image and kit scripts somewhere that can | Done | On `main` (2026-11-06; `docs/ops/image-and-kits-mac.md`): every image and kit script passes on the Mac with Colima: the image smoke on both architectures, both Compose kits, the backend kit, the offline bundle for either architecture with its SBOM from the saved archive, and the fresh machine to first sign-in in 23 s. Signing with the release key and ghcr.io stay with you (T-036) |
| T-024 | The user's acceptance of 1.0 | You | The last step |

## Open source and going public

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-030 | Stay fully open source under AGPL-3.0-only | Done | Decision recorded |
| T-031 | Make the repository public for 1.0 | You | The user confirms the switch itself |
| T-032 | Scan the whole git history for secrets first | Done | On `main` (2026-11-05): no real secret in 816 commits, pull request refs included; `pnpm secrets` (gitleaks, `.gitleaks.toml`) stays clean and fails on anything new; `docs/security/secret-scan.md` |
| T-032a | 221 commit messages carry a `Claude-Session:` link, public with the history: keep them, or drop them in the T-005 rewrite? | Done | The user decided on 2026-11-13: drop the session links in the T-005 rewrite (confirmed with the user before it runs and before the force-push) |
| T-033 | Trademark search for the name | You | No domain needed, but a clash could force a rename |
| T-034 | Counsel review deferred to the first public release | You | Includes the clean room and AGPL questions |
| T-035 | Turn on and test private vulnerability reporting | To do | `SECURITY.md` already points to it; no email needed |
| T-036 | Publish images on ghcr.io | You | The user runs the two `gh` and `docker login` commands; no stored token |

## The Builder and updates

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-040 | People download the Builder from the releases page | To do | Part of the release |
| T-041 | The Builder is the one-file HTML page for 1.0 | Done | Decision recorded; no `.exe` or `.dmg` for now |
| T-042 | Anyone can host their own copy with complete admin control | Done | Decision recorded; nothing may depend on a central service |
| T-043 | One update command, signed releases only | Done | `claude/easy-updates` |
| T-044 | New-version notice for site administrators, with an off switch | Done | `claude/easy-updates`; off in the air-gap bundle |
| T-045 | Refuse a release with only a checksum | Done | Decided by the user |
| T-046 | All-in-one image named `ghcr.io/rockersands/taskmoor-allinone` | Done | Decided by the user |
| T-047 | A desktop wrapper for the Builder | Later | Only if people ask |

## People, access and sign-in

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-050 | Sign in with any email, personal or company | Done | `claude/track-invites`; no open sign-up |
| T-051 | Invite by email with a set role | Done | `claude/track-invites`; real email not yet tested |
| T-052 | A link to copy when a site has no mail server | Done | `claude/track-invites` |
| T-053 | Should managers copy links where email works? | Done | On `main` (`d9061d06`, wave 13, 2026-11-14), as the user decided: where email works only site administrators copy invitation links |
| T-054 | A manager can tell an account exists when inviting it | Done | Accepted by the user |
| T-055 | Site administrators give track administrators permission to invite | Done | Off by default |
| T-056 | Managers appoint managers by default, through a removable permission | Done | Decided by the user |
| T-057 | Track managers' web pages | Done | Settings > Tracks you run; moves into the panel on merge |
| T-058 | Google sign-in option, invited people only | Done | `claude/google-signin`; tested against a fake provider |
| T-059 | Real Google test | You | Create the client and enter the secret on a demo; the user said later |
| T-060 | A provider sign-in does not need Taskmoor's second factor | Done | Decided by the user; the guide says so plainly |
| T-061 | Google's logo on the button? | Done | On `main` (`d9061d06`, wave 13, 2026-11-14), as the user decided: the Google button shows Google's G mark (drawn inline; compare with Google's official asset before 1.0, T-262) |
| T-062 | Treat Gmail spellings as the same address? | Done | The user decided on 2026-11-13: no; dots and +tags are not the same address (as built) |
| T-063 | Allow `@googlemail.com`? | Done | The user decided on 2026-11-13: no, not for now (as built) |

## Navigation and tracks

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-070 | "Tableros" leaves the sidebar; each track is one place with sections | Done | `claude/ui-overhaul`; the name stays Track |
| T-071 | Tracks in the sidebar is one link, with no list under it | Done | replaces the expanding list, as there could be many tracks |
| T-072 | Exactly one board per track, enforced on the server | Done | ADR-116 |
| T-073 | No board outside a track | Done | ADR-116 |
| T-074 | Decide about the leftover demo board `rrg` | Done | Gone with the new demo |
| T-075 | Summary is a dashboard the track owner can customize | Done | On `main` (ADR-116): the owner customizes it with every widget kind, members read it |
| T-075a | Should members also filter a track's Summary (RPT-006 says "view and filter")? | Done | On `main` (`d9061d06`, wave 13, 2026-11-14), as the user decided: members filter the Summary for themselves (the filter lives in the page's address) |
| T-076 | Statistics holds every report for the track | Done | On `main` (ADR-116, RPT-001, RPT-002): time since, grouped tickets, time tracking, workload by person, by release and as a pie, and the outcome report; each number equals its search |
| T-077 | Files and links section | Done | `claude/ui-overhaul` |
| T-078 | Keep the Lista and Versiones tabs | Done | Decided by the user |
| T-079 | An Objetivos tab listing outcomes with progress | Done | On `main` (AGL-024, ADR-116): the Outcomes section, with one definition of done shared by subtickets and the backlog's outcome panel |
| T-080 | A New track button on the Tracks page | Done | `claude/ui-overhaul` |
| T-081 | Hide Backlog entirely on Kanban tracks, and other Scrum-only items | Done | `claude/ui-overhaul` |
| T-082 | A way to manage outcomes on Kanban tracks | Done | On `main` (`d9061d06`, wave 13, 2026-11-14), as the user decided: every track type manages outcomes from the Outcomes tab |
| T-083 | A cross-track timeline | Done | On `main` with T-088: the plan Timeline spans tracks |
| T-084 | Personal track groups: drag tracks together, name the group | Done | On `main` (ADR-121, CORE-034, migration 0100): by mouse, touch and keyboard; private to their owner |
| T-085 | Open group is a glass bubble; a minimized one is the size of one track card, with a count and small glass squares | Done | On `main` |
| T-086 | Share a whole group, or set it on another person | Done | On `main` (IAM-034) |
| T-086a | "Set it on another person": is it right that they get their own copy of the group? | Done | The user decided on 2026-11-13: keep as built (their own copy, with the role outright) |
| T-087 | Sharing a group gives access to its tracks | Done | On `main`: the sharer picks a role and gives it only where they could give it track by track; taking back removes only what the share gave |
| T-087a | Creating tracks: off for everyone by default; a ticked box when giving someone the manager role, which can be unticked | Done | On `main` (migration 0097, IAM-033, ADR-118): new sites let only site administrators create tracks until granted; only site administrators and holders may tick the box |
| T-087b | When someone loses the manager role, should their permission to create tracks go too? | Done | On `main` (`d9061d06`, wave 13, 2026-11-14), as the user decided: losing the manager role takes away the create-tracks grant that came with it (T-259 asks two details) |
| T-087d | One customizable Summary per track, with Paneles for more | Done | Decided by the user; the spec is being changed on `claude/ui-overhaul` |
| T-087c | Keep Paneles in the sidebar | Done | Decided by the user; dashboards that can span tracks |
| T-088 | Multi-track first version: a plan over several tracks and saved searches, with Summary, Timeline, List and Calendar | Done | On `main` (ADR-122, PLN-001, PLN-012, migration 0101): sources each viewer may see, filters and grouping in the address, rescheduling, the first 10,000 per view; `docs/plan/multi-track-tasks.md` holds the next stages |
| T-088a | One plan is called a "plan" in the interface; the terminology file had "roadmap". Keep "plan"? | Done | On `main` (`d9061d06`, wave 13, 2026-11-14), as the user decided: "plan" everywhere, terminology file updated |
| T-089 | Multi-track: dependencies view | Done | On `main` (ADR-122, PLN-006): blocking links drawn as lines and badges on the plan Timeline, late ones in red with a label, a list for keyboards and screen readers; blockers outside the plan or hidden from the viewer are only counted |
| T-089i | Dependencies: build PLN-013 (other link types, flags within one sprint) in 1.0, and keep outside blockers a count only? | Done | The user decided on 2026-11-13: PLN-013 (link types beyond blocks, flags within one sprint) is built in 1.0 with the program board, T-089d; outside blockers stay a count |
| T-089b | Multi-track: teams and capacity | Done | On `main` (ADR-122 stage 3, PLN-005, PLN-009, migration 0102): capacity per team and person by period in points or hours, over-capacity flagged with a label; hidden work only counted, never named |
| T-089j | Multi-track capacity: the parts of PLN-005 and PLN-009 not built (velocity from history, days and percentages, allocations to outcomes, bulk fill and CSV import), and two questions in ADR-122 (hidden work counted in "elsewhere"; notes kept in the event payload after erasure) | Done | The user decided on 2026-11-13: the unbuilt capacity parts go to 2.0; an erased person's capacity notes are removed from the event history too, on `main` in wave 13 |
| T-089c | Multi-track: releases across tracks | Done | On `main` (ADR-122 stage 4, PLN-007, migration 0106): lines up tracks' own releases on one end, its own pages, a plan's Releases tab, markers, the `crossTrackRelease` query field, a move after a confirmed list. Independent review repaired on 2026-11-05; waits for the coordinator's gate; ADR-122 lists eight questions for the user, built with the first answer each |
| T-089d | Multi-track: program board with live editing | In progress | On Windows from 2026-11-13 (`COORDINATION.md`, `wave14/t089d-program-board`). In 1.0; with PLN-013 (link types beyond blocks, sprint flags), the user's decision of 2026-11-13 |
| T-300 | Program board: twelve questions (ADR-122 stage 5), built on the first answer each | You | (1) columns: the plan's periods for every team, or each team's own sprints; (2) a card's period: its due day, or its sprint's days when it has none; (3) a move shifts the days by the periods' distance, or sets the due day to the period's last day; (4) rows: the plan's teams plus "Other or no team", or only the teams; (5) live edits: re-read with no presence, or also show who is looking and which card someone holds; (6) two people moving one card: the second is refused and shown where it is now, or the last move wins; (7) dependencies on the board: badges and a list, or also lines; (8) hidden work in a cell: not counted, or one number per board; (9) a chosen link type's direction: the source finishes first, or chosen per type; (10) same sprint: only open sprints, or completed ones too; (11) boards per plan: no limit, or a limit; (12) a plan copy: leaves its boards out, or copies them |
| T-089e | Multi-track: draft changes and scenarios | To do | In 1.0 |
| T-089f | Multi-track: auto-scheduler | To do | In 1.0 |
| T-089g | Multi-track: duplicate a plan, link to a view, CSV and image export | Done | On `main` (ADR-122 stage 8, PLN-014, no migration): a private copy of what the maker sees, a link holding the view's filters and position, each view's CSV, a Timeline PNG of up to 400 rows; hidden work only counted, formula-safe cells. Independent review repaired on 2026-11-05; waits for the coordinator's gate; ADR-122 lists seven questions for the user, six built with the first answer each |
| T-089h | A "Your tracks" section at the top of Home | Done | On `main`; shows tracks the person can see, as the track list cannot yet say which they belong to |
| T-089a | Multi-track: hierarchy grid (PLN-010) and baselines (PLN-011) | To do | The user decided on 2026-11-13: the hierarchy grid (PLN-010) and baselines (PLN-011) move into 1.0; stages, requirement wording, milestones and the plan to update |

## Boards and moving tickets

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-090 | Fix drag and drop refusing moves | Done | The missing close reason |
| T-091 | Seamless moves in any direction, with no dialog, by default | Done | Needs the user's check by mouse |
| T-092 | A column is its status | Done | New column makes a status; rename renames it |
| T-093 | Refusals in plain words, no raw codes | Done | `claude/ui-overhaul` |
| T-094 | Why a move happened goes in a comment, with no prompt | Done | Decided by the user |
| T-095 | Closing a ticket by drag sets the reason Completed, and reports count it | Done | A server test covers it |
| T-096 | The rightmost column closes by default, and this can be changed | Done | Per track |
| T-097 | Deleting a column with cards asks where they go | Done | `claude/ui-overhaul` |
| T-098 | Columns no card can reach say so, and offer a fix | Done | Includes the "potato" test |
| T-099 | Decide on the "potato" column | Done | No longer needed: its sample track was removed |
| T-100 | Should demo tracks stop sharing one workflow? | Done | Settled: the three real tracks each have their own |
| T-101 | Track picker in the board form, raw query under advanced | Done | `claude/ui-overhaul` |
| T-102 | Filter a board by person, for ordinary members | Done | `claude/ui-overhaul` |
| T-103 | The people list floats, and does not push the page down | Done | `claude/ui-overhaul` |
| T-104 | Filter buttons and checkboxes get the glass style | Done | `claude/ui-overhaul` |
| T-105 | Check whether "Solo mis tickets" and "Yo" duplicate each other | Done | `claude/ui-overhaul` |
| T-106 | Complete a sprint from the board, for managers and above, with a confirmation pop-up | Done | On `main`: counts done and open, chooses where open ones go; Complete and Cancel (ADR-054) |

## Tickets

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-110 | One status dropdown on the ticket, not a row of buttons | Done | `claude/ui-overhaul` |
| T-111 | A way back from a ticket to its board | Done | `claude/ui-overhaul` |
| T-112 | Fix Escape after Create in the create dialog | Done | `claude/ui-overhaul` |
| T-113 | Ticket templates | Done | `claude/ticket-templates`; form limits accepted by the user |
| T-114 | Links with categories, on every ticket type | Done | On `main` (M1-143) |
| T-115 | Link picker searches by number or name, same track only | Done | On `main` |
| T-116 | Subtickets on the ticket page, with a completion percentage | Done | On `main`; normal ticket statuses; boards up to 50,000 cards show progress |
| T-117 | Checklists with completion, item states open, in progress, done, rejected | Done | On `main`; rejected items are left out of the percentage |
| T-118 | A `/` menu in descriptions and comments | Done | On `main`; our own list, no Atlassian site opened |
| T-119 | Mention someone with `@` to notify them | Done | Already built |
| T-120 | Add any tool the `/` menu is missing | You | Describe it in words, no screenshots |
| T-118a | Followers are not notified of checklist changes | Done | Decided by the user; webhooks still get the event |
| T-118b | A clone restarts every checklist item as open | Done | Decided by the user |
| T-118c | The section on an Outcome reads "Tickets under this" | Done | Decided by the user |
| T-121 | Open a ticket in a pop-up from the board or any section, instead of leaving the page | Done | On `main`; a shared link shows the full page |
| T-122 | Clone a ticket from the pop-up and the ticket page | Done | On `main` |
| T-123 | Copy a link to a ticket | Done | On `main` |
| T-124 | Set a ticket's priority from the pop-up | Done | On `main` |
| T-125 | Board cards show title, priority, assignee and points | Done | points only where set |
| T-126 | Edit a ticket's title from the card, with a pencil button | Done | `claude/ui-overhaul` |
| T-127 | The ticket's type shows as an icon on the card, not a word | Done | our own icons; the name stays for screen readers |
| T-128 | Priority shows as an icon, not a word | Done | shape as well as colour; custom priorities too |
| T-129 | Add a Very low priority and remove the None choice | Done | new tickets take the default priority |
| T-129a | A seeded Points field, so points can show on cards | Done | Migration 0095, on `main`; a backup's field of another type arrives as "Points (imported)" |
| T-129b | Show the ticket key on board cards again | Done | On `main`, on its own line above the title |

## Search and dashboards

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-130 | Basic search: dates on, before, after and between | Done | `claude/ui-overhaul` |
| T-131 | Basic search: type, priority, labels and more | Done | `claude/ui-overhaul` |
| T-132 | A widget that cannot load says what it needs | Done | `claude/ui-overhaul` |
| T-133 | The user's "vxfdv" widget holds an invalid search | Done | Gone with the new demo |
| T-134 | Remove the sample tracks; keep only Flutter, Backend and Front | Done | The user asked; the four sample tracks are in the demo's trash |

## The look

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-140 | Liquid Glass style, in our own design | Done | No Apple or Atlassian assets |
| T-141 | Deep strength, Soft canvas, the generated illustration | Done | Decided by the user, who says Gemini's terms allow it |
| T-142 | Controls need not truly bend their colour for now | Done | Decision recorded |
| T-143 | Glass on every page, starting with the track sections | Done | On `main` (ADR-114): every route; not yet looked at signed in (T-220). The strength of the light skin stays as built (the user, 2026-11-04) |
| T-144 | The design is consistent through the whole app | Done | On `main`: shared styles (`shared.css`), and `styles/design.test.ts` holds the rules. The design questions it raised are T-213 to T-219 |
| T-145 | Dark Reader: detect it, use our dark mode, tell it to back off | Done | The user's own skin choice is kept |
| T-146 | Fix the English filters in the Spanish interface | Done | On `main`: every filter checked in Spanish and the pseudo-locale; the list's group headings for type and priority were the one gap. Status names stay untranslated everywhere (NFR-006 (2), a product decision) |
| T-147 | A watery look for every animation in the app | Done | off with reduced motion |

## Administration

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-150 | Administration as its own section, with an overview | Done | e2e not run yet |
| T-151 | Pages for visibility policies and the permission explainer | Done | `claude/ui-overhaul` |
| T-152 | Page for webhooks | Done | `claude/ui-overhaul` |
| T-153 | Pages for AI limits and prices | Done | `claude/ui-overhaul` |
| T-154 | Choose which sets a track uses | Done | A plain picker for now |
| T-155 | Decide which other API-only controls go in 1.0 | You | UI-T21; the list comes from the front sub chat |

## The rest of the interface work

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-160 | Help menu with tutorials and keyboard shortcuts | Done | `claude/ui-overhaul` |
| T-161 | Tutorial: first-run offer, sections to pick, one of everything | Done | On `main` (ADR-115, AGL-025): an offer on Home at first sign-in, Settings, Tutorials to start, resume and replay, and a coach card through the eight sections, each making one real thing |
| T-162 | Drag and drop with a keyboard path beyond boards | Done | On `main` (ADR-114): the backlog (rank and move between sprints), dashboard widgets and files onto the ticket page, by mouse, touch and keys, with a menu for every move |
| T-162a | Should board cards and calendar entries use the same touch drag as the backlog and widgets? | Done | Decided by the user on 2026-11-04: yes (decisions.csv) |
| T-162b | Board cards and calendar entries on the shared pointer drag | Done | On `main` (ADR-114): a finger drags a card or calendar entry by its grip. Not tried on a real phone yet; real touch went through Chromium only |
| T-163 | Layout editor page | Done | On `main` (ADR-114, UI-T15): fields dragged or moved by keys into tabs and sections, a live preview per ticket type and operation, the server the judge |
| T-163a | Open the layout editor to a local-mode track's own administrators? | Done | Decided by the user on 2026-11-04: yes (decisions.csv) |
| T-163b | The layout editor for a local-mode track's own administrators | Done | On `main` (ADR-114): the server refuses other tracks and shared sets, with tests in `layouts.test.ts` |
| T-164 | Phone and accessibility pass | In progress | UI-T09 |
| T-165 | Update the e2e specs the rework broke | Done | The e2e specs pass: 239 in the gate of 2026-11-04 |

## Waiting on the user, for later

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-170 | AI key for the live tests | Done | The user ran `packages/ai/src/live.test.ts` with their own key on 2026-11-07: 3 of 3 passed (answers with a cache hit, streaming with strict structured output and a strict tool, token counting and the model list). The key never reached a file or this chat's commands |
| T-171 | Spanish review | You | Once every M1 task is finished |

## Known gaps found along the way

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-190 | The full ticket page has no protection for unsaved text | Done | On `main`: links, Back, code-driven navigation in both routing modes and the tab's close or reload ask while a draft exists (NFR-005) |
| T-191 | Controls follow edit permission up front, not only priority | Done | On `main`: the ticket view, edit and transition answers say which fields the person may change; a locked field does not yet say why (WF-007 (2)) |
| T-192 | Turning a track's sprints off while a sprint runs is not guarded | Done | On `main`: refused while a sprint runs, naming it; a sprint cannot start while sprints are off; the box shows only where the board can have sprints |
| T-193 | A 5,000-card column is not smooth | Done | On `main` (ADR-049): columns over 100 cards draw only the cards near the screen, with roving focus and every card reachable by keyboard; measured 50 to 55 fps and a drop settled in about 110 ms on the Mac. Browser find sees only drawn cards |
| T-194 | Home's "Your tracks" should show the tracks a person belongs to | Done | On `main` (ADR-046): a role given directly or through a group, owning the track, or a team on its board or a live area; policy grants and "open to everyone" only let people see. Recently opened tracks come first however many they belong to; "latest opened" stays per browser |
| T-195 | A backup's saved filter naming Points reads the seeded field, not the imported one | Done | On `main` (ADR-095): saved filters and a board's filter, sub-filter and quick filters read the field the backup's own Points became; a name several backup fields share reads the one field they became, or the query is left out, in a dry run too |
| T-196 | Ticket tools' own follow-ups, TT-1 to TT-8 | Done | On `main` (ADR-120) except TT-7, which waits on the user; columns now written as their own form in Markdown and wiki markup |
| T-196a | TT-7: tell followers when a checklist changes? | Done | Decided by the user on 2026-11-04: the recommended notice, per track, off by default (decisions.csv) |
| T-196b | The "Checklist changed" notice | Done | On `main` (NTF-015, ADR-120, migration 0103): a notice track administrators turn on, off by default |
| T-197 | Run the fuzz targets adf, markdown and wiki over the slash menu's new blocks | To do | Part of T-019 |
| T-207 | Free movement is the default everywhere, including a new demo's sample tracks | Done | On `main` (WF-008, ADR-116, migrations 0104 and 0105): new workflows, added statuses, sample data and close reasons all stay free moving |
| T-208 | A fresh checkout's first full gate fails in the browser stories (Vite's dependency cache is cold; "optimized dependencies changed") | Done | On `main` (2026-11-08, ADR-030): the stories list their dependencies up front, kept in step with Vite's scan by a test, and each skin has its own cache. Still to see: the next fresh clone's first gate on Windows, where the 48 failures happened |
| T-209 | Changing a status's stage on a free-moving workflow leaves its transition's close rule as it was | Done | On `main` (ADR-116): a free move into a closed-stage status sets the default close reason and the Closed time; a stage change locks the status list, then workflows, then statuses, the same order as every other path, so a board sync no longer deadlocks with it |
| T-210 | A status added through the API draft has no way in, and old workflows made empty stay with no moves | Done | On `main` (ADR-116): a status added through the draft API on a free-moving workflow gets its free move; an old workflow left with no moves gets them at its next saved draft (T-237) |
| T-211 | `pnpm demo` keeps an older built frontend | Done | On `main`: the demo builds the frontend again when the checkout moved on since the last build |
| T-212 | Sweep for buttons whose spoken name leaves out the words they show (WCAG 2.5.3) | In progress | Found on the inbox; axe only reports it where a test runs it. Part of T-164 |
| T-213 | Sticky cells of the timeline and the capacity table: stay opaque inside glass, or the whole table on an opaque panel? | Done | The user decided on 2026-11-13: opaque sticky cells, as built; the card stays glass. Nothing to change |
| T-214 | A not-found page, and the words "This area is under construction" on signed-out Search and on Home while the session is checked | Done | On `main` (wave 12, 2026-11-13), as the user decided |
| T-215 | The release page and a track's templates sit outside the track's tab bar, and List, Calendar, Timeline and Releases have a "Track summary" link that repeats a tab | Done | On `main` (wave 12, 2026-11-13), as the user decided |
| T-216 | List's Columns and Format rules: stay as folds, or open as the shared pop-over? | Done | On `main` (wave 12, 2026-11-13), as the user decided |
| T-217 | The ticket page's purpose line, and the waves on stand-alone pages over the Soft canvas: keep or drop? | Done | On `main` (`d9061d06`, wave 13, 2026-11-14), as the user decided: the unused purpose.ticket text is gone |
| T-218 | On a phone, a long paragraph about Alt+arrow keys comes before the work on Board, Backlog, Calendar and Timeline | Done | The user decided on 2026-11-13: touch wording on phones (page review answer 6), built in wave 12 (G5) |
| T-219 | Account and the Administration pages lost their narrower widths (48 to 60 rem) and now use the page width (76 rem): keep? | Done | On `main` (wave 12, 2026-11-13), as the user decided |
| T-220 | Look at every route signed in, in Chrome, in both skins and at both widths (UI-T22) | Done | On `main` (`bff9aa24`, 2026-11-13, wave 12): 147 of the 151 page-review faults fixed in six groups after the user's 37 answers, each group reviewed by a skeptic, fixed and re-checked, then gated together (8,299 tests, 250 e2e). One fault waits on T-240; T-250 fixed another; two needed no change. A fresh sweep to look at the visual fixes is T-258 |
| T-221 | Phone looks left by the glass pass: List's Summary breaks mid-word, Backlog's selection boxes are 44 px native squares | In progress | T-143 review (low); part of T-164. The box needs a label wrapper to keep the target |
| T-222 | Small leftovers of the glass pass | In progress | T-143: `.board-choice` is not ModalDialog; `WidgetView` tables have no quiet head; `plans/*` and dashboards use `.report-empty` for loading; the workflow editor's way back is a text link where others use a pill; "Yours" and "Shared with you" look larger than card titles; `McpPage` has no forbidden state; `noX` sentences the guard does not match (`layouts.noTabs`, `tickets.create.noTracks`, `admin.network.noGroups`) |
| T-223 | Rule set panel: rules with no row are compared against fields that refresh while the panel is open | In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). Wave 6 review (low): `ConfigurationSetsPage.tsx:644` |
| T-224 | Someone whose only track to run is archived is told they have no access, not that the track is archived | In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). Wave 6 review (low): `trackScope.tsx`; session `managesTracks` is false |
| T-225 | Keyboard focus falls to the page after "Use this set for KEY" | In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). Wave 6 review (low): the button that had focus goes away |
| T-226 | "Back to managing KEY" and the field rule links are under 44 px on a phone | In progress | Wave 6 review (low): inline links in `.page-note`; part of T-164 |
| T-227 | A person who runs tracks and is no administrator sees a breadcrumb to a Setup page that refuses them | In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). Wave 6 review (low): `adminPlace`, `AdminBreadcrumb` |
| T-228 | Calendar grip: the menu stays open during a drag, Alt+Arrow in the menu moves the ticket, a flick starting on a grip does not scroll | In progress | Wave 6 review (low): the flick lands as a move, so check on a real phone first; part of T-164 |
| T-229 | Calendar: the keyboard does not always stay with the entry on its new day, as the manual says it does | In progress | Wave 6 review (low): the target day can be hidden on a phone |
| T-230 | Board: another person's change that arrives while a card is held stays unseen when the drag is cancelled | In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). Wave 6 review (low): `BoardPage.tsx:361`; no reload after a cancel or a drop on its own place |
| T-231 | No automated check of the 44 px grips on touch | In progress | Wave 6 review (low): the rule was once hidden behind a width query with every test green. `test/touch.ts` from T-143 can hold it |
| T-232 | Checklist notices: the batch can wait on an older notification of the ticket, and a refusal shows above where the person is looking | Done | On `main` (NTF-015): a checklist run begun in an email's window goes whole in that email, and older changes go on time; each answer on the track people page shows at the foot of its card, announced. Two choices for you in T-248 |
| T-233 | Tests that prove less than they say | Done | On `main`: the weak tests now fail when what they name breaks (phone checks in a real browser, both closing conditions, the sample workflow's fit, the null-completed free move) |
| T-234 | Free-moving edge cases after a close reason's deletion or an old draft | Done | On `main` (ADR-116): free moves use the new Completed reason after Completed was replaced; the editor offers "Let this draft move freely" on a default workflow's draft still holding the strict seed steps |
| T-235 | The Windows Compose install (`install.ps1`) still prints a setup link on port 8080 | In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). Found by T-023 on the Mac (2026-11-06): `install.sh` now names the host port; the PowerShell script needs the same change and a run on Windows |
| T-236 | The image build has no retry for corepack's pnpm download | Done | On `main` (2026-11-08): the image fetches pnpm with a time limit and up to four attempts; the dependency install itself can still stall (T-247) |
| T-237 | An old workflow left with no moves gets its free moves only at its next saved draft | Done | On `main` (ADR-116): a draft save and a stage change take one lock order; `cli.mjs workflow-moves [--repair]` gives old empty workflows their free moves (T-246 asks whether that becomes a migration) |
| T-238 | A board's workflow takeover checks the workflow before locking it | Done | On `main` (ADR-116): a board's takeover reads the workflow's guards and published steps under its lock, and a version holds all its statuses in id order |
| T-239 | Load `tickets.md` into a demo with one command | To do | Done by hand twice (T-198 on Windows, again on the Mac on 2026-11-06 with a local script): Backend, Front and Flutter tracks, states as statuses, sample tracks to the trash |
| T-240 | A release page's own dates still read `2026-12-01`, next to a locale date for its release across tracks | To do | Multi-track review |
| T-241 | Multi-track: the questions of ADR-122 stage 4 (8) and stage 8 (7, one is a byte-order mark on CSV files for Excel), plus two behaviours to confirm: a bare number in a saved query means the id, and a same-day move brings back releases out of step | Done | All 17 answered by the user on 2026-11-13 (decisions.csv): everything kept as built except the byte-order mark, now on every CSV export (T-252) |
| T-242 | Speed limits this Windows machine missed in the gate of 2026-11-07: plan duplicate with 500 sources and 50 teams (1,386 of 1,000 ms, new with T-089g), permission check p95 (10.5 of 10 ms), ticket edit with 1,500 fields p95 (274 of 50 ms, seen before) | Later | The user said on 2026-11-14: no benchmarking tickets for now, only bugs and new features. Not enforced by `pnpm verify`; check with `pnpm bench:check` before 1.0 |
| T-243 | Two lists can show an older answer when two reads cross: the board's sprints and the backlog | In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). Found reading the code for T-013a, never seen failing: `BoardPage` `loadSprints` and `BacklogPage` `load()` have no ordering check (the board's own read has one); a completed sprint's Complete button could come back |
| T-244 | Some e2e specs make track keys from the time alone and collide when repeated | In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). T-013a: checklist-notices, releases, list-calendar and others fail with `key_taken` under `--repeat-each`; board-drag is fixed |
| T-245 | Tutorial progress is lost when someone presses Finish and leaves at once | In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). T-013a: the save is sent without waiting; `keepalive: true` on it would keep the Done state |
| T-246 | Old workflows' free moves: a one-time repair command, or a migration before 1.0? | Done | On `main` (`d9061d06`, wave 13, 2026-11-14), as the user decided: migration 0107 gives old workflows their free moves; publishing or importing a workflow with no moves gives it the defaults |
| T-247 | The image's dependency install can stall for a long time on a slow link | To do | T-236 follow-up: 51 minutes in one run, with 16-18 minute quiet stretches; pnpm's fetch timeout and retries for that step, or a limit on the step |
| T-248 | Checklist notices and the track people page: two choices | Done | On `main` (`d9061d06`, wave 13, 2026-11-14), as the user decided: one email for an older change during a checklist run; results beside the row pressed |
| T-249 | Small follow-ups from wave 10 | In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). Two syncs on different boards taking each other's statuses by name could still deadlock (lock every candidate status in one id-ordered pass); the column-path route picks its workflow before its transaction; two jsdom phone tests in `TrackPeople.test.tsx` read a scrollWidth that is always 0; `freeMoveEffects(true, null)` still allowed by its types |
| T-250 | Opening a ticket may change it | Done | On `main` (ADR-014): the collaborative editor added an empty line after a description ending in a code block as soon as it loaded, and saved it as an edit; now only the person's own edit adds it. "Also editing" no longer counts the person's own other pages |
| T-251 | Five statistics pages fail to read the track's fields | Done | On `main`: the five reports called a per-type route without a type; they now read the track's fields by its id and offer the custom fields they can group by |
| T-252 | Every CSV export starts with a UTF-8 byte-order mark | Done | On `main` (`d9061d06`, wave 13, 2026-11-14), as the user decided: every CSV export starts with a UTF-8 byte-order mark |
| T-253 | The create form cannot set assignee, release, area, parent or custom person fields | Done | On `main` (`488632e0`, 2026-11-14): the create form sets assignee, release, area, parent and custom person fields; the Track picker is the icon select. Requester and custom team, group, release and area fields still say they cannot be set here (T-265) |
| T-254 | One confirmation for every destructive action | Done | On `main` (`488632e0`): every destructive action outside Plans uses DangerAction with a question that names what happens; service-account Deactivate and a person's own token Revoke now ask. Plans' own prompts are Windows' (T-266) |
| T-255 | Small leftovers of wave 12 | Done | On `main` (`488632e0`): check boxes 28 px on touch, the Spanish admin heading on one line, no overlapping 'from any status' tabs, Guardrails reads the permission key as its own field (internal route). The checklist rows on a phone wait on T-268 |
| T-256 | The renames: 'site' and 'Plans' (G7) | Done | On `main` (`d9061d06`, wave 13, 2026-11-14), as the user decided: the interface and operator text say "site", and the section is "Plans" |
| T-257 | Merge or retire the sweep tool | Done | On `main` (`488632e0`): `pnpm sweep` merged with tests; phone routes are captured by the window with touch kept, so pictures show what a phone shows |
| T-258 | A fresh sweep to look at wave 12's visual fixes | Done | Swept on 2026-11-14 (`488632e0`): of the 151 faults, 119 are fixed and 27 remain or changed; 69 new faults confirmed by a second reader (15 medium, none high), in `docs/plan/page-review-second-sweep.md`. Fixes are T-271 and T-272 |
| T-259 | Losing the manager role: two details | You | Built as: the create-tracks grant goes when the person runs no track at all any more (someone still running another track keeps it); deactivation removes it for good and reactivation does not bring it back. Should it instead go when they lose the role on the track it came with? Should reactivation restore it? Also: an erased person's capacity notes are emptied in the event history, but stored audit records keep the text until audit retention drops them (shown empty wherever read or exported): enough? |
| T-260 | Workflows with no moves: three edge cases | You | (1) Should a Data Center import of a workflow with no transitions also get free moves? (2) Should restoring an empty earlier version add free moves at once, not only at publish? (3) A definition whose only statuses are closed-stage ones, on a site with no close reason, still publishes with no moves (free moves never close without a reason): refuse such a publish instead? |
| T-261 | Checklist emails at the one-window limit | You | Built: an older change held for a checklist run goes, at most one window late, with the run as it stands; the run's later changes then come in a second email. The alternative sends the older change alone at the limit (two emails again). Keep as built? |
| T-262 | The Google button's details | You | Compare the G mark (drawn inline, not downloaded) with Google's official asset before 1.0; bundle Roboto (Apache-2.0) as Google's guidelines ask, or keep the skin's font; the button is 44 px on touch (Google says 40): acceptable? |
| T-263 | CSV for Spanish Excel | You | Excel with Spanish settings may expect semicolons; you kept the comma, so those users open the file through Excel's import from text. Acceptable, or offer a semicolon option? Also: the importer reads every file as UTF-8, so a file Excel saves as plain CSV (the Windows code page, no mark) would garble accents: support other encodings? |
| T-264 | The Summary filter in the address | You | Built: a member's Summary filter lives in the page's address, so a shared link shows the same filter to whoever opens it. Keep it there, or save it per person instead? |
| T-265 | The create form: the fields it still cannot set, and narrower pickers | To do | Requester (needs Modify requester) and custom team, group, release and area fields; fill the pickers from a ticket template's assignee, areas and releases; offer only valid parents; honour a person field's allowed-people restriction (CORE-009 (2)) |
| T-266 | Plans' own delete prompts use the shared confirmation | To do | Windows' area: Delete plan and changing the unit or period (which clears capacities) in PlanSettingsPage, and Delete on a release across tracks still use window.confirm |
| T-267 | Small removals and existing confirmations | You | Should D13's confirmation also cover small removals (a field option, a checklist or checklist item, a ticket link, a release from a release across tracks, Withdraw on an invitation)? And should the actions that already have their own step (archive or restore a track, discard a draft or restore a version, remove a security key, directory 'Sync and remove', a board column with tickets, 'Restore default' on a Summary) use the same pattern? |
| T-268 | Checklist rows on a phone | You | At 375 px a checklist row's controls (grip, state, Edit, Move up, Move down, Remove) do not fit one line. Fold them into a 'more' menu, or keep them as they are? |
| T-269 | Assigning at create without people search | You | The Assignee picker uses the people search, which needs the site permission 'Browse users and groups' (everyone has it by default). Someone without it finds no one to assign. Give the picker its own search that only needs Assign tickets in the track? |
| T-270 | Small wave 14 notes | To do | The stable API's 'Instance' tag (getMeta) still says 'instance' (D12 says 'site'); other touch stories should use onARealTouchScreen instead of asOnATouchScreen; two Biome warnings (admin.css .import-kinds th specificity; an unused import in api/contract.test.ts) |
| T-271 | Fix the second sweep's faults | To do | `docs/plan/page-review-second-sweep.md`: 27 earlier faults still there or changed, 69 new (15 medium). Plans routes (plan-*) belong to Windows' Multi-track work: hand those over in COORDINATION.md |
| T-272 | Day-bucketed reports count days in UTC | To do | Second sweep: tickets created on the evening of Nov 13 (local) appear on Nov 14 in Recently created, Time to close, the release and outcome reports, while the calendar says today is Nov 13. The same class of bug as the timeline's 'today' (fixed in wave 12 with `localDay`), here probably in the server's day buckets or the charts' axes |
| T-198 | Load these tickets into the demo again | Done | All tickets loaded on the demo on 2026-11-04, in the Backend, Front and Flutter tracks; again on the Mac's demo on 2026-11-06 (221 tickets) |
| T-199 | Old notes in `.cache/from-old-clone` on the last PC | You | Not on GitHub; copy them first if wanted |
| T-200 | After editing an in-progress checklist item, its box loses the half-ticked look | Done | On `main` |
| T-201 | A subticket refusal names a custom field as "field 12", not by its name | Done | On `main`: the panel reads the create form's field names once per type; the template picker still says "field N" for a field not on the form |
| T-202 | A pasted section title from another Taskmoor document keeps control characters | Done | On `main` |
| T-203 | A checklist item rewritten by someone else shows its new words in the writer's own data download | In progress | On Windows from 2026-11-14 (`wave14/windows-bugs`). Only on tickets the person still sees; needs an `updated_by` column |
| T-204 | A person cannot leave a group someone shared with them | Done | On `main` (ADR-121): leaving takes back only what that share gave, with an event and the audit log |
| T-205 | Track groups are not in a person's data download or erasure | Done | On `main` (ADR-111, ADR-121): owned groups, shares given and received in the download; erasure deletes own groups and takes shares back by the same rules, refusing to leave a track with nobody to run it |
| T-205a | Erasing a person whose share gave the role to run a track to its only other runner: refuse, as built, or let the role stay? | Done | On `main` (`d9061d06`, wave 13, 2026-11-14), as the user decided: the erasure goes through and the runner keeps the role |
| T-206 | Nobody is told when a group is shared with them | Done | On `main`: an inbox notification and email by their preferences, naming the group and who shared it, never tracks they cannot see |

## Flutter app (stopped)

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-180 | Flutter app stays stopped for now | Later | Pushed at `8540a0a`; merge after M1 |
| T-181 | A mobile kit for operators' own builds and notifications | Later | The user asked whether a builder is needed; a note for the plan |
| T-182 | App id, sign-in protection and push questions | Later | ADR-112; no relay, each operator uses their own keys |
