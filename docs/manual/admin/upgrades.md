---
title: "Upgrades"
audience: admins
sources: deploy/compose/update.sh, apps/web/src/meta/VersionGate.tsx, tools/release/sign-update-manifest.sh, packages/builder-core/src/backend.ts, apps/server/src/updates/check.ts, apps/server/src/routes/update-check.ts, apps/web/src/admin/UpdateNotice.tsx, docs/adr/0117-update-command-and-new-version-notice.md, tools/airgap/install-offline.sh, apps/server/src/upgrade.ts, apps/server/src/upgrade-check.ts, apps/server/src/cli.ts, apps/server/src/main.ts, apps/server/src/frontend.ts, apps/server/src/routes/meta.ts, packages/db/src/releases.ts, apps/web/src/i18n/messages.en.ts, deploy/README.md, deploy/compose/README.md, deploy/compose/upgrade.sh, deploy/allinone/entrypoint.sh, deploy/helm/README.md, deploy/helm/taskmoor/templates/upgrade-check.yaml, docs/adr/0022-upgrades-and-migrations.md, docs/adr/0070-meta-endpoint-and-version-window.md, docs/specs/05b-administration-security-and-self-hosting.md, packages/builder-core/src/postgres-tls.ts, docs/adr/0111-personal-data-and-database-tls.md
accessed: 2026-11-22
attestation: own-words
---
# Upgrades

One command takes a site from any of the last three releases, and from the latest
long-term-support release, to a new one. There is no step per version in between. The command
checks first, backs up, applies every migration, verifies the result and rolls back on any
failure.

## Updating to the newest release

In the folder of the Compose kit or the Builder's backend kit, on the server:

```bash
bash update.sh                # the newest release
bash update.sh 1.4.0          # that release
bash update.sh --dry-run      # says what it would do; nothing changes or stops
```

It needs Docker, `curl` or `wget`, `openssl` and `base64`. On Windows with Docker Desktop, run it
from Git Bash. `update.sh`:

1. asks the project's public GitHub releases for the newest stable version, unless you named one;
2. checks the release's signature against `taskmoor-release.pub`, the release key's public half
   beside the script. The signed statement names the image by digest, so the image itself is
   checked when it downloads;
3. runs `upgrade.sh` with that image, which backs up, migrates and puts everything back on failure
   ([Compose](#compose) below).

**It never installs a release it cannot verify.** A release with no signature, a signature that
does not match, a statement for another version, or a missing `openssl` stops it before anything
is pulled or stopped, and there is no option to skip the check. If you have decided to trust an
image some other way, `bash upgrade.sh <image>` is still there.

It sends the release source nothing except ordinary requests for public files. It does nothing on
the newest version, and refuses to go back to an older one: for that, see [Which releases can
upgrade](#which-releases-can-upgrade). With `TASKMOOR_PULL=never` it stops and points you to the
air-gap bundle's own steps.

| Exit code | Meaning |
|---|---|
| 0 | Updated, or nothing to do, or a dry run that found nothing in the way |
| 1 | Not updated: the previous version is running on the database as it was. The message says why |
| 2 | Wrong arguments |
| 3 | The update and its rollback failed; the previous version is not back and the backend stays stopped (see [If an upgrade fails](#if-an-upgrade-fails)) |
| 4 | A backend or PostgreSQL did not come back; nothing vouches for what is running. Read the log the message names |

### A frontend on another host

A frontend the backend serves updates with it, and there is nothing more to do. A frontend on a
separate host keeps its version until you replace it, so `update.sh` ends by naming it and giving
the steps:

1. Open the new Builder, which you download from the release page.
2. Load your saved project file.
3. Upload the new frontend to that host.

See [The Builder's kits](builder-kits.md). Taskmoor stores no hosting login, so this step stays
yours. Until then, the app itself shows people the notices in [Frontend and backend
versions](#frontend-and-backend-versions).

## The new-version notice

Once a day, the worker looks at the project's public GitHub releases and remembers the newest
version. Site administrators then see a notice above every page with the new version and the exact
command to run. **Not now** hides it on that browser until a newer release. **Settings**, **System
status** has an **Updates** card with the same command, when the server last looked, and the
switch. Nobody else sees any of this.

There is no "Update" button in the app, on purpose: it would need the app to control Docker on its
server.

| Question | Answer |
|---|---|
| What is sent? | One ordinary request for a public file, through the [outbound guard](configuration.md). It carries no version, site id or cookie. GitHub sees what any request shows: your server's address |
| How do I turn it off? | **Look for new versions once a day** on the **Updates** card, or `TASKMOOR_UPDATE_CHECK=off` in the server's environment, which also locks the switch. Off, no request is made |
| What if there is no internet, or GitHub is down? | Nothing: a failed look shows nothing, logs only at debug level, and is tried again the next day |
| Behind a proxy? | The check does not use an outgoing proxy, so it fails quietly. Run `bash update.sh` from a shell with your proxy settings, as `curl` and `wget` use them |
| Air-gapped? | The bundle's installer turns it off in `.env`. On Helm, set `updateCheck.enabled=false` |

The notice shows `bash update.sh <version>` unless the kit says otherwise: the Helm chart and the
all-in-one image set their own in `TASKMOOR_UPDATE_COMMAND`, and you can set yours the same way.
It is text for you to read, and Taskmoor never runs it.

`GET /api/v1/admin/update-check` reads the same facts; `PUT` with `{"enabled": false}` is the
switch, and the audit log records the change.

## Upgrading each kit

| Kit | Upgrade |
|---|---|
| Compose | `bash update.sh`, or `bash upgrade.sh <image>` in the kit's directory |
| All-in-one | Start the new image on the same volume: it upgrades before it serves |
| Helm | `helm upgrade` |

The Compose and all-in-one kits run `node cli.mjs upgrade` from the new image, described in
[What the upgrade does](#what-the-upgrade-does). Helm works differently; see
[Helm](#helm) below.

### Compose

```bash
bash upgrade.sh ghcr.io/rockersands/taskmoor:1.4.0
```

`upgrade.sh`:

1. pulls the image when it is not loaded (with `TASKMOOR_PULL=never` it refuses instead of
   contacting a registry);
2. with the bundled PostgreSQL, makes the database's TLS certificate when there is none yet
   and restarts PostgreSQL with TLS once if it ran without it (see [Encryption between the
   backend and PostgreSQL](install.md#encryption-between-the-backend-and-postgresql));
3. stops the backend while PostgreSQL keeps running;
4. runs the upgrade from the new image against the kit's database and data volume;
5. on success, records the image as `TASKMOOR_IMAGE` in `.env`, starts it and waits up to two
   minutes for it to be ready;
6. on failure, starts the previous image again on the unchanged database.

An install made with an earlier kit gets TLS when you replace its `docker-compose.yml` with the
current one and run `upgrade.sh` (or `docker compose up -d`): the data volume stays as it is.

Like the installer, it uses `docker-compose.external.yml` when `DATABASE_URL` is set in the
environment or in `.env`, and adds the files named in `TASKMOOR_COMPOSE_OVERRIDE`.

| Exit code | Meaning |
|---|---|
| 0 | Upgraded, or nothing to do; the new image is running |
| 1 | Not upgraded; the database is as it was and the previous image is running. Also used when Docker is missing: the message says so |
| 2 | Wrong arguments |
| 3 | The upgrade and its rollback failed; the backend stays stopped (see [If an upgrade fails](#if-an-upgrade-fails)) |
| 4 | A backend did not become ready in two minutes, the backend could not be stopped, or PostgreSQL did not come back: the message says which, and its log says why |

### All-in-one

Every start of the all-in-one image runs the upgrade (`--unattended`) before the server. With
nothing to apply it costs a few queries. When an upgrade fails, the container stops with the
database as it was, and the next start of the same image does not try again, so a restarting
container never piles up backups. Start the previous image, or retry by hand with the container
stopped:

```bash
docker run --rm -v taskmoor-data:/data <image> upgrade
```

Never run this beside a running container on the same volume: both would start PostgreSQL on the
same files.

### Helm

`helm upgrade` first runs `node cli.mjs check-upgrade` from the new image as a pre-upgrade hook
(`upgradeCheck.enabled`, on by default). A blocking finding stops the upgrade before anything
changes. Then pods roll one at a time, never below full capacity, and the first new app pod
applies the pending migrations as it starts, in one transaction, so a failed one leaves the
database as it was.

The chart takes no backup of its own: back up the database with its provider's tooling before
you upgrade. See [Kubernetes with Helm](helm.md).

## What the upgrade does

1. **Checks, changing nothing.** If anything blocks, it stops here.
2. **Backs up** the database, the files and the password keyring into `pre-upgrade-<time>` in
   the backup directory (`TASKMOOR_BACKUP_DIR`, else `/data/backups`), after waiting up to an
   hour for a running backup to finish. The backup log lists it as a manual backup, so scheduled
   retention never deletes it. An empty database (a new install) needs no backup.
3. **Applies the migrations** of every release it crosses in one transaction. Migrations marked
   online (an index built concurrently on a large table, say) run each on their own, outside it.
4. **Verifies** before committing that nothing is pending and that every table, column and index
   matches the reviewed schema. Objects of your own beyond it are reported and left alone.
5. **Rolls back on any failure.** While nothing has committed, the transaction leaves the
   database exactly as it was. Once an online migration has committed, it drops what the upgrade
   created, restores the pre-upgrade backup in place and checks every table against it.

### The checks

| Check | Blocks when | Warns when |
|---|---|---|
| `database` | The database cannot be reached | |
| `postgres-version` | PostgreSQL is older than 16 | |
| `upgrade-lock` | Another upgrade of this database is running | |
| `migrations` | A newer release migrated the database, or a migration would run out of order | |
| `upgrade-path` | The database is too many releases back; the message names the release to upgrade to first | |
| `backup` | There is no backup directory (with `TASKMOOR_BACKUP_DIR=off` it says backups are off for the process, as scheduled backups do), or `--no-backup` with online migrations | A backup is running (the upgrade waits for it), or `--no-backup` |
| `backup-space` | Less free space than the backup needs | Less than twice that |
| `processes` | Other Taskmoor processes are connected and the plan has online migrations | Other Taskmoor processes are connected |
| `previous-attempt` | An unattended run whose last attempt at this target failed | |

The backup is expected to need the size of the last backup plus a fifth, or the size of the
database and files when there is none yet. Stop the other Taskmoor processes before upgrading:
they keep running the old version, which may not work with the new schema.

After the checks the command prints the plan: each migration, whether it runs online, the
existing tables it changes with their size, and a rough time estimate at 50 MB per second.

## Exit codes and the report

| Exit code | Outcome | Meaning |
|---|---|---|
| 0 | `upgraded` | Upgraded and verified |
| 0 | `up-to-date` | Nothing to apply |
| 0 | `planned` | A dry run |
| 1 | `blocked` | A check blocks; nothing was written |
| 1 | `failed` | The pre-upgrade backup failed; nothing was changed |
| 1 | `rolled-back` | A migration failed; the transaction put everything back |
| 1 | `restored` | A migration failed after a commit; the pre-upgrade backup was restored |
| 3 | `rollback-failed` | The upgrade failed and putting the database back failed too |

The last line of the output is the whole report as JSON: the outcome, the version, where the
database started and ends, every check, the plan, the migrations applied, the backup's path and
size, the migration that failed and why, and the seconds each step took. The backup log keeps
the outcome with the pre-upgrade backup.

## Dry runs

```bash
bash upgrade.sh ghcr.io/rockersands/taskmoor:1.4.0 --dry-run
```

A dry run prints the checks and the plan and changes nothing; the backend keeps running. When
the bundled PostgreSQL does not use TLS yet, the dry run says that the upgrade will set it up
first, and stops there: run it again after the upgrade or a `docker compose up -d`. Outside
the Compose kit, run `node cli.mjs upgrade --dry-run` from the new image.

## Skipping the backup

`node cli.mjs upgrade --no-backup` skips the pre-upgrade backup, for a database whose provider
keeps its own (snapshots, point-in-time recovery). A failure is then rolled back by the
transaction alone, and a plan with online migrations is refused.

## Checking without upgrading

`node cli.mjs check-upgrade` runs a shorter set of checks against the database and
exits with 1 while anything blocks: `database`, `postgres-version`, `migrations`, `upgrade-path`,
plus `disk-space` (blocks with less free space than the database's size, warns under twice that)
and `backup` (warns when the last backup is missing or older than a day). Each line starts with
`ok`, `warn` or `BLOCK`, and the last line says whether the upgrade can proceed.

`node cli.mjs status` shows which migrations are applied and pending; `node cli.mjs migrate`
applies pending migrations without checks or a backup, as the server does when it starts on an
older database. See [The operator CLI](cli.md).

## Which releases can upgrade

An upgrade starts from any of the three releases before the new one, counted by schema: patch
releases without migrations do not use up the window. The latest long-term-support release is
supported as well when it is older. From anything older, upgrade to the release the check names
first, then to the one you want.

Going back is refused: a database migrated by a newer release blocks the upgrade. Restore a
backup taken before, or use that release. Taskmoor has published no release yet, so for now
every earlier database can upgrade in one step.

## Frontend and backend versions

The image serves the web app it was built with, and refuses to start its web role next to a web
app of another version.

A frontend kit on a static host keeps its version until you replace it. A backend at version
x.y works with frontends from x.(y-1).0 on; at x.0 it needs x.0.0, because a major release
changes the API on purpose. Development builds accept any frontend. The web app asks the backend
when it starts and every 30 minutes:

- below the minimum, it shows **Update required** in place of the app, a stand-alone page with
  **Reload**; if the page comes back after reloading, it asks people to turn to a site
  administrator, since the frontend kit itself needs replacing;
- below x.y.0, it shows **A newer version is available.** with **Reload** and **Not now**.

Upgrade the backend first, then replace the frontend kit with one made for the new version (see
[The Builder's kits](builder-kits.md)). `GET /api/meta` shows the window as `frontend.minimum`
and `frontend.recommended`; see [Monitoring and logs](monitoring.md).

## If an upgrade fails

- **Exit 1.** The database is as it was. The Compose kit already runs the previous image again;
  with the all-in-one image, start the previous image. Read the report, fix the cause and retry.
- **Exit 4 (Compose).** A backend or PostgreSQL did not come back. If it was the new image, the
  upgrade itself succeeded and `.env` names it: read `docker compose logs taskmoor`, fix the cause
  and run `docker compose up -d`. If you must go back, restore the pre-upgrade backup with the
  command below and set `TASKMOOR_IMAGE` in `.env` to the previous image.
- **Exit 3.** Keep every Taskmoor process stopped and restore the pre-upgrade backup the output
  names; the output also prints the exact command. In the Compose kit (add
  `-f docker-compose.external.yml` for an external database):

```bash
TASKMOOR_IMAGE=<new image> docker compose run --rm taskmoor node cli.mjs restore /data/backups/pre-upgrade-<time> --yes
docker compose up -d
```

`.env` still names the previous image, so `docker compose up -d` starts it.

The all-in-one image's start script has no restore command. With the container stopped, open a
shell in the new image on the same volume and run the steps its start script uses:

```bash
docker run --rm -it -v taskmoor-data:/data --entrypoint sh <new image>
```

Then, in that shell:

```bash
su-exec postgres pg_ctl -D /data/postgres -w start
su-exec node env DATABASE_URL=postgres://postgres@127.0.0.1:5432/taskmoor node cli.mjs restore /data/backups/pre-upgrade-<time> --yes
su-exec postgres pg_ctl -D /data/postgres -m fast -w stop
```

Then start the previous image. See [Backups and restore](backups.md).

Once the new version has proved itself, remove the pre-upgrade backup by hand: retention never
deletes it.
