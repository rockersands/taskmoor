---
spec: 03
title: "Planning, time, discovery and quality"
sources: docs/research/sources.md
accessed: 2026-10-11
attestation: own-words
---
# 03 Planning, time, discovery and quality

This file specifies, for Taskmoor, the planning and management layers that Jira sells as Premium features, as separate products or through Marketplace apps: roadmaps (Jira: Plans; cross-team planning with sandbox, scenarios, capacity and a program board), the cross-track hierarchy grid, time tracking with timesheets, approvals and cost, discovery (Jira: Product Discovery) with a public idea portal, Align-style portfolio management (OKRs, strategy, budgets, WSJF, PI planning), and test management. All of it is included in the free product. Each area builds on the ticket core (files 01a to 01c) rather than keeping its own copy of tickets.

## How to read

- **ID**: `MODULE-NNN`, stable and never reused. This file holds PLN, TIM, DSC, PRT and QA.
- **MS**: M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must, S = Should, C = Could.
- **Source**: parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit; "verify" marks a fact the research flagged as unconfirmed.
- **Terms**: ticket (Jira: issue), track (Jira: project); roadmap (Jira: Plans, formerly Advanced Roadmaps), which the product calls **Multi-track**, one roadmap being a **plan** (the user's decision of 2026-11-03; ADR-122); file 00 lists the full vocabulary.

## 1. Reference: roadmaps

- **Sources**: tracks (both configuration modes) and saved searches, mixed in one roadmap. Boards are not sources: each board belongs to one track (ADR-116), so choosing the track does the same (the user's decision of 2026-11-03).
- **Hierarchy**: every level of file 01a section 1.2, including custom levels above Outcome.
- **Views**: timeline with list, calendar (tickets with start and due dates or dates inherited from sprint or release; drag to reschedule; sprints and releases themselves are not moved there), summary, program board; saved views per roadmap.
- **Scheduling inputs**: rank, estimates (points, hours or days), team capacity per iteration or velocity, sprints including other boards' sprints, release dates, fixed start and due dates, dependencies, exclusion rules (hide closed tickets, chosen ticket types or releases).
- **Roll-ups**: dates, estimates and progress rolled up from children, including partial roll-ups when only some children are estimated.
- **Warnings**: child scheduled after parent end, dependency conflict, ticket outside its sprint or release dates, team over capacity, unestimated ticket in a capacity-planned sprint.
- **Settings**: roadmap permissions (view, edit), financial year start, estimation units, working days.
- **Jira limits to exceed**: 10,000 issues and 200 projects per plan; 2 active program boards per plan; program board not real-time; individual capacity fixed at a 40-hour week; cross-project releases exist only inside a plan.

## 2. PLN requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| PLN-001 | **Roadmaps.** Taskmoor shall let users create roadmaps (Multi-track plans) from tracks and saved searches, mixed in one plan, with the hierarchy, views, roll-ups, warnings and settings of section 1, with no ticket or track cap. A plan gives no access: each viewer sees only the tickets of the sources they may see, as they may see them; a source they cannot see adds nothing for them, and a plan with no visible source finds nothing. | (1) A roadmap over 300 tracks and 50,000 tickets opens its timeline in under 3 s. (2) Partial roll-ups show estimated and unestimated portions separately. (3) Each warning type of section 1 is raised by a fixture roadmap. (4) A viewer never sees, counts or groups a ticket of a plan they may not see, and a saved search whose query no longer runs is left out and flagged without stopping the plan. | M1 | M | Jira Premium; exceeds Jira (10,000 items, 200 spaces) |
| PLN-002 | **Sandbox and selective commit.** Taskmoor shall hold roadmap edits as drafts until reviewed, show them as a change list with old and new values, and commit or discard all or selected changes. | (1) Edits in a roadmap do not change live tickets until committed. (2) Committing 3 of 10 changes applies only those 3, and the other 7 stay pending. (3) A commit fails per ticket with a reason when the user lacks permission, without blocking the rest. | M2 | M | Jira Premium |
| PLN-003 | **Scenarios.** Taskmoor shall support several what-if scenarios per roadmap, each with its own draft changes, side-by-side comparison and promotion of one scenario to the baseline. | (1) Two scenarios with different team assignments show different end dates. (2) Promoting a scenario makes its drafts the roadmap's drafts. | M2 | M | Jira Premium |
| PLN-004 | **Auto-scheduler.** Taskmoor shall schedule tickets by rank, dependencies, capacity or velocity, sprints and release dates, respecting fixed dates and exclusion rules, and preview the result as draft changes. | (1) With capacity 20 points per sprint, 60 points of ranked work fill three sprints in rank order. (2) A blocked ticket is never scheduled before its blocker ends. (3) Fixed-date tickets are not moved. | M2 | M | Jira Premium |
| PLN-005 | **Teams and capacity.** Taskmoor shall plan with site teams (CORE-027), capacity per iteration in points, hours or days, velocity from history, and other teams' sprints as external iterations. | (1) Changing a team's capacity re-runs scheduling previews. (2) Velocity defaults to the average of the last 3 completed sprints. | M2 | M | Jira Premium |
| PLN-006 | **Dependencies.** Taskmoor shall treat blocking links as dependencies on a plan's Timeline: draw a line from each blocker to the ticket it blocks and a numbered badge beside each blocked ticket's bar; show a dependency as late, in red and with a text label, never by colour alone, when its blocker ends on or after the day the blocked ticket starts; count, on each blocked ticket, its blockers outside the plan or hidden from the viewer without naming them; and give the same information as a list for the keyboard and screen readers. A plan gives no access here either: a blocker the viewer may not see is only ever part of a count. Choosing other link types as dependencies, and flagging dependencies within one sprint, are PLN-013. | (1) A dependency whose blocker ends on or after the day the dependent starts turns red and says "late" in words; a closed blocker, or a closed dependent, is never late. (2) A blocker outside the plan, or one the viewer may not see, is counted on the ticket it blocks and never named, dated or linked; a blocker of the plan that a filter leaves out is counted apart. (3) The list names each listed ticket's listed blockers and says whether each is late. | M1 | M | Jira Premium |
| PLN-007 | **Releases in roadmaps.** Taskmoor shall show track releases and support cross-track releases stored as first-class objects that align several track releases to one date and that end on a fixed date or when their work completes. | (1) A cross-track release is visible outside the roadmap, in queries and on release pages. (2) Moving its date moves the linked track releases after commit. | M2 | M | Jira Premium; exceeds Jira (plan-only) |
| PLN-008 | **Program board.** Taskmoor shall provide program boards showing level-1 and level-0 tickets by team and iteration with dependencies, editable by many users at once in real time, with no limit per roadmap. | (1) Two users moving cards see each other's moves within 1 s. (2) A roadmap holds 3 or more active program boards. | M2 | M | Jira Premium; exceeds Jira (2 boards, not real-time) |
| PLN-009 | **Individual capacity.** Taskmoor shall allocate people's time to Outcome-level or higher tickets, level-2 tickets (Jira: initiatives) and free-text entries (leave, maintenance) in hours, days or percent, with people and work views, bulk copy, paste and fill, CSV import, and a configurable working week. | (1) A 32-hour working week is honoured in percent allocations. (2) Over-allocation above 100% is highlighted. | M2 | M | Jira Premium; exceeds Jira (fixed 40-hour week) |
| PLN-010 | **Hierarchy grid.** Taskmoor shall provide a cross-track grid of any depth built from generators (insert by query, group by field, extend by children or by link type), with inline editing, aggregate columns (sum, min, max, progress, count), formula columns, drag-to-reparent and saved structures. | (1) A structure of 100,000 rows scrolls and edits without errors. (2) Dragging a row under another parent changes the parent field after confirmation. (3) A sum column equals the sum of children's values. | M2 | M | Structure app; JXL app |
| PLN-011 | **Gantt baselines and resource levelling.** Taskmoor shall capture baselines of roadmap dates and compare them with current dates, show the critical path, and level resources by shifting unconstrained tickets to remove over-allocation. | (1) A baseline comparison shows slipped tickets with their delay in days. (2) Levelling never moves fixed-date tickets. | M4 | S | OpenProject; BigPicture app |
| PLN-012 | **Plan views, grouping, filters and rescheduling.** Taskmoor shall show each plan as a Summary, a Timeline, a List and a Calendar, each listing at most the first 10,000 of the plan's tickets and saying so; group the Timeline and the List by track, assignee, status, ticket type or priority; filter every view by one track, one assignee, one ticket type and one stage; keep the grouping and filters in the page's address; and reschedule tickets from the Timeline and the Calendar through the ticket's own change. | (1) A plan over 20 tracks and 100,000 tickets answers each view in under 1 s. (2) A view of a plan with more than 10,000 tickets lists 10,000 and says so. (3) Every number on the Summary equals the count of the search it links to. (4) An address with a filter and a grouping opens the view filtered and grouped. (5) Moving a bar or a calendar entry changes the ticket's dates and history; a refusal says why. | M1 | M | Jira Premium; exceeds Jira (one value per filter at first) |
| PLN-013 | **Dependency options.** Taskmoor shall let a plan treat link types it chooses as dependencies, beside blocking links, drawn, counted and judged late as PLN-006 says; and, when asked, flag each dependency whose blocker and the ticket it blocks are in the same sprint. | (1) A plan that also counts a chosen link type shows those links with lines, badges and in the list, and a plan that does not shows none of them. (2) With the flag asked for, a dependency within one sprint is marked in words as well as by colour; without it, none is marked. | M2 | M | Jira Premium |

## 3. Reference: time tracking

- **Global settings**: working hours per day and working days per week (decimals allowed), display format, default unit, copying transition comments into the time entry description.
- **Fields**: original estimate, remaining estimate, time spent, effort ratio; time entry = author, start date and time, duration, description, visibility (role or group), and attributes (account, billable flag, work category).
- **Remaining estimate when recording time**: reduce automatically, leave unchanged, set to a value, or reduce by a given amount.
- **Timesheet states**: open, submitted, approved, rejected, reopened; approved periods are locked.

## 4. TIM requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| TIM-001 | **Estimates and time entries.** Taskmoor shall provide the fields, settings and remaining-estimate options of section 3, gated by Work on tickets and the edit and delete own or all time entry permissions. | (1) Recording 2h with "reduce automatically" lowers a 5h remaining estimate to 3h. (2) "1w 2d" parses according to the working-week settings. (3) Imported Jira worklogs keep author, date and duration. | M1 | M | Jira Free (needed by the M1 importer) |
| TIM-002 | **Timers.** Taskmoor shall offer start and stop timers on tickets that create time entries, firing Work started and Work stopped events. | (1) A timer left running over midnight produces one time entry with the correct duration. | M2 | S | YouTrack; Jira Free events |
| TIM-003 | **Timesheets and approvals.** Taskmoor shall provide personal and team timesheets by day, week and month, recording time from the grid, and period approval with the states of section 3. | (1) A submitted week can be approved or rejected by the team's approver. (2) Time entries in an approved period cannot be edited without reopening, which is audited. | M2 | M | Tempo Timesheets app |
| TIM-004 | **Accounts, billing and cost.** Taskmoor shall support accounts linked to customers and tracks, billable and non-billable time, cost rates per person or role and effective date, and budgets in money or hours per track, Outcome or account with burn tracking. | (1) Cost of an Outcome equals the sum of time entry hours times the rate in force on each time entry's date. (2) Budget burn shows spent, remaining and forecast. | M2 | M | Tempo app; OpenProject |
| TIM-005 | **Time reports and workload.** Taskmoor shall report time by person, track, account, parent and period, estimated versus actual, and show a workload view against each person's capacity. | (1) A report grouped by account and month exports to CSV with totals matching time entries. (2) A person over capacity shows in red on the workload view. | M2 | M | Tempo app; Asana; ClickUp |

## 5. Reference: discovery

- **Idea**: a ticket in a discovery track; idea types and connected hierarchies (for example problem, opportunity, solution).
- **Fields**: rating (1 to 5), slider, number, checkbox, select, multi-select, labels, people, date interval (for roadmap placement), votes, evidence count, delivery progress, delivery status.
- **Formulas**: roll-up (for example sum of the impact of linked evidence), weighted score (percentage weights across chosen fields), custom expression (for example `{Impact} / {Effort}` or RICE).
- **Evidence**: snippet, source link, customer or customer group, impact value, and optional customer attributes (revenue, tier, size), linked to one or more ideas.
- **Views**: list, board (grouped by a field), matrix (X and Y fields, bubble size; ideas with no value do not plot), timeline or roadmap (date intervals, or Now, Next, Later columns).
- **Delivery progress**: by ticket count per stage, or by points.

## 6. DSC requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| DSC-001 | **Discovery tracks and ideas.** Taskmoor shall provide discovery tracks with ideas, idea types and connected idea hierarchies, where anyone with access can comment, vote and add evidence at no cost. | (1) An idea of type Solution can be connected under an Opportunity. (2) There is no separate paid creator role. | M4 | M | JPD; exceeds JPD (creator licences) |
| DSC-002 | **Discovery fields and formulas.** Taskmoor shall implement the field and formula types of section 5. | (1) A weighted score with weights 50/30/20 recomputes when an input changes. (2) A RICE expression yields the documented value on fixture ideas. | M4 | M | JPD |
| DSC-003 | **Evidence and customer requests.** Taskmoor shall capture evidence from a browser extension, chat, service-desk requests and email, link it to ideas with impact and customer attributes, and filter and sort ideas by it. | (1) Creating evidence from a service-desk request links back to the request. (2) Ideas sort by total revenue of linked customers. | M4 | M | JPD; Linear customer requests |
| DSC-004 | **Discovery views.** Taskmoor shall provide the view types of section 5 with per-view filter, sort and group, view-level permissions, and roadmap views spanning several discovery tracks. | (1) Dragging an idea in a matrix changes its X and Y field values. (2) A view restricted to product leads is hidden from others. | M4 | M | JPD Premium (view permissions, cross-space roadmaps) |
| DSC-005 | **Delivery linking.** Taskmoor shall create or link tickets for delivery (Outcomes and their children) in software tracks and show delivery progress and status on ideas, by count or by points in both configuration modes. | (1) Completing half the linked tickets' points shows 50% progress. (2) Progress works when delivery is in a track in local mode. | M4 | M | JPD; exceeds JPD (points only for company-managed) |
| DSC-006 | **Published views.** Taskmoor shall publish read-only live views to internal and external viewers without an account, choosing visible fields, inviting by email, allowing comments on the view and export. | (1) An external viewer sees only the chosen fields. (2) Revoking the link stops access immediately. | M4 | M | JPD |
| DSC-007 | **Public idea portal with voting.** Taskmoor shall offer a branded public portal where signed-in or email-verified users submit ideas, vote, comment and follow status, with moderation, duplicate merging (votes combined) and notifications to voters on status change. | (1) Merging two ideas keeps all votes once per person. (2) Changing an idea to "Shipped" emails its voters. | M4 | M | Productboard, Aha!; exceeds JPD (no portal) |

## 7. Reference: portfolio (Align-style)

- **Levels**: enterprise, portfolio, solution, program, team; strategic themes and value streams above portfolio epics, capabilities and features (mapped onto custom hierarchy levels).
- **Frameworks**: SAFe (Essential, Large Solution, Portfolio, Full), LeSS, Scrum@Scale, Spotify-style tribes, Disciplined Agile, custom and hybrid (agile and waterfall).
- **WSJF** (SAFe definition): (business value + time criticality + risk reduction or opportunity enablement) / job size.
- **PI objects**: program increment, iterations, team PI objectives with business value, risks with ROAM state (resolved, owned, accepted, mitigated), confidence vote.

## 8. PRT requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| PRT-001 | **Goals and OKRs.** Taskmoor shall provide hierarchical goals with owners, dates, status updates and followers, key results with start, target and current values and confidence, and links to tickets, tracks and level-2 tickets (Jira: initiatives), rolling up progress. | (1) A key result fed by a query (for example closed tickets count) updates automatically. (2) A ticket's Goals field shows linked goals. | M4 | M | Jira Free (Goals); Jira Align |
| PRT-002 | **Strategy and portfolio structure.** Taskmoor shall model strategic themes, value streams and the levels of section 7, with a strategy view showing how work maps to themes. | (1) Every portfolio epic shows its theme and value stream. | M4 | M | Jira Align (strategy room) |
| PRT-003 | **Lean budgets and investment vs actuals.** Taskmoor shall allocate budgets to themes, value streams and increments, compute actual spend from time entries and cost rates (TIM-004), and report planned versus actual investment. | (1) The investment report matches spend computed from time entries. | M4 | M | Jira Align |
| PRT-004 | **Prioritisation.** Taskmoor shall compute WSJF (section 7), rank portfolio epics, and provide a portfolio Kanban with WIP limits. | (1) Changing job size re-ranks epics by WSJF. | M4 | M | Jira Align; SAFe |
| PRT-005 | **PI planning.** Taskmoor shall plan program increments with team objectives, a real-time program board with dependencies, a ROAM risk board and confidence voting for remote and in-room events. | (1) 100 participants can edit the PI board at once with sub-second updates. (2) Confidence votes are recorded per team. | M4 | M | Jira Align; Targetprocess |
| PRT-006 | **Framework templates.** Taskmoor shall configure levels, terms and boards from templates for each framework in section 7. | (1) Applying the SAFe Portfolio template creates the levels, fields and boards it defines. | M4 | M | Jira Align |
| PRT-007 | **Portfolio reporting and forecasting.** Taskmoor shall report progress, spend and labour cost together, forecast delivery from velocity and capacity, propagate dependency slips, and compare quarterly delivery and financial trends. | (1) A slip in a capability's dependency moves its forecast end date. | M4 | M | Jira Align |

## 9. Reference: test management

- **Entities**: test (manual steps with action, data, expected result; Gherkin scenario; exploratory charter; generic automated), precondition, test set, test plan, test execution, test run, step result, defect link.
- **Statuses**: to do, executing, passed, failed, blocked, aborted (configurable).
- **CI formats**: JUnit XML, Cucumber JSON, TestNG, NUnit, xUnit, Robot Framework (Xray parity verify).

## 10. QA requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| QA-001 | **Test repository.** Taskmoor shall store the test entities of section 9 as ticket types with versioning, folders, reusable steps, preconditions and parameterised data sets. | (1) Editing a test creates a new version; executions keep the version they ran. (2) A data set with 5 rows expands into 5 iterations at run time. | M4 | M | Xray, Zephyr apps |
| QA-002 | **Plans, executions and runner.** Taskmoor shall group tests into plans and executions per release and environment, assign testers, and run tests step by step with timer, evidence attachments and one-click defect creation prefilled with the failing step. | (1) A failed step creates a defect linked to the run and the requirement. (2) Execution progress updates live for all viewers. | M4 | M | Xray, Zephyr apps |
| QA-003 | **Coverage and traceability.** Taskmoor shall show requirement-to-test-to-run-to-defect traceability and coverage status per requirement, release and environment, with query functions for coverage. | (1) A requirement with one failing test shows "not covered: failed" for that release. (2) A query returns requirements without tests. | M4 | M | Xray app |
| QA-004 | **CI result import.** Taskmoor shall import the formats of section 9 through API and CLI, create missing automated tests, and link runs to builds and deployments. | (1) Importing a JUnit file with 500 cases creates or updates 500 runs in one execution. | M4 | M | Xray app; Azure Test Plans |
| QA-005 | **Test reports.** Taskmoor shall report execution progress, pass-rate trends, flaky tests and coverage, as reports and dashboard widgets. | (1) A test that alternates pass and fail across 10 runs is flagged flaky. | M4 | M | Xray, Zephyr apps |
