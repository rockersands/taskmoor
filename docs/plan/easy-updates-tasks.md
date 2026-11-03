# Easier updates (the user's decision of 2026-11-03, for M1-120)

Spec: OPS-025 and OPS-026 (`docs/specs/05b-administration-security-and-self-hosting.md`).
Decision record: [ADR-117](../adr/0117-update-command-and-new-version-notice.md). No migration.

## Tasks

| Task | State | Where |
|---|---|---|
| `update.sh` in `deploy/compose` | Done | `deploy/compose/update.sh`, `taskmoor-release.pub` |
| The same scripts in the Builder's backend kit | Done | `packages/builder-core/src/backend.ts`, `kit-scripts.ts` (written by `tools/compose/kit-scripts.mjs`) |
| Release statement and its signature | Done | `tools/release/sign-update-manifest.sh`, `docs/ops/releases.md` |
| `upgrade.sh` exit code 4 | Done | `deploy/compose/upgrade.sh`, manual |
| Worker check, stored result, off switches | Done | `apps/server/src/updates/check.ts`, `main.ts`, `config.ts` |
| Administrators' API | Done | `apps/server/src/routes/update-check.ts`, event `update_check.updated` |
| Notice and status card, English and Spanish, stories | Done | `apps/web/src/admin/UpdateNotice.tsx`, `Facts.tsx`, `AppShell.tsx`, `shell.css` |
| Air-gapped installs stay silent | Done | `install-offline.sh`, `install.sh`, `test-offline.sh`, chart's `updateCheck.enabled` |
| The list of frontends on other hosts | Done | `node cli.mjs frontends` |
| Manual | Done | `admin/upgrades.md`, `configuration.md`, `monitoring.md`, `builder-kits.md`, `cli.md`, `helm.md` |

## Handoff

**What changed.** `bash update.sh [version] [--dry-run]` works in both Compose kits. It finds the
newest release, checks the signed statement, runs `upgrade.sh` by image digest, says plainly what
happened, and ends with the Builder steps when a frontend is on another host. The worker looks at
the public releases at most once a day, through the outbound guard, and site administrators see
the new version and the exact command above every page and on the status page.

**Release work this adds.** Every release needs the signed statement attached, or `update.sh`
refuses it. See "Releasing" in `docs/ops/releases.md`.

**Tested only against a fake.** There is no public release yet, and the repository is private.

- The tests use a release source on loopback, a throwaway signing key and a stand-in for Docker.
- The real `update.sh` and `upgrade.sh` ran, under Git Bash on Windows, with curl.
- Not exercised: GitHub's real API answer and rate limit; a real release download with its
  redirect; a real `docker pull` of `name:tag@digest`, `docker image inspect` of that form, and
  Compose running it; the wget path; bash on Linux; `install.sh` on a real Compose stack; the
  outbound guard reaching GitHub over the internet.
- The real release key has not signed a statement.
- The Helm template has not been rendered (`helm` is not on this machine).

**First things to check at the first release.** Run these on a Linux server with the 1.0.0 kit:

1. `bash update.sh --dry-run`, then `bash update.sh`, against the first real next release.
2. On that machine, confirm `.env` records `name:version@sha256:...` and `docker compose up -d`
   starts it.
3. `helm template deploy/helm/taskmoor` shows `TASKMOOR_UPDATE_CHECK` and
   `TASKMOOR_UPDATE_COMMAND`.
4. An instance with the check on shows a notice within a day; `tools/airgap/test-offline.sh`
   passes.

**Half-done.** Nothing. `progress.csv`, `backlog.csv`, `HANDOFF.md` and `STATUS.md` are the
coordinator's.
