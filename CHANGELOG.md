# Changelog

Every release, newest first. The policy for versions, channels and support is
`docs/ops/releases.md`.

## 1.0.0 (unreleased)

The first release: a self-hosted work tracker with every feature included, compatible with
Jira's API and query language where people and tools expect them, and an importer that moves a
Data Center or Cloud instance across.

### Work tracking
- Tracks, ticket types and hierarchy levels; tickets with change history, rich text, comments
  (with role and group visibility, reactions, edit history), attachments, links, followers,
  votes, time tracking, clone and deep clone, trash and restore.
- Custom fields of every common type, with contexts, rules and layouts per track and type;
  formula fields and read-only info fields (first response, days since last comment).
- Priorities, close reasons, labels, releases, areas, teams and visibility levels; entity
  properties for integrations.

### Workflows
- Statuses and versioned workflows with transitions, guards, checks and effects; a visual
  editor; workflow maps per track; board-managed workflows for simple tracks; edit locks per
  state; export and import as files.

### Search and views
- A query language with a Jira-compatible dialect: fields, operators, functions, history
  operators ("was", "changed"), full-text search, saved searches with subscriptions.
- A query editor with autocomplete and inline errors; search results, list, calendar and
  timeline views; bulk edit, move, transition and delete as background jobs.

### Planning and reports
- Kanban and Scrum boards with drag and drop, work-in-progress limits and swimlanes; backlog
  planning, sprints, the releases hub.
- Sprint, flow, release and outcome reports; dashboards and track summaries.

### Collaboration
- Home page, inbox, mentions and activity; notification rules and email notifications with
  digests; live updates on every open screen; works offline and catches up.

### Identity and administration
- Passwords (Argon2id, breached-password check), two-factor sign-in (required for site
  administrators by default), OpenID Connect, SAML 2.0, LDAP and Active Directory, SCIM 2.0.
- Roles, access policies and an explainer for who may do what; an audit log; API tokens and
  service accounts; IP allowlists; rate limits; guardrails with a usage page; session lifetimes
  as an administrator setting.
- Skins, English and Spanish, right-to-left layouts, WCAG 2.1 AA.

### APIs and integrations
- REST API v1 with an OpenAPI document and a TypeScript SDK; an async bulk API; webhooks; an
  MCP server with OAuth.
- A Jira-compatible API (core and Agile, wiki markup) for existing tools and scripts.

### AI (optional)
- An AI gateway for Claude (Anthropic API, Bedrock, Vertex AI, Foundry) and OpenAI-compatible
  servers, with spend limits, redaction, audit and per-feature switches. Nothing is sent
  anywhere until an administrator configures a provider.
- Ticket and thread summaries, natural language to query, drafts and breakdowns, and duplicate
  suggestions. Similar tickets work without any provider, through a bundled embedding model.

### Import and export
- Data Center import from a backup or the database, Cloud import over REST, CSV import and a
  full export; delta re-sync for the cutover; a wizard and a CLI; earlier keys keep working.

### Install and operations
- The Builder: one page that produces the backend kit and the frontend kit; Docker Compose kits
  (bundled or external PostgreSQL), an all-in-one image, a Helm chart and an air-gap bundle with
  a signed checksum list and an SBOM.
- One-command install and upgrade (backup, migrations, roll back on failure, three releases in
  one step), scheduled backups, restore drills, a health page, metrics and traces.

### Measured
- At 1M tickets on four cores: every search of the 50-query set under 171 ms (p95), a ticket
  opens in 15 ms, a 5,000-card board is usable in 0.3 s; 10M and 30M are documented estimates
  (`docs/spikes/estimates-10m-30m.md`).
