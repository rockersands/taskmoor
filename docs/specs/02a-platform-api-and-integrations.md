---
spec: 02a
title: "Platform, API and integrations: APIs, compatibility shim, webhooks, MCP and migration"
sources: docs/research/sources.md
accessed: 2026-10-11
attestation: own-words
---
# 02a Platform, API and integrations: APIs, compatibility shim, webhooks, MCP and migration

This file specifies the programmable surface of Tracksmith (a working name for the product) and the way customers move in and out: the native REST API, the Jira-compatible API shim that keeps existing scripts and integrations working, webhooks, the built-in MCP server, the command-line client, and the importers for Jira Data Center, Server and Cloud plus full export. The importer is the product's main acquisition channel before Jira Data Center turns read-only on 28 March 2029, so it must carry more than Atlassian's own migration assistant, including what that tool drops. Files 02b (automation, extensions, development tools) and 02c (AI) complete the platform.

## How to read

- **ID**: `MODULE-NNN`, stable and never reused. This file holds API and IMP.
- **MS**: M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must, S = Should, C = Could.
- **Source**: parity target. "exceeds Jira" marks a deliberate improvement over a documented Jira limit; "verify" marks a fact the research flagged as unconfirmed. The research did not capture exact Jira endpoint paths and payloads beyond those named below; build the shim from recorded request and response fixtures, not from Atlassian documentation text (clean-room rule).
- **Terms**: work item = issue, space = project, work type = issue type.

## 1. Reference: API catalog

### 1.1 Native API principles

1. Base path `/api/v1`; JSON; an OpenAPI 3.1 document is published and generated client libraries (for example `@tracksmith/api-client`) are released with each version.
2. API first: the web and mobile clients use only public API calls, so every UI action has an API equivalent.
3. Cursor pagination: `cursor` and `limit` (max 1,000) in, `next_cursor` and `has_more` out; `count=approx` or `count=exact` adds a total.
4. Errors use RFC 9457 problem documents with stable machine-readable codes.
5. `ETag` on every resource; updates accept `If-Match` and return 412 on a stale version.
6. `Idempotency-Key` on POST: a repeat within 24 hours returns the first response.
7. Sparse fields (`fields=`) and expansions (`expand=`).
8. Rich text negotiated by `format=` (doc, markdown, html, adf, wiki) on read and write (API-011).
9. Timestamps are ISO 8601 UTC; durations are seconds.
10. Additive changes only within a major version; a deprecated version stays available at least 24 months.
11. Rate-limit responses are 429 with `Retry-After` and `RateLimit-*` headers.

### 1.2 Jira-compatible shim families

| Family | Paths and behaviour | MS |
|---|---|---|
| Work items | `/rest/api/2` and `/rest/api/3`: issue create, get, edit, delete; transitions list and execute; comments; worklogs; attachments; watchers; votes; remote links; properties; changelog; `/issue/bulk` (create); `/issue/bulkfetch`. v2 carries wiki markup, v3 carries ADF; `expand` options such as renderedFields, changelog, names, schema, transitions, editmeta and versionedRepresentations (verify) | M1 |
| Search | `/search/jql` with `nextPageToken` and `isLast`, no total; the legacy offset search `/search` with `startAt`, `maxResults` and `total` is kept (Atlassian removed it from Cloud in 2025 and it returns 410 there; Data Center scripts still call it) | M1 |
| Async bulk | `/bulk/issues/transition`, `/bulk/issues/move`, `/bulk/issues/fields`, `/bulk/issues/delete` returning a task id; `/bulk/queue/{taskId}` for progress, kept at least 14 days | M1 |
| Spaces | Project create, read, update, archive; components; versions; roles and actors; categories; project types | M1 |
| Configuration | Issue types and schemes; fields, custom field contexts and options; screens and schemes; workflows and workflow schemes; statuses; priorities; resolutions; link types; security schemes and levels; permission schemes; notification schemes | M1 |
| Filters and dashboards | Filters with share permissions and favourites; dashboards and gadgets (verify shapes) | M1 |
| Users and permissions | User search, current user, groups and members, my permissions, server info | M1 |
| Webhooks | `/rest/webhooks/1.0/webhook` (admin registration) and dynamic registration for apps | M1 |
| Agile | `/rest/agile/1.0`: board (configuration, items, backlog, sprints, epics), backlog, sprint (CRUD, items, start, complete), epic, issue (rank, estimation) | M1 |
| DevOps ingestion | Development information, builds, deployments, feature flags, remote links, security information, operations, DevOps components (file 02b; paths verify) | M2 |
| Service desk | `/rest/servicedeskapi` (not researched; verify every endpoint) | M2 |
| Assets | Assets object API (not researched; verify) | M3 |

Shim authentication: Basic with email and API token, Bearer personal token, OAuth 2.0. Shim error bodies and rate-limit headers (`Retry-After`, `RateLimit-Reason`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-NearLimit`) follow Jira's shapes as captured in fixtures.

### 1.3 Webhook event catalog

Work item created, updated, deleted; item property set, deleted; worklog created, updated, deleted; comment created, updated, deleted; attachment created, deleted; link created, deleted; work type created, updated, deleted; space created, updated, deleted, trashed, restored, archived, unarchived; version created, updated, moved, released, unreleased, merged, deleted; filter created, updated, deleted; user created, updated, deleted; sprint created, updated, deleted, started, closed; board created, updated, deleted, configuration changed; site option changed (voting, watching, unassigned items, subtasks, linking, time tracking). Native-only events add transition executed, sprint scope changed, approval requested and decided, SLA threshold, alert events and CMDB object events. Shim event identifiers follow Jira's names as captured in fixtures (verify); native names use `work_item.created` style.

## 2. API requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| API-001 | **Native REST API.** Tracksmith shall expose all functionality through a versioned REST API following section 1.1. | (1) A contract test confirms every UI action used in end-to-end tests has a matching public endpoint. (2) The OpenAPI document validates and generated clients compile. (3) A repeated POST with the same Idempotency-Key creates one item. | M1 | M | Jira Free |
| API-002 | **API authentication.** Tracksmith shall accept session cookies (web only), scoped expiring personal tokens, service-account tokens, OAuth 2.0 authorization code with PKCE and client credentials, and Basic email-plus-token on the shim. | (1) A token scoped read-only cannot write (403). (2) An expired token is rejected with a clear error. (3) OAuth consent lists the requested scopes. | M1 | M | Jira Free |
| API-003 | **Shim v2.** Tracksmith shall serve the `/rest/api/2` families of section 1.2 with wiki-markup rich text. | (1) A recorded suite of at least 500 request/response fixtures from real Jira scripts passes with field-level equality on documented fields. (2) Unknown or unsupported parameters return a Jira-style error, never a silent wrong result. | M1 | M | Jira Free |
| API-004 | **Shim v3 with ADF.** Tracksmith shall serve the same operations under `/rest/api/3` with Atlassian Document Format for rich text. | (1) v2 and v3 return the same item with only rich-text representation differing. (2) ADF written through v3 reads back identically. | M1 | M | Jira Free |
| API-005 | **Shim search.** Tracksmith shall serve token-paged `/search/jql`, legacy offset `/search` and `/issue/bulkfetch`, both with the compatible query dialect (file 01b). | (1) Paging 50,000 results with nextPageToken returns each item once. (2) Legacy `startAt`/`maxResults` returns a correct `total`. | M1 | M | Jira Free; exceeds Jira (legacy search removed in Cloud) |
| API-006 | **Agile shim.** Tracksmith shall serve `/rest/agile/1.0` board, backlog, sprint, epic and issue operations, including rank. | (1) Creating, starting and completing a sprint through the shim matches the UI result. (2) Rank before and after another item works. | M1 | M | Jira Free |
| API-007 | **Async bulk APIs.** Tracksmith shall run bulk transition, move, field edit and delete as tasks with a polling endpoint, with configurable item limits (default 10,000). | (1) Bulk transition of 1,000 items with mixed transition ids returns a task that reports per-item results. (2) Task status remains readable for 14 days. | M1 | M | Jira Free; exceeds Jira (1,000 cap) |
| API-008 | **Service desk shim.** Tracksmith shall serve the Jira Service Management REST API for request types, requests, customers, organizations, approvals, queues and SLAs. | (1) The top 20 endpoints by usage in design-partner scripts pass fixture tests. | M2 | M | JSM (endpoint list verify) |
| API-009 | **Webhooks.** Tracksmith shall deliver the events of section 1.3 to registered HTTPS endpoints with full query-language filters, an HMAC-SHA256 signature header (`X-Hub-Signature: sha256=...` on the shim), a unique delivery id for deduplication, up to 5 retries with backoff on 408, 409, 425, 429 and 5xx, a failed-delivery list with replay, and no expiry. | (1) A filter using any query clause, including custom fields and functions, filters deliveries. (2) A receiver verifying the signature with the shared secret accepts every delivery. (3) Deliveries land within 5 s p95, and a replayed delivery carries the original id. | M1 | M | Jira Free; exceeds Jira (filter clause subset, 30-day expiry) |
| API-010 | **Rate limits and usage visibility.** Tracksmith shall apply configurable token-bucket limits per token, app, user and IP, plus a per-item write limit, and show admins a dashboard of request counts, errors and throttling per client. | (1) Exceeding a limit returns 429 with Retry-After. (2) The dashboard shows the top 20 clients by requests over the last hour and day. (3) Defaults never throttle a single user at under 20 requests per second. | M1 | M | exceeds Jira (QuotaWatch app fills this gap) |
| API-011 | **Rich text formats on the API.** Tracksmith shall accept and return rich text as canonical document, Markdown, HTML, ADF or wiki markup, selected per request. | (1) Writing Markdown and reading ADF yields equivalent content. (2) Plain-text output strips formatting for ETL use. | M1 | M | exceeds Jira (no Markdown output) |
| API-012 | **MCP server.** Tracksmith shall ship a free, built-in MCP server over streamable HTTP (OAuth 2.1 or personal token) and local stdio, with tools to search, read, create, update, transition, comment on and link items and to list spaces, boards, sprints and knowledge articles; admins allowlist clients and pick a tool profile (read-only, planner, full); every call is audited. | (1) An MCP client lists tools and creates an item that appears in the UI. (2) A read-only profile rejects write tools. (3) Each call writes an audit record with client, user and tool. | M1 | M | Rovo MCP server; Plane; exceeds OpenProject (paid MCP) |
| API-013 | **Entity properties.** Tracksmith shall store arbitrary JSON properties on items, spaces, users, boards and sprints, readable and writable through the API, with declared properties indexed for queries. | (1) A property set through the shim is returned by both the shim and the native API. (2) A declared indexed property can be queried. | M1 | M | Jira Free |
| API-014 | **Compatibility matrix and contract tests.** Tracksmith shall publish, per shim endpoint, whether it is complete, partial or missing, and run nightly contract tests against fixture recordings. | (1) The matrix is generated from test results, never edited by hand. (2) A regression in any fixture fails the release build. | M1 | M | exceeds Jira |
| API-015 | **Command-line client.** Tracksmith shall provide a CLI for search, create, edit, transition, import, export, backup and admin tasks, authenticating with tokens. | (1) `tracksmith search "assignee = currentUser()"` prints results as table or JSON. (2) The CLI runs in air-gapped environments with no extra downloads. | M1 | S | Atlassian CLI; Kaneo |
| API-016 | **Change feed.** Tracksmith shall expose an ordered, resumable feed of entity changes per workspace (monotonic sequence number), filtered by the caller's permissions. | (1) A consumer resuming from sequence N receives every later change exactly once in order. (2) Changes to items the caller cannot browse are omitted. | M1 | S | Linear sync engine |
| API-017 | **Public meta endpoint.** The Tracksmith backend shall serve an unauthenticated meta endpoint returning API version, minimum and recommended frontend kit versions, enabled sign-in methods with public SSO details (issuer, client id, authorize URL; no secrets), instance id, instance name and instance public key, and shall sign a caller-supplied nonce with the instance private key so a frontend kit can prove it reached the backend named in its connection manifest (file 05b, OPS-014). | (1) The response validates against a published schema and contains no secret value. (2) A frontend kit built for instance A refuses to run against instance B because the id or signature check fails. (3) It answers within 100 ms and is reachable cross-origin from every allowed frontend origin. | M1 | M | User requirement (Builder) |
| API-018 | **Frontend compatibility window.** The Tracksmith backend shall serve its current API version and the previous one (N-1), so a frontend kit built for the previous backend release keeps working after a backend upgrade. | (1) The end-to-end suite of release N-1's frontend kit passes against backend N. (2) A kit older than N-1 shows an "update required" screen instead of failing silently. | M1 | M | User requirement (Builder) |

## 3. Reference: importer mapping

| Jira entity | Target | DC/Server XML | Cloud REST | Note |
|---|---|---|---|---|
| Projects, categories, avatars | Spaces, categories | Yes | Yes | Atlassian's tool drops project avatars |
| Issue types, icons, schemes, hierarchy | Work types, levels, type sets | Yes | Yes | Icons dropped by Atlassian's tool |
| Issues with all system fields, archived issues | Work items | Yes | Yes | |
| Custom fields, contexts, options (incl. issue picker) | Fields, contexts | Yes | Yes | Some types dropped by Atlassian's tool |
| Change history | History | Yes | Yes (per-item changelog) | Bulk changelog endpoint unverified |
| Comments (restricted), reactions | Comments | Yes | Yes | Reactions dropped by Atlassian's tool |
| Worklogs | Worklogs | Yes | Yes (per-item calls; new search omits some data) | |
| Attachments, thumbnails | Attachments | Yes (`data/`) | Yes (download) | SSO-protected DC downloads need an admin token |
| Links, link types, remote links | Links | Yes | Yes | |
| Watchers, votes | Watchers, votes | Yes | Yes | |
| Key history of moved issues | Key aliases | Yes | verify | Redirects dropped by Atlassian's tool |
| Rank, sprints, versions, components | Same | Yes | Yes | |
| Boards incl. multi-project, columns, swimlanes, quick filters, card colours, Kanban sub-filters | Boards | Yes | Yes (Agile API) | Multi-project boards and sub-filters dropped by Atlassian's tool |
| Filters incl. multi-project and shared ones, column layouts | Filters, column sets | Yes | Yes | Dropped by Atlassian's tool |
| Filter subscriptions | Subscriptions | Yes | verify | Dropped by Atlassian's tool |
| Dashboards and gadgets incl. system dashboard | Dashboards | Yes | verify | Dropped by Atlassian's tool |
| Workflows with functions, properties, triggers, layout | Workflows | Yes | Yes | Function properties, triggers and layout dropped by Atlassian's tool |
| Screens, tabs, screen schemes; field configurations and schemes | Layout sets; field schemes | Yes | Yes | |
| Permission schemes, project roles, global permissions | Permission policies, roles, global grants | Yes | Yes | Global permissions dropped by Atlassian's tool |
| Notification schemes, custom events | Notification policies, events | Yes | Yes | Custom events dropped by Atlassian's tool |
| Issue security schemes and levels | Security level sets | Yes | Yes | |
| Priorities, priority schemes, resolutions, statuses, translations | Same | Yes | Yes (translations verify) | Translations dropped by Atlassian's tool |
| Users (active, inactive, deleted), avatars, time zones, properties | Users | Yes | Yes (emails may be hidden) | Avatars, time zones, properties dropped by Atlassian's tool |
| Groups, memberships, role actors | Groups, role actors | Yes | Yes | |
| Webhooks | Webhooks (disabled until reviewed) | Yes | Yes | Dropped by Atlassian's tool |
| Mail handlers, issue collectors | Email channels, forms | Yes | verify | Dropped by Atlassian's tool |
| General configuration (time tracking, attachments, linking) | Site settings | Yes | Partial | Dropped by Atlassian's tool |
| Automation rules, plans with scenarios and views, service desk data, forms, Tempo worklogs | M2 modules (IMP-016) | Yes (app tables, verify) | Partial (verify) | Scenarios, views and classic plans dropped by Atlassian's tool |
| Assets objects; Opsgenie configuration | M3 modules (IMP-017) | verify | verify | |
| Xray and Zephyr tests; Product Discovery ideas | M4 modules (IMP-018) | verify | verify | |
| Fields of apps without an importer | Read-only text fields holding raw values | Yes | Yes | Dropped by Atlassian's tool |

## 4. IMP requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| IMP-001 | **XML backup importer.** Tracksmith shall import Jira Server and Data Center backups and Jira Cloud backup exports (ZIP with `entities.xml`, `activeobjects.xml` and `data/`), streaming the XML and cleaning control characters, 0xFFFE, 0xFFFF and NULL bytes. | (1) A 50 GB backup imports with memory use under 4 GB. (2) A file containing NULL bytes and 0xFFFF imports with the bad characters removed and logged. (3) Backups from every Jira version in the design-partner corpus import (verify version range). | M1 | M | Jira DC backup format |
| IMP-002 | **Cloud REST importer.** Tracksmith shall pull Jira Cloud data with the customer's own API token using token-paged search, bulk fetch and per-item changelog, comment, worklog and attachment calls, honouring Retry-After and burst limits. | (1) A 1M-item site imports in at most 3 days at 20 to 50 requests per second. (2) A 429 pauses that worker for the Retry-After period and resumes. (3) Requests run only against the customer's own site with the customer's own token. | M1 | M | Jira Cloud REST |
| IMP-003 | **DC database reader.** Tracksmith shall read a Jira DC database directly (PostgreSQL, MySQL, Oracle, SQL Server) for instances that can no longer produce backups. | (1) An import from a read-only database matches an XML import of the same instance. | M2 | S | Jira DC end of life |
| IMP-004 | **Entity coverage.** Tracksmith shall import every row of section 3 marked for M1. | (1) An automated check confirms a non-zero imported count for each entity present in the fixture backup. (2) Entities Atlassian's tool drops (dashboards, multi-project boards and filters, subscriptions, webhooks, global permissions, archived projects, custom events) are imported. | M1 | M | exceeds Jira's migration assistant |
| IMP-005 | **Configuration normalisation.** Tracksmith shall map Jira schemes into the target model (file 01a), merge identical objects, and report every merge, rename and unsupported setting. | (1) 40 identical permission schemes become one shared policy used by 40 spaces. (2) The report lists each unsupported setting with item counts affected. | M1 | M | exceeds Jira |
| IMP-006 | **Query translation.** Tracksmith shall translate saved filters, board filters, quick filters, swimlane queries, subscriptions and gadget queries, re-pointing ids to imported objects. | (1) Each translated query parses. (2) Untranslatable functions are listed with the filters using them. (3) With a Cloud source, translated filters return the same count as Jira for at least 99% of filters. | M1 | M | exceeds Jira |
| IMP-007 | **User and group mapping.** Tracksmith shall match users by email, DC username or user key, or Cloud account id, accept an admin CSV map where emails are hidden, use pre-provisioned SCIM users, and create inactive placeholder users for unmatched or deleted accounts so attribution is kept. | (1) Every comment, worklog and history entry keeps its author after import. (2) A CSV mapping Cloud account ids to emails links imported content to existing SSO users. | M1 | M | Jira Free |
| IMP-008 | **Rich text conversion.** Tracksmith shall convert ADF and wiki markup into the canonical format, re-map mentions to new user ids and inline images to imported attachments, and keep the original source alongside. | (1) Mentions in imported comments point to the mapped users. (2) Inline images render. (3) The original ADF or wiki markup is retrievable through the API. | M1 | M | Jira Free |
| IMP-009 | **Idempotent, resumable, incremental import.** Tracksmith shall key every imported entity by source system and source id, resume after interruption from a checkpoint, re-run to update rather than duplicate, sync deltas with `updated >= last run` during a cutover window, and offer a dry run. | (1) Killing the importer at a random point and restarting yields the same final state as an uninterrupted run. (2) A second run creates no duplicates. (3) A delta run picks up an item edited in Jira after the first run. | M1 | M | Plane importer; exceeds Jira |
| IMP-010 | **Fidelity verification.** Tracksmith shall produce a report comparing source and target counts per entity, checksums on samples of fields, comments and attachments, and a warning list. | (1) A 1M-item DC backup imports with at least 99.9% entity fidelity measured by this report. (2) The report exports as HTML and JSON. | M1 | M | exceeds Jira |
| IMP-011 | **Keys and URL redirects.** Tracksmith shall keep space keys, item numbers and key aliases, and redirect Jira URL patterns (for example `/browse/KEY-123`) to the imported items. | (1) Visiting `/browse/ABC-42` on the new host opens imported ABC-42. (2) An item moved in Jira from OLD-5 to NEW-9 is reachable by both keys. | M1 | M | Jira Free |
| IMP-012 | **CSV and JSON import.** Tracksmith shall import CSV with a field mapping UI, create-or-update by key, hierarchy via a parent column and saved mapping templates, plus the Jira JSON import format (verify format). | (1) A CSV with 100,000 rows and a parent column imports with correct hierarchy. (2) Re-importing the same CSV with changes updates items. | M1 | M | Jira Free |
| IMP-013 | **Migration console.** Tracksmith shall run imports as background jobs from a wizard and the CLI, with progress, throughput, pause, resume, cancel and downloadable logs. | (1) Progress shows entities done and remaining per type. (2) Pause and resume lose no data. | M1 | M | Jira Free |
| IMP-014 | **Full export.** Tracksmith shall export the whole site or chosen spaces at any time, without throttling, as documented NDJSON plus attachments, and also as Jira-compatible CSV. | (1) Exporting then importing into an empty instance reproduces items, history, comments, attachments and configuration. (2) The export format is documented and versioned. | M1 | M | exceeds Jira |
| IMP-015 | **Other tracker importers.** Tracksmith shall import from Trello, Asana, ClickUp, monday.com, Linear, GitHub Issues, GitLab, Azure DevOps, YouTrack, Notion, Smartsheet, Wrike, Airtable, Plane, OpenProject and Redmine. | (1) Each importer brings items, comments, attachments, assignees and statuses for a fixture export. | M2 | S | Jira Cloud importers; WeKan |
| IMP-016 | **M2 product data import.** Tracksmith shall import Jira automation rules, Plans (including scenarios and saved views), service-desk data (request types, portals, queues, SLAs, customers, organizations, canned responses), forms and Tempo worklogs and accounts. | (1) Imported automation rules run in the M2 engine or are listed as needing changes. (2) SLA timers on imported open requests continue from their Jira elapsed time. | M2 | M | Jira Premium; JSM; Tempo app |
| IMP-017 | **M3 product data import.** Tracksmith shall import Assets/Insight schemas and objects and Opsgenie teams, schedules, escalations, routing rules, integrations and alert history. | (1) Object references survive import. (2) An imported schedule shows the same on-call person as Opsgenie for the next 30 days. | M3 | M | JSM Assets; Opsgenie |
| IMP-018 | **M4 product data import.** Tracksmith shall import Xray and Zephyr test data and Jira Product Discovery ideas, insights and views. | (1) Test executions keep step results and defect links. (2) Ideas keep insights and delivery links. | M4 | M | Xray, Zephyr apps; JPD |
