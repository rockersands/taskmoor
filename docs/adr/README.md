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
| [009](0009-configuration-model.md) | One configuration model | Accepted |
| [011](0011-search.md) | Search in Postgres, with an optional OpenSearch adapter | Accepted |
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
| [026](0026-extensions.md) | Extensions as WASM in Extism, UI slots in sandboxed iframes | Accepted |
| [027](0027-analytics-store.md) | Analytics store with daily snapshots over OData | Accepted |
| [028](0028-ai-provider-gateway.md) | AI provider gateway | Accepted |
| [029](0029-supply-chain-gates.md) | Supply-chain gates | Accepted |
| [030](0030-test-strategy.md) | Test strategy and the verify gate | Accepted |
| [031](0031-builder-and-two-kits.md) | The Builder, two kits and a signed connection manifest | Accepted |
| [032](0032-cross-origin-auth-and-versioning.md) | Cross-origin authentication and frontend version compatibility | Accepted |
| [033](0033-desktop-first-responsive-ui.md) | Desktop-first, responsive UI | Accepted |

Waiting for their spikes: 008 (field storage, M0-016), 010 (query compiler, M0-017), 012
(permissions, M0-018), 013 (sync engine, M0-019) and 025 (importer, M0-022).
