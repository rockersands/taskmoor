---
spec: 04a
title: "Service management and operations: service desk, knowledge base and ITSM"
sources: docs/research/sources.md
accessed: 2026-10-11
attestation: own-words
---
# 04a Service management and operations: service desk, knowledge base and ITSM

This file specifies the Jira Service Management equivalent in Taskmoor: service spaces with request types, branded help centres and portals, free and unlimited customers and organizations, queues, the SLA engine with calendars, email and chat channels, approvals, forms, satisfaction surveys, the knowledge base, and the ITIL practices Atlassian gates behind JSM Premium (incident, major incident, post-incident review, problem and change management with risk scoring and CI/CD gating). Agents are not licensed or counted. File 04b continues with on-call and alerting, status pages, the CMDB and mobile apps.

## How to read

- **ID**: `MODULE-NNN`, stable and never reused. This file holds SD, KB and ITSM.
- **MS**: M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must, S = Should, C = Could.
- **Source**: parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit; "verify" marks a fact the research flagged as unconfirmed.
- **Terms**: work item = issue; request = a work item raised through a request type; agent = a staff member working requests; customer = a requester, usually portal-only.

## 1. Reference: service desk model

### 1.1 Structure

- **Service space**: a space type (file 01a) whose items are organised in work categories: service requests, incidents, problems, changes and post-incident reviews. Each category ships default work types, workflows, request types and queues.
- **Templates**: IT service management, general service, HR, facilities, legal (verify the current Jira template list), plus customer service (M4).
- **Request type**: name, icon, request-type group, description, underlying work type, customer-visible fields (with their own labels and help text), customer-facing status names, attached forms, and who may raise it (all customers, chosen organizations or groups).
- **People**: agents (staff with the Service space agent permission), collaborators (staff who comment internally), customers (portal-only or full accounts), organizations (groups of customers reused across service spaces; email-domain rules add new customers automatically), request participants (customers copied on a request).
- **Help centre**: name, home title, logo, banner, colours for banner, links, buttons and navigation, announcements, login-page message, custom domain and URL slug; several help centres per site, each with its own branding and set of service spaces.

### 1.2 SLA engine semantics

1. An SLA metric has start, pause and stop conditions. Conditions are events (for example item created, entered status X, comment for customers, resolution set) or states (for example status in a list, field value).
2. Time counts only between start and stop and not while any pause condition holds.
3. After a stop, a later start condition opens a new cycle; every cycle is kept for reporting.
4. Goals are an ordered list. Each goal has a query scope, a target duration and a calendar. The first goal whose scope matches applies; a final catch-all goal is allowed.
5. If a field change makes another goal match (for example priority changes), the running cycle is re-evaluated against the new goal's target.
6. Editing an SLA recalculates running cycles; completed cycles keep their results.
7. A calendar has a time zone, working hours per weekday and holidays (one-off and recurring).
8. Each cycle shows state (running, paused, met, breached), elapsed and remaining time, and fires threshold events (for example 30 minutes before breach) for automation and notifications.
9. Query functions: `breached()`, `everBreached()`, `completed()`, `running()`, `paused()`, `remaining()`, `withinCalendarHours()` (file 01b).

### 1.3 Channels

Portal and help centre; email (several mailboxes per space, each tied to a request type; policy for creating customer accounts from To and Cc addresses); embeddable widget; Slack and Microsoft Teams intake; REST API (shim and native). The request channel type is stored on every request and is queryable.

### 1.4 Forms

Sections and elements (text, paragraph, number, date, choice, multi-choice, user, attachment, table), conditional sections and fields, validation rules, elements linked to item fields, attach to request types, share as a link, or add mid-resolution; several forms per request; form states (open, submitted, locked, reopened); export of form answers.

### 1.5 ITSM practices

- **Incident**: severity, priority, affected services, responders, linked alerts, timeline, status for stakeholders; created manually, from alerts, by API or from templates.
- **Major incident**: a flag that adds response roles (commander, communications lead, scribe and custom roles), a conference bridge, a chat channel, stakeholder updates and the post-incident review.
- **Post-incident review**: template with summary, impact, timeline, contributing factors and action items linked as work items.
- **Problem**: linked incidents, root cause, workaround, known-error state (resolution Known error), and linked changes.
- **Change**: types standard (pre-approved), normal and emergency; risk score from factors (change type, affected services and their tier, recent incidents on those services, deployment size, time of day, author history); low risk auto-approved; high risk routed to more approvers (CAB with any, majority or all quorum); change calendar with maintenance and freeze windows; conflict detection on the same service or CI.
- **Deployment gating**: a pipeline step creates or updates a change record, waits for approval, may soak until a maintenance window, and is held when an incident is open on an affected service.

## 2. SD requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| SD-001 | **Service spaces and work categories.** Taskmoor shall provide service spaces with the work categories and templates of section 1.1, each with default types, workflows, request types and queues. | (1) Creating an IT service management space yields working request types and queues for all five categories. (2) Categories can be renamed and hidden per space. | M2 | M | JSM; exceeds JSM Premium (change and problem gated) |
| SD-002 | **Request types.** Taskmoor shall implement request types with every attribute of section 1.1. | (1) A customer sees only the request type's visible fields with their customer labels. (2) Customer-facing status names differ from agent status names. (3) A request type restricted to organization X is hidden from others. | M2 | M | JSM |
| SD-003 | **Help centres and branding.** Taskmoor shall support any number of help centres with the branding, announcements, login message, custom domains (with automatic TLS) and slugs of section 1.1, free of charge. | (1) Two help centres on two custom domains show different branding and service spaces. (2) An announcement shows on the home page until its end date. | M2 | M | JSM Premium (multiple help centres); exceeds Jira |
| SD-004 | **Customer portal.** Taskmoor shall let customers browse request types by group, search the knowledge base with suggested articles while typing, raise requests, see and comment on their requests and their organization's shared requests, add participants, and approve requests assigned to them. | (1) Typing a request summary shows matching articles; a "this solved it" click is counted as a deflection. (2) A customer cannot see another organization's requests. (3) The portal is localised to the customer's language. | M2 | M | JSM |
| SD-005 | **Customers and organizations.** Taskmoor shall support unlimited free customers and organizations reusable across service spaces, email-domain auto-membership for new customers, central management and customer profile fields. | (1) 100,000 customers incur no licence or count limit. (2) A new customer with an @acme.com address joins organization Acme automatically. | M2 | M | JSM; exceeds Jira (per-agent pricing) |
| SD-006 | **Agent workspace.** Taskmoor shall distinguish internal notes from replies to customers, provide canned responses with variables, show when another agent is viewing or typing, and never count agents as licences. | (1) An internal note is never emailed or shown to customers. (2) A canned response fills the customer's name. (3) Imported Jira canned responses are kept (Atlassian's migration tool drops them). | M2 | M | JSM |
| SD-007 | **Queues.** Taskmoor shall provide query-based queues with chosen columns, sort and live counts, grouped by category, with assign and transition from the queue and no cap on queues. | (1) A new matching request appears in the queue within 2 s without refresh. (2) A space holds more than 300 queues in one category. | M2 | M | JSM; exceeds Jira (300 per category) |
| SD-008 | **SLA engine and calendars.** Taskmoor shall implement the semantics of section 1.2. | (1) Fixture timelines covering pause, multiple cycles, goal change on priority change and holidays produce expected elapsed times to the minute. (2) Editing an SLA recalculates running cycles only. (3) A threshold event fires 30 minutes before breach. | M2 | M | JSM |
| SD-009 | **Service metrics.** Taskmoor shall provide the SLA query functions and service reports and gadgets: SLA success rate, time to first response, time to resolution, created vs resolved, satisfaction, workload and request channel. | (1) `"Time to resolution" = breached()` returns breached requests. (2) The SLA success report matches cycle data. | M2 | M | JSM |
| SD-010 | **Email channel.** Taskmoor shall receive email through IMAP, POP3, Microsoft 365 and Gmail (OAuth), create requests per mailbox and request type, thread replies into comments, keep attachments, convert HTML to rich text, apply the customer-creation policy for To and Cc, and detect loops and auto-replies. | (1) A reply to a request notification becomes a comment on that request. (2) An out-of-office auto-reply creates no comment. (3) A mail loop between two systems stops after 3 messages. | M2 | M | JSM |
| SD-011 | **Widget, chat and API channels.** Taskmoor shall offer an embeddable request widget, Slack and Microsoft Teams intake with thread sync, and API intake, recording the channel on each request. | (1) A request raised in Slack syncs agent replies back to the thread. (2) `requestChannelType` queries return requests by channel. | M2 | M | JSM |
| SD-012 | **Request approvals.** Taskmoor shall use the approval engine (WF-013) for requests, with customers and organization members as approvers through portal and email, and the approval query functions. | (1) A customer approver approves from the portal. (2) `approval = pendingBy(currentUser())`-style queries list pending approvals (exact syntax verify). | M2 | M | JSM |
| SD-013 | **Forms engine.** Taskmoor shall implement the forms of section 1.4, shared with work intake forms (CORE-028) and the forms validators (WF-004). | (1) A section shows only when a previous answer is "Yes". (2) A form element linked to a field updates the field on submit. (3) Imported ProForma or Jira Forms keep their layout and answers. | M2 | M | Jira Forms (ProForma) |
| SD-014 | **Satisfaction surveys.** Taskmoor shall email a 1 to 5 rating with comment on resolution (on by default), support link-based surveys sent by automation, and report results by agent, team and request type. | (1) A rating submitted from the email is stored on the request and shown in reports. | M2 | M | JSM |
| SD-015 | **Customer service management.** Taskmoor shall provide an omnichannel conversation thread (web chat, email, voice transcripts, messaging), customer and account profiles with CRM attributes and entitlements, branded portals per customer type, and escalation to development backlogs. | (1) A chat conversation, a later email and a call transcript appear in one thread. (2) Escalating creates a linked item in a software space. | M4 | M | JSM customer service (CSM) |

## 3. KB requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| KB-001 | **Knowledge base basics.** Taskmoor shall provide articles with rich text, categories, internal or public visibility, linking to service spaces, portal search with deflection, article suggestions for agents, and creating an article from a request. | (1) A public article appears in portal search; an internal one does not. (2) An agent can insert an article link into a reply in two clicks. | M2 | M | JSM knowledge base |
| KB-002 | **Full knowledge base.** Taskmoor shall add article versions and approval workflow, templates (including runbooks and post-incident reviews), inline comments with resolvable discussions, helpfulness feedback, analytics (views, deflections, searches with no result), several knowledge bases per help centre and translated articles. | (1) Publishing a draft requires approval when the space requires it. (2) Searches with no result are listed for content gaps. | M3 | M | JSM; YouTrack knowledge base |
| KB-003 | **External knowledge sources.** Taskmoor shall index external wiki page trees and folders as knowledge sources for search and the virtual agent, and expose articles through MCP tools. | (1) A connected wiki page answers a portal search. (2) An MCP client can search and read articles. | M3 | S | JSM (Confluence knowledge base); YouTrack MCP tools |

## 4. ITSM requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| ITSM-001 | **Incident management.** Taskmoor shall implement incidents per section 1.5 with manual, alert, API and template creation and no monthly limits. | (1) An alert routed to a team creates an incident linked to it. (2) The incident timeline records every status change, responder and update. | M3 | M | JSM Premium; exceeds Jira (Standard caps) |
| ITSM-002 | **Major incidents and response.** Taskmoor shall support the major-incident flag with response roles, one-click conference bridge and chat channel creation (Slack, Teams, Zoom), stakeholder updates and incident configurations (templates, roles, email templates). | (1) Flagging major creates the channel, invites responders and posts the incident summary. (2) Unlimited major incidents per month. | M3 | M | JSM Premium; incident.io |
| ITSM-003 | **Post-incident reviews.** Taskmoor shall create post-incident reviews from incidents with the section 1.5 template, imported timeline and tracked action items, with no limit on count. | (1) Action items are work items linked to the review and their completion shows on it. | M3 | M | JSM Premium; exceeds Jira (5 on Standard) |
| ITSM-004 | **Problem management.** Taskmoor shall provide problem category and queues, link incidents to problems, record root cause and workaround, mark known errors, and raise changes from problems. | (1) Linking 10 incidents to a problem shows them on the problem with counts. (2) Known errors are searchable for agents and suggested on matching incidents. | M3 | M | JSM Premium |
| ITSM-005 | **Change management and risk.** Taskmoor shall implement change types, rule-based risk scoring with configurable factors and weights, auto-approval of low risk, and CAB approval with quorum for high risk (section 1.5). | (1) A standard change with low risk is approved automatically and logged. (2) A high-risk change waits for majority approval of the CAB group. (3) Every score shows the factors that produced it. | M3 | M | JSM Premium; change-management apps |
| ITSM-006 | **Change calendar and conflicts.** Taskmoor shall show changes on a calendar with maintenance and freeze windows and flag conflicts between changes on the same service or configuration item. | (1) Scheduling a change inside a freeze window requires an emergency type or an override with reason. (2) Two overlapping changes on one service are both flagged. | M3 | M | JSM Premium |
| ITSM-007 | **CI/CD deployment gating.** Taskmoor shall provide a gate API and plugins for GitHub Actions, GitLab CI, Jenkins, Bitbucket Pipelines, CircleCI and Octopus Deploy that create or update change records, hold the pipeline until approval, release standard changes automatically, soak until a maintenance window, and hold when an incident is open on an affected service. | (1) A pipeline step returns "wait" until approval and "proceed" after. (2) An open incident on the service turns "proceed" into "hold" with the incident key. | M3 | M | JSM Premium (deployment gating) |
| ITSM-008 | **Services and health.** Taskmoor shall maintain services with owning teams, tiers, dependencies, linked CIs (file 04b, CMDB) and external services, let users subscribe to services, and show service health from open incidents and alerts. | (1) A subscriber is notified when an incident opens on the service. (2) Service health turns degraded while a linked incident is open. | M3 | M | JSM Premium (service subscriptions, external services) |
| ITSM-009 | **ITSM analytics.** Taskmoor shall report incident and major-incident counts, MTTA, MTTR, change success and failure rates, change lead time and problem ageing, by service and team. | (1) MTTR per service matches incident timestamps in a fixture set. | M3 | M | JSM Premium (analytics) |
