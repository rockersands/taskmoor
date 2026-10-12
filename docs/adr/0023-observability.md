# ADR-023: Observability with OpenTelemetry, Prometheus and structured logs

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

Operators need request latency, error rate, queue depth and database pool metrics scraped by
Prometheus, traces from API to database and worker, and structured logs (OPS-011), with no
vendor lock-in and nothing leaving the server by default (OPS-005).

## Decision

- **Logs:** `pino` JSON to stdout, one line per event, with request id, workspace id, user id
  (never personal data beyond ids), route, status, duration; log level per module at runtime.
  Secrets are redacted by a shared redaction list that the config validator also uses.
- **Metrics:** `prom-client` exposing `/metrics` on an internal port per role: HTTP histograms
  per route, queue depth and failures (ADR-015), outbox lag, database pool usage, realtime
  connections, change-log lag, backup age, certificate expiry. Example Grafana dashboards and
  alert rules ship in `deploy/observability`.
- **Traces:** OpenTelemetry SDK with auto-instrumentation for Fastify, `pg` and outbound HTTP,
  propagated through the queue (trace context stored on the job), exported over OTLP only when
  an endpoint is configured.
- **Health:** `/health` (process alive) and `/ready` (database reachable, migrations current)
  per role; an admin page shows database, queue lag, disk, backup age and certificates.
- **No telemetry to the project** by default; an opt-in anonymous version ping is a separate
  decision (`docs/plan/decisions.csv`, "Telemetry").

## Options considered

| Option | For | Against |
|---|---|---|
| OpenTelemetry plus Prometheus (chosen) | Standard; works with every backend operators already run; nothing proprietary | Two exporters to keep configured |
| Vendor SDK (Datadog, Sentry) | Turnkey | Lock-in; egress by default contradicts air-gap |
| Logs only | Simplest | No latency histograms or traces; the performance budgets could not be watched in production |

## Consequences

The metrics named here are the same ones the nightly benchmark (M0-033) reads, so budgets in CI
and alerts in production agree.
