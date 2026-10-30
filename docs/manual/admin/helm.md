---
title: "Kubernetes with Helm"
audience: admins
sources: deploy/helm/README.md, deploy/helm/taskmoor/Chart.yaml, deploy/helm/taskmoor/values.yaml, deploy/helm/taskmoor/templates/_helpers.tpl, deploy/helm/taskmoor/templates/workloads.yaml, deploy/helm/taskmoor/templates/service.yaml, deploy/helm/taskmoor/templates/secret.yaml, deploy/helm/taskmoor/templates/pepper-secret.yaml, deploy/helm/taskmoor/templates/upgrade-check.yaml, deploy/helm/taskmoor/templates/NOTES.txt, deploy/helm/taskmoor/templates/tests/test-ready.yaml, apps/server/src/main.ts, apps/server/src/setup.ts, apps/server/src/upgrade-check.ts, apps/server/src/config.ts, deploy/README.md, docs/adr/0021-delivery-and-images.md, docs/specs/05b-administration-security-and-self-hosting.md
accessed: 2026-10-30
attestation: own-words
---
# Kubernetes with Helm

The Helm chart in `deploy/helm/taskmoor` installs Taskmoor on Kubernetes 1.27 or later. One
image runs two deployments: **app** (the API, the web app and realtime) and **worker**
(background jobs). PostgreSQL 16 or later runs outside the chart. Taskmoor does not yet publish
the chart to a Helm repository or images to a registry: install the chart from a copy of the
source, push an image you built ([installing Taskmoor](install.md#getting-the-image)) to a
registry your cluster can pull from, and set `image.repository` and `image.tag`.

## Installing the chart

Put the database's connection URL in a Secret, then install:

```bash
PW='the database password'
kubectl create secret generic taskmoor-db \
  --from-literal=DATABASE_URL="postgres://taskmoor:$PW@db.example.internal:5432/taskmoor"
helm install taskmoor deploy/helm/taskmoor \
  --set database.existingSecret=taskmoor-db \
  --set publicUrl=https://tracker.example.com \
  --set ingress.enabled=true --set ingress.host=tracker.example.com
kubectl logs deploy/taskmoor-app | grep first-run
helm test taskmoor
```

The log line holds the one-time setup link ([first-run setup](first-run.md)). Without an
ingress, reach the app with `kubectl port-forward svc/taskmoor 8080:80`.

## What the chart creates

Names start with the release name when it contains `taskmoor`, otherwise with
`<release>-taskmoor`. With `helm install taskmoor` they are:

| Object | What it is |
|---|---|
| Deployment `taskmoor-app` | The roles in `app.roles`, `api,web,realtime` by default |
| Deployment `taskmoor-worker` | The `worker` role (when `worker.enabled`) |
| Service `taskmoor` | The app on port 80 (`service.port`) |
| Service `taskmoor-metrics` | Prometheus metrics of every pod, inside the cluster only |
| PersistentVolumeClaim `taskmoor-data` | The app's `/data` with `storage.type: local`; kept when you uninstall |
| Secret `taskmoor-password-pepper` | The password pepper, made once; kept when you uninstall |
| Secret `taskmoor-database` | Only when you give `database.url` instead of a Secret |
| Ingress, HorizontalPodAutoscaler, PodDisruptionBudget, ServiceMonitor | When turned on |
| Job `taskmoor-upgrade-check`, pod `taskmoor-test` | The pre-upgrade check and `helm test` |

## Values

| Value | Default | Meaning |
|---|---|---|
| `image.repository`, `image.tag`, `image.pullPolicy` | `ghcr.io/rockersands/taskmoor`, the chart's appVersion, `IfNotPresent` | The image |
| `imagePullSecrets` | none | Secrets for a private registry |
| `publicUrl` | `http://taskmoor.local` | The address people use; the setup link and secure cookies follow it |
| `webRouting` | `path` | Clean URLs (`path`) or hash routing (`hash`) |
| `database.existingSecret`, `database.existingSecretKey` | none, `DATABASE_URL` | The Secret with the connection URL (recommended) |
| `database.url` | none | Or the URL itself; the chart makes a Secret of it |
| `setupToken.existingSecret`, `setupToken.existingSecretKey` | none, `TASKMOOR_SETUP_TOKEN` | A fixed setup token of at least 16 characters |
| `passwordPepper.existingSecret`, `passwordPepper.existingSecretKey` | none, `TASKMOOR_PASSWORD_PEPPER` | Your own pepper Secret instead of the chart's |
| `storage.type` | `local` | `local` (a volume) or `s3` |
| `storage.local.size`, `.storageClass`, `.accessMode` | `20Gi`, cluster default, `ReadWriteOnce` | The app's volume |
| `storage.s3.endpoint`, `.bucket`, `.region`, `.forcePathStyle`, `.existingSecret` | none, none, none, `false`, none | The bucket; the Secret holds `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` |
| `trustedProxies` | `loopback,uniquelocal` | Proxies whose forwarded client address is believed |
| `logLevel` | `info` | Log level |
| `extraEnv` | none | More environment variables for every Taskmoor container |
| `otel.endpoint`, `otel.serviceName` | none, `taskmoor` | OpenTelemetry traces |
| `metrics.port`, `metrics.serviceMonitor.enabled` | `9464`, `false` | Prometheus |
| `app.roles` | `api,web,realtime` | `TASKMOOR_ROLE` of the app pods |
| `app.replicas`, `app.autoscaling.*` | 1; off, 2 to 6 pods at 70% CPU | App pods |
| `worker.enabled`, `worker.replicas`, `worker.autoscaling.*` | true, 1; off, 1 to 4 pods at 70% CPU | Worker pods |
| `app.podDisruptionBudget.*`, `worker.podDisruptionBudget.*` | on, off; `minAvailable: 1` | Disruption budgets |
| `*.resources` | app: 250m CPU and 384Mi requested, 1Gi limit; worker: 100m, 256Mi, 768Mi | Requests and limits |
| `*.nodeSelector`, `*.tolerations`, `*.affinity`, `*.podAnnotations` | none | Placement per deployment |
| `drainSeconds`, `terminationGracePeriodSeconds` | 10, 40 | Graceful shutdown |
| `upgradeCheck.enabled` | true | The pre-upgrade check |
| `service.type`, `service.port` | `ClusterIP`, 80 | The app's Service |
| `ingress.enabled`, `.className`, `.annotations`, `.host`, `.tls` | off, none, none, `taskmoor.local`, none | The Ingress |
| `serviceAccount.create`, `serviceAccount.name` | true, the same name as the other objects | The pods' service account |

## Secrets

- **Database.** Set `database.existingSecret` (recommended) or `database.url`; the chart refuses
  to render without one.
- **Password pepper.** Every password hash depends on a secret key kept outside the database,
  and every pod needs the same one. By default the chart makes a Secret with a random key at
  the first install, reads it back at every upgrade, and keeps it after `helm uninstall`.
  Without that key no stored password verifies, so back it up. To manage it yourself, name a
  Secret in `passwordPepper.existingSecret` (32 characters or more).
- **Setup token.** `setupToken.existingSecret` fixes the first-run token. Without it, each app
  pod makes a new token when it starts and the newest one replaces the others: with several app
  pods, use the link from the pod that started last.
- **S3 keys.** `storage.s3.existingSecret` names a Secret with `S3_ACCESS_KEY_ID` and
  `S3_SECRET_ACCESS_KEY`. Without it, the default AWS credential chain applies (an instance
  role, for example).
- **Everything else** goes through `extraEnv`, for example mail:

```yaml
extraEnv:
  - name: TASKMOOR_SMTP_URL
    value: smtp://mail.example.com:587
  - name: TASKMOOR_SMTP_USER
    value: taskmoor@example.com
  - name: TASKMOOR_SMTP_PASSWORD
    valueFrom: { secretKeyRef: { name: taskmoor-mail, key: password } }
```

The [configuration reference](configuration.md) lists every variable.

## Roles and replicas

The app pods run `app.roles` and the worker pods run `worker`. For more than one app pod,
attachments need shared storage: `storage.type: s3`, or a volume with
`storage.local.accessMode: ReadWriteMany`. The chart refuses a `ReadWriteOnce` volume with more
than one app pod, counting the autoscaler's maximum. A highly available install looks like this:

```bash
helm install taskmoor deploy/helm/taskmoor \
  --set database.existingSecret=taskmoor-db \
  --set storage.type=s3 --set storage.s3.bucket=taskmoor-files \
  --set storage.s3.existingSecret=taskmoor-s3 \
  --set app.autoscaling.enabled=true --set app.autoscaling.minReplicas=2 \
  --set worker.replicas=2 --set worker.podDisruptionBudget.enabled=true
```

A disruption budget is made only for a deployment with two or more pods. Use the
`nodeSelector`, `tolerations` and `affinity` of `app` and `worker` to keep API traffic and
background work on separate nodes. With local storage the worker cannot see the app's volume,
so the app pod cleans up deleted attachments itself.

## Ingress and routing

With `ingress.enabled`, the chart routes everything under `/` on `ingress.host` to the app's
Service; `ingress.className`, `ingress.annotations` and `ingress.tls` are passed as they are.
Keep `publicUrl` equal to the address people use. The app is served with clean URLs
(`webRouting: path`); set `webRouting: hash` if something in front cannot pass deep links
through. The ingress controller must pass WebSocket upgrades for live updates and co-editing.

## Checking with helm test

`helm test taskmoor` starts a pod that checks, through the Service, that the app answers
`/health` and `/ready`, that `/api/v1/setup` answers, and that the metrics include
`taskmoor_build_info`. With clean URLs it also opens a deep link twice, as a reload would, and
expects the app. It retries for a minute while a new cluster settles. Add `--logs` to see its
output; the pod stays until the next run.

## Upgrading with helm upgrade

```bash
helm upgrade taskmoor deploy/helm/taskmoor --reuse-values --set image.tag=1.1.0
```

Before anything changes, a pre-upgrade hook runs `node cli.mjs check-upgrade` from the new image
(`upgradeCheck.enabled`). A blocking finding stops the upgrade: the database cannot be reached
or runs a PostgreSQL older than 16, a newer release has already migrated it, or it is further
behind than this release upgrades from in one step. Then the pods roll one at a time and never
below full capacity, and the first new app pod applies the pending migrations in one
transaction, so a failed one leaves the database as it was. The chart takes no backup: take
one with your database provider's tools first. A stopping pod keeps serving for
`drainSeconds` while it leaves the Service, then finishes the requests in flight. See
[upgrades](upgrades.md).

## Backups and monitoring

The worker's `/data` is a temporary volume, so the chart turns scheduled backups off there and
System status says they have nowhere to go. Back up with your database provider's snapshots or
point-in-time recovery, and turn the schedule off
(`PUT /api/v1/admin/backups/schedule` with `{"enabled": false}`). The chart has no value yet for
mounting another volume into the worker. With `storage.type: local`, the attachments live on
the `taskmoor-data` claim: back it up too. See [backups](backups.md).

Every pod serves Prometheus metrics through the `taskmoor-metrics` Service;
`metrics.serviceMonitor.enabled=true` makes a ServiceMonitor for the Prometheus Operator, and
`otel.endpoint` sends traces to an OpenTelemetry collector ([monitoring](monitoring.md)).

## Pod security

Pods run as user 1000 with a read-only root filesystem, no Linux capabilities, the default
seccomp profile and no service account token; `/tmp` and `/data` are the only writable paths.

## Uninstalling

`helm uninstall taskmoor` removes the deployments but keeps the `taskmoor-data` claim and the
`taskmoor-password-pepper` Secret, so a reinstall finds its files and passwords. Delete them
yourself to remove the data for good.
