# ADR-117: One update command, and a new-version notice for administrators

- Status: Accepted
- Date: 2026-11-03
- Backlog: M1-120 (the user's decision of 2026-11-03: easier updates in 1.0)

## Context

Taskmoor is self-hosted with no central service (the user's decision of 2026-11-03: anyone hosts
their own copy, and nothing may depend on a service the project runs). `upgrade.sh <image>`
already backs up, migrates and rolls back (ADR-022), but an operator had to find out that a
release exists, look up its image and trust it by hand. The Builder's backend kit did not carry
`upgrade.sh` at all.

The user decided two additions for 1.0: one update command, and a notice for administrators read
from the public releases, with an off switch. They were told an "Update" button in the app would
need the app to control Docker on its server, which is a security risk, so there is none.

## Decision

### The update command (OPS-025)

`bash update.sh [version] [--dry-run]`, the same file in `deploy/compose` and in the Builder's
backend kit, beside `upgrade.sh` and the public half of the release key
(`taskmoor-release.pub`).

1. **Which version.** The one named, or the newest stable from
   `api.github.com/repos/Rockersands/taskmoor/releases/latest`. Only a plain `x.y.z` tag is
   accepted. It says "nothing to do" at or above that version, and refuses to go back.
2. **Verification.** Each release publishes `taskmoor-release.txt`:

   ```
   version=1.4.0
   image=ghcr.io/rockersands/taskmoor@sha256:<digest>
   ```

   and `taskmoor-release.txt.sig`, its ECDSA P-256 signature in the format `cosign sign-blob
   --key` writes, as for the air-gap bundle (ADR-021, OPS-007).
   `tools/release/sign-update-manifest.sh` writes both and refuses a key other than the one the
   kits carry. `update.sh` needs `openssl` and `base64`, checks the signature against
   `taskmoor-release.pub`, checks that the statement names the version asked for, and pulls by
   digest, so Docker checks the image against the signed checksum. The tag on the registry and
   the answer from GitHub are not trusted.
3. **No verification, no update.** A release with no signed statement, a signature that does not
   match, a statement for another version, or a missing `openssl` or key all stop before anything
   is pulled or stopped. There is no flag to skip this. An operator who has decided to trust an
   image anyway still has `upgrade.sh <image>`.
4. **The upgrade.** `upgrade.sh <repo>:<version>@<digest>`, which records that reference in
   `.env`. A kit on a registry of its own keeps it: the digest is the same image there.
5. **Failure.** `upgrade.sh` gains exit code 4, "a backend or PostgreSQL did not come back", so
   that exit 1 always means the previous version is running. `update.sh` says which case it is:
   1, the previous version is back on the unchanged database; 3, the rollback failed too and the
   backend stays stopped; 4, nothing vouches for what is running.
6. **Frontends.** A frontend the backend serves updates with it, and nothing more is said. For a
   frontend on another host (`node cli.mjs frontends`, the origins in `.env` when the backend
   cannot answer), the last message says to open the new Builder, load the saved project file and
   upload the new frontend. No hosting login is stored, and the kits' default layout is unchanged.

The Builder runs in a browser and reads no files, so `tools/compose/kit-scripts.mjs` writes the
scripts into `packages/builder-core/src/kit-scripts.ts`; a test fails when they differ.

### The new-version notice (OPS-026)

- **The check.** In the worker role, queued with the other housekeeping every five minutes when
  24 hours have passed since the last attempt, keyed by the date so several workers ask once.
  The job has one attempt: the next day's check is the retry.
- **What it sends.** `GET` to the same releases address through the outbound guard (ADR-110), with
  `accept` and `user-agent: taskmoor`: no version, instance id, query string or cookie. GitHub
  sees what any request shows: the server's address.
- **What it keeps.** `instance_setting` under `update_check_result`: when it tried, when it
  succeeded, and the version. Only a plain `x.y.z` is kept; the command and the link are built
  from it here. No migration.
- **Quiet.** A failure is logged at debug level only and shows nothing anywhere. A proxy the
  guard does not use, a firewall, no DNS and GitHub's rate limit all look the same.
- **Who sees it.** `GET /api/v1/admin/update-check`, site administrators only (the `admin` token
  class). `/api/meta`, which is public, says nothing about it. The web app asks only for a site
  administrator, shows the version and the command above every page until **Not now** (per
  version, on that browser), and keeps a card with the switch on the system status page.
- **Off switches.** `TASKMOOR_UPDATE_CHECK=off` overrules everything; the setting (`PUT
  /api/v1/admin/update-check`, audited as `update_check.updated`) turns it off for a site
  administrator. Off, no request is made and no notice shows.
- **Air gap.** The bundle's installer writes `TASKMOOR_UPDATE_CHECK=off` into `.env`, so OPS-005's
  "no outbound calls" still holds for a bundle install; `test-offline.sh` checks it. Helm has
  `updateCheck.enabled`.
- **Development builds** ask nothing, having no version to compare.
- **The command.** `bash update.sh <version>` by default. `TASKMOOR_UPDATE_COMMAND`, with
  `{version}`, replaces it: the chart and the all-in-one image set theirs. It is text for a person
  to read and nothing ever runs it.

## Options considered

| Option | For | Against |
|---|---|---|
| A signed statement naming the image digest (chosen) | Checks the image itself with tools every server has; the kit carries the key; same key and format as the bundle | One more file per release, and the release must be signed for anyone to update through this command |
| `cosign verify` of the image | The standard tool | One more program to install on each server; Sigstore's own services by default |
| A checksum file with no signature | No key involved | It comes from the same place as the release, so it proves no more than the download did. The digest in the signed statement is the checksum |
| Trusting the tag over HTTPS | Nothing to build | A registry or account compromise installs on every server |
| A release source the project runs | Could carry channels and notes | Ruled out: nothing may depend on a project service |
| An "Update" button in the app | One click | The app would need to control Docker on its server (the user's decision) |
| Retrying a failed check within the day | Learns sooner | Breaks "at most once a day"; a release is not urgent to the hour |
| A column or table for the result | Typed | One row of `instance_setting` does it; no migration |

## Consequences

- **Every release from 1.0 must attach the signed statement**, or `update.sh` refuses it. The
  release steps are in `docs/ops/releases.md`.
- A new release key needs new kits, as the key is a file in the kit. Rotating it needs a procedure
  (the new key signed by the old) before it happens.
- `update.sh` and `upgrade.sh` do not replace themselves. A release that changes them, or the
  Compose file, must say so in its notes and give the files to copy, as the manual already says
  for an earlier kit. Self-replacement was left out on purpose: a script that rewrites itself from
  the network is harder to trust.
- All-in-one and Helm installs get the notice and their command, not `update.sh`.
- ADR-021 and ADR-023 read "no update check" and "no telemetry": the first now holds for the
  air-gap bundle only, the second is unchanged, as this is a read of a public file and reports
  nothing. ASVS 10.2.1's row says so.
- The real GitHub API, a real registry and real Docker were not used to test this: the repository
  is private until 1.0. See `docs/plan/easy-updates-tasks.md`.
- Revisit if GitHub's rate limit (60 requests an hour per address, shared on a NAT) makes the
  command fail often. An explicit version needs no such lookup.
