# Architecture decision records

Numbers follow the ADR table in the [build plan](../plan/build-plan.md#5-architecture-and-stack).
Records not yet written are listed in the plan with their intended decision. Use
[template.md](template.md) for new ones.

| ADR | Title | Status |
|---|---|---|
| [001](0001-record-decisions.md) | Record architecture decisions as ADRs | Accepted |
| [002](0002-licence-and-contributions.md) | Licence and contribution model | Accepted |
| [003](0003-clean-room.md) | Clean-room rules | Accepted |
| [004](0004-monorepo-and-toolchain.md) | Monorepo layout and toolchain | Accepted |
| [005](0005-typescript-end-to-end.md) | TypeScript end to end | Accepted |
| [006](0006-postgres-only.md) | PostgreSQL 16+ as the only required service | Accepted |
| [007](0007-sql-builder-and-migrations.md) | Typed SQL builder and SQL migrations | Accepted |
| [008](0008-field-storage.md) | Custom field storage: JSONB on the ticket plus typed side tables | Accepted |
| [009](0009-configuration-model.md) | One configuration model | Accepted |
| [010](0010-query-compiler.md) | Query language: own grammar, AST, resolver and SQL compiler with a permission pre-filter | Accepted |
| [011](0011-search.md) | Search in Postgres, with an optional OpenSearch adapter | Accepted |
| [012](0012-authorization-engine.md) | Authorization engine: in-process evaluator over Postgres with a permission cache | Accepted |
| [013](0013-sync-engine.md) | Sync engine: in-house change log with a commit-ordered sequence | Accepted |
| [014](0014-rich-text-model.md) | Rich text model and collaboration | Accepted |
| [015](0015-job-queue-and-outbox.md) | Job queue and transactional outbox in Postgres | Accepted |
| [016](0016-api-contract-and-compat-shim.md) | Contract-first native API and a separate Jira-compatible shim | Accepted |
| [017](0017-webhooks.md) | Webhooks with signatures, idempotency, replay and no expiry | Accepted |
| [018](0018-mcp-server.md) | Built-in MCP server over the native API | Accepted |
| [019](0019-identity.md) | Identity: OIDC, SAML, LDAP, SCIM, TOTP and WebAuthn, all free | Accepted |
| [020](0020-file-storage.md) | File storage through the S3 API with a local-disk fallback | Accepted |
| [021](0021-delivery-and-images.md) | One multi-arch image, a static frontend, Compose and Helm kits, signed air-gap bundle | Accepted |
| [022](0022-upgrades-and-migrations.md) | Forward-only expand/contract migrations, pre-flight checks and automatic backup | Accepted |
| [023](0023-observability.md) | Observability with OpenTelemetry, Prometheus and structured logs | Accepted |
| [024](0024-i18n-and-accessibility.md) | Internationalisation and accessibility | Accepted |
| [025](0025-importer.md) | Importer: staged and idempotent, streaming DC XML, Cloud REST with the customer's token | Accepted |
| [026](0026-extensions.md) | Extensions as WASM in Extism, UI slots in sandboxed iframes | Accepted |
| [027](0027-analytics-store.md) | Analytics store with daily snapshots over OData | Accepted |
| [028](0028-ai-provider-gateway.md) | AI provider gateway | Accepted |
| [029](0029-supply-chain-gates.md) | Supply-chain gates | Accepted |
| [030](0030-test-strategy.md) | Test strategy and the verify gate | Accepted |
| [031](0031-builder-and-two-kits.md) | The Builder, two kits and a signed connection manifest | Accepted |
| [032](0032-cross-origin-auth-and-versioning.md) | Cross-origin authentication and frontend version compatibility | Accepted |
| [033](0033-desktop-first-responsive-ui.md) | Desktop-first, responsive UI | Accepted |
| [034](0034-audit-log.md) | Audit log: one hash chain per workspace in monthly partitions | Accepted |
| [035](0035-api-tokens-and-service-accounts.md) | API tokens and service accounts: prefixed, hashed, scoped and expiring | Accepted |
| [036](0036-skins-and-soft-visual-language.md) | Skins and the soft visual language | Accepted |
| [037](0037-global-rank.md) | Global rank with fractional keys and a sequence for new tickets | Accepted |
| [038](0038-scim-provisioning.md) | SCIM provisioning through a service account's scim token | Accepted |
| [039](0039-workflows-as-versioned-data.md) | Workflows as versioned data with instant publish | Accepted |
| [040](0040-attachment-storage.md) | Attachment storage: random keys, streamed uploads, signed URLs, a scan hook | Accepted |
| [041](0041-notification-recipients.md) | Notification recipients resolved by a bus subscriber, redacted per recipient | Accepted |
| [042](0042-edit-locks.md) | Per-status locks and per-field edit permissions, explained to the person | Accepted |
| [043](0043-bulk-operations.md) | Bulk operations run through the ticket routes, as the person who asked | Accepted |
| [044](0044-comments.md) | Comments, their restriction, versions and reactions | Accepted |
| [045](0045-workflow-maps.md) | Workflow maps, track-local workflows and background status migration | Accepted |
| [046](0046-home-create-dialog-palette.md) | The home page, the create dialog and a palette that reaches every action | Accepted |
| [047](0047-inbox-mentions-activity.md) | The in-app inbox, mentions and activity streams | Accepted |
| [048](0048-importer-framework.md) | The importer framework: extract, map and load in resumable batches | Accepted |
| [049](0049-boards.md) | Boards on a query, read through the search compiler, moved through the ticket routes | Accepted |
| [051](0051-configuration-guardrails.md) | Configuration guardrails | Accepted |
| [052](0052-search-results.md) | Search results: columns, inline edit and streaming export | Accepted |
| [053](0053-saved-searches.md) | Saved searches: sharing, references and subscriptions | Accepted |
| [054](0054-sprints.md) | Sprints owned by a board, membership rows and scope-change rows | Accepted |
| [055](0055-webhooks.md) | Webhooks as event-bus subscribers with recorded, replayable deliveries | Accepted |
| [056](0056-report-event-store.md) | The report event store reads the change history and sprint changes | Accepted |
| [057](0057-sprint-charts.md) | Sprint charts computed from report events, drawn as plain SVG on chart tokens | Accepted |

ADR-008 and ADR-010 become Accepted when the 10M-ticket runs (M0-016, M0-017) confirm their budgets.
