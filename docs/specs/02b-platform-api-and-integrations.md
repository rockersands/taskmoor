---
spec: 02b
title: "Platform, API and integrations: automation, extensions and development tools"
sources: docs/research/sources.md
accessed: 2026-10-11
attestation: own-words
---
# 02b Platform, API and integrations: automation, extensions and development tools

This file specifies, for Taskmoor, the automation engine (Jira Automation parity without step metering or per-rule caps), the extension platform (sandboxed server extensions, UI extension slots and a scripting runtime that covers what ScriptRunner, JMWE and JSU sell), and the development-tool integration layer (development panel, commit commands (Jira: smart commits), deployment tracking and DORA metrics). These are the areas where Jira customers buy the most Marketplace apps, so each catalog lists what must be native.

## How to read

- **ID**: `MODULE-NNN`, stable and never reused. This file holds AUT, EXT and DEV.
- **MS**: M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must, S = Should, C = Could.
- **Source**: parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit; "verify" marks a fact the research flagged as unconfirmed.
- **Terms**: ticket (Jira: issue), track (Jira: project), rule (Jira: "flow"), step (Jira: "component"), for each block (Jira: branch), variables (Jira: smart values); file 00 lists the full vocabulary.

## 1. Reference: automation catalog

### 1.1 Rule anatomy

A rule has a name, description, scope (one track, a list of tracks, a track type, or global), owner, actor (the identity it acts as: a service account, the rule owner, or the triggering user), one trigger, an ordered list of steps (conditions, actions, for each blocks, if/else blocks, loops, delays), labels, an enabled flag, error-notification settings and a version history. Track admins create track-scoped rules; global rules need the automation admin permission. A rule can never do more than its actor's permissions allow.

### 1.2 Triggers

| Group | Triggers | MS |
|---|---|---|
| Tickets and platform | Field value changed; Form attached; Form opened for edits; Form submitted; Incoming webhook; Ticket assigned; Ticket commented; Comment edited; Ticket created; Ticket deleted; Ticket linked; Link deleted; Ticket moved; Ticket transitioned; Ticket updated; Manual trigger from ticket; Multiple ticket events; Track created; Scheduled; Time recorded | M2 |
| Agile | Sprint created, started, completed; Release created, updated, shipped | M2 |
| Development | Branch created; Commit created; Pull request created, merged, declined; Build successful, failed, status changed; Deployment successful, failed, status changed | M2 |
| Security | Vulnerability found | M2 |
| Service | Approval required; Approval completed; SLA threshold breached; Service limit breached; Emoji reaction to a chat message | M2 |
| Operations and CMDB | Alert created, updated, status changed, note added; Manual trigger from alert; Object created or updated; Attribute value changed | M3 |
| Other | Design linked, updated, status changed (C); Component created and scorecard status change map to the service catalog (C) | M4 |

### 1.3 Conditions

Jira's condition list was not captured; Taskmoor provides: field value comparison; query match (the ticket matches a query); user condition (actor, assignee or requester in a group, role or list); related-tickets condition (parent, children, subtickets or linked tickets where all, any or none match a query); advanced compare (two template expressions with equals, not equals, contains, matches regex, greater, less, in list); business-hours condition using SLA calendars; if/else-if/else blocks with nested conditions (verify Jira condition names for rule import).

### 1.4 Actions

| Group | Actions | MS |
|---|---|---|
| Tickets | Assign; Clone; Comment; Create ticket; Create subtickets; Delete comment; Delete ticket; Delete links; Edit comment; Edit ticket (any field, plus advanced JSON); Edit request form; Link tickets; Record time; Lookup tickets; Manage followers; Re-fetch ticket data; Set entity property; Transition ticket; Delete attachments; Link vulnerability; Link to goal | M2 |
| Agile | Create release; Ship release; Unship release; Create sprint; Start sprint; Complete sprint | M2 |
| Forms | Attach forms; Attach forms with values; Change form status; Copy forms | M2 |
| Messages | Send email (HTML template); Send Slack message; Send Microsoft Teams message; Send SMS (pluggable provider) | M2 |
| Integration and data | Send web request (response usable later); Create variable; Create lookup table; Create dynamic lookup table; Log action | M2 |
| Flow | For each; If/else; Loop; Delay; Delay until; Stop rule | M2 |
| Development | Create branch in GitHub, GitLab, Bitbucket, Gitea or Forgejo | M2 |
| AI (file 02c) | Use AI (prompt to text or structured output); Use agent; Hand off to coding agent | M2 |
| Service and ITSM | Approve or decline request; Add customer; Create ticket with request form; Create incident; Add stakeholders; Send status page update; Create post-incident review; Create meeting for incident; Create chat channel; Set channel topic; Add apps to channel | M3 |
| CMDB | Lookup objects; Create object; Edit object; Edit object field attributes | M3 |
| Cloud operations | Publish to a message topic; Run a cloud runbook; Restart a virtual machine (through plugins) | M3 (C) |
| Knowledge | Create knowledge page | M2 |

### 1.5 For each blocks

Current ticket; parent; children; subtickets; children of an Outcome or higher level; linked tickets by link type; tickets returned by a query; tickets created earlier in the rule; lookup results; CMDB objects returned by an inventory query (M3). For each blocks nest; each block runs its iterations sequentially or in parallel as configured.

### 1.6 Template language (variables)

- Paths in double braces: `{{ticket.summary}}`, `{{ticket.assignee.displayName}}`; `issue` and `workItem` are accepted as aliases of `ticket`; multi-word properties use camelCase.
- Method chaining: `{{now.plusDays(5)}}`, `{{ticket.summary.toLowerCase().substring(0, 10).concat("!!")}}`.
- List sections: `{{#ticket.comments}}Author: {{author.displayName}}{{/}}`.
- Inline math: `{{#=}}{{ticket.Invoice Amount}} + 100{{/}}`.
- Fallback values after a vertical bar: a missing reference followed by `|"Hello world"` yields "Hello world".
- Scopes: ticket, trigger event and field changes, user, sprint, release, webhook payload, web response, lookup results, variables, created tickets, now, rule, alert, object, SLA.
- Function families: date and time (add, subtract, format, business days, difference), text (case, substring, replace, regex, split, trim, URL, JSON and HTML encoding), math, lists (size, join, first, last, distinct), JSON (parse, path access) and conditionals (if, equals, exists).
- Jira's full function reference was not captured; build compatibility from a corpus of imported rules and document every function Taskmoor supports.

### 1.7 Limits compared with Jira Cloud

| Limit | Jira Cloud (2026) | Taskmoor (admin-adjustable defaults) |
|---|---|---|
| Steps per rule | 65 (500 for advanced flows) | 1,000 default, no hard cap |
| Tickets from a scheduled query | 999, error above | No cap; processed in pages of 1,000 |
| Lookup tickets action | First 100 results | 1,000 per page with paging |
| Tickets touched per run | 5,000, then rule disabled | Warning at 50,000; no auto-disable by default |
| Global queue | 50,000 items | Configurable; back-pressure, nothing dropped |
| Processing time | 60 minutes per 12 hours | Per-run timeout, default 15 minutes; no rolling quota |
| Loop detection | 10 triggers deep | Default 10, configurable |
| Subtickets per action; fields per create | 50; 2,000 | 1,000; no cap |
| Concurrent rules | 5 to 30 by plan | Scales with worker count |
| Usage metering | 150 to 1,000 steps per user per month, then $0.50 per 1,000 | None |

## 2. AUT requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| AUT-001 | **Rule model, scopes and actors.** Taskmoor shall implement the rule anatomy of section 1.1 with a visual builder and JSON representation. | (1) A rule scoped to track A never fires for events in track B. (2) A rule acting as a service account without access to track C fails with a permission error there. (3) Saving a rule creates a version; any version can be restored and diffed. | M2 | M | Jira Automation; exceeds Jira (versioning) |
| AUT-002 | **Triggers.** Taskmoor shall implement every trigger in section 1.2 as its module ships. | (1) Each trigger has an end-to-end test firing it from a real event. (2) "Field value changed" can watch several fields and specific change types. (3) "Multiple ticket events" fires once per matching event. | M2 | M | Jira Automation |
| AUT-003 | **Conditions.** Taskmoor shall implement the conditions of section 1.3, including nested if/else blocks. | (1) An if/else-if/else block takes exactly one path in tests for all three cases. (2) A related-tickets condition with "none match" is true for a ticket without children. | M2 | M | Jira Automation (verify names) |
| AUT-004 | **Actions.** Taskmoor shall implement every action in section 1.4 as its module ships. | (1) Each action has an end-to-end test. (2) Edit ticket accepts any field, including custom fields, through the form and through advanced JSON. (3) Send web request exposes status, headers and body to later steps. | M2 | M | Jira Automation |
| AUT-005 | **For each blocks.** Taskmoor shall implement the for each blocks of section 1.5 with nesting and sequential or parallel execution. | (1) A for each block over linked "blocks" tickets acts on exactly those tickets. (2) A for each block over a query's 20,000 tickets completes in pages without hitting a cap. | M2 | M | Jira Automation |
| AUT-006 | **Template language.** Taskmoor shall evaluate templates per section 1.6 in a sandbox with no file, network or process access. | (1) Every example in section 1.6 produces the documented output. (2) At least 95% of template expressions in an imported Jira rule corpus evaluate identically. (3) A template that loops forever stops at the evaluation time limit with a clear error. | M2 | M | Jira Automation |
| AUT-007 | **Variables, lookups and web requests.** Taskmoor shall provide variables, static and dynamic lookup tables, ticket lookups with paging, and outbound web requests with secret storage for credentials. | (1) A lookup of 3,000 tickets is available to later steps in full. (2) Secrets used in web request headers never appear in logs or audit output. | M2 | M | Jira Automation; exceeds Jira (100-result lookup) |
| AUT-008 | **Scheduled rules.** Taskmoor shall run rules on cron or interval schedules, optionally over the tickets of a query, without the 999-item cap and with one run at a time per rule by default. | (1) A schedule over 25,000 matching tickets processes all 25,000. (2) A run that starts while the previous run continues is skipped and logged. | M2 | M | Jira Automation; exceeds Jira |
| AUT-009 | **No metering, adjustable limits.** Taskmoor shall impose no usage metering and enforce only the admin-adjustable limits of section 1.7, reporting THROTTLED and LOOP outcomes in the audit log. | (1) A 200-step rule saves and runs. (2) A rule triggering itself 11 levels deep stops at level 10 with outcome LOOP. (3) No usage counter can stop rules. | M2 | M | exceeds Jira (65 steps, 999 items, step billing) |
| AUT-010 | **Reliable execution.** Taskmoor shall enqueue triggers through a transactional outbox, process at least once with idempotent actions, keep per-ticket ordering, survive restarts mid-delay, apply back-pressure instead of dropping, and scale across workers. | (1) Restarting all workers during 1,000 queued runs loses none and duplicates no side effect. (2) A 3-day delay resumes after a restart. (3) Events for one ticket run in order. | M2 | M | exceeds Jira |
| AUT-011 | **Audit log and debugger.** Taskmoor shall record each run with outcome (SUCCESS, NO_ACTIONS_PERFORMED, SOME_ERRORS, ABORTED, NO_MATCH, THROTTLED, LOOP), a step trace with evaluated template values and timings, and offer a dry run with a chosen test event. | (1) A dry run shows what each action would change without changing anything. (2) Run logs are kept for an admin-set period (default 90 days). | M2 | M | Jira Automation; exceeds Jira (debugger) |
| AUT-012 | **Templates and rule portability.** Taskmoor shall ship a library of rule templates, export and import rules as JSON, and import Jira automation rule exports. | (1) The template "close subtickets when parent is Closed" works after one click. (2) An imported Jira rule either runs or lists the parts needing changes. | M2 | M | Jira Automation (export format verify) |
| AUT-013 | **Manual and webhook triggers.** Taskmoor shall support manual triggers from tickets and alerts with user input fields, and incoming webhook triggers authenticated by secret, exposing inputs and payload to templates. | (1) A manual rule asks for a reason and writes it into a comment. (2) A webhook call without the secret is rejected with 401. | M2 | M | Jira Automation |

## 3. Reference: extension points

| Area | Extension points (Forge module equivalents) |
|---|---|
| Ticket view | Panel; glance; context (side) panel; action (more menu); activity tab; background script; search-results action |
| Fields and data | Custom field; custom field type; entity property with query indexing; query function |
| Workflow | Guard; check; effect; action check |
| Agile | Board action; backlog action; sprint action |
| Pages | Global page; track page; track settings page; admin page; personal settings page; full page; command palette command |
| Dashboards | Widget; background script |
| Platform | UI modifications (change field visibility, options and values on create, edit and transition layouts); time tracking provider; global and track permissions; scheduled triggers; event listeners; web triggers (custom REST endpoints); AI tools exposed to agents and the MCP server |

## 4. EXT requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| EXT-001 | **Sandboxed server runtime.** Taskmoor shall run server extensions compiled to WebAssembly in a sandbox exposing only declared host functions (ticket and track API as the extension's identity, key-value and SQL storage, outbound HTTP to an allowlist, logging), with limits on CPU time, memory and wall-clock per invocation. | (1) An extension calling an undeclared host or domain is denied and logged. (2) An extension exceeding its memory limit is stopped without affecting the server. (3) Limits are admin-configurable per extension. | M2 | M | Atlassian Forge; Extism |
| EXT-002 | **Extension points.** Taskmoor shall offer every extension point in section 3. | (1) A sample extension for each point installs and renders or runs in tests. (2) A custom field type from an extension supports query operators it declares. | M2 | M | Forge Jira modules |
| EXT-003 | **UI extensions.** Taskmoor shall render UI extensions in sandboxed iframes with a strict content security policy, a message bridge to call permitted APIs, design tokens for theming and a TypeScript SDK (`@taskmoor/extension-sdk`). | (1) An iframe extension cannot read the host page's DOM or cookies. (2) Theme changes reach the extension through tokens. | M2 | M | Forge Custom UI |
| EXT-004 | **Scripting.** Taskmoor shall provide a TypeScript scripting environment for admins with a script console, scripted event listeners, scripted (calculated) fields that are indexed and searchable, scripted query functions, custom REST endpoints, scripted guards, checks and effects, scheduled jobs, UI behaviours and bulk scripted changes with dry run. | (1) A scripted field computing days open is sortable and searchable. (2) A scripted query function `issueFunction`-style returns linked tickets and runs in under 1 s on 1M tickets (exact ScriptRunner names verify). (3) Every script run is audited with author and version. | M2 | M | ScriptRunner app |
| EXT-005 | **Packaging and lifecycle.** Taskmoor shall install extensions from signed packages declaring scopes, permissions, egress domains and extension points; require admin approval of scopes; support upgrade, disable, per-track enablement and uninstall with data removal; and allow offline install from a file. | (1) An unsigned package is rejected unless the admin enables unsigned installs. (2) An upgrade that adds scopes waits for admin approval. (3) Install works with no internet access. | M2 | M | Forge; exceeds Jira (offline install) |
| EXT-006 | **Extension storage.** Taskmoor shall give each extension key-value storage and its own SQL schema with admin-set quotas and no fixed per-install size cap. | (1) An extension stores 5 GB when the quota allows. (2) Uninstall with data removal deletes the schema. | M2 | M | Forge storage; exceeds Forge (1 GiB SQL cap) |
| EXT-007 | **Extension observability.** Taskmoor shall show per-extension invocation counts, errors, latency, log lines and resource use. | (1) An admin finds the last 100 errors of an extension with stack traces. | M2 | M | exceeds Jira |
| EXT-008 | **Integration connectors.** Taskmoor shall provide an n8n node and documented webhook-plus-API recipes for workflow tools, and two-way sync connectors to other Jira instances, ServiceNow, Azure DevOps and GitHub Issues. | (1) An n8n workflow creates and updates tickets through the node. (2) A two-way sync keeps summary, status and comments in step within 1 minute. | M4 | S | YouTrack n8n node; Exalate app |
| EXT-009 | **Extension registry.** Taskmoor shall provide a public extension registry with search, versions, signatures, compatibility ranges and ratings, plus a mirror mode for air-gapped sites. | (1) An admin installs from the registry in one step. (2) A mirrored registry serves packages with no internet access. A nice-to-have after the core product is finished (user decision, 2026-10-12): extensions install from files and URLs until then. | M4 | C | Atlassian Marketplace |

## 5. Reference: development data

- **Linked entities**: branches, commits, pull requests, reviews, builds, deployments (environment and status), feature flags (enabled state, rollout percentage), vulnerabilities, web links, operations records (incidents, reviews), components.
- **Linking rule**: an entity links to a ticket when the ticket's key appears in the branch name, commit message or pull request title; a deployment links when any of its commits links.
- **Panel summary rules**: pull request status shows OPEN over MERGED over DECLINED; review states REVIEW, APPROVAL, SUMMARIZE, REJECTED, closed; builds show all passed or any failed.
- **Commit command syntax**: `KEY #comment text`; `KEY #time 1w 2d 4h 30m comment`; `KEY #<transition name> #comment text`; several commands per commit and across lines.
- **Metrics**: tickets completed per week (8 weeks); overdue tickets; open bugs; pull request cycle time (median first commit to merge over 7 days); lead time for changes; deployment frequency (average production deployments per week over 12 weeks); open pull requests (30 days); critical vulnerabilities.

## 6. DEV requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| DEV-001 | **Tool connections.** Taskmoor shall connect to GitHub, GitLab, Bitbucket, Gitea, Forgejo, Azure DevOps and Jenkins (cloud and self-hosted) by app install, OAuth or webhook, with a per-track toolchain page. | (1) Connecting a self-hosted Gitea needs only its URL and a token. (2) The toolchain page lists connected tools and their last sync. | M2 | M | Jira Free; Kaneo |
| DEV-002 | **Development panel.** Taskmoor shall link development entities by the rule in section 5 and show them on the ticket with the panel summary rules, gated by the View development tools permission. | (1) A commit with ABC-12 in its message appears on ABC-12 within 30 s of the push. (2) A ticket with 500 commits pages through all of them (Jira shows the first 100). (3) Board cards show development status icons. | M2 | M | Jira Free; exceeds Jira |
| DEV-003 | **Ingestion API.** Taskmoor shall accept development information, builds, deployments, feature flags, web links, security information, operations data and components through a typed API, usable by on-premises tools with client-credential tokens. | (1) A Jenkins job posting a deployment shows it on linked tickets and on the release. (2) Payloads matching Jira's ingestion API shapes are accepted (fixtures, verify). | M2 | M | Jira Software ingestion APIs |
| DEV-004 | **Create from ticket.** Taskmoor shall create branches and pull requests from a ticket in a chosen tool using an admin-set branch-name template that must include the key, and copy commit commands. | (1) "Create branch" in GitLab produces `feature/ABC-12-short-summary` under the default template. | M2 | M | Jira Free |
| DEV-005 | **Commit commands.** Taskmoor shall execute commit commands (section 5) as the committer matched by email, reporting failures to the committer. | (1) `ABC-12 #time 2h #done #comment shipped` records 2 hours, runs transition Done and adds the comment. (2) An unmatched committer email produces no change and a notice to admins. | M2 | M | Jira Free |
| DEV-006 | **Status rules and release tracking.** Taskmoor shall let tracks move tickets automatically on repository activity and record per ticket which environment and release a change has reached. | (1) Merging a pull request moves its ticket to In Review without an automation rule. (2) A production deployment marks linked tickets as released to production. | M2 | M | Kaneo; Linear Releases |
| DEV-007 | **Development page and DORA metrics.** Taskmoor shall show the metrics of section 5 per track and team, with a related-work tab of pull requests, vulnerabilities and deployments. | (1) Deployment frequency matches a fixture of deployment events. (2) Metrics work without CI data by showing ticket-based metrics only. | M2 | M | Jira Free (Development page) |
| DEV-008 | **Release hub and development queries.** Taskmoor shall show deployment and build status per release and expose development data in queries (for example tickets with open pull requests). | (1) A release page shows which tickets are deployed to which environment. (2) A query for tickets with failed builds returns them (Jira's `development[...]` syntax verify). | M2 | M | Jira Free |
| DEV-009 | **Service catalog with Backstage.** Taskmoor shall keep a service and component registry with owners and dependencies, import `catalog-info.yaml` from repositories and Backstage, and link components to tickets, on-call teams and changes. | (1) Importing a Backstage catalog creates components with owners. (2) An incident on a service shows its owning team's on-call. | M3 | M | Compass (retired); Backstage |
| DEV-010 | **Design links.** Taskmoor shall link design files from design tools to tickets and show previews and status. | (1) A pasted design URL shows a preview and last-updated time. | M4 | C | Jira design integrations |
