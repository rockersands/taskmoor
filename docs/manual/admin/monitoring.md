---
title: "Monitoring and logs"
audience: admins
sources: apps/server/src/app.ts, apps/server/src/main.ts, apps/server/src/config.ts, apps/server/src/observability.ts, apps/server/src/routes/admin.ts, apps/server/src/routes/meta.ts, apps/server/src/routes/audit.ts, apps/server/src/audit/chain.ts, apps/server/src/audit/query.ts, apps/server/src/audit/record.ts, apps/server/src/audit/retention.ts, apps/server/src/audit/subscriber.ts, apps/server/src/cli.ts, apps/web/src/admin/SystemPage.tsx, apps/web/src/i18n/messages.en.ts, deploy/README.md, deploy/observability/prometheus.yml, deploy/observability/alerts.yml, deploy/observability/grafana-dashboard.json, deploy/helm/README.md, deploy/helm/taskmoor/templates/workloads.yaml, deploy/allinone/entrypoint.sh, Dockerfile, docs/adr/0023-observability.md, docs/adr/0034-audit-log.md, docs/adr/0070-meta-endpoint-and-version-window.md, docs/specs/05a-administration-security-and-self-hosting.md, docs/specs/05b-administration-security-and-self-hosting.md, apps/server/src/audit/syslog.ts, apps/server/src/routes/audit.ts, apps/web/src/admin/audit/AuditPage.tsx, apps/web/src/admin/audit/words.ts, apps/web/src/admin/TableScroller.tsx, apps/web/src/admin/audit/AuditSettings.tsx, docs/adr/0078-allowlists-and-syslog.md, apps/web/src/admin/UpdateNotice.tsx, apps/server/src/routes/update-check.ts, packages/webconfig/src/csv.ts, apps/web/src/styles/admin.css, docs/plan/page-review-third-sweep.md, apps/web/src/account/csvStyle.tsx
accessed: 2026-11-23
attestation: own-words
---
# Monitoring and logs

Every Taskmoor process answers health probes, serves Prometheus metrics on an internal port,
writes JSON logs to standard output and can send traces to an OpenTelemetry collector. Site
administrators also have a status page and an audit log page in the app.

## Health and readiness

Both endpoints answer on the app's port (8080 by default) without signing in.

| Endpoint | Answers | Use |
|---|---|---|
| `GET /health` | `{"status":"ok","version":"...","roles":[...]}` whenever the process is up; it never touches the database | Liveness: restart the process when it fails |
| `GET /ready` | `{"status":"ready"}`, or `503` with `{"status":"unavailable","reason":"database"}` when the database does not answer | Readiness: stop sending traffic while it fails |

The image's health check calls `/health` every 30 seconds. The Helm chart uses `/health` for its
startup and liveness probes and `/ready` for readiness. Probe requests are neither timed nor
traced.

```bash
curl http://localhost:8080/ready
```

## The System status page

Site administrators open **Administration**, **System status** to see whether the site is healthy.
**Refresh** reads it again.

| Section | Shows |
|---|---|
| **Site** | **Version**, **Roles**, **Started**, **Uptime** |
| **Updates** | **Running**, **Newest version**, **Last looked**, the command when a newer version exists, and the switch (see [The new-version notice](upgrades.md#the-new-version-notice)) |
| **Database** | **Connection** (**Connected**, a green badge, or **Unreachable**), **PostgreSQL** version, **Size**, **Migrations** (applied, pending, and any from a newer release), **Connections** in use, maximum and waiting |
| **Storage** | **Data directory**, **Free space**, **Last backup** (with a warning once it is older than a day) |
| **Scheduled backups** | **Schedule**, **Next backup**, **Last success**, **Last failure**, **Restore drill** |
| **Runtime** | **Node.js**, **Platform**, **Memory** |

Times on the page are in your time zone and name it, such as "Nov 9, 2026, 8:30 PM CST"; the
backup schedule is in UTC and says so.

The page reads `GET /api/v1/admin/system` from the process that answers it, and never shows
settings or secrets. Without `TASKMOOR_DATA` the data directory shows as not configured and disk
space is not measured. See [Backups and restore](backups.md) for the backup facts.

## Prometheus metrics

Each process serves metrics at `/metrics` on its own listener, port `9464` by default, kept apart
from the app so it is never exposed with it.

| Variable | Default | Meaning |
|---|---|---|
| `METRICS_PORT` | `9464` | The port; `0` turns the listener off |
| `METRICS_HOST` | the value of `HOST` | The address it listens on |

The Compose kits do not publish the port: run Prometheus on the same Docker network and scrape
`taskmoor:9464`. The Helm chart exposes every pod's port through the `<release>-metrics` Service,
and `metrics.serviceMonitor.enabled=true` creates a ServiceMonitor for the Prometheus Operator.

### Metric names

| Metric | Type and labels | Meaning |
|---|---|---|
| `taskmoor_http_request_duration_seconds` | Histogram; `method`, `route`, `status_code` | Request latency by route pattern |
| `taskmoor_db_query_duration_seconds` | Histogram; `outcome` (`ok` or `error`) | Database statement latency |
| `taskmoor_db_pool_connections` | Gauge; `state` (`total`, `idle`, `waiting`, `max`) | The database connection pool |
| `taskmoor_backup_age_seconds` | Gauge | Seconds since the last completed backup; absent before the first |
| `taskmoor_build_info` | Gauge; `version`, `roles` | Always 1; says what runs |

The usual Node.js process metrics (CPU, memory, event loop lag) come with them. The backup age
needs `TASKMOOR_DATA`, where the backup marker lives.

### Example configuration, alerts and dashboard

The `deploy/observability` folder of the Taskmoor repository holds three files to start from:

- `prometheus.yml` scrapes `taskmoor:9464` every 30 seconds as the job `taskmoor`; list each
  process as a target when you run one per role.
- `alerts.yml` holds these rules; adjust the thresholds to your site.
- `grafana-dashboard.json` is a dashboard named Taskmoor with the version, the last backup's age,
  requests per second and p95 latency by route, the server error ratio, p95 statement time, the
  database pool and resident memory. A dashboard variable picks the Prometheus data source.

| Alert | Fires when |
|---|---|
| `TaskmoorDown` | The metrics endpoint does not answer for 2 minutes (critical) |
| `TaskmoorServerErrors` | More than 5% of requests fail with a server error for 10 minutes |
| `TaskmoorSlowRequests` | A route's p95 latency stays above 1 s for 15 minutes |
| `TaskmoorSlowStatements` | The p95 statement time stays above 300 ms for 15 minutes |
| `TaskmoorDatabasePoolExhausted` | Requests wait for a database connection for 5 minutes |
| `TaskmoorBackupTooOld` | The last backup is more than 26 hours old |
| `TaskmoorNoBackup` | No backup has been recorded for a day (information) |

## Traces

Traces are off unless an OpenTelemetry collector is named with the standard variables:
`OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, plus
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_SERVICE_NAME` (default `taskmoor`) if needed. In the Helm
chart, set `otel.endpoint`.

Each request becomes a server span that continues an incoming `traceparent` header, with one
child span per database statement. A statement span carries its SQL text, never its parameters.
Nothing leaves the server by default.

## Logs

Every process writes JSON to standard output, one line per event: a line when a request comes in
and one when it completes (with its request id, status and response time), and messages from
start-up and background jobs. Read them where your kit keeps them:

```bash
docker compose logs taskmoor
kubectl logs deploy/taskmoor-app
```

`LOG_LEVEL` chooses how much: `fatal`, `error`, `warn`, `info` (the default), `debug`, `trace` or
`silent`. The Compose kits read it from `.env`; the Helm chart has `logLevel`. The all-in-one
image also keeps PostgreSQL's own log in `/data/postgres/postgres.log`.

Useful lines at start-up:

| `msg` | Meaning |
|---|---|
| `first-run setup` | The one-time setup link, in `link`; see [First-run setup](first-run.md) |
| `database migrated` | The migrations applied at this start, in `applied` |
| `passwords are hashed without a pepper: ...` | Neither `TASKMOOR_DATA` nor `TASKMOOR_PASSWORD_PEPPER` is set |
| `attachments are off: ...` | No place for attachments is configured |

The operator CLI prints errors on standard error with any password in a connection URL replaced
by `***`.

## The audit log

The audit log is append-only, and every record carries the hash of the one before it, so a
record that was changed, removed or added shows up as a broken chain.

### What it records

- sign-ins, sign-outs, refused sign-ins and the lockouts they cause, refused password checks and
  password links, refused single sign-ons;
- changes to people, groups, roles, access policies, grants, two-factor settings, identity
  providers, API tokens and service accounts;
- changes to configuration: tracks, ticket types, fields, statuses, priorities, close reasons,
  workflows and workflow maps, releases, areas, boards, sprints, saved searches, dashboards,
  webhooks, and settings such as email, trash retention and the backup schedule;
- deleting, restoring and permanently deleting tickets and tracks, and files held back by the
  virus scan;
- every tool call by an AI agent through [the MCP server](mcp.md);
- imports, exports, and every export of the audit log itself.

Edits to tickets are not in the audit log: each ticket's history holds them.

### Searching and exporting

Site administrators open **Administration**, **Audit log**. It lists records newest first, 50 at a
time (**Show older records** reads further back), with filters for a first and last day and an
action. The action is picked in words: **Action about** names what it concerns, such as
**Person** for every event about people, and then **What happened** narrows it to one kind, such
as **Signed in**. Each action in the list reads as words too, such as **Ticket template created**
for `ticket_template.created`, and what it is about by its kind and its name as it is now, such
as **Track “Shop”**, a ticket by its key, such as **Ticket “MOB-12”**, or by its number when it
has no name to show, such as **API token 7** (an erased person is never named). The security
actions read as words as well: a refused password link is **Password link refused**, a lockout
**Sign-in locked after failed attempts**, a change of password just **Password changed**. A track
role given or taken says which role and to whom, such as **Track role “Developers” given to Noor
Haddad**, while the role and the person still exist. Every action Taskmoor writes has its words in
English and Spanish; one from a newer server the page does not know yet shows as its code. In
the table the day stands over the time, and the address a record came from under who made it,
in the column **Who, from where**. A table wider than the screen scrolls sideways inside its
card, which the keyboard reaches with Tab. On a phone
each record is one block: when, who and what, then what it is about and the address it came
from. Through the API, `action=user.` finds every event about people. **Download as CSV** and **Download as JSON Lines** save
every record the filter finds, oldest first; each download is itself recorded. The CSV file is
UTF-8 with a byte-order mark first, so Excel on Windows opens it properly by a double-click, and
its cells are separated by commas or semicolons as your profile's **Spreadsheet files (CSV)** says
(see [Your account](../use/account.md#profile)); through the API, `separator=semicolon`. **Check the
chain** verifies the whole log and says where it breaks, if it does.

The same is available through the API (an API token needs the admin scope; see
[The REST API](rest-api.md)):

| Request | Does |
|---|---|
| `GET /api/v1/audit` | Searches, newest first, 50 records a page (`limit` up to 500, `cursor` for the next page) |
| `GET /api/v1/audit/export?format=csv` | Streams every matching record, oldest first, as CSV or `jsonl` (JSON Lines); CSV takes `separator=comma` (the default) or `semicolon` |
| `GET /api/v1/audit/verify` | Checks this site's chain |
| `GET` and `PUT /api/v1/audit/settings` | Reads or sets `retentionMonths` |

Both search and export take the filters `from` and `to` (a date or a date and time with an
offset), `actor` (a person's id), `action` (an action or its start: `user.` finds every user
event) and `subject` (a type such as `user`, or `user:12`). A record holds its sequence number,
when it happened and was recorded, the actor, the action, the subject, details, the client
address, and its own and the previous hash.

### Verifying the chain

```bash
docker compose exec taskmoor node cli.mjs audit-verify
```

It prints one JSON line per site (`ok`, the records checked, where checking started, the
head's sequence number and hash, and the first broken record) and exits with 1 when a chain is
broken. Someone with full rights on the database could rewrite a chain from start to end, so keep
the head hash it prints, or the last line of an export, somewhere else as well.

### Retention

The log keeps 12 months by default. **Keep records for** on the audit log page changes it for
the whole site, as does `PUT /api/v1/audit/settings` with `{"retentionMonths": 24}`; `0`
(**Forever**) keeps everything. Once a day the worker drops the
months older than that, after checking the part of the chain it drops; a range that does not
verify is kept and reported instead. Each drop is itself recorded in the log.

### Forwarding to syslog

Under **Forward to syslog** on the audit log page, name a syslog receiver (a SIEM or a log
collector): its host, port and transport (TLS, TCP or UDP), and **Forward new records**. Every
ten seconds the worker sends the records the log gained since its last run, oldest first, as
RFC 5424 messages (facility 13, log audit; severity notice) whose text is the record as JSON,
with the same fields as the JSON Lines download. Over TLS and TCP each message is preceded by
its length in bytes (octet counting, RFC 6587); over UDP each is one datagram, and a lost
datagram is not sent again, so prefer TLS.

The receiver gets what happens after you name it; the downloads have the past. When it cannot be
reached, forwarding stops where it was, the page shows the error, and it catches up once the
receiver answers. **Send a test message** sends one message, `audit.syslog_test`, without
moving that position. The same settings are `GET` and `PUT /api/v1/audit/syslog` and
`POST /api/v1/audit/syslog/test`. A continuous stream in other formats (CEF, HTTPS,
OpenTelemetry) is planned for release 2.0.

## Site and version information

`GET /api/meta` answers without signing in, to any origin, and holds only public values:

| Field | Meaning |
|---|---|
| `version` | The backend's version |
| `api` | The native API's version and base path (`/api/v1`) |
| `frontend` | `minimum` and `recommended` web app versions this backend works with; null on a development build |
| `instance` | The site's id, name and public key (Ed25519) with its fingerprint |
| `signIn` | Whether passwords work, and each enabled single sign-on provider's public details |

With `?nonce=` (16 to 128 base64url characters) the answer also carries the site's signature
over the nonce, which the Builder's kits use to check they reached their own backend. When the
password pepper is lost, the signature is refused with `503 identity_unavailable`. The version
also appears in `/health`, in `taskmoor_build_info` and on the System status page. See
[Upgrades](upgrades.md) for how versions pair.

## Not yet available

Taskmoor does not yet show queue depth or job lag, offer a job console or a support bundle, or
list the frontends connected to a backend.
