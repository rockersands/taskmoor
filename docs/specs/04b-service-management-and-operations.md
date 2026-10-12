---
spec: 04b
title: "Service management and operations: on-call and alerting, status pages, CMDB and mobile"
sources: docs/research/sources.md
accessed: 2026-10-11
attestation: own-words
---
# 04b Service management and operations: on-call and alerting, status pages, CMDB and mobile

This file specifies, for Taskmoor, the operations layer that Atlassian rebuilt inside Jira Service Management when it retired Opsgenie (end of support 5 April 2027): alert ingestion, teams, on-call schedules, escalations, routing, notification channels including SMS and voice, heartbeats and stakeholder communication. It also covers public and private status pages (Atlassian still sells Statuspage separately), the Assets-style CMDB with its query language, imports, discovery and reconciliation, and the mobile apps. Everything Atlassian gates behind JSM Premium or meters per object is free and unmetered here.

## How to read

- **ID**: `MODULE-NNN`, stable and never reused. This file holds ONC, STS, CMDB and MOB.
- **MS**: M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must, S = Should, C = Could.
- **Source**: parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit; "verify" marks a fact the research flagged as unconfirmed.
- **Terms**: work item = issue; alert = a signal from a monitoring tool; incident = an ITSM record (file 04a); CI = configuration item (CMDB object).

## 1. Reference: on-call and alerting (Opsgenie parity)

- **Alert fields**: message, alias (deduplication key), description, priority P1 to P5, tags, details (key-value), entity, source, responders (users, teams, schedules, escalations), alert assignee, notes, actions, duplicate count. States: open, acknowledged, snoozed, closed.
- **Inbound integrations**: REST API, generic webhook with field mapping, email, and connectors for Prometheus Alertmanager, Grafana, Datadog, New Relic, Dynatrace, Amazon CloudWatch, Azure Monitor, Google Cloud Monitoring, Sentry, Zabbix and Nagios (Opsgenie offered 150+; grow through the extension platform).
- **Policies**: alert policies (modify fields, suppress, delay, auto-close) and notification policies (delay, suppress, auto-restart notifications) at site and team level; maintenance windows (site or team, by integration or policy).
- **Teams**: members, team admins, custom team roles, team-owned integrations, schedules, escalations, routing rules and services.
- **Schedules**: rotations (hourly, daily, weekly, custom length) with participants, handoff time and time zone; time restrictions (time of day, weekdays); layered rotations; overrides; final computed schedule; gap warnings; "who is on call" now or at a time; iCal export.
- **Escalation rules**: condition (not acknowledged, not closed), delay, recipient (user, team, on-call of a schedule, next on-call, all members), repeat count, close after repeats.
- **Routing rules**: evaluated in order; conditions on alert fields and time windows; target an escalation, a schedule or nobody.
- **Contact methods and personal rules**: email, mobile push, SMS, voice call; rules by priority and time of day with delays; quiet hours; forwarding while away; critical alerts that bypass do-not-disturb on mobile.
- **Heartbeats**: name, interval, grace period, priority, owning team; pinged by HTTP or email; a missed ping raises an alert and the next ping closes it.
- **Stakeholders**: subscriber lists per service or incident, message templates, delivery by email, SMS, chat and status page.
- **Jira gating and limits removed**: voice, heartbeats, global policies, custom team roles and incoming call routing are JSM Premium; routing rules are 1 per team on Free and 100 elsewhere; 300 escalation policies with 50 rules per team; 2,000 heartbeats per site. None apply here.
- **Not rebuilt** (Atlassian deprecated them): MSP child accounts, Opsgenie activity streams, v1 heartbeats, the Incident Command Center.

## 2. ONC requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| ONC-001 | **Alerts and ingestion.** Taskmoor shall ingest alerts through the integrations of section 1, deduplicate by alias, and manage the alert fields, states, notes and actions, linking alerts to incidents. | (1) 1,000 alerts per second sustained are accepted without loss on the reference HA cluster. (2) A repeat alert with the same alias increments the duplicate count instead of creating a new alert. (3) Acknowledging stops escalation for that alert. | M3 | M | Opsgenie; JSM |
| ONC-002 | **Alert policies and maintenance.** Taskmoor shall apply site and team alert and notification policies and maintenance windows (section 1), free on all installs. | (1) A suppress policy for tag "test" stores the alert without notifying. (2) During a maintenance window, matching alerts notify nobody and are marked as in maintenance. | M3 | M | JSM Premium (global policies); exceeds Jira |
| ONC-003 | **Teams and roles.** Taskmoor shall provide operations teams with members, team admins and custom team roles, owning their integrations, schedules, escalations, routing and services. | (1) A custom role "Responder" can acknowledge but not edit schedules. | M3 | M | JSM Premium (custom roles) |
| ONC-004 | **On-call schedules.** Taskmoor shall implement the schedule features of section 1 with unlimited schedules. | (1) A weekly rotation of 4 people with a weekend restriction and an override shows the correct on-call person for every hour of a 60-day fixture. (2) Daylight-saving changes do not shift handoffs. (3) Gaps raise a warning to schedule owners. | M3 | M | Opsgenie; JSM Standard |
| ONC-005 | **Escalation policies.** Taskmoor shall run escalation rules (section 1) with no limit on policies or rules. | (1) An unacknowledged P1 escalates from on-call to team lead after 5 minutes, then repeats twice and stops. | M3 | M | Opsgenie; exceeds Jira (300 policies, 50 rules) |
| ONC-006 | **Routing rules.** Taskmoor shall route alerts by ordered rules on fields and time windows, with no limit per team. | (1) An alert at 02:00 matching "after hours" goes to the night escalation; the same alert at 10:00 goes to the day escalation. | M3 | M | Opsgenie; exceeds Jira (1 or 100 per team) |
| ONC-007 | **Notification channels.** Taskmoor shall notify through email, push, SMS and voice using pluggable providers (Twilio-compatible and SIP-based, bring your own numbers), apply personal notification rules, quiet hours and forwarding, and let both users and admins manage contact methods. | (1) A P1 alert calls the on-call phone and accepts "press 1 to acknowledge". (2) Swapping the SMS provider needs only settings, no code. (3) An admin can fix a user's phone number (Atlassian lets only the user edit). | M3 | M | JSM Premium (voice); exceeds Jira |
| ONC-008 | **Heartbeats.** Taskmoor shall monitor heartbeats (section 1) with no per-site cap. | (1) A heartbeat with a 5-minute interval and 1-minute grace raises an alert 6 minutes after the last ping and closes it on the next ping. (2) 10,000 heartbeats run on the reference HA cluster. | M3 | M | JSM Premium; exceeds Jira (2,000 per site) |
| ONC-009 | **Stakeholder communications.** Taskmoor shall manage stakeholder subscriptions per service and incident, send templated updates by email, SMS, chat and status page, and keep central message templates. | (1) Posting an incident update notifies every subscriber of the affected service through their chosen channel. | M3 | M | JSM Premium (stakeholders) |
| ONC-010 | **ChatOps, edge runner and call routing.** Taskmoor shall let responders acknowledge, assign and close alerts from Slack and Microsoft Teams, sync bidirectionally with other ITSM tools, run approved scripts and runbooks on-premises through an outbound-only edge runner, and route incoming phone calls to the current on-call person. | (1) Acknowledging in Slack updates the alert within 2 s. (2) The edge runner needs no inbound firewall rule. (3) A call to the team number rings the on-call person. | M3 | M | JSM Premium (Jira Edge Connector, call routing) |
| ONC-011 | **Infrastructure as code and analytics.** Taskmoor shall provide a Terraform provider for teams, schedules, escalations, routing, integrations and heartbeats, and on-call analytics (alert volume, MTTA, MTTR, notifications per person, off-hours interruptions). | (1) `terraform apply` of a fixture creates a team with schedule and escalation; a second apply makes no changes. (2) Off-hours interruptions per person match notification logs. | M3 | M | Atlassian Operations Terraform provider; JSM Premium analytics |

## 3. Reference: status pages

- **Components** and component groups; component status: operational, degraded performance, partial outage, major outage, under maintenance.
- **Incidents** with states investigating, identified, monitoring, resolved, and timestamped updates; **scheduled maintenance** with planned, in progress and completed states.
- **Page**: custom domain with automatic TLS, branding and custom CSS, 90-day uptime bars per component, history page.
- **Private and audience pages**: sign-in by SSO or IP allowlist; audiences that see different components.
- **Subscribers**: email, SMS, webhook, RSS and Atom, chat; per-component subscriptions; no subscriber cap.

## 4. STS requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| STS-001 | **Public, private and audience status pages.** Taskmoor shall host any number of status pages with the features of section 3, including private pages behind SSO or IP allowlists and audience-specific component sets. | (1) A private page refuses anonymous visitors. (2) Audience A sees components X and Y; audience B sees only Y. (3) Pages stay readable when the main application is degraded (served from a separate static snapshot). | M3 | M | Atlassian Statuspage (separate product, $29 to $1,499 per month); exceeds Jira |
| STS-002 | **Subscribers, incident link and API.** Taskmoor shall notify subscribers on the channels of section 3, publish updates from incidents manually or by automation ("send status page update"), set component status from service health, and offer a status API and embeddable widget. | (1) Resolving the linked incident posts a resolved update and returns the component to operational when configured. (2) 50,000 email subscribers receive an update within 10 minutes. | M3 | M | Statuspage; JSM automation |

## 5. Reference: CMDB (Assets parity)

- **Schema**: object types with icons, parent types, attribute inheritance and abstract types; schema templates including a common data model (devices, software, people, locations, services).
- **Attribute types**: text, text area, integer, decimal, boolean, date, date-time, URL, email, IP address, select, status, user, group, and reference to another object type (Atlassian's full list was not captured; verify). Options: unique, required (minimum cardinality), maximum cardinality, default, label attribute, hidden, regular-expression validation.
- **References**: typed, labelled relationships ("runs on", "depends on", "owned by") navigable inbound and outbound.
- **Object query language** (Taskmoor's design; Atlassian's AQL syntax was not captured, so AQL compatibility is a verify item): attribute comparisons (`objectType = Server AND "Operating system" = "Ubuntu 24.04"`), reference traversal (`outboundReferences(objectType = Application)`, `inboundReferences(...)`), functions (`currentUser()`, `now()`), placeholders for the current item and user (for example the item's reporter), ordering.
- **Imports**: CSV, JSON, SQL databases, LDAP and Entra ID, AWS, Azure and Google Cloud inventories, discovery results; mapping of source fields to types and attributes, automatic creation of types and attributes, parent and child structures, identifiers for matching, schedules, handling of missing objects (keep, mark, delete), import history with errors.
- **Reconciliation**: several sources per type, precedence per attribute, match keys, cleansing and normalisation rules, gap and conflict reports.
- **Lifecycle** (hardware asset management): procured, in stock, deployed, in repair, retired, disposed.

## 6. CMDB requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| CMDB-001 | **Schemas and object types.** Taskmoor shall provide schemas, object types with inheritance and abstract types, and schema templates including a common data model (section 5). | (1) A child type inherits its parent's attributes and adds its own. (2) Applying the common data model template creates its types and references. | M3 | M | JSM Assets |
| CMDB-002 | **Attributes and references.** Taskmoor shall implement the attribute types, options and labelled references of section 5. | (1) A unique attribute rejects a duplicate value. (2) A reference with maximum cardinality 1 rejects a second target. | M3 | M | JSM Assets (attribute list verify) |
| CMDB-003 | **Object management.** Taskmoor shall let users create, edit, bulk edit and delete objects, view history and attachments, see linked items, and explore references in an interactive graph. | (1) The graph of a server shows its applications and their services two hops out. (2) Every attribute change appears in object history with actor and time. | M3 | M | JSM Assets |
| CMDB-004 | **Object query language.** Taskmoor shall implement the object query language of section 5, usable in object search, field scoping, automation lookups and branches, and inside item queries through bridging functions. | (1) An item query returns items linked to servers running Ubuntu 24.04. (2) A query with a placeholder resolves against the current item. (3) Queries over 1M objects return the first page in under 1 s. | M3 | M | JSM Assets (AQL compatibility verify) |
| CMDB-005 | **Object fields on items.** Taskmoor shall provide an object-reference custom field scoped by an object query (with placeholders), single or multiple, showing chosen attributes, and searchable by object attributes. | (1) Selecting a laptop is limited to objects owned by the reporter. (2) An item query by the laptop's model attribute finds the item. | M3 | M | JSM Assets |
| CMDB-006 | **Imports and reconciliation.** Taskmoor shall implement the imports and reconciliation of section 5. | (1) A scheduled CSV import of 100,000 rows creates and updates objects idempotently and logs row errors. (2) Two sources reporting different RAM sizes resolve by the configured precedence and list the conflict. | M3 | M | JSM Assets Data Manager |
| CMDB-007 | **Discovery.** Taskmoor shall provide a downloadable discovery scanner (agentless: ICMP, SNMP, SSH, WMI; optional agent) with stored credentials and schedules, feeding the import pipeline. | (1) Scanning a fixture subnet discovers hosts with OS, CPU, memory and installed software. (2) Credentials are stored encrypted and never shown in logs. | M3 | M | JSM Assets Discovery |
| CMDB-008 | **Object permissions, automation, lifecycle and scale.** Taskmoor shall provide schema roles (admin, manager, user) and object-level visibility, object triggers and actions in automation, hardware lifecycle states (section 5), and no metering of object counts. | (1) A user role can view but not edit objects. (2) An attribute change fires the "Attribute value changed" trigger. (3) 5 million objects load and query with no licence or usage limit. | M3 | M | JSM Assets; exceeds Jira (5k, 50k, 500k objects then $0.02 per object) |

## 7. MOB requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| MOB-001 | **Installable web app with offline mode.** Taskmoor shall ship the web client as an installable progressive web app that caches recently used items, boards and lists for offline reading, queues changes made offline and syncs them on reconnect, and receives Web Push notifications. | (1) An item edited offline syncs on reconnect, and a conflicting field shows the server value with the offline value in history. (2) Push notifications arrive with the app closed. | M2 | M | Linear (offline outbox) |
| MOB-002 | **Native mobile apps.** Taskmoor shall provide iOS and Android apps for items, boards, search, inbox, approvals, comments, attachments (camera and files) and on-call (alerts with critical-alert override of do-not-disturb, acknowledge, close, escalate, who is on call, schedule overrides), with biometric unlock, working against any self-hosted backend URL. | (1) A P1 alert sounds on a phone in do-not-disturb mode when the user allowed critical alerts. (2) Signing in to a self-hosted instance needs only its URL. | M3 | M | Jira Free (mobile apps); Opsgenie app |
| MOB-003 | **Mobile management policies.** Taskmoor shall let admins require device passcode and encryption, block screenshots, restrict copy and export, allow mobile access from outside IP allowlists only with app attestation, and remotely sign out devices. | (1) With screenshots blocked, the Android app sets the secure-window flag. (2) A remote sign-out ends the device session within 1 minute. | M3 | M | Atlassian Guard Standard (mobile app management) |
