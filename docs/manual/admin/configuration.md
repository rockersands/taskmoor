---
title: "Configuration reference"
audience: admins
sources: apps/server/src/config.ts, apps/server/src/main.ts, apps/server/src/app.ts, apps/server/src/origins.ts, apps/server/src/routes/oauth.ts, docs/adr/0080-cross-origin-auth.md, apps/server/src/cli.ts, apps/server/src/observability.ts, apps/server/src/backup.ts, apps/server/src/backups/schedule.ts, apps/server/src/attachments/stores.ts, apps/server/src/secrets.ts, apps/server/src/ldap/settings.ts, apps/server/src/sso/oidc.ts, apps/server/src/webhooks/model.ts, Dockerfile, deploy/allinone/Dockerfile, deploy/compose/.env.example, deploy/compose/docker-compose.yml, deploy/compose/install.sh, deploy/compose/upgrade.sh, deploy/README.md, packages/builder-core/src/kits.ts, packages/builder-core/src/backend.ts, docs/adr/0021-delivery-and-images.md, docs/adr/0031-builder-and-two-kits.md, docs/specs/05b-administration-security-and-self-hosting.md, apps/server/src/email/smtp.ts, apps/server/src/compat/register.ts, docs/adr/0087-registered-frontend-origins.md, apps/server/src/ai/environment.ts, apps/server/src/ai/keyring.ts, docs/adr/0098-ai-key-storage.md
accessed: 2026-10-31
attestation: own-words
---
# Configuration reference

The Taskmoor server reads its settings from environment variables when it starts. This page
lists every one of them, grouped by topic, with its default and meaning.

## How settings are read

- The server checks every setting at start. When one is wrong it stops and lists each problem
  with the variable's name and the rule it broke, never the value (a database URL can hold a
  password). Taskmoor does not yet have a command that only checks the settings.
- An empty value counts as not set, so a Compose file may pass `${NAME:-}` safely.
- Some settings go in pairs and must be set both or neither; the tables say which.
- How a setting reaches the server depends on the kit: the Compose kits pass the settings of
  this page from `.env` ([installing Taskmoor](install.md#the-env-file)),
  the Builder's backend kit passes its whole `.env`, the all-in-one image takes `docker run -e`,
  and Helm takes chart values and `extraEnv` ([Kubernetes with Helm](helm.md#secrets)).

The image sets `TASKMOOR_ROLE=all`, `TASKMOOR_WEB_DIR=/app/web`, `TASKMOOR_DATA=/data`,
`PORT=8080`, `HOST=0.0.0.0` and its own `TASKMOOR_VERSION`. The defaults below are those of a
server started without the image.

## Roles

One image runs every part of Taskmoor. `TASKMOOR_ROLE` picks what a process does: `all` (the
default), or a comma-separated list of these roles.

| Role | What the process does |
|---|---|
| `api` | The REST API under `/api/`, sign-in and setup. It owns the database schema: it applies pending migrations when it starts, and prints the setup link while setup is not done |
| `worker` | Background work: events and jobs, notification emails, search subscriptions, scheduled backups and their drills, the trash purge, audit retention, imports, bulk changes, webhook deliveries, directory syncs and sprint cycles |
| `realtime` | WebSockets on the same port: live updates (`/api/v1/sync/socket`) and co-editing (`/api/v1/collab`) |
| `web` | The web app from `TASKMOOR_WEB_DIR`, with its settings filled in for this instance |

Every role but `web` needs `DATABASE_URL`. The Compose kits and the all-in-one image run
`all`; the Helm chart runs `api,web,realtime` in its app pods and `worker` in its worker pods.
The operator CLI runs as `api` unless told otherwise. Every process answers `/health` and
`/ready`.

## Database

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none | `postgres://` or `postgresql://` URL of a PostgreSQL 16 or later; required for every role but `web` |
| `TASKMOOR_PG_BIN` | none | A folder to look in first for `pg_dump` and `pg_restore` (backups and restores) |

## Server and network

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | The port the server listens on |
| `HOST` | `0.0.0.0` | The address it listens on |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`; logs are JSON lines |
| `TASKMOOR_TRUSTED_PROXIES` | none | Proxies whose forwarded client address is believed: addresses, CIDR ranges, or `loopback`, `linklocal`, `uniquelocal`, comma-separated. Unset, the direct peer is the client |
| `TASKMOOR_SHUTDOWN_DRAIN_MS` | `2000` | After a stop signal, how long the server keeps answering (closing each connection) before it stops; 0 to 60000 |

## URLs and routing

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:<PORT>` | The address people use. The setup link and the links in emails follow it, its path is the app's base path, and cookies are marked secure when it starts with `https://` |
| `TASKMOOR_WEB_DIR` | none | The built web app the `web` role serves; unset, it serves none |
| `TASKMOOR_WEB_ROUTING` | `hash` | `path` for clean URLs (the kits' setting) or `hash` ([installing Taskmoor](install.md#clean-urls-or-hash-routing)) |
| `TASKMOOR_VERSION` | The version the server was built with | Leave it alone: the `web` role refuses a web app of another version |

## Frontends on other origins

| Variable | Default | Meaning |
|---|---|---|
| `TASKMOOR_ALLOWED_ORIGINS` | none | Origins of web apps served elsewhere, such as `https://tracker.example.com`, comma-separated: scheme, name and port only, `https` (plain `http` only for `localhost` and names under it). They may call the API with the backend's cookie, open its WebSockets and sign in through OAuth |
| `TASKMOOR_OAUTH_REDIRECT_URIS` | Each allowed origin with `/` | Where sign-in from another site may send people back: exact addresses on the allowed origins, comma-separated |

Requests that name any other origin are refused (`403 origin_not_allowed`), including
WebSocket connections; programs, which name none, are not affected. The Builder writes both
settings ([the Builder's kits](builder-kits.md#frontend-and-backend-on-different-origins)). A
wildcard such as `https://*.example.com` stops the server at start. Site administrators can add
more frontends under **Settings > Frontends** without a restart
([adding frontends](builder-kits.md#adding-frontends-without-a-restart)).

## Setup and instance identity

| Variable | Default | Meaning |
|---|---|---|
| `TASKMOOR_SETUP_TOKEN` | A new one at every start | A fixed first-run token, at least 16 characters ([first-run setup](first-run.md)) |
| `TASKMOOR_INSTANCE_ID`, `TASKMOOR_INSTANCE_KEY` | none | Pair. The instance's id (a UUID) and its Ed25519 key seed from a Builder kit; they seed the identity the first time it is needed, and an identity already stored is kept |

## Secrets and keys

| Variable | Default | Meaning |
|---|---|---|
| `TASKMOOR_PASSWORD_PEPPER` | The keyring in `TASKMOOR_DATA/secrets/password-peppers` | The secret key mixed into every password hash, 32 characters or more. Unset, the server creates a keyring file on first start; without either, passwords are hashed without a pepper and the log says so |
| `TASKMOOR_MASTER_KEY` | none | The key that protects stored AI provider keys, 32 characters or more; the Builder's backend kit writes one. Unset, the password pepper protects them; without either, AI keys cannot be stored ([AI settings](ai.md#how-keys-are-kept)) |
| `TASKMOOR_MASTER_KEY_PREVIOUS` | none | After changing the master key: the earlier key or keys, comma-separated. At start the server moves every stored AI key over to the new master key and logs how many; then remove this setting |

The Builder's backend kit also writes `TASKMOOR_TOKEN_SIGNING_KEY`. The server does not read it:
its sign-in tokens are random and kept as hashes, so they need no signing key.

Keep the master key with your other secrets and out of backups of the database: a backup holds
AI keys only in encrypted form, and restoring it needs the same master key (or, without one,
the pepper keyring that the backup carries).

## Data, backups and imports

| Variable | Default | Meaning |
|---|---|---|
| `TASKMOOR_DATA` | none (the image: `/data`) | The data directory: attachments in `files`, backups in `backups`, import files in `imports`, the pepper keyring in `secrets` |
| `TASKMOOR_BACKUP_DIR` | `TASKMOOR_DATA/backups` | Where scheduled backups go; `off` keeps this process from taking them |
| `TASKMOOR_IMPORT_DIR` | `TASKMOOR_DATA/imports` | The only folder imports may read files from by path; `off` refuses paths |

See [backups](backups.md) and [importing and exporting](import-export.md).

## Storage and attachments

| Variable | Default | Meaning |
|---|---|---|
| `TASKMOOR_STORAGE` | `s3` when a bucket is named, else `local` | Where new attachments go; `s3` needs `TASKMOOR_S3_BUCKET` |
| `TASKMOOR_FILES_DIR` | `TASKMOOR_DATA/files` | The local store's folder; `off` for no local store in this process |
| `TASKMOOR_S3_BUCKET` | none | The bucket; naming it makes S3 the store for new files |
| `TASKMOOR_S3_REGION` | `us-east-1` | The bucket's region |
| `TASKMOOR_S3_ENDPOINT` | none | The store's address, for anything but AWS (MinIO, Garage, Ceph, R2) |
| `TASKMOOR_S3_PUBLIC_ENDPOINT` | none | The address browsers reach the store at, when it differs; downloads are signed for it |
| `TASKMOOR_S3_FORCE_PATH_STYLE` | `true` with an endpoint, else `false` | Path-style bucket addresses |
| `TASKMOOR_S3_PREFIX` | none | A key prefix of folder names ending in `/`, such as `taskmoor/` |
| `TASKMOOR_S3_ACCESS_KEY_ID`, `TASKMOOR_S3_SECRET_ACCESS_KEY` | none | Pair. Unset, the AWS default chain applies (an instance role, for example) |
| `TASKMOOR_S3_SESSION_TOKEN` | none | A session token to go with the key pair |
| `TASKMOOR_S3_SSE`, `TASKMOOR_S3_SSE_KMS_KEY_ID` | none | Server-side encryption: `AES256` or `aws:kms`, and the KMS key |
| `TASKMOOR_S3_URL_TTL` | `300` | Seconds a signed download address lives, 10 to 3600 |
| `TASKMOOR_SCAN_CLAMD` | none | ClamAV's daemon (`host:port`, `tcp://host:port` or `unix:/path`); files are served once it finds them clean |

Files already on disk stay readable after a switch to S3 while the data directory is there.
Without `TASKMOOR_DATA`, `TASKMOOR_FILES_DIR` or a bucket, attachments are off.

## Mail

| Variable | Default | Meaning |
|---|---|---|
| `TASKMOOR_SMTP_URL` | none | `smtp://host:587` (STARTTLS when offered) or `smtps://host:465`, without credentials. Unset, the server of the setup form's mail fields is used; without either, notifications still reach the inbox and email waits unsent |
| `TASKMOOR_SMTP_USER`, `TASKMOOR_SMTP_PASSWORD` | none | The SMTP sign-in, a pair with `TASKMOOR_SMTP_URL`. The password alone signs in the user the setup form saved |
| `TASKMOOR_SMTP_FROM` | `Taskmoor <taskmoor@host>`, with the host of `PUBLIC_URL` | The From address of notification emails |

The worker sends email; set `PUBLIC_URL` too, for the links inside. See
[email and notification policies](notifications.md).

## Search and limits

| Variable | Default | Meaning |
|---|---|---|
| `TASKMOOR_QUERY_TIMEOUT_MS` | `30000` | How long one search may run, 100 to 600000 milliseconds; a longer one answers `503 query_timeout` |
| `TASKMOOR_JIRA_COMPAT` | `on` | `off` stops serving the Jira-compatible API under `/rest` (see [The REST API](rest-api.md#the-jira-compatible-api)) |

The largest attachment, the trash retention, the backup schedule and the email batching are
not environment variables: site administrators set them in the app or through the API.

## Monitoring

| Variable | Default | Meaning |
|---|---|---|
| `METRICS_PORT` | `9464` | The internal Prometheus port; `0` turns it off |
| `METRICS_HOST` | `HOST` | The address of the metrics listener |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | none | An OpenTelemetry collector for traces; unset, no trace leaves the server |
| `OTEL_EXPORTER_OTLP_HEADERS` | none | Headers for the collector |
| `OTEL_SERVICE_NAME` | `taskmoor` | The service name on traces |

See [monitoring and logs](monitoring.md).

## Exceptions for test networks

Taskmoor refuses plain-text connections where a password or a payload could leak. These switch
the rule off and belong only on test networks:

| Variable | Effect when `true` |
|---|---|
| `TASKMOOR_LDAP_ALLOW_PLAIN` | Plain LDAP without StartTLS to a directory that is not on this machine |
| `TASKMOOR_OIDC_ALLOW_HTTP` | An OpenID Connect issuer on plain `http` |
| `TASKMOOR_WEBHOOK_ALLOW_HTTP` | Webhook targets on plain `http` |

## AI providers

These let an install switch AI on without opening the settings page. On the **first start**
with them set, the server moves them into the database, the key encrypted, and switches AI on
when they are complete. On every later start it ignores them and its log says so: from then on
the [AI settings](ai.md) page and its API are where they change. The install scripts remove
`TASKMOOR_AI_KEY` from `.env` once the server has moved it.

| Variable | Default | Meaning |
|---|---|---|
| `TASKMOOR_AI_PROVIDER` | none | `anthropic`, `bedrock`, `vertex`, `foundry` or `openai-compatible` |
| `TASKMOOR_AI_KEY` | none | The provider's key: an Anthropic API key, a Bedrock API key, a Vertex AI access token, a Foundry key, or an OpenAI-compatible server's key |
| `TASKMOOR_AI_REGION` | none | The region, for Bedrock and Vertex AI (both need one) |
| `TASKMOOR_AI_PROJECT` | none | The Google Cloud project, for Vertex AI |
| `TASKMOOR_AI_RESOURCE` | none | The Foundry resource name |
| `TASKMOOR_AI_BASE_URL` | none | The server's address for an OpenAI-compatible provider, or another address for the Anthropic API |
| `TASKMOOR_AI_MODEL` | none | The model an OpenAI-compatible server serves |

When the settings are incomplete (for example Bedrock without a region), the key is still
stored, AI stays off and the log lists what is missing, by name. Log lines never show a key.

## Kit and tool variables

These are read by the install scripts, the Compose files or the operator CLI, not by the server.

| Variable | Read by | Meaning |
|---|---|---|
| `POSTGRES_PASSWORD` | Compose with bundled PostgreSQL, Builder backend kit | The bundled database's password; `install.sh` writes a fresh one |
| `POSTGRES_IMAGE` | Compose kit | The PostgreSQL image; `postgres:16` by default |
| `TASKMOOR_IMAGE` | Compose kits, Builder backend kit, `upgrade.sh` | The Taskmoor image; `taskmoor:dev` in the Compose kit, the pinned version in a Builder kit |
| `TASKMOOR_PORT` | Compose kits | The host port; `8080` by default |
| `TASKMOOR_PULL` | `install.sh`, `upgrade.sh` | `missing` by default; `never` installs from images already loaded |
| `TASKMOOR_COMPOSE_OVERRIDE` | `install.sh`, `upgrade.sh` | More Compose files, separated by spaces |
| `TASKMOOR_DOMAIN` | Builder backend kit | The backend's host name, which the preflight resolves |
| `TASKMOOR_HTTP_PORT`, `TASKMOOR_HTTPS_PORT` | Builder backend kit | Caddy's host ports; `80` and `443` by default |
| `TASKMOOR_URL`, `TASKMOOR_TOKEN` | `node cli.mjs mcp` | The server's address and an API token, for MCP over standard input and output ([the MCP server](mcp.md)) |
