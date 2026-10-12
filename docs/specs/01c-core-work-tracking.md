---
spec: 01c
title: "Core work tracking: reports, dashboards, notifications and collaboration"
sources: docs/research/sources.md
accessed: 2026-10-11
attestation: own-words
---
# 01c Core work tracking: reports, dashboards, notifications and collaboration

This file specifies how people using Tracksmith (a working name for the product) see and are told about work: agile and general reports, dashboards and gadgets, space insight dashboards, the analytics store for BI tools, notification policies and channels, the inbox, rich text, real-time collaboration and chat integrations. Jira users complain most about notification floods and clunky reporting, so this file sets explicit behaviour for batching, digests and exports, and keeps every Jira report and gadget so imported dashboards keep working.

## How to read

- **ID**: `MODULE-NNN`, stable and never reused. This file holds RPT and NTF.
- **MS**: M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must, S = Should, C = Could.
- **Source**: parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit; "verify" marks a fact the research flagged as unconfirmed.
- **Terms**: work item = issue, space = project, work type = issue type.

## 1. Reference: reports and gadgets

### 1.1 Report catalog

| Group | Reports | Data each needs |
|---|---|---|
| Scrum board | Burndown, Burnup, Sprint report, Velocity, Epic report, Epic burndown, Release burndown, Version report | Sprint scope events, estimate snapshots, version and parent membership history |
| Any board | Cumulative flow diagram; Control chart (cycle time scatter with rolling average, configurable averaging method); Cycle time report | Status change history mapped to columns |
| General | Average age, Created vs resolved, Pie chart, Recently created, Resolution time, Single level group by, Time since, Time tracking, User workload, Version workload, Workload pie chart | Current values plus created and resolved dates |
| Development | Deployment frequency (file 02b, DEV) | Deployment events |
| Wiki-based | Change log, Status report (generated as knowledge pages) | Versions, filters |
| AI | Agents dashboard: agent sessions, outcomes, cost (file 02c) | Agent session log |

Classic reports run against a board; space insights (below) run against a whole space; dashboards run against any filter. Space-local and shared spaces get the same reports (Jira gives space-local software spaces only Burnup and Velocity).

### 1.2 Dashboard gadgets

Activity stream; Assigned to me; Average age; Average time in status; Average number of times in status; Bubble chart; Calendar; Created vs resolved; Days remaining in sprint; Filter results; Introduction; Labels; Pie chart; Quick links; Recently created; Resolution time; Road map (versions due); Service space report (file 04a); Spaces; Sprint burndown; Sprint health; Time since; Time to first response (file 04a); Two-dimensional filter statistics; Voted work items; Wallboard spacer; Watched work items; Work item statistics; Work items in progress.

### 1.3 Space insight widgets

Chart (at least bar, stacked bar, line, area, pie, donut and number tile, with grouping and filtering; Jira advertises "7+ chart types" without naming them, verify), List (query results), Link (rich link preview), Activity stream. Templates: Team overview, Agents.

### 1.4 Summary "work pulse"

Four stages computed per space: Intake (created in the last 7 days), Triage (not started), Execute (in progress), Delivery (done in the last 7 days). Each stage shows a state of Empty, Dormant, Off track or On track plus attention badges, filterable by date range, assignee, work type, status, parent and priority.

## 2. RPT requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| RPT-001 | **Agile reports.** Tracksmith shall provide every board report in section 1.1, with sprint, version and epic selectors and scope-change markers. | (1) A burndown of a fixture sprint matches hand-computed values at each day, including scope added mid-sprint. (2) Velocity shows committed and completed per sprint and can be split per team. (3) The control chart supports at least two rolling-average methods and excludes chosen columns. | M1 | M | Jira Free |
| RPT-002 | **General reports.** Tracksmith shall provide every general report in section 1.1 for any filter or space. | (1) Created vs resolved over a 90-day window matches counts from history. (2) Time tracking report totals equal the sum of worklogs. (3) Each report renders on 1M items in under 3 s. | M1 | M | Jira Free |
| RPT-003 | **Report data foundation.** Tracksmith shall keep append-only status, field, sprint-scope, estimate and membership history so any report can be computed as of any past date. | (1) A report for a past date returns the same numbers before and after later edits. (2) History needed by reports is imported from Jira backups so imported sprints chart correctly. | M1 | M | Jira Free |
| RPT-004 | **Dashboards.** Tracksmith shall provide personal and shared dashboards with configurable layouts, an admin-set default dashboard, wallboard mode, sharing to users, groups, roles, signed-in users or the public, and signed embed links for external pages. | (1) A gadget shows only items the viewer may browse, even on a shared dashboard. (2) Wallboard mode rotates dashboards full screen. (3) Jira dashboards import with gadgets and layouts (Atlassian's migration tool drops them). | M1 | M | Jira Free; exceeds Jira (import) |
| RPT-005 | **Gadget catalog.** Tracksmith shall implement every gadget in section 1.2 with its configuration options. | (1) Each gadget has a rendering test against a fixture dataset. (2) Two-dimensional filter statistics accepts any two fields as axes. | M1 | M | Jira Free |
| RPT-006 | **Space insight dashboards.** Tracksmith shall provide per-space widget dashboards (section 1.3) that space admins edit and members view and filter, with no limit on dashboards per space. | (1) A space can hold 6 or more insight dashboards. (2) A chart widget grouped by assignee and filtered by type renders from live data. | M1 | M | Jira Free; exceeds Jira (5 per space) |
| RPT-007 | **Summary work pulse.** Tracksmith shall show the work pulse of section 1.4 on each space's Summary tab. | (1) Stage counts match the defining queries. (2) A stage with no activity for 14 days shows Dormant. | M2 | S | Jira Free |
| RPT-008 | **Analytics store and BI access.** Tracksmith shall keep daily snapshots and full revisions of items and board state in an append-only analytics store, exposed through OData and a read-only SQL endpoint for BI tools. | (1) Power BI and Excel load the OData feed with work items, daily snapshots and revisions. (2) Custom fields appear as typed columns. (3) BI access respects browse permissions of the connecting account. | M2 | M | Azure DevOps Analytics; Power BI Connector app; exceeds Jira |
| RPT-009 | **Report export and scheduling.** Tracksmith shall export each report and gadget as PNG, PDF and CSV and email a dashboard on a schedule. | (1) CSV export of a report equals its displayed data. (2) A weekly dashboard email arrives with rendered gadgets. | M1 | S | Better Excel Exporter app |
| RPT-010 | **Wiki-based reports.** Tracksmith shall generate change-log and status-report pages from versions and filters into the knowledge base. | (1) A change log for version 2.1 lists its resolved items grouped by type. | M2 | C | Jira Free (Confluence reports) |
| RPT-011 | **OLAP reporting.** Tracksmith shall provide multidimensional analysis over the analytics store: dimensions (time, space, type, status, assignee, any custom field), measures (counts, sums, averages, time in status, cycle and lead time), calculated measures, pivot tables and charts saved as reports. | (1) A pivot of resolved items by month and team with average cycle time matches SQL computed on the store. (2) Calculated measures use a documented formula syntax. | M4 | M | eazyBI app |

## 3. Reference: notification events, recipients and channels

- **Events** (notification policy rows): Work item created, updated, assigned, resolved, closed, commented, reopened, deleted, moved; Worklog added, updated, deleted; Work started, Work stopped; Generic event; any number of custom events fired by transitions. Product events outside policies: Mentioned, Approval requested and decided (M2), SLA near breach (file 04a), Alert routed (file 04b), Subscription delivered.
- **Recipient types**: Current assignee, Reporter, Component lead, Single user, Group, Space role (cited); Watchers, Space lead, Current user, User field value, Group field value (verify; Jira's full list was only partly captured).
- **Channels**: email, in-app inbox, mobile push, chat (Slack, Microsoft Teams), outbound webhook, and push relays such as ntfy and Gotify.

## 4. NTF requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| NTF-001 | **Notification policies.** Tracksmith shall map events to recipient types (section 3) through policies that are shared or space-local, shipping a default policy. | (1) Adding Watchers to "Work item commented" notifies watchers on the next comment. (2) A custom event fired by a transition reaches its configured recipients. (3) Recipients never receive content for items or restricted comments they cannot see. | M1 | M | Jira Free |
| NTF-002 | **Email notifications.** Tracksmith shall send HTML and plain-text email per recipient locale, batch changes to one item within a configurable window into one email, include unsubscribe links, and impose no daily send cap. | (1) Five edits by one user within 2 minutes produce one email listing all five. (2) 10,000 emails in a day are delivered with no cap (Jira Free stops at 100). (3) Each email links to the item and to notification settings. | M1 | M | Jira Free; exceeds Jira |
| NTF-003 | **In-app inbox.** Tracksmith shall provide a real-time inbox with read and unread state, snooze, filters by type and space, and a priority tab that separates direct asks (mentions, assignments, approvals) from general updates. | (1) A mention appears in the inbox within 2 s. (2) Marking read in the inbox also marks the matching email digest entry read. (3) Priority tab contains only direct asks. | M1 | M | Linear (priority inbox); Jira complaints about floods |
| NTF-004 | **Personal preferences and digests.** Tracksmith shall let each user choose per event and channel, receive daily or weekly digests instead of instant email, and set quiet hours. | (1) A user on daily digest gets one email per day summarising all events. (2) During quiet hours only push for urgent alerts (file 04b) is delivered. | M1 | M | exceeds Jira |
| NTF-005 | **Mentions.** Tracksmith shall support mentions of users and teams in descriptions and comments, notifying mentioned people who can view the item and warning the author when a mentioned person cannot. | (1) Mentioning a user without browse access shows a warning and sends nothing. (2) Naming a person in a People field does not notify them. | M1 | M | Jira Free |
| NTF-006 | **Rich text editor.** Tracksmith shall provide a rich text editor with headings, bold, italic, strike, code and code blocks with syntax highlighting, links, bullet, numbered and check lists, tables, panels, quotes, mentions, emoji, dates, status lozenges, inline images and attachments, Markdown shortcuts and paste from Markdown or HTML. | (1) Typing `## ` creates a heading and `[] ` a checklist item. (2) Pasting a Markdown table produces a table. (3) The editor works with keyboard only. | M1 | M | Jira Free |
| NTF-007 | **Rich text storage and conversion.** Tracksmith shall store rich text in one canonical document format and convert losslessly to and from Markdown, HTML, Atlassian Document Format (ADF) and Jira wiki markup, keeping the original of imported ADF or wiki content beside the converted copy. | (1) A corpus of 1,000 imported ADF documents converts and back again with no lost text, mentions or links. (2) ADF nodes without an equivalent (for example custom panels) are preserved and rendered read-only. (3) The REST shim returns ADF on v3 and wiki markup on v2 from the same stored document. | M1 | M | Jira Free; exceeds Jira (no Markdown option) |
| NTF-008 | **Real-time collaboration.** Tracksmith shall push changes to open item views, boards, lists and backlogs, show who else is viewing, and support simultaneous editing of descriptions with merge at character level. | (1) A change by user A appears on user B's board within 1 s (p95). (2) Two users typing in one description at once both keep their text. (3) Concurrent edits of the same field resolve last-write-wins with the overwritten value kept in history. | M1 | M | Linear; Plane |
| NTF-009 | **Share and reply by email.** Tracksmith shall let users share an item by email or link with a message, and add email replies to notifications as comments. | (1) A reply to a notification email becomes a comment by the replying user, with quoted history stripped. (2) Sharing needs the Send work items in email permission. | M1 | S | Jira Free |
| NTF-010 | **Chat integrations.** Tracksmith shall integrate with Slack and Microsoft Teams: channel notifications from rules or policies, create and update items from messages, link previews, and thread-to-comment sync. | (1) A Slack message action creates an item linked to the thread. (2) Replies in the linked thread appear as comments within 10 s and vice versa. | M2 | M | Jira Free (Slack, Teams apps) |
| NTF-011 | **Rich links and wiki pages.** Tracksmith shall render pasted URLs as rich previews, link items to knowledge pages (file 04a, KB) and external wiki pages, and show linked pages on the item. | (1) A pasted link to another item renders its key, summary and status. (2) A linked wiki page shows its title and last update. | M2 | S | Jira Free (Smart Links, Confluence links) |
| NTF-012 | **Whiteboards.** Tracksmith shall provide whiteboards with shapes, sticky notes and connectors, where sticky notes convert to work items and items embed as live cards. | (1) Converting a sticky note creates an item and keeps it on the board as a live card. | M4 | S | YouTrack; ClickUp |
