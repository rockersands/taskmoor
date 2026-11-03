# Tickets: everything asked for in the local session

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
| T-005 | Rewrite git history to remove the old address and paths, once, with a backup | You | Just before going public; needs `git-filter-repo` and one force-push, each confirmed |
| T-006 | Tests run on native Windows | Done | M1-144, on `main` |
| T-007 | Job queue uses the database's clock | Done | On `main` |
| T-009 | A leftover test process (vitest, PIDs 40468 and 30628) that a sub chat could not stop | You | Close it, or allow it to be closed |
| T-008 | Keep every request as a ticket, here and in the tool itself | In progress | This file, and tracks BE, FE and FL on the demo |

## Getting to 1.0

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-010 | Full gate, then fast-forward `main` | Done | `main` at `3ad14a3`; repeats for each merge |
| T-011 | Fix the flaky keyboard e2e test | Done | Passed 20 of 20 |
| T-012 | Fix the flaky MCP consent e2e test | Done | Passed 10 of 10 |
| T-013 | Look into the AI settings Strict mode test that needed its retry | Done | Late answers overwrote unsaved settings; fixed |
| T-013a | Look into the boards and sprints e2e tests that need their retry in full gates | To do | Passed alone; may be the proxy losing connections, may be a real race |
| T-013b | Rerun the 1M import after the two fixes | To do | Optional; those fixes have only quick tests so far |
| T-014 | 500k-issue import | Done | 100% of sampled entities in 1 h 58 min; ADR-092 |
| T-015 | Find out why records failed in the large imports | Done | Reserved words as generated keys, and sprints too large for one statement; both fixed; the seven at 500k fit the first cause, as the key BY appears by then, though that run did not capture reasons |
| T-016 | Try the 1M-issue import on this PC | Done | 3 h 58 min, 100% of sampled entities; ADR-092 |
| T-017 | Close M1-091 with the results | Done | In progress.csv |
| T-018 | Merge the finished branches, each with a full gate | To do | Templates, updates, invitations, Google, ticket tools, UI; expect conflicts |
| T-019 | Fuzz stages (1, 2, 4, 8 hours) | To do | The user's decision: after all merges, about 15 hours |
| T-020 | Release 1.0 (M1-120) | To do | LTS, changelog, signed release files |
| T-021 | Sign the air-gap bundle and release files with the key from Drive | To do | The user allows it; never committed; local copy removed afterwards |
| T-022 | Run the checks only a real release can do | To do | `docs/plan/easy-updates-tasks.md`: Docker, GitHub, Linux, a real signature |
| T-023 | Run the bash image and kit scripts somewhere that can | To do | Not run on this Windows setup |
| T-024 | The user's acceptance of 1.0 | You | The last step |

## Open source and going public

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-030 | Stay fully open source under AGPL-3.0-only | Done | Decision recorded |
| T-031 | Make the repository public for 1.0 | You | The user confirms the switch itself |
| T-032 | Scan the whole git history for secrets first | To do | Before T-031 |
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
| T-053 | Should managers copy links where email works? | You | Today every inviter can; recommended: only site administrators there |
| T-054 | A manager can tell an account exists when inviting it | Done | Accepted by the user |
| T-055 | Site administrators give track administrators permission to invite | Done | Off by default |
| T-056 | Managers appoint managers by default, through a removable permission | Done | Decided by the user |
| T-057 | Track managers' web pages | Done | Settings > Tracks you run; moves into the panel on merge |
| T-058 | Google sign-in option, invited people only | Done | `claude/google-signin`; tested against a fake provider |
| T-059 | Real Google test | You | Create the client and enter the secret on a demo; the user said later |
| T-060 | A provider sign-in does not need Taskmoor's second factor | Done | Decided by the user; the guide says so plainly |
| T-061 | Google's logo on the button? | You | Recommended: plain text for now |
| T-062 | Treat Gmail spellings as the same address? | You | Recommended: no |
| T-063 | Allow `@googlemail.com`? | You | Recommended: no for now |

## Navigation and tracks

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-070 | "Tableros" leaves the sidebar; each track is one place with sections | Done | `claude/ui-overhaul`; the name stays Track |
| T-071 | Tracks in the sidebar is one link, with no list under it | Done | replaces the expanding list, as there could be many tracks |
| T-072 | Exactly one board per track, enforced on the server | Done | ADR-116 |
| T-073 | No board outside a track | Done | ADR-116 |
| T-074 | Decide about the leftover demo board `rrg` | You | Its sample track is gone; it can go too if the user agrees |
| T-075 | Summary is a dashboard the track owner can customize | In progress | Migration 0090 exists |
| T-076 | Statistics holds every report for the track | In progress | Created vs closed and two-dimensional were missing |
| T-077 | Files and links section | Done | `claude/ui-overhaul` |
| T-078 | Keep the Lista and Versiones tabs | Done | Decided by the user |
| T-079 | An Objetivos tab listing outcomes with progress | To do | Decided by the user; after the front merge |
| T-080 | A New track button on the Tracks page | Done | `claude/ui-overhaul` |
| T-081 | Hide Backlog entirely on Kanban tracks, and other Scrum-only items | Done | `claude/ui-overhaul` |
| T-082 | A way to manage outcomes on Kanban tracks | You | Their panel lives on the backlog |
| T-083 | A cross-track timeline | In progress | Part of T-088 |
| T-084 | Personal track groups: drag tracks together, name the group | To do | Waits for the merges; takes the next free migration number at the start; private to the person |
| T-085 | Open group is a glass bubble; a minimized one is the size of one track card, with a count and small glass squares | To do | Waits for the merges |
| T-086 | Share a whole group, or set it on another person | To do | Waits for the merges |
| T-087 | Sharing a group gives access to its tracks | To do | Waits for the merges. Decided by the user; the sharer picks a role, only tracks they may give roles on, and un-sharing removes only what the share gave |
| T-087a | Creating tracks: off for everyone by default; a ticked box when giving someone the manager role, which can be unticked | To do | After the front merge. Larger than it looks: a track-level action writes a site-wide grant, so it needs a rule on who may tick it, for example only a site administrator or someone who already holds it, plus audit and tests |
| T-087b | One customizable Summary per track, with Paneles for more | Done | Decided by the user; the spec is being changed on `claude/ui-overhaul` |
| T-087c | Keep Paneles in the sidebar | Done | Decided by the user; dashboards that can span tracks |
| T-088 | Multi-track first version: a plan over several tracks and saved searches, with Summary, Timeline, List and Calendar | To do | Paused on `claude/multi-track`; restarts after the merges |
| T-089 | Multi-track: dependencies view | To do | In 1.0; starts after T-088 |
| T-089b | Multi-track: teams and capacity | To do | In 1.0 |
| T-089c | Multi-track: releases across tracks | To do | In 1.0 |
| T-089d | Multi-track: program board with live editing | To do | In 1.0 |
| T-089e | Multi-track: draft changes and scenarios | To do | In 1.0 |
| T-089f | Multi-track: auto-scheduler | To do | In 1.0 |
| T-089g | Multi-track: duplicate a plan, link to a view, CSV and image export | To do | In 1.0 |
| T-089h | A "Your tracks" section at the top of Home | Done | On `main`; shows tracks the person can see, as the track list cannot yet say which they belong to |
| T-089a | Multi-track: hierarchy grid (PLN-010) and baselines (PLN-011) | You | Not in what the user described; 2.0 and 4.0 unless the user says otherwise |

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
| T-106 | Complete a sprint from the board, for managers and above, with a confirmation pop-up | To do | Waits for the merges; says how many tickets are done and open, and where open ones go; Complete and Cancel |

## Tickets

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-110 | One status dropdown on the ticket, not a row of buttons | Done | `claude/ui-overhaul` |
| T-111 | A way back from a ticket to its board | Done | `claude/ui-overhaul` |
| T-112 | Fix Escape after Create in the create dialog | Done | `claude/ui-overhaul` |
| T-113 | Ticket templates | Done | `claude/ticket-templates`; form limits accepted by the user |
| T-114 | Links with categories, on every ticket type | On branch | `claude/ticket-tools` |
| T-115 | Link picker searches by number or name, same track only | On branch | `claude/ticket-tools` |
| T-116 | Subtickets on the ticket page, with a completion percentage | On branch | `claude/ticket-tools`; normal ticket statuses |
| T-117 | Checklists with completion, item states open, in progress, done, rejected | On branch | `claude/ticket-tools`; rejected items are left out of the percentage |
| T-118 | A `/` menu in descriptions and comments | On branch | `claude/ticket-tools`; our own list, no Atlassian site opened |
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
| T-133 | The user's "vxfdv" widget holds an invalid search | You | Fix or clear its search on the demo |
| T-134 | Remove the sample tracks; keep only Flutter, Backend and Front | Done | The user asked; the four sample tracks are in the demo's trash |

## The look

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-140 | Liquid Glass style, in our own design | Done | No Apple or Atlassian assets |
| T-141 | Deep strength, Soft canvas, the generated illustration | Done | Decided by the user, who says Gemini's terms allow it |
| T-142 | Controls need not truly bend their colour for now | Done | Decision recorded |
| T-143 | Glass on every page, starting with the track sections | To do | Waits for the merges; the list section was called out |
| T-144 | The design is consistent through the whole app | To do | Waits for the merges; shared styles, a guard, then a sweep of every route |
| T-145 | Dark Reader: detect it, use our dark mode, tell it to back off | Done | The user's own skin choice is kept |
| T-146 | Fix the English filters in the Spanish interface | To do | Check first: filter names were reworked, and type names are now translated |
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
| T-161 | Tutorial: first-run offer, sections to pick, one of everything | To do | Waits for the merges; progress and picker exist |
| T-162 | Drag and drop with a keyboard path beyond boards | To do | Backlog, dashboard widgets, files onto tickets |
| T-163 | Layout editor page | To do | UI-T15 |
| T-164 | Phone and accessibility pass | To do | UI-T09 |
| T-165 | Update the e2e specs the rework broke | To do | Needed before that branch can pass a gate |

## Waiting on the user, for later

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-170 | AI key for the live tests | You | Not yet, the user said |
| T-171 | Spanish review | You | Once every M1 task is finished |

## Known gaps found along the way

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-190 | The full ticket page has no protection for unsaved text | To do | The pop-up has it |
| T-191 | Controls follow edit permission up front, not only priority | To do | Today other fields show controls and the server refuses |
| T-192 | Turning a track's sprints off while a sprint runs is not guarded | To do | Changing a board to Kanban during a sprint is refused already |
| T-193 | A 5,000-card column is not smooth | To do | About 15 frames a second scrolling and a 0.9 s pause on a drop; `content-visibility` might help, but clips card menus |
| T-194 | Home's "Your tracks" should show the tracks a person belongs to | To do | Today, tracks they can see; "latest opened" is remembered per browser |
| T-195 | A backup's saved filter naming Points reads the seeded field, not the imported one | To do | Known limit, not tested |
| T-196 | Ticket tools' own follow-ups, TT-1 to TT-8 | To do | `docs/plan/ticket-tools-tasks.md`: same-named files, live co-editing of collapsible sections, email |
| T-197 | Run the fuzz targets adf, markdown and wiki over the slash menu's new blocks | To do | Part of T-019 |
| T-198 | Load these tickets into the demo again | To do | T-121 onward never reached the demo, and a new device starts with none |
| T-199 | Old notes in `.cache/from-old-clone` on the last PC | You | Not on GitHub; copy them first if wanted |

## Flutter app (stopped)

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-180 | Flutter app stays stopped for now | Later | Pushed at `8540a0a`; merge after M1 |
| T-181 | A mobile kit for operators' own builds and notifications | Later | The user asked whether a builder is needed; a note for the plan |
| T-182 | App id, sign-in protection and push questions | Later | ADR-112; no relay, each operator uses their own keys |
