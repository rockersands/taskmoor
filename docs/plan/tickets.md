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

A ticket is only Done on `main` after a green full gate. "On branch" means what its sub chat
reported, and the coordinator checked that it was pushed.

## Setup and repository

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-001 | Everything lives on one NVMe drive and runs on native Windows | Done | Decision recorded; this PC has no WSL Ubuntu |
| T-002 | Old copies of the repository cleared from other drives | You | In the Recycle Bin; the user empties it |
| T-003 | Repository renamed to `Rockersands/taskmoor` | Done | Remote and docs updated |
| T-004 | The user's Gmail address and local paths removed from tracked files | On branch | M1 branch; new commits use the no-reply address |
| T-005 | Rewrite git history to remove the old address and paths, once, with a backup | You | Just before going public; needs `git-filter-repo` and one force-push, each confirmed |
| T-006 | Tests run on native Windows | Done | M1-144, on `main` |
| T-007 | Job queue uses the database's clock | Done | On `main` |
| T-008 | Keep every request as a ticket, here and in the tool itself | In progress | This file, and tracks BE, FE and FL on the demo |

## Getting to 1.0

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-010 | Full gate, then fast-forward `main` | Done | `main` at `3ad14a3`; repeats for each merge |
| T-011 | Fix the flaky keyboard e2e test | Done | Passed 20 of 20 |
| T-012 | Fix the flaky MCP consent e2e test | Done | Passed 10 of 10 |
| T-013 | Look into the AI settings Strict mode test that needed its retry | To do | Failed in two gates, passed alone |
| T-014 | 500k-issue import | Done | 100% of sampled entities in 1 h 58 min; ADR-092 |
| T-015 | Find out why seven records failed in that run | In progress | The test now reports reasons; the 1M run shows them |
| T-016 | Try the 1M-issue import on this PC | In progress | Estimate 3 h 57 min, right at the 4 h bar |
| T-017 | Close M1-091 with the results | To do | After T-015 and T-016 |
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
| T-043 | One update command, signed releases only | On branch | `claude/easy-updates` |
| T-044 | New-version notice for site administrators, with an off switch | On branch | `claude/easy-updates`; off in the air-gap bundle |
| T-045 | Refuse a release with only a checksum | On branch | Decided by the user |
| T-046 | All-in-one image named `ghcr.io/rockersands/taskmoor-allinone` | On branch | Decided by the user |
| T-047 | A desktop wrapper for the Builder | Later | Only if people ask |

## People, access and sign-in

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-050 | Sign in with any email, personal or company | On branch | `claude/track-invites`; no open sign-up |
| T-051 | Invite by email with a set role | On branch | `claude/track-invites`; real email not yet tested |
| T-052 | A link to copy when a site has no mail server | On branch | `claude/track-invites` |
| T-053 | Should managers copy links where email works? | You | Today every inviter can; recommended: only site administrators there |
| T-054 | Is it fine that a manager can tell an account exists? | You | Recommended: accept it |
| T-055 | Site administrators give track administrators permission to invite | On branch | Off by default |
| T-056 | Managers appoint managers by default, through a removable permission | On branch | Decided by the user |
| T-057 | Track managers' web pages | On branch | Settings > Tracks you run; moves into the panel on merge |
| T-058 | Google sign-in option, invited people only | On branch | `claude/google-signin`; tested against a fake provider |
| T-059 | Real Google test | You | Create the client and enter the secret on a demo; the user said later |
| T-060 | A provider sign-in does not need Taskmoor's second factor | On branch | Decided by the user; the guide says so plainly |
| T-061 | Google's logo on the button? | You | Recommended: plain text for now |
| T-062 | Treat Gmail spellings as the same address? | You | Recommended: no |
| T-063 | Allow `@googlemail.com`? | You | Recommended: no for now |

## Navigation and tracks

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-070 | "Tableros" leaves the sidebar; each track is one place with sections | On branch | `claude/ui-overhaul`; the name stays Track |
| T-071 | Tracks expands in the sidebar with the current one marked | On branch | Up to eight, then a link to all |
| T-072 | Exactly one board per track, enforced on the server | On branch | ADR-116 |
| T-073 | No board outside a track | On branch | ADR-116 |
| T-074 | Decide about the leftover demo board `rrg` | You | Its sample track is gone; it can go too if the user agrees |
| T-075 | Summary is a dashboard the track owner can customize | In progress | Migration 0090 exists |
| T-076 | Statistics holds every report for the track | In progress | Created vs closed and two-dimensional were missing |
| T-077 | Files and links section | On branch | `claude/ui-overhaul` |
| T-078 | Keep the Lista and Versiones tabs? | You | Recommended: keep both |
| T-079 | An Objetivos tab listing outcomes with progress | You | Recommended: add it |
| T-080 | A New track button on the Tracks page | To do | With the front sub chat |
| T-081 | Hide Backlog entirely on Kanban tracks, and other Scrum-only items | To do | With the front sub chat |
| T-082 | A way to manage outcomes on Kanban tracks | You | Their panel lives on the backlog |
| T-083 | A cross-track timeline | Later | Roadmaps in 2.0, unless the user wants it sooner |

## Boards and moving tickets

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-090 | Fix drag and drop refusing moves | On branch | The missing close reason |
| T-091 | Seamless moves in any direction, with no dialog, by default | On branch | Needs the user's check by mouse |
| T-092 | A column is its status | On branch | New column makes a status; rename renames it |
| T-093 | Refusals in plain words, no raw codes | On branch | `claude/ui-overhaul` |
| T-094 | Why a move happened goes in a comment, with no prompt | On branch | Decided by the user |
| T-095 | Closing a ticket by drag sets the reason Completed, and reports count it | On branch | A server test covers it |
| T-096 | The rightmost column closes by default, and this can be changed | On branch | Per track |
| T-097 | Deleting a column with cards asks where they go | On branch | `claude/ui-overhaul` |
| T-098 | Columns no card can reach say so, and offer a fix | On branch | Includes the "potato" test |
| T-099 | Decide on the "potato" column | Done | No longer needed: its sample track was removed |
| T-100 | Should demo tracks stop sharing one workflow? | Done | Settled: the three real tracks each have their own |
| T-101 | Track picker in the board form, raw query under advanced | On branch | `claude/ui-overhaul` |
| T-102 | Filter a board by person, for ordinary members | On branch | `claude/ui-overhaul` |
| T-103 | The people list floats, and does not push the page down | To do | With the front sub chat |
| T-104 | Filter buttons and checkboxes get the glass style | To do | With the front sub chat |
| T-105 | Check whether "Solo mis tickets" and "Yo" duplicate each other | To do | With the front sub chat |

## Tickets

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-110 | One status dropdown on the ticket, not a row of buttons | On branch | `claude/ui-overhaul` |
| T-111 | A way back from a ticket to its board | On branch | `claude/ui-overhaul` |
| T-112 | Fix Escape after Create in the create dialog | On branch | `claude/ui-overhaul` |
| T-113 | Ticket templates | On branch | `claude/ticket-templates`; form limits accepted by the user |
| T-114 | Links with categories, on every ticket type | In progress | `claude/ticket-tools` |
| T-115 | Link picker searches by number or name, same track only | In progress | `claude/ticket-tools` |
| T-116 | Subtickets on the ticket page, with a completion percentage | In progress | `claude/ticket-tools`; normal ticket statuses |
| T-117 | Checklists with completion, item states open, in progress, done, rejected | In progress | `claude/ticket-tools`; rejected items are left out of the percentage |
| T-118 | A `/` menu in descriptions and comments | In progress | `claude/ticket-tools`; our own list, no Atlassian site opened |
| T-119 | Mention someone with `@` to notify them | Done | Already built |
| T-120 | Add any tool the `/` menu is missing | You | Describe it in words, no screenshots |
| T-121 | Open a ticket in a pop-up from the board or any section, instead of leaving the page | To do | With the front sub chat |
| T-122 | Clone a ticket from the pop-up and the ticket page | To do | Clone exists on the ticket page; the pop-up needs it |
| T-123 | Copy a link to a ticket | To do | With the front sub chat |
| T-124 | Set a ticket's priority from the pop-up | To do | With the front sub chat |
| T-125 | Board cards show title, priority, assignee and points | To do | With the front sub chat; points only where set |
| T-126 | Edit a ticket's title from the card, with a pencil button | To do | With the front sub chat |
| T-127 | The ticket's type shows as an icon on the card, not a word | To do | With the front sub chat; our own icons; the name stays for screen readers |
| T-128 | Priority shows as an icon, not a word | To do | With the front sub chat; shape as well as colour; custom priorities too |

## Search and dashboards

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-130 | Basic search: dates on, before, after and between | On branch | `claude/ui-overhaul` |
| T-131 | Basic search: type, priority, labels and more | On branch | `claude/ui-overhaul` |
| T-132 | A widget that cannot load says what it needs | On branch | `claude/ui-overhaul` |
| T-133 | The user's "vxfdv" widget holds an invalid search | You | Fix or clear its search on the demo |
| T-134 | Remove the sample tracks; keep only Flutter, Backend and Front | Done | The user asked; the four sample tracks are in the demo's trash |

## The look

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-140 | Liquid Glass style, in our own design | On branch | No Apple or Atlassian assets |
| T-141 | Deep strength, Soft canvas, the generated illustration | On branch | Decided by the user, who says Gemini's terms allow it |
| T-142 | Controls need not truly bend their colour for now | Done | Decision recorded |
| T-143 | Glass on every page, starting with the track sections | In progress | The list section was called out |
| T-144 | The design is consistent through the whole app | In progress | Shared styles, a guard, then a sweep of every route |
| T-145 | Dark Reader: detect it, use our dark mode, tell it to back off | On branch | The user's own skin choice is kept |
| T-146 | Fix the English filters in the Spanish interface | To do | With the front sub chat |

## Administration

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-150 | Administration as its own section, with an overview | On branch | e2e not run yet |
| T-151 | Pages for visibility policies and the permission explainer | On branch | `claude/ui-overhaul` |
| T-152 | Page for webhooks | On branch | `claude/ui-overhaul` |
| T-153 | Pages for AI limits and prices | On branch | `claude/ui-overhaul` |
| T-154 | Choose which sets a track uses | On branch | A plain picker for now |
| T-155 | Decide which other API-only controls go in 1.0 | You | UI-T21; the list comes from the front sub chat |

## The rest of the interface work

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-160 | Help menu with tutorials and keyboard shortcuts | On branch | `claude/ui-overhaul` |
| T-161 | Tutorial: first-run offer, sections to pick, one of everything | In progress | Progress and picker exist; the steps do not |
| T-162 | Drag and drop with a keyboard path beyond boards | To do | Backlog, dashboard widgets, files onto tickets |
| T-163 | Layout editor page | To do | UI-T15 |
| T-164 | Phone and accessibility pass | To do | UI-T09 |
| T-165 | Update the e2e specs the rework broke | To do | Needed before that branch can pass a gate |

## Waiting on the user, for later

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-170 | AI key for the live tests | You | Not yet, the user said |
| T-171 | Spanish review | You | Once every M1 task is finished |

## Flutter app (stopped)

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-180 | Flutter app stays stopped for now | Later | Pushed at `8540a0a`; merge after M1 |
| T-181 | A mobile kit for operators' own builds and notifications | Later | The user asked whether a builder is needed; a note for the plan |
| T-182 | App id, sign-in protection and push questions | Later | ADR-112; no relay, each operator uses their own keys |
