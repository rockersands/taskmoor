---
spec: 01c
title: "Core work tracking: reports, dashboards, notifications and collaboration"
sources: docs/research/sources.md
accessed: 2026-10-11
attestation: own-words
---
# 01c Core work tracking: reports, dashboards, notifications and collaboration

This file specifies how people using Taskmoor see and are told about work: agile and general reports, dashboards and widgets, track insight dashboards, the analytics store for BI tools, notification policies and channels, the inbox, rich text, real-time collaboration and chat integrations. Jira users complain most about notification floods and clunky reporting, so this file sets explicit behaviour for batching, digests and exports, and keeps every Jira report and gadget so imported dashboards keep working.

## How to read

- **ID**: `MODULE-NNN`, stable and never reused. This file holds RPT and NTF.
- **MS**: M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must, S = Should, C = Could.
- **Source**: parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit; "verify" marks a fact the research flagged as unconfirmed.
- **Terms**: Taskmoor uses its own names, defined in `docs/specs/00-terminology.md`. The main ones: ticket = Jira issue, track = Jira project, ticket type = Jira issue type. Jira's names stay valid in the Jira-compatible API and query dialect.

## 1. Reference: reports and widgets

### 1.1 Report catalog

| Group | Reports | Data each needs |
|---|---|---|
| Scrum board | Burndown, Burnup, Sprint report, Velocity, Outcome report, Outcome burndown, Release burndown, Release report | Sprint scope events, estimate snapshots, release and parent membership history |
| Any board | Cumulative flow diagram; Control chart (cycle time scatter with rolling average, configurable averaging method); Cycle time report | Status change history mapped to columns |
| General | Average age, Created vs closed, Pie chart, Recently created, Time to close, Single level group by, Time since, Time tracking, User workload, Release workload, Workload pie chart | Current values plus created and closed dates |
| Development | Deployment frequency (file 02b, DEV) | Deployment events |
| Wiki-based | Change log, Status report (generated as knowledge pages) | Releases, saved searches |
| AI | Agents dashboard: agent sessions, outcomes, cost (file 02c) | Agent session log |

Classic reports run against a board; track insights (below) run against a whole track; dashboards run against any saved search. Local-mode and shared-mode tracks get the same reports (Jira gives team-managed software projects only Burnup and Velocity).

### 1.2 Dashboard widgets

Activity stream; Assigned to me; Average age; Average time in status; Average number of times in status; Bubble chart; Calendar; Created vs closed; Days remaining in sprint; Saved search results; Introduction; Labels; Pie chart; Quick links; Recently created; Time to close; Road map (releases due); Service track report (file 04a); Tracks; Sprint burndown; Sprint health; Time since; Time to first response (file 04a); Two-dimensional search statistics; Voted tickets; Wallboard spacer; Followed tickets; Ticket statistics; Tickets in progress.

### 1.3 Track insight widgets

Chart (at least bar, stacked bar, line, area, pie, donut and number tile, with grouping and filtering; Jira advertises "7+ chart types" without naming them, verify), List (query results), Link (rich link preview), Activity stream. Templates: Team overview, Agents.

### 1.4 Summary "work pulse"

Four phases computed per track: Intake (created in the last 7 days), Triage (not started), Execute (in progress), Delivery (done in the last 7 days). Each phase shows a state of Empty, Dormant, Off track or On track plus attention badges, filterable by date range, assignee, ticket type, status, parent and priority.

## 2. RPT requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| RPT-001 | **Agile reports.** Taskmoor shall provide every board report in section 1.1, with sprint, release and outcome selectors and scope-change markers. | (1) A burndown of a fixture sprint matches hand-computed values at each day, including scope added mid-sprint. (2) Velocity shows committed and completed per sprint and can be split per team. (3) The control chart supports at least two rolling-average methods and excludes chosen columns. | M1 | M | Jira Free |
| RPT-002 | **General reports.** Taskmoor shall provide every general report in section 1.1 for any saved search or track. | (1) Created vs closed over a 90-day window matches counts from history. (2) Time tracking report totals equal the sum of time entries. (3) Each report renders on 1M tickets in under 3 s. | M1 | M | Jira Free |
| RPT-003 | **Report data foundation.** Taskmoor shall keep append-only status, field, sprint-scope, estimate and membership history so any report can be computed as of any past date. | (1) A report for a past date returns the same numbers before and after later edits. (2) History needed by reports is imported from Jira backups so imported sprints chart correctly. | M1 | M | Jira Free |
| RPT-004 | **Dashboards.** Taskmoor shall provide personal and shared dashboards with configurable layouts, an admin-set default dashboard, wallboard mode, sharing to users, groups, roles, signed-in users or the public, and signed embed links for external pages. | (1) A widget shows only tickets the viewer may browse, even on a shared dashboard. (2) Wallboard mode rotates dashboards full screen. (3) Jira dashboards import with gadgets and layouts (Atlassian's migration tool drops them). | M1 | M | Jira Free; exceeds Jira (import) |
| RPT-005 | **Widget catalog.** Taskmoor shall implement every widget in section 1.2 with its configuration options. | (1) Each widget has a rendering test against a fixture dataset. (2) Two-dimensional search statistics accepts any two fields as axes. | M1 | M | Jira Free |
| RPT-006 | **Track Summary.** Taskmoor shall give each track one customizable Summary of widgets (section 1.3) that track admins edit and members view and filter; personal and shared Dashboards remain the place for more. | (1) A track has one customized Summary at most. (2) A chart widget grouped by assignee and filtered by type renders from live data. | M1 | M | Jira Free |
| RPT-007 | **Summary work pulse.** Taskmoor shall show the work pulse of section 1.4 on each track's Summary tab. | (1) Phase counts match the defining queries. (2) A phase with no activity for 14 days shows Dormant. | M2 | S | Jira Free |
| RPT-008 | **Analytics store and BI access.** Taskmoor shall keep daily snapshots and full revisions of tickets and board state in an append-only analytics store, exposed through OData and a read-only SQL endpoint for BI tools. | (1) Power BI and Excel load the OData feed with tickets, daily snapshots and revisions. (2) Custom fields appear as typed columns. (3) BI access respects browse permissions of the connecting account. | M2 | M | Azure DevOps Analytics; Power BI Connector app; exceeds Jira |
| RPT-009 | **Report export and scheduling.** Taskmoor shall export each report and widget as PNG, PDF and CSV and email a dashboard on a schedule. | (1) CSV export of a report equals its displayed data. (2) A weekly dashboard email arrives with rendered widgets. | M2 | S | Better Excel Exporter app |
| RPT-010 | **Wiki-based reports.** Taskmoor shall generate change-log and status-report pages from releases and saved searches into the knowledge base. | (1) A change log for release 2.1 lists its closed tickets grouped by type. | M2 | C | Jira Free (Confluence reports) |
| RPT-011 | **OLAP reporting.** Taskmoor shall provide multidimensional analysis over the analytics store: dimensions (time, track, type, status, assignee, any custom field), measures (counts, sums, averages, time in status, cycle and lead time), calculated measures, pivot tables and charts saved as reports. | (1) A pivot of closed tickets by month and team with average cycle time matches SQL computed on the store. (2) Calculated measures use a documented formula syntax. | M4 | M | eazyBI app |

## 3. Reference: notification events, recipients and channels

- **Events** (notification policy rows): Ticket created, updated, assigned, close reason set, closed, commented, reopened, deleted, moved; Time entry added, updated, deleted; Work started, Work stopped; Generic event; any number of custom events fired by transitions. Product events outside policies: Mentioned, Approval requested and decided (M2), SLA near breach (file 04a), Alert routed (file 04b), Subscription delivered.
- **Recipient types**: Current assignee, Requester, Area owner, Single user, Group, Track role (cited); Followers, Track owner, Current user, User field value, Group field value (verify; Jira's full list was only partly captured).
- **Channels**: email, in-app inbox, mobile push, chat (Slack, Microsoft Teams), outbound webhook, and push relays such as ntfy and Gotify.

## 4. NTF requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| NTF-001 | **Notification policies.** Taskmoor shall map events to recipient types (section 3) through policies that are shared or local to a track, shipping a default policy. | (1) Adding Followers to "Ticket commented" notifies followers on the next comment. (2) A custom event fired by a transition reaches its configured recipients. (3) Recipients never receive content for tickets or restricted comments they cannot see. | M1 | M | Jira Free |
| NTF-002 | **Email notifications.** Taskmoor shall send HTML and plain-text email per recipient locale, batch changes to one ticket within a configurable window into one email, include unsubscribe links, and impose no daily send cap. | (1) Five edits by one user within 2 minutes produce one email listing all five. (2) 10,000 emails in a day are delivered with no cap (Jira Free stops at 100). (3) Each email links to the ticket and to notification settings. | M1 | M | Jira Free; exceeds Jira |
| NTF-003 | **In-app inbox.** Taskmoor shall provide a real-time inbox with read and unread state, snooze, filters by type and track, and a priority tab that separates direct asks (mentions, assignments, approvals) from general updates. | (1) A mention appears in the inbox within 2 s. (2) Marking read in the inbox also marks the matching email digest entry read. (3) Priority tab contains only direct asks. | M1 | M | Linear (priority inbox); Jira complaints about floods |
| NTF-004 | **Personal preferences and digests.** Taskmoor shall let each user choose per event and channel, receive daily or weekly digests instead of instant email, and set quiet hours. | (1) A user on daily digest gets one email per day summarising all events. (2) During quiet hours only push for urgent alerts (file 04b) is delivered. | M1 | M | exceeds Jira |
| NTF-005 | **Mentions.** Taskmoor shall support mentions of users and teams in descriptions and comments, notifying mentioned people who can view the ticket and warning the author when a mentioned person cannot. | (1) Mentioning a user without browse access shows a warning and sends nothing. (2) Naming a person in a People field does not notify them. | M1 | M | Jira Free |
| NTF-006 | **Rich text editor.** Taskmoor shall provide a rich text editor with headings, bold, italic, strike, code and code blocks with syntax highlighting, links, bullet, numbered and check lists, tables, panels, quotes, mentions, emoji, dates, status lozenges, inline images and attachments, Markdown shortcuts and paste from Markdown or HTML. | (1) Typing `## ` creates a heading and `[] ` a checklist item. (2) Pasting a Markdown table produces a table. (3) The editor works with keyboard only. | M1 | M | Jira Free |
| NTF-007 | **Rich text storage and conversion.** Taskmoor shall store rich text in one canonical document format and convert losslessly to and from Markdown, HTML, Atlassian Document Format (ADF) and Jira wiki markup, keeping the original of imported ADF or wiki content beside the converted copy. | (1) A corpus of 1,000 imported ADF documents converts and back again with no lost text, mentions or links. (2) ADF nodes without an equivalent (for example custom panels) are preserved and rendered read-only. (3) The REST shim returns ADF on v3 and wiki markup on v2 from the same stored document. | M1 | M | Jira Free; exceeds Jira (no Markdown option) |
| NTF-008 | **Real-time collaboration.** Taskmoor shall push changes to open ticket views, boards, lists and backlogs, show who else is viewing, and support simultaneous editing of descriptions with merge at character level. | (1) A change by user A appears on user B's board within 1 s (p95). (2) Two users typing in one description at once both keep their text. (3) Concurrent edits of the same field resolve last-write-wins with the overwritten value kept in history. | M1 | M | Linear; Plane |
| NTF-009 | **Share and reply by email.** Taskmoor shall let users share a ticket by email or link with a message, and add email replies to notifications as comments. | (1) A reply to a notification email becomes a comment by the replying user, with quoted history stripped. (2) Sharing needs the Send tickets in email permission. | M2 | S | Jira Free |
| NTF-010 | **Chat integrations.** Taskmoor shall integrate with Slack and Microsoft Teams: channel notifications from rules or policies, create and update tickets from messages, link previews, and thread-to-comment sync. | (1) A Slack message action creates a ticket linked to the thread. (2) Replies in the linked thread appear as comments within 10 s and vice versa. | M2 | M | Jira Free (Slack, Teams apps) |
| NTF-011 | **Rich links and wiki pages.** Taskmoor shall render pasted URLs as rich previews, link tickets to knowledge pages (file 04a, KB) and external wiki pages, and show linked pages on the ticket. | (1) A pasted link to another ticket renders its key, summary and status. (2) A linked wiki page shows its title and last update. | M2 | S | Jira Free (Smart Links, Confluence links) |
| NTF-012 | **Whiteboards.** Taskmoor shall provide whiteboards with shapes, sticky notes and connectors, where sticky notes convert to tickets and tickets embed as live cards. | (1) Converting a sticky note creates a ticket and keeps it on the board as a live card. | M4 | S | YouTrack; ClickUp |
