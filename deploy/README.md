# Installing Tracksmith

One image runs every role (ADR-021). Pick a kit:

| Kit | For | Where |
|---|---|---|
| Compose with bundled PostgreSQL | A server of your own, up to a few hundred users | [`compose/`](compose/README.md) |
| Compose with an external PostgreSQL | A managed or shared database | [`compose/`](compose/README.md) |
| All-in-one container | Trials and single-box installs: PostgreSQL inside, one `/data` volume | [`allinone/`](allinone/Dockerfile) |

Every kit ends the same way: the backend logs a line like

```
{"msg":"first-run setup","link":"http://localhost:8080/#/setup?token=..."}
```

Open that link (`docker compose logs tracksmith` shows it) to create the first administrator.
The token works once and expires after 24 hours; restarting the backend prints a new one. Set
`PUBLIC_URL` (for example `https://tracker.example.com`) so the link and the session cookies
match the address people use, and `TRACKSMITH_SETUP_TOKEN` to choose the token yourself, as an
installer or a test does.

Before an upgrade, run the pre-upgrade check (ADR-022): it blocks on a database that is
unreachable, older than PostgreSQL 16 or migrated by a newer release, and warns about disk
space and backup age:

```
docker compose exec tracksmith node cli.mjs check-upgrade
```

Then change the image tag and start again; migrations run at start (`node cli.mjs migrate`
runs them on their own, `node cli.mjs status` shows what is pending).

## Backups

A backup is a directory with the database (`pg_dump` custom format), the uploaded files, the
non-secret configuration and a manifest with a checksum per entry (OPS-008):

```
docker compose exec tracksmith node cli.mjs backup
```

It lands under `/data/backups/<timestamp>` on the `tracksmith-data` volume (`--out <dir>` picks
another place; copy it off the host afterwards) and refreshes the marker that the pre-upgrade
check reads, which warns when the last backup is older than a day. To restore, stop everything
but one backend, put the backup directory under `/data/backups`, then (OPS-009):

```
docker compose exec tracksmith node cli.mjs restore /data/backups/<timestamp> --yes
```

The restore verifies the checksums first, replaces the database contents and the files, and
leaves the instance exactly as it was backed up, including the administrators and their
sessions. `node cli.mjs checksum` prints one checksum per table; CI runs the whole drill
(back up, wipe, restore, compare) with `tools/image/drill-backup.sh` on every push.
Scheduled backups come with M1.

The Builder (M1) generates these files with fresh secrets and a reverse proxy with HTTPS; until
then, copy the examples and fill them by hand.
