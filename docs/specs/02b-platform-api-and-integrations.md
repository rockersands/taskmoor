---
spec: 02b
title: "Platform, API and integrations: automation, extensions and development tools"
sources: docs/research/sources.md
accessed: 2026-10-11
attestation: own-words
---
# 02b Platform, API and integrations: automation, extensions and development tools

This file specifies, for Taskmoor, the automation engine (Jira Automation parity without step metering or per-rule caps), the extension platform (sandboxed server extensions, UI extension slots and a scripting runtime that covers what ScriptRunner, JMWE and JSU sell), and the development-tool integration layer (development panel, smart commits, deployment tracking and DORA metrics). These are the areas where Jira customers buy the most Marketplace apps, so each catalog lists what must be native.

## How to read

- **ID**: `MODULE-NNN`, stable and never reused. This file holds AUT, EXT and DEV.
- **MS**: M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must, S = Should, C = Could.
- **Source**: parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit; "verify" marks a fact the research flagged as unconfirmed.
- **Terms**: work item = issue, space = project, rule = Jira "flow", step = Jira "component".

## 1. Reference: automation catalog

### 1.1 Rule anatomy

A rule has a name, description, scope (one space, a list of spaces, a space type, or global), owner, actor (the identity it acts as: a service account, the rule owner, or the triggering user), one trigger, an ordered list of steps (conditions, actions, branches, if/else blocks, loops, delays), labels, an enabled flag, error-notification settings and a version history. Space admins create space-scoped rules; global rules need the automation admin permission. A rule can never do more than its actor's permissions allow.

### 1.2 Triggers

| Group | Triggers | MS |
|---|---|---|
| Work items and platform | Field value changed; Form attached; Form opened for edits; Form submitted; Incoming webhook; Item assigned; Item commented; Comment edited; Item created; Item deleted; Item linked; Link deleted; Item moved; Item transitioned; Item updated; Manual trigger from item; Multiple item events; Space created; Scheduled; Work logged | M2 |
| Agile | Sprint created, started, completed; Version created, updated, released | M2 |
| Development | Branch created; Commit created; Pull request created, merged, declined; Build successful, failed, status changed; Deployment successful, failed, status changed | M2 |
| Security | Vulnerability found | M2 |
| Service | Approval required; Approval completed; SLA threshold breached; Service limit breached; Emoji reaction to a chat message | M2 |
| Operations and CMDB | Alert created, updated, status changed, note added; Manual trigger from alert; Object created or updated; Attribute value changed | M3 |
| Other | Design linked, updated, status changed (C); Component created and scorecard status change map to the service catalog (C) | M4 |

### 1.3 Conditions

Jira's condition list was not captured; Taskmoor provides: field value comparison; query match (the item matches a query); user condition (actor, assignee or reporter in a group, role or list); related-items condition (parent, children, subtasks or linked items where all, any or none match a query); advanced compare (two template expressions with equals, not equals, contains, matches regex, greater, less, in list); business-hours condition using SLA calendars; if/else-if/else blocks with nested conditions (verify Jira condition names for rule import).

### 1.4 Actions

| Group | Actions | MS |
|---|---|---|
| Work items | Assign; Clone; Comment; Create item; Create subtasks; Delete comment; Delete item; Delete links; Edit comment; Edit item (any field, plus advanced JSON); Edit request type; Link items; Log work; Lookup items; Manage watchers; Re-fetch item data; Set entity property; Transition item; Delete attachments; Link vulnerability; Link to goal | M2 |
| Agile | Create version; Release version; Unrelease version; Create sprint; Start sprint; Complete sprint | M2 |
| Forms | Attach forms; Attach forms with values; Change form status; Copy forms | M2 |
| Messages | Send email (HTML template); Send Slack message; Send Microsoft Teams message; Send SMS (pluggable provider) | M2 |
| Integration and data | Send web request (response usable later); Create variable; Create lookup table; Create dynamic lookup table; Log action | M2 |
| Flow | Branch; If/else; Loop; Delay; Delay until; Stop rule | M2 |
| Development | Create branch in GitHub, GitLab, Bitbucket, Gitea or Forgejo | M2 |
| AI (file 02c) | Use AI (prompt to text or structured output); Use agent; Hand off to coding agent | M2 |
| Service and ITSM | Approve or decline request; Add customer; Create item with request type; Create incident; Add stakeholders; Send status page update; Create post-incident review; Create meeting for incident; Create chat channel; Set channel topic; Add apps to channel | M3 |
| CMDB | Lookup objects; Create object; Edit object; Edit object field attributes | M3 |
| Cloud operations | Publish to a message topic; Run a cloud runbook; Restart a virtual machine (through plugins) | M3 (C) |
| Knowledge | Create knowledge page | M2 |

### 1.5 Branches

Current item; parent; children; subtasks; children of an epic or higher level; linked items by link type; items returned by a query; items created earlier in the rule; lookup results; CMDB objects returned by an object query (M3). Branches nest; each branch runs its iterations sequentially or in parallel as configured.

### 1.6 Template language (smart values)

- Paths in double braces: `{{issue.summary}}`, `{{issue.assignee.displayName}}`; `workItem` is accepted as an alias of `issue`; multi-word properties use camelCase.
- Method chaining: `{{now.plusDays(5)}}`, `{{issue.summary.toLowerCase().substring(0, 10).concat("!!")}}`.
- List sections: `{{#issue.comments}}Author: {{author.displayName}}{{/}}`.
- Inline math: `{{#=}}{{issue.Invoice Amount}} + 100{{/}}`.
- Fallback values after a vertical bar: a missing reference followed by `|"Hello world"` yields "Hello world".
- Scopes: item, trigger event and field changes, user, sprint, version, webhook payload, web response, lookup results, variables, created items, now, rule, alert, object, SLA.
- Function families: date and time (add, subtract, format, business days, difference), text (case, substring, replace, regex, split, trim, URL, JSON and HTML encoding), math, lists (size, join, first, last, distinct), JSON (parse, path access) and conditionals (if, equals, exists).
- Jira's full function reference was not captured; build compatibility from a corpus of imported rules and document every function Taskmoor supports.

### 1.7 Limits compared with Jira Cloud

| Limit | Jira Cloud (2026) | Taskmoor (admin-adjustable defaults) |
|---|---|---|
| Steps per rule | 65 (500 for advanced flows) | 1,000 default, no hard cap |
| Items from a scheduled query | 999, error above | No cap; processed in pages of 1,000 |
| Lookup items action | First 100 results | 1,000 per page with paging |
| Items touched per run | 5,000, then rule disabled | Warning at 50,000; no auto-disable by default |
| Global queue | 50,000 items | Configurable; back-pressure, nothing dropped |
| Processing time | 60 minutes per 12 hours | Per-run timeout, default 15 minutes; no rolling quota |
| Loop detection | 10 triggers deep | Default 10, configurable |
| Subtasks per action; fields per create | 50; 2,000 | 1,000; no cap |
| Concurrent rules | 5 to 30 by plan | Scales with worker count |
| Usage metering | 150 to 1,000 steps per user per month, then $0.50 per 1,000 | None |

## 2. AUT requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| AUT-001 | **Rule model, scopes and actors.** Taskmoor shall implement the rule anatomy of section 1.1 with a visual builder and JSON representation. | (1) A rule scoped to space A never fires for events in space B. (2) A rule acting as a service account without access to space C fails with a permission error there. (3) Saving a rule creates a version; any version can be restored and diffed. | M2 | M | Jira Automation; exceeds Jira (versioning) |
| AUT-002 | **Triggers.** Taskmoor shall implement every trigger in section 1.2 as its module ships. | (1) Each trigger has an end-to-end test firing it from a real event. (2) "Field value changed" can watch several fields and specific change types. (3) "Multiple item events" fires once per matching event. | M2 | M | Jira Automation |
| AUT-003 | **Conditions.** Taskmoor shall implement the conditions of section 1.3, including nested if/else blocks. | (1) An if/else-if/else block takes exactly one path in tests for all three cases. (2) A related-items condition with "none match" is true for an item without children. | M2 | M | Jira Automation (verify names) |
| AUT-004 | **Actions.** Taskmoor shall implement every action in section 1.4 as its module ships. | (1) Each action has an end-to-end test. (2) Edit item accepts any field, including custom fields, through the form and through advanced JSON. (3) Send web request exposes status, headers and body to later steps. | M2 | M | Jira Automation |
| AUT-005 | **Branches.** Taskmoor shall implement the branches of section 1.5 with nesting and sequential or parallel execution. | (1) A branch over linked "blocks" items acts on exactly those items. (2) A query branch over 20,000 items completes in pages without hitting a cap. | M2 | M | Jira Automation |
| AUT-006 | **Template language.** Taskmoor shall evaluate templates per section 1.6 in a sandbox with no file, network or process access. | (1) Every example in section 1.6 produces the documented output. (2) At least 95% of template expressions in an imported Jira rule corpus evaluate identically. (3) A template that loops forever stops at the evaluation time limit with a clear error. | M2 | M | Jira Automation |
| AUT-007 | **Variables, lookups and web requests.** Taskmoor shall provide variables, static and dynamic lookup tables, item lookups with paging, and outbound web requests with secret storage for credentials. | (1) A lookup of 3,000 items is available to later steps in full. (2) Secrets used in web request headers never appear in logs or audit output. | M2 | M | Jira Automation; exceeds Jira (100-result lookup) |
| AUT-008 | **Scheduled rules.** Taskmoor shall run rules on cron or interval schedules, optionally over the items of a query, without the 999-item cap and with one run at a time per rule by default. | (1) A schedule over 25,000 matching items processes all 25,000. (2) A run that starts while the previous run continues is skipped and logged. | M2 | M | Jira Automation; exceeds Jira |
| AUT-009 | **No metering, adjustable limits.** Taskmoor shall impose no usage metering and enforce only the admin-adjustable limits of section 1.7, reporting THROTTLED and LOOP outcomes in the audit log. | (1) A 200-step rule saves and runs. (2) A rule triggering itself 11 levels deep stops at level 10 with outcome LOOP. (3) No usage counter can stop rules. | M2 | M | exceeds Jira (65 steps, 999 items, step billing) |
| AUT-010 | **Reliable execution.** Taskmoor shall enqueue triggers through a transactional outbox, process at least once with idempotent actions, keep per-item ordering, survive restarts mid-delay, apply back-pressure instead of dropping, and scale across workers. | (1) Restarting all workers during 1,000 queued runs loses none and duplicates no side effect. (2) A 3-day delay resumes after a restart. (3) Events for one item run in order. | M2 | M | exceeds Jira |
| AUT-011 | **Audit log and debugger.** Taskmoor shall record each run with outcome (SUCCESS, NO_ACTIONS_PERFORMED, SOME_ERRORS, ABORTED, NO_MATCH, THROTTLED, LOOP), a step trace with evaluated template values and timings, and offer a dry run with a chosen test event. | (1) A dry run shows what each action would change without changing anything. (2) Run logs are kept for an admin-set period (default 90 days). | M2 | M | Jira Automation; exceeds Jira (debugger) |
| AUT-012 | **Templates and rule portability.** Taskmoor shall ship a library of rule templates, export and import rules as JSON, and import Jira automation rule exports. | (1) The template "close subtasks when parent is Done" works after one click. (2) An imported Jira rule either runs or lists the parts needing changes. | M2 | M | Jira Automation (export format verify) |
| AUT-013 | **Manual and webhook triggers.** Taskmoor shall support manual triggers from items and alerts with user input fields, and incoming webhook triggers authenticated by secret, exposing inputs and payload to templates. | (1) A manual rule asks for a reason and writes it into a comment. (2) A webhook call without the secret is rejected with 401. | M2 | M | Jira Automation |

## 3. Reference: extension points

| Area | Extension points (Forge module equivalents) |
|---|---|
| Item view | Panel; glance; context (side) panel; action (more menu); activity tab; background script; search-results action |
| Fields and data | Custom field; custom field type; entity property with query indexing; query function |
| Workflow | Condition; validator; post function; action validator |
| Agile | Board action; backlog action; sprint action |
| Pages | Global page; space page; space settings page; admin page; personal settings page; full page; command palette command |
| Dashboards | Gadget; background script |
| Platform | UI modifications (change field visibility, options and values on create, edit and transition screens); time tracking provider; global and space permissions; scheduled triggers; event listeners; web triggers (custom REST endpoints); AI tools exposed to agents and the MCP server |

## 4. EXT requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| EXT-001 | **Sandboxed server runtime.** Taskmoor shall run server extensions compiled to WebAssembly in a sandbox exposing only declared host functions (item and space API as the app identity, key-value and SQL storage, outbound HTTP to an allowlist, logging), with limits on CPU time, memory and wall-clock per invocation. | (1) An extension calling an undeclared host or domain is denied and logged. (2) An extension exceeding its memory limit is stopped without affecting the server. (3) Limits are admin-configurable per extension. | M2 | M | Atlassian Forge; Extism |
| EXT-002 | **Extension points.** Taskmoor shall offer every extension point in section 3. | (1) A sample extension for each point installs and renders or runs in tests. (2) A custom field type from an extension supports query operators it declares. | M2 | M | Forge Jira modules |
| EXT-003 | **UI extensions.** Taskmoor shall render UI extensions in sandboxed iframes with a strict content security policy, a message bridge to call permitted APIs, design tokens for theming and a TypeScript SDK (`@taskmoor/extension-sdk`). | (1) An iframe extension cannot read the host page's DOM or cookies. (2) Theme changes reach the extension through tokens. | M2 | M | Forge Custom UI |
| EXT-004 | **Scripting.** Taskmoor shall provide a TypeScript scripting environment for admins with a script console, scripted event listeners, scripted (calculated) fields that are indexed and searchable, scripted query functions, custom REST endpoints, scripted workflow functions, scheduled jobs, UI behaviours and bulk scripted changes with dry run. | (1) A scripted field computing days open is sortable and searchable. (2) A scripted query function `issueFunction`-style returns linked items and runs in under 1 s on 1M items (exact ScriptRunner names verify). (3) Every script run is audited with author and version. | M2 | M | ScriptRunner app |
| EXT-005 | **Packaging and lifecycle.** Taskmoor shall install extensions from signed packages declaring scopes, permissions, egress domains and extension points; require admin approval of scopes; support upgrade, disable, per-space enablement and uninstall with data removal; and allow offline install from a file. | (1) An unsigned package is rejected unless the admin enables unsigned installs. (2) An upgrade that adds scopes waits for admin approval. (3) Install works with no internet access. | M2 | M | Forge; exceeds Jira (offline install) |
| EXT-006 | **Extension storage.** Taskmoor shall give each extension key-value storage and its own SQL schema with admin-set quotas and no fixed per-install size cap. | (1) An extension stores 5 GB when the quota allows. (2) Uninstall with data removal deletes the schema. | M2 | M | Forge storage; exceeds Forge (1 GiB SQL cap) |
| EXT-007 | **Extension observability.** Taskmoor shall show per-extension invocation counts, errors, latency, log lines and resource use. | (1) An admin finds the last 100 errors of an extension with stack traces. | M2 | M | exceeds Jira |
| EXT-008 | **Integration connectors.** Taskmoor shall provide an n8n node and documented webhook-plus-API recipes for workflow tools, and two-way sync connectors to other Jira instances, ServiceNow, Azure DevOps and GitHub Issues. | (1) An n8n workflow creates and updates items through the node. (2) A two-way sync keeps summary, status and comments in step within 1 minute. | M4 | S | YouTrack n8n node; Exalate app |
| EXT-009 | **Extension registry.** Taskmoor shall provide a public extension registry with search, versions, signatures, compatibility ranges and ratings, plus a mirror mode for air-gapped sites. | (1) An admin installs from the registry in one step. (2) A mirrored registry serves packages with no internet access. A nice-to-have after the core product is finished (user decision, 2026-10-12): extensions install from files and URLs until then. | M4 | C | Atlassian Marketplace |

## 5. Reference: development data

- **Linked entities**: branches, commits, pull requests, reviews, builds, deployments (environment and status), feature flags (enabled state, rollout percentage), vulnerabilities, remote links, operations records (incidents, reviews), components.
- **Linking rule**: an entity links to an item when the item's key appears in the branch name, commit message or pull request title; a deployment links when any of its commits links.
- **Panel summary rules**: pull request status shows OPEN over MERGED over DECLINED; review states REVIEW, APPROVAL, SUMMARIZE, REJECTED, closed; builds show all passed or any failed.
- **Smart commit syntax**: `KEY #comment text`; `KEY #time 1w 2d 4h 30m comment`; `KEY #<transition name> #comment text`; several commands per commit and across lines.
- **Metrics**: items completed per week (8 weeks); overdue items; open bugs; pull request cycle time (median first commit to merge over 7 days); lead time for changes; deployment frequency (average production deployments per week over 12 weeks); open pull requests (30 days); critical vulnerabilities.

## 6. DEV requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| DEV-001 | **Tool connections.** Taskmoor shall connect to GitHub, GitLab, Bitbucket, Gitea, Forgejo, Azure DevOps and Jenkins (cloud and self-hosted) by app install, OAuth or webhook, with a per-space toolchain page. | (1) Connecting a self-hosted Gitea needs only its URL and a token. (2) The toolchain page lists connected tools and their last sync. | M2 | M | Jira Free; Kaneo |
| DEV-002 | **Development panel.** Taskmoor shall link development entities by the rule in section 5 and show them on the item with the panel summary rules, gated by the View development tools permission. | (1) A commit with ABC-12 in its message appears on ABC-12 within 30 s of the push. (2) An item with 500 commits pages through all of them (Jira shows the first 100). (3) Board cards show development status icons. | M2 | M | Jira Free; exceeds Jira |
| DEV-003 | **Ingestion API.** Taskmoor shall accept development information, builds, deployments, feature flags, remote links, security information, operations data and components through a typed API, usable by on-premises tools with client-credential tokens. | (1) A Jenkins job posting a deployment shows it on linked items and on the release. (2) Payloads matching Jira's ingestion API shapes are accepted (fixtures, verify). | M2 | M | Jira Software ingestion APIs |
| DEV-004 | **Create from item.** Taskmoor shall create branches and pull requests from an item in a chosen tool using an admin-set branch-name template that must include the key, and copy commit commands. | (1) "Create branch" in GitLab produces `feature/ABC-12-short-summary` under the default template. | M2 | M | Jira Free |
| DEV-005 | **Smart commits.** Taskmoor shall execute smart-commit commands (section 5) as the committer matched by email, reporting failures to the committer. | (1) `ABC-12 #time 2h #done #comment shipped` logs 2 hours, runs transition Done and adds the comment. (2) An unmatched committer email produces no change and a notice to admins. | M2 | M | Jira Free |
| DEV-006 | **Status rules and release tracking.** Taskmoor shall let spaces move items automatically on repository activity and record per item which environment and version a change has reached. | (1) Merging a pull request moves its item to In Review without an automation rule. (2) A production deployment marks linked items as released to production. | M2 | M | Kaneo; Linear Releases |
| DEV-007 | **Development page and DORA metrics.** Taskmoor shall show the metrics of section 5 per space and team, with a related-work tab of pull requests, vulnerabilities and deployments. | (1) Deployment frequency matches a fixture of deployment events. (2) Metrics work without CI data by showing item-based metrics only. | M2 | M | Jira Free (Development page) |
| DEV-008 | **Release hub and development queries.** Taskmoor shall show deployment and build status per version and expose development data in queries (for example items with open pull requests). | (1) A version page shows which items are deployed to which environment. (2) A query for items with failed builds returns them (Jira's `development[...]` syntax verify). | M2 | M | Jira Free |
| DEV-009 | **Service catalog with Backstage.** Taskmoor shall keep a service and component registry with owners and dependencies, import `catalog-info.yaml` from repositories and Backstage, and link components to items, on-call teams and changes. | (1) Importing a Backstage catalog creates components with owners. (2) An incident on a service shows its owning team's on-call. | M3 | M | Compass (retired); Backstage |
| DEV-010 | **Design links.** Taskmoor shall link design files from design tools to items and show previews and status. | (1) A pasted design URL shows a preview and last-updated time. | M4 | C | Jira design integrations |
