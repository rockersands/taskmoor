# Helm chart

`taskmoor/` installs Taskmoor on Kubernetes 1.27 or later (ADR-021, OPS-018). One image runs
two deployments: **app** (API, frontend and realtime) and **worker** (background jobs). PostgreSQL
16 or later is external.

```
PW='the database password'
kubectl create secret generic taskmoor-db \
  --from-literal=DATABASE_URL="postgres://taskmoor:$PW@db.example.internal:5432/taskmoor"
helm install taskmoor deploy/helm/taskmoor \
  --set database.existingSecret=taskmoor-db \
  --set publicUrl=https://tracker.example.com \
  --set ingress.enabled=true --set ingress.host=tracker.example.com
kubectl logs deploy/taskmoor-app | grep first-run   # the one-time setup link
helm test taskmoor
```

## Highly available

```
helm install taskmoor deploy/helm/taskmoor \
  --set database.existingSecret=taskmoor-db \
  --set storage.type=s3 --set storage.s3.bucket=taskmoor-files \
  --set storage.s3.existingSecret=taskmoor-s3 \
  --set app.autoscaling.enabled=true --set app.autoscaling.minReplicas=2 \
  --set worker.replicas=2 --set worker.podDisruptionBudget.enabled=true
```

- Several app pods need shared files: S3 (`storage.type=s3`, keys in a Secret with
  `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`) or a ReadWriteMany volume. The chart refuses a
  ReadWriteOnce volume with more than one app pod.
- Disruption budgets are created for any component with two or more pods.
- `app.nodeSelector`, `app.tolerations` and `app.affinity` (and the same for `worker`) keep API
  traffic and background work on separate nodes.

## Upgrades

`helm upgrade` first runs `node cli.mjs check-upgrade` from the new image (ADR-022); a blocking
finding (database unreachable, or migrated by a newer release) stops the upgrade before anything
changes. Pods roll one at a time and never below full capacity; a stopping pod keeps serving for
`drainSeconds` while it leaves the Service, then finishes its in-flight requests. The first new
app pod applies pending migrations, which are forward-compatible with the release before.
`tools/helm/kind-test.sh` checks this: two app pods, `helm test`, then a rolling upgrade while
clients keep calling, with zero failed requests allowed.

## Monitoring

Every pod serves Prometheus metrics on port 9464 through the `<release>-metrics` Service;
`metrics.serviceMonitor.enabled=true` creates a ServiceMonitor for the Prometheus Operator.
`otel.endpoint` sends traces to an OpenTelemetry collector. See `../observability/` for alert
rules and a dashboard.

## Values

| Value | Default | Meaning |
|---|---|---|
| `image.repository`, `image.tag` | `ghcr.io/rockersands/taskmoor`, chart appVersion | The image |
| `publicUrl` | `http://taskmoor.local` | Address people use; the setup link and secure cookies follow it |
| `database.existingSecret` / `database.url` | | Connection string from a Secret (recommended) or inline |
| `setupToken.existingSecret` | | Fixed first-run token, for installers |
| `storage.type` | `local` | `local` (a volume) or `s3` |
| `app.replicas`, `app.autoscaling.*` | 1, off | App pods, or a CPU-based autoscaler |
| `worker.enabled`, `worker.replicas` | true, 1 | Background worker pods |
| `*.podDisruptionBudget.*` | app on | Budget for components with two or more pods |
| `drainSeconds`, `terminationGracePeriodSeconds` | 10, 40 | Graceful shutdown |
| `upgradeCheck.enabled` | true | Pre-upgrade check job |
| `metrics.port`, `metrics.serviceMonitor.enabled` | 9464, off | Prometheus |
| `otel.endpoint` | | OTLP endpoint for traces |
| `ingress.*` | off | Ingress for `ingress.host` |

Pods run as a non-root user with a read-only root filesystem, no capabilities and the default
seccomp profile; `/tmp` and `/data` are writable volumes.
