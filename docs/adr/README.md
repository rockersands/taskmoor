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
| [058](0058-flow-reports.md) | Flow reports from status changes, cycle time over chosen columns | Accepted |
| [059](0059-general-and-release-reports.md) | General reports counted in SQL; release and outcome burndowns from report events | Accepted |
| [060](0060-dashboards.md) | Dashboards as owned pages of typed widgets, shared like saved searches | Accepted |
| [061](0061-releases-hub.md) | The releases hub reads releases through the search runner and generates notes | Accepted |
| [062](0062-track-templates.md) | Track templates as recipes over the create route, and configuration copied by reference | Accepted |
| [063](0063-full-export-format.md) | Full export as canonical NDJSON with source ids, imported verbatim; checked by a translated re-export | Accepted |
| [064](0064-timeline.md) | The timeline reads dates and roll-ups in one request and reschedules through tickets | Accepted |
| [065](0065-list-and-calendar-views.md) | List and calendar views over search, format rules as query conditions | Accepted |
| [066](0066-frontend-artefact-and-runtime-config.md) | The frontend as a versioned artefact with a runtime-config slot and two routing modes | Accepted |
| [067](0067-rest-api-v1.md) | REST API v1 as a written contract of stable operations over the server's own schemas | Accepted |
| [068](0068-mcp-server.md) | A built-in MCP tool server over the REST API, as the caller | Accepted |
| [069](0069-full-text-search.md) | Full-text search: stemmed word columns, the search syntax as tsquery, relevance, and counts estimated from block samples | Accepted |
| [070](0070-meta-endpoint-and-version-window.md) | The meta endpoint, the instance identity and the frontend version window | Accepted |
| [071](0071-speed-limits-in-the-benchmark-run.md) | Speed limits are measured in the gate and enforced in the benchmark run | Accepted |
| [072](0072-synthetic-dc-backups.md) | Synthetic Data Center backups from a seeded streaming generator, with a manifest of exact counts | Accepted |
| [073](0073-workflow-files.md) | Workflow files: the stored definition with document ids and name tables, mapped by name and never widened | Accepted |
| [074](0074-offline-manual.md) | The manual is Markdown with provenance, built into an offline bundle by our own script | Accepted |
| [075](0075-rate-limits.md) | Rate limits as in-process token buckets, with usage counted per minute | Accepted |
| [076](0076-teams.md) | Teams: their own table, named by id everywhere, granting nothing | Accepted |
| [077](0077-clone-and-deep-clone.md) | Clone and deep clone run as a bulk operation, each copy made through the create route | Accepted |
| [078](0078-allowlists-and-syslog.md) | IP allowlists matched in each process, and the audit log forwarded to syslog by cursor | Accepted |
| [079](0079-board-managed-workflows.md) | Board-managed workflows as ordinary workflows the board rewrites | Accepted |
| [080](0080-cross-origin-auth.md) | Cross-origin sign-in with the backend's cookie on one site and OAuth across sites | Accepted |
| [081](0081-dc-backup-mapping.md) | The Data Center backup import: a streaming stage of per-kind files, and a mapping report by name | Accepted |
| [082](0082-load-tests.md) | Load tests with k6 against the real server, and a sizing table computed from them | Accepted |
| [083](0083-entity-properties.md) | Entity properties in a table per entity kind, and declared indexes in typed side tables | Accepted |
| [084](0084-oauth-for-mcp-clients.md) | OAuth for MCP clients through self-registration, consent at the browser and tokens bound to the MCP endpoint | Accepted |
| [085](0085-jira-compat-contract-suite.md) | The Jira-compatible API's contract as our own operations and synthetic cases, with a generated matrix | Accepted |
| [086](0086-jira-compat-shim.md) | The Jira-compatible API as routes that call the native API in-process, with token sign-in only | Accepted |
| [087](0087-registered-frontend-origins.md) | Registered frontend origins in the database, read by the origin policy with a short cache, and versions the frontends report | Accepted |
| [088](0088-builder-page.md) | The Builder page as a second entry of the web app, built into one offline file | Accepted |
| [089](0089-dc-fields-and-forms.md) | The Data Center import of custom fields and forms, and tickets carrying their values | Accepted |
| [090](0090-dc-access-and-visibility.md) | The Data Center import of permissions, issue security, notifications and global permissions | Accepted |
| [091](0091-wiki-markup-converter.md) | Wiki markup as a rich-text format of its own, with a reader and writer that agree | Accepted |
| [092](0092-dc-ticket-content.md) | The Data Center import of an issue's content: a stage that spills to buckets, content kinds, and fidelity against the fixture | Accepted |
| [093](0093-dc-workflows.md) | The Data Center import of workflows and workflow schemes, with every rule mapped or held and reported | Accepted |
| [094](0094-cloud-rest-import.md) | The Cloud REST importer: a resumable fetch into a staging table, throttled as the source asks | Accepted |
| [095](0095-dc-boards-and-sprints.md) | The Data Center import of boards, sprints, rank, releases and areas: queries translated and checked, rank keys that keep the order | Accepted |
| [096](0096-dc-filters-and-query-translation.md) | Translating saved filters, dashboards and subscriptions from a Data Center backup | Accepted |
| [097](0097-imported-keys-and-links.md) | Keys and links from the tracker an import came from | Accepted |
| [098](0098-ai-key-storage.md) | AI provider keys under envelope encryption, write-only, moved in from the environment, rotated without failed calls | Accepted |
| [099](0099-ai-settings-page.md) | The AI settings page: provider, write-only keys, live test connection, per-feature model and effort, and switches enforced at one choke point | Accepted |
| [100](0100-ai-spend-audit-redaction.md) | AI spend limits, the AI audit log and redaction, in the gateway's call path | Accepted |
| [101](0101-agent-runs-with-budgets.md) | Agent runs with budgets that are enforced before they can be passed | Accepted |
| [102](0102-delta-import-runs.md) | Delta runs for cutover windows: the changes since an earlier run, deletions reported | Accepted |
| [103](0103-import-wizard-and-cli.md) | The import wizard and the import CLI: one API, an imports folder you can upload into | Accepted |
| [104](0104-security-hardening.md) | Security hardening for 1.0: threat model, ASVS level 2, fuzzing, prompt injection, scans | Accepted |
| [105](0105-fresh-machine-harness.md) | The fresh-machine harness: both kits on an empty Docker host, the full journey in a browser | Accepted |
| [106](0106-local-embeddings-and-vector-search.md) | Local embeddings on ONNX Runtime WebAssembly, `real[]` vectors and optional pgvector | Accepted |
| [107](0107-ai-eval-sets.md) | AI eval sets and their runner, on a seeded synthetic dataset: query pairs scored by exact result, a summary rubric with an automatic grader, duplicate clusters | Accepted |
| [108](0108-ai-v1-features.md) | The AI features of v1: streamed summaries citing readable comments, checked queries never run by AI, proposals created only on confirmation, duplicates re-ranked within 2 s | Accepted |
| [109](0109-security-notices-and-alerts.md) | Security notices by email on credential changes, failed authentication and refusals in the audit log, alert rules that tell site administrators | Accepted |
| [110](0110-outbound-guard-archive-limits-storage-quotas.md) | One outbound guard for requests to typed addresses (resolved, private ranges refused, pinned, redirects re-checked, operator allow list), archive ceilings checked before unpacking, storage quotas off by default | Accepted |
| [111](0111-personal-data-and-database-tls.md) | A person's data as a background ZIP download and erasure to a stable placeholder, the audit log kept intact and masked on read; TLS with verify-full to the bundled PostgreSQL, the all-in-one on its Unix socket | Accepted |
| [118](0118-track-invitations.md) | Invitations into a track by email or copied link, off until a site administrator gives the permission; a separate, removable permission for appointing a track's administrators, on by default; a track keeps its last administrator; web pages for track managers | Accepted |

ADR-008 and ADR-010 become Accepted when the 10M-ticket runs (M0-016, M0-017) confirm their budgets.
