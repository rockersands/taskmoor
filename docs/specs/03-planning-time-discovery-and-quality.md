---
spec: 03
title: "Planning, time, discovery and quality"
sources: docs/research/sources.md
accessed: 2026-10-11
attestation: own-words
---
# 03 Planning, time, discovery and quality

This file specifies, for Tracksmith (a working name for the product), the planning and management layers that Jira sells as Premium features, as separate products or through Marketplace apps: Plans (cross-team planning with sandbox, scenarios, capacity and a program board), the cross-space hierarchy grid, time tracking with timesheets, approvals and cost, Product Discovery with a public idea portal, Align-style portfolio management (OKRs, strategy, budgets, WSJF, PI planning), and test management. All of it is included in the free product. Each area builds on the work-item core (files 01a to 01c) rather than keeping its own copy of items.

## How to read

- **ID**: `MODULE-NNN`, stable and never reused. This file holds PLN, TIM, DSC, PRT and QA.
- **MS**: M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must, S = Should, C = Could.
- **Source**: parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit; "verify" marks a fact the research flagged as unconfirmed.
- **Terms**: work item = issue, space = project; plan = Jira Plans (formerly Advanced Roadmaps).

## 1. Reference: Plans

- **Sources**: boards, spaces (both configuration modes) and saved filters, mixed in one plan.
- **Hierarchy**: every level of file 01a section 1.2, including custom levels above Epic.
- **Views**: timeline with list, calendar (items with start and due dates or dates inherited from sprint or release; drag to reschedule; sprints and releases themselves are not moved there), summary, program board; saved views per plan.
- **Scheduling inputs**: rank, estimates (story points, hours or days), team capacity per iteration or velocity, sprints including other boards' sprints, release dates, fixed start and due dates, dependencies, exclusion rules (hide done items, chosen types or releases).
- **Roll-ups**: dates, estimates and progress rolled up from children, including partial roll-ups when only some children are estimated.
- **Warnings**: child scheduled after parent end, dependency conflict, item outside its sprint or release dates, team over capacity, unestimated item in a capacity-planned sprint.
- **Settings**: plan permissions (view, edit), financial year start, estimation units, working days.
- **Jira limits to exceed**: 10,000 items and 200 spaces per plan; 2 active program boards per plan; program board not real-time; individual capacity fixed at a 40-hour week; cross-space releases exist only inside a plan.

## 2. PLN requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| PLN-001 | **Plans.** Tracksmith shall let users create plans from boards, spaces and filters with the hierarchy, views, roll-ups, warnings and settings of section 1, with no item or space cap. | (1) A plan over 300 spaces and 50,000 items opens its timeline in under 3 s. (2) Partial roll-ups show estimated and unestimated portions separately. (3) Each warning type of section 1 is raised by a fixture plan. | M2 | M | Jira Premium; exceeds Jira (10,000 items, 200 spaces) |
| PLN-002 | **Sandbox and selective commit.** Tracksmith shall hold plan edits as drafts until reviewed, show them as a change list with old and new values, and commit or discard all or selected changes. | (1) Edits in a plan do not change live items until committed. (2) Committing 3 of 10 changes applies only those 3, and the other 7 stay pending. (3) A commit fails per item with a reason when the user lacks permission, without blocking the rest. | M2 | M | Jira Premium |
| PLN-003 | **Scenarios.** Tracksmith shall support several what-if scenarios per plan, each with its own draft changes, side-by-side comparison and promotion of one scenario to the baseline. | (1) Two scenarios with different team assignments show different end dates. (2) Promoting a scenario makes its drafts the plan's drafts. | M2 | M | Jira Premium |
| PLN-004 | **Auto-scheduler.** Tracksmith shall schedule items by rank, dependencies, capacity or velocity, sprints and release dates, respecting fixed dates and exclusion rules, and preview the result as draft changes. | (1) With capacity 20 points per sprint, 60 points of ranked work fill three sprints in rank order. (2) A blocked item is never scheduled before its blocker ends. (3) Fixed-date items are not moved. | M2 | M | Jira Premium |
| PLN-005 | **Teams and capacity.** Tracksmith shall plan with site teams (CORE-027), capacity per iteration in points, hours or days, velocity from history, and other teams' sprints as external iterations. | (1) Changing a team's capacity re-runs scheduling previews. (2) Velocity defaults to the average of the last 3 completed sprints. | M2 | M | Jira Premium |
| PLN-006 | **Dependencies.** Tracksmith shall treat chosen link types as dependencies, show them as lines or numbered badges, colour off-track ones red, flag same-iteration dependencies on request, and show dependencies on items outside the plan. | (1) A dependency whose blocker ends after the dependent starts turns red. (2) An outside-plan blocker appears with its space and status. | M2 | M | Jira Premium |
| PLN-007 | **Releases in plans.** Tracksmith shall show space versions as releases and support cross-space releases stored as first-class objects that align several versions to one date and that end on a fixed date or when their work completes. | (1) A cross-space release is visible outside the plan, in queries and on version pages. (2) Moving its date moves the linked versions after commit. | M2 | M | Jira Premium; exceeds Jira (plan-only) |
| PLN-008 | **Program board.** Tracksmith shall provide program boards showing level-1 and level-0 items by team and iteration with dependencies, editable by many users at once in real time, with no limit per plan. | (1) Two users moving cards see each other's moves within 1 s. (2) A plan holds 3 or more active program boards. | M2 | M | Jira Premium; exceeds Jira (2 boards, not real-time) |
| PLN-009 | **Individual capacity.** Tracksmith shall allocate people's time to epic-level or higher items, initiatives and free-text entries (leave, maintenance) in hours, days or percent, with people and work views, bulk copy, paste and fill, CSV import, and a configurable working week. | (1) A 32-hour working week is honoured in percent allocations. (2) Over-allocation above 100% is highlighted. | M2 | M | Jira Premium; exceeds Jira (fixed 40-hour week) |
| PLN-010 | **Hierarchy grid.** Tracksmith shall provide a cross-space grid of any depth built from generators (insert by query, group by field, extend by children or by link type), with inline editing, aggregate columns (sum, min, max, progress, count), formula columns, drag-to-reparent and saved structures. | (1) A structure of 100,000 rows scrolls and edits without errors. (2) Dragging a row under another parent changes the parent field after confirmation. (3) A sum column equals the sum of children's values. | M2 | M | Structure app; JXL app |
| PLN-011 | **Gantt baselines and resource levelling.** Tracksmith shall capture baselines of plan dates and compare them with current dates, show the critical path, and level resources by shifting unconstrained items to remove over-allocation. | (1) A baseline comparison shows slipped items with their delay in days. (2) Levelling never moves fixed-date items. | M4 | S | OpenProject; BigPicture app |

## 3. Reference: time tracking

- **Global settings**: working hours per day and working days per week (decimals allowed), display format, default unit, copying transition comments into the worklog description.
- **Fields**: original estimate, remaining estimate, time spent, work ratio; worklog = author, start date and time, duration, description, visibility (role or group), and attributes (account, billable flag, work category).
- **Remaining estimate on logging**: reduce automatically, leave unchanged, set to a value, or reduce by a given amount.
- **Timesheet states**: open, submitted, approved, rejected, reopened; approved periods are locked.

## 4. TIM requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| TIM-001 | **Estimates and worklogs.** Tracksmith shall provide the fields, settings and remaining-estimate options of section 3, gated by Work on work items and the edit and delete own or all worklog permissions. | (1) Logging 2h with "reduce automatically" lowers a 5h remaining estimate to 3h. (2) "1w 2d" parses according to the working-week settings. (3) Imported Jira worklogs keep author, date and duration. | M1 | M | Jira Free (needed by the M1 importer) |
| TIM-002 | **Timers.** Tracksmith shall offer start and stop timers on items that create worklogs, firing Work started and Work stopped events. | (1) A timer left running over midnight produces one worklog with the correct duration. | M2 | S | YouTrack; Jira Free events |
| TIM-003 | **Timesheets and approvals.** Tracksmith shall provide personal and team timesheets by day, week and month, logging from the grid, and period approval with the states of section 3. | (1) A submitted week can be approved or rejected by the team's approver. (2) Worklogs in an approved period cannot be edited without reopening, which is audited. | M2 | M | Tempo Timesheets app |
| TIM-004 | **Accounts, billing and cost.** Tracksmith shall support accounts linked to customers and spaces, billable and non-billable time, cost rates per person or role and effective date, and budgets in money or hours per space, epic or account with burn tracking. | (1) Cost of an epic equals the sum of worklog hours times the rate in force on each worklog date. (2) Budget burn shows spent, remaining and forecast. | M2 | M | Tempo app; OpenProject |
| TIM-005 | **Time reports and workload.** Tracksmith shall report time by person, space, account, parent and period, estimated versus actual, and show a workload view against each person's capacity. | (1) A report grouped by account and month exports to CSV with totals matching worklogs. (2) A person over capacity shows in red on the workload view. | M2 | M | Tempo app; Asana; ClickUp |

## 5. Reference: Product Discovery

- **Idea**: a work item in a discovery space; idea types and connected hierarchies (for example problem, opportunity, solution).
- **Fields**: rating (1 to 5), slider, number, checkbox, select, multi-select, labels, people, date interval (for roadmap placement), votes, insights count, delivery progress, delivery status.
- **Formulas**: roll-up (for example sum of linked insights' impact), weighted score (percentage weights across chosen fields), custom expression (for example `{Impact} / {Effort}` or RICE).
- **Insight**: snippet, source link, customer or organization, impact value, and optional customer attributes (revenue, tier, size), linked to one or more ideas.
- **Views**: list, board (grouped by a field), matrix (X and Y fields, bubble size; ideas with no value do not plot), timeline or roadmap (date intervals, or Now, Next, Later columns).
- **Delivery progress**: by item count per status category, or by story points.

## 6. DSC requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| DSC-001 | **Discovery spaces and ideas.** Tracksmith shall provide discovery spaces with ideas, idea types and connected idea hierarchies, where anyone with access can comment, vote and add insights at no cost. | (1) An idea of type Solution can be connected under an Opportunity. (2) There is no separate paid creator role. | M4 | M | JPD; exceeds JPD (creator licences) |
| DSC-002 | **Discovery fields and formulas.** Tracksmith shall implement the field and formula types of section 5. | (1) A weighted score with weights 50/30/20 recomputes when an input changes. (2) A RICE expression yields the documented value on fixture ideas. | M4 | M | JPD |
| DSC-003 | **Insights and customer requests.** Tracksmith shall capture insights from a browser extension, chat, service-desk requests and email, link them to ideas with impact and customer attributes, and filter and sort ideas by them. | (1) Creating an insight from a service-desk request links back to the request. (2) Ideas sort by total revenue of linked customers. | M4 | M | JPD; Linear customer requests |
| DSC-004 | **Discovery views.** Tracksmith shall provide the view types of section 5 with per-view filter, sort and group, view-level permissions, and roadmap views spanning several discovery spaces. | (1) Dragging an idea in a matrix changes its X and Y field values. (2) A view restricted to product leads is hidden from others. | M4 | M | JPD Premium (view permissions, cross-space roadmaps) |
| DSC-005 | **Delivery linking.** Tracksmith shall create or link delivery items (epics and their children) in software spaces and show delivery progress and status on ideas, by count or by story points in both configuration modes. | (1) Completing half the linked items' points shows 50% progress. (2) Progress works when delivery is in a space-local space. | M4 | M | JPD; exceeds JPD (points only for company-managed) |
| DSC-006 | **Published views.** Tracksmith shall publish read-only live views to internal and external viewers without an account, choosing visible fields, inviting by email, allowing comments on the view and export. | (1) An external viewer sees only the chosen fields. (2) Revoking the link stops access immediately. | M4 | M | JPD |
| DSC-007 | **Public idea portal with voting.** Tracksmith shall offer a branded public portal where signed-in or email-verified users submit ideas, vote, comment and follow status, with moderation, duplicate merging (votes combined) and notifications to voters on status change. | (1) Merging two ideas keeps all votes once per person. (2) Changing an idea to "Shipped" emails its voters. | M4 | M | Productboard, Aha!; exceeds JPD (no portal) |

## 7. Reference: portfolio (Align-style)

- **Levels**: enterprise, portfolio, solution, program, team; strategic themes and value streams above portfolio epics, capabilities and features (mapped onto custom hierarchy levels).
- **Frameworks**: SAFe (Essential, Large Solution, Portfolio, Full), LeSS, Scrum@Scale, Spotify-style tribes, Disciplined Agile, custom and hybrid (agile and waterfall).
- **WSJF** (SAFe definition): (business value + time criticality + risk reduction or opportunity enablement) / job size.
- **PI objects**: program increment, iterations, team PI objectives with business value, risks with ROAM state (resolved, owned, accepted, mitigated), confidence vote.

## 8. PRT requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| PRT-001 | **Goals and OKRs.** Tracksmith shall provide hierarchical goals with owners, dates, status updates and followers, key results with start, target and current values and confidence, and links to items, spaces and initiatives, rolling up progress. | (1) A key result fed by a query (for example done items count) updates automatically. (2) An item's Goals field shows linked goals. | M4 | M | Jira Free (Goals); Jira Align |
| PRT-002 | **Strategy and portfolio structure.** Tracksmith shall model strategic themes, value streams and the levels of section 7, with a strategy view showing how work maps to themes. | (1) Every portfolio epic shows its theme and value stream. | M4 | M | Jira Align (strategy room) |
| PRT-003 | **Lean budgets and investment vs actuals.** Tracksmith shall allocate budgets to themes, value streams and increments, compute actual spend from worklogs and cost rates (TIM-004), and report planned versus actual investment. | (1) The investment report matches spend computed from worklogs. | M4 | M | Jira Align |
| PRT-004 | **Prioritisation.** Tracksmith shall compute WSJF (section 7), rank portfolio epics, and provide a portfolio Kanban with WIP limits. | (1) Changing job size re-ranks epics by WSJF. | M4 | M | Jira Align; SAFe |
| PRT-005 | **PI planning.** Tracksmith shall plan program increments with team objectives, a real-time program board with dependencies, a ROAM risk board and confidence voting for remote and in-room events. | (1) 100 participants can edit the PI board at once with sub-second updates. (2) Confidence votes are recorded per team. | M4 | M | Jira Align; Targetprocess |
| PRT-006 | **Framework templates.** Tracksmith shall configure levels, terms and boards from templates for each framework in section 7. | (1) Applying the SAFe Portfolio template creates the levels, fields and boards it defines. | M4 | M | Jira Align |
| PRT-007 | **Portfolio reporting and forecasting.** Tracksmith shall report progress, spend and labour cost together, forecast delivery from velocity and capacity, propagate dependency slips, and compare quarterly delivery and financial trends. | (1) A slip in a capability's dependency moves its forecast end date. | M4 | M | Jira Align |

## 9. Reference: test management

- **Entities**: test (manual steps with action, data, expected result; Gherkin scenario; exploratory charter; generic automated), precondition, test set, test plan, test execution, test run, step result, defect link.
- **Statuses**: to do, executing, passed, failed, blocked, aborted (configurable).
- **CI formats**: JUnit XML, Cucumber JSON, TestNG, NUnit, xUnit, Robot Framework (Xray parity verify).

## 10. QA requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| QA-001 | **Test repository.** Tracksmith shall store the test entities of section 9 as work types with versioning, folders, reusable steps, preconditions and parameterised data sets. | (1) Editing a test creates a new version; executions keep the version they ran. (2) A data set with 5 rows expands into 5 iterations at run time. | M4 | M | Xray, Zephyr apps |
| QA-002 | **Plans, executions and runner.** Tracksmith shall group tests into plans and executions per version and environment, assign testers, and run tests step by step with timer, evidence attachments and one-click defect creation prefilled with the failing step. | (1) A failed step creates a defect linked to the run and the requirement. (2) Execution progress updates live for all viewers. | M4 | M | Xray, Zephyr apps |
| QA-003 | **Coverage and traceability.** Tracksmith shall show requirement-to-test-to-run-to-defect traceability and coverage status per requirement, version and environment, with query functions for coverage. | (1) A requirement with one failing test shows "not covered: failed" for that version. (2) A query returns requirements without tests. | M4 | M | Xray app |
| QA-004 | **CI result import.** Tracksmith shall import the formats of section 9 through API and CLI, create missing automated tests, and link runs to builds and deployments. | (1) Importing a JUnit file with 500 cases creates or updates 500 runs in one execution. | M4 | M | Xray app; Azure Test Plans |
| QA-005 | **Test reports.** Tracksmith shall report execution progress, pass-rate trends, flaky tests and coverage, as reports and dashboard gadgets. | (1) A test that alternates pass and fail across 10 runs is flagged flaky. | M4 | M | Xray, Zephyr apps |
