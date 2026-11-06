# Image and kit scripts on a Mac (T-023)

The bash scripts that build the image and install the kits cannot run on the Windows setup, so
they had not run since the merges of late October. This page records their first run on a Mac,
on 2026-11-05, what failed and what was fixed, and a second run that evening after the fixes
for what the runs left behind. The scripts are the ones in `CLAUDE.md`'s command
table; none of them reaches a registry other than Docker Hub for base images.

## The machine

| | |
|---|---|
| Computer | Apple M3 Pro (11 cores, 36 GB), macOS 26.3.1, arm64 |
| Docker | Colima 0.10.3 (`vz` VM with Rosetta, `colima start --cpu 6 --memory 12`, 60 GB disk); Docker Engine 29.5.2, CLI 29.9.2, Buildx 0.38.1, Compose 5.6.1 |
| Shell and tools | `/bin/bash` 3.2.57 (the macOS bash), Node 22 (Homebrew `node@22`), OpenSSL 4.0.3 (Homebrew), the system's `python3` 3.9.6, `sha256sum` and `base64` |
| Network | About 0.4 MB/s, so first pulls and the first image build are slow |

## Results

### First pass

All five scripts passed, one after the other, at commit `3bf55903`. Times are with Docker's
caches warm; the first runs, with every base image pulled over the slow link, are under "Runs
and fixes".

| Script | Result | Time | What it showed |
|---|---|---|---|
| `bash tools/image/smoke.sh` | Passed | 32 s | Image 96 MB (limit 400 MB), built for arm64 (this host) and for amd64 under emulation; the frontend artefact and the server are the same version; a deep link goes to its hash route and `/browse/ABC-1` to its ticket, in both routing modes; all roles ready next to PostgreSQL 16; the amd64 image answers `/health` |
| `bash tools/image/smoke-kits.sh` | Passed | 46 s | All-in-one image 107 MB: ready, clean URLs, PostgreSQL on its Unix socket only, data kept across a restart and an unclean stop, `upgrade` up to date. Compose kit with bundled PostgreSQL: TLS only, plain TCP refused, `verify-full` accepted, `upgrade.sh` to the same image keeps the certificate authority. Compose kit with an external PostgreSQL: ready, clean URLs |
| `bash tools/image/smoke-backend-kit.sh` | Passed | 13 s | The Builder's backend kit for `https://localhost:18443`: `install.sh` prints the setup link, health answers through Caddy's HTTPS, `/api/meta` serves the kit's instance, a second `install.sh` changes nothing |
| `bash tools/airgap/test-offline.sh` | Passed | 34 s | A 258 MB bundle signed with a throwaway key made for the run; a changed file and another key are refused; the offline install on an internal network with no route out; the new-version check off; the bundled model embeds tickets and finds the similar one, with pgvector's HNSW index |
| `bash tools/image/fresh-vm.sh` | Passed | 28 s | M1-113: both kits on an empty Docker-in-Docker machine, installed in 18 s; fresh machine to first sign-in 22 s (limit 15 minutes); setup, sign-in at another site, a track, a ticket, a board, a query; the open board updated 310 ms after a change elsewhere |

### Second run, after the clean-up fixes

The same evening, at `0bb2cad0` (the fixes below for volumes, tags and `install.sh`), with the
`taskmoor:dev` image built at `20570481`: nothing the image carries changed between the two (only
scripts, tests, documentation and `deploy/compose/install.sh`, which is not in the image). The
machine was much busier this time: other sessions' test runs between and beside these ones put
the load average between 15 and 120.

| Script | Result | Time | What it showed |
|---|---|---|---|
| `bash tools/image/smoke.sh` | Not run to the end | | First try: BuildKit failed in 2 s, before any step, with "unable to lease content: lease does not exist" while resolving the Dockerfile's syntax image (Docker's own fault; nothing in the script). Second try: the dependency install layer was no longer cached (no dependency file had changed, so Docker had lost it), the image build downloaded all 820 packages again at the slow link's pace, and stopped making progress at 815 after 77 minutes; it was stopped after nearly three hours. Its own change since the first pass is only `docker rm -v` |
| `bash tools/image/smoke-kits.sh` | Passed | 55 s | As in the first pass; no volume left behind (the count stayed at the 20 the first pass had left) |
| `bash tools/image/smoke-backend-kit.sh` | Passed | 21 s | As in the first pass; no volume left behind |
| `bash tools/airgap/test-offline.sh` | Passed | 1851 s | As in the first pass, and the setup link now names port 18120, the one the test publishes. The time is most likely the machine's load (34 s in the first pass); the script logs no times of its own to say which step took it |
| `bash tools/image/fresh-vm.sh` | Failed | 942 s | Both kits installed on the fresh machine in 24 s and the setup link made the administrator; the browser journey then timed out at the "Add a track" button, which Playwright found but never saw "stable", and the test's 3-minute limit ran to 15 minutes on the starved machine. The same image passed in 28 s in the first pass. A third run waited more than two hours behind other sessions' test runs and was stopped, so whether load alone caused this is not settled |

## Runs and fixes

Each failure was fixed in the script or in what it exercises, with a test where one can show it,
and the script was run again.

| Script | First run | Cause | Fix | Test |
|---|---|---|---|---|
| `smoke.sh` | The emulated step built arm64 again | On an arm64 host the "other architecture" step was also arm64, so amd64 was never checked on a Mac (noted on 2026-10-30 too) | The script builds the host's architecture, then whichever of amd64 and arm64 it is not, and checks the emulated image's architecture | Run: amd64 under Rosetta passed |
| `smoke.sh` | Failed after 226 s in the image build | The network: corepack's download of pnpm was cut off ("other side closed") | None needed: the second run built in about two minutes | |
| `smoke.sh` | Failed after 127 s: `/browse/ABC-1` went to `/#/tickets/ABC-1` | Since M1-128 that path is a link from an imported tracker and goes to its ticket; the script still expected `/#/browse/ABC-1`, and its clean-URL probe used the same path | The script probes a plain deep link and the imported link, in both routing modes | `packages/devtools/src/image-scripts.test.ts` holds every probe against the server's rules |
| `smoke-kits.sh` | Stopped at once: `secret[@]: unbound variable` | In bash 3.2 an empty array expanded in quotes under `set -u` is an error, and the build-secret array is empty unless `BUILD_CA` is set. `fresh-vm.sh` had the same line | Both expand it as `${a[@]+"${a[@]}"}`, the same on every bash (also the fuzzing stages' process list) | `image-scripts.test.ts` checks every bash script of `tools/` and `deploy/` |
| `smoke-kits.sh` | Passed in 270 s | | | Most of the time was pulling `pgvector/pgvector:0.8.1-pg16-trixie` |
| `smoke-backend-kit.sh` | Stopped at once: no `apps/web/dist` | The Builder CLI reads the checkout's web build unless told otherwise, and a checkout has none until `pnpm build` | The script copies `/app/web` out of the image, as `fresh-vm.sh` does, so the kits also carry the image's own version | `image-scripts.test.ts` |
| `test-offline.sh` | Failed after 152 s at "checksums and signature", with no reason shown | `verify.sh` decoded the signature with `base64 -d <file>`, which a Mac's `base64` refuses, so it refused every bundle; `bundle.sh` discarded its message | `verify.sh` reads the signature from standard input (as `update.sh` already did); `bundle.sh` writes one line of base64 without GNU's `-w0` and prints `verify.sh`'s reason when it fails; the file count lost the Mac's padding | `packages/devtools/src/airgap-verify.test.ts` runs the real `verify.sh` on a bundle signed with a throwaway key |
| `test-offline.sh` | Failed: `service "postgres-tls" didn't complete successfully: exit 127` | Not Mac-specific. Since ADR-111 the Compose kit makes its database certificate with `openssl` in the database image; the bundle still shipped `postgres:16.10-alpine`, which has no `openssl`, so no offline install could start | `bundle.sh` takes the database image the kit's `docker-compose.yml` names; `test-offline.sh` uses the same. ADR-106 is amended and the manual's similar-tickets page follows | `airgap-verify.test.ts` runs `bundle.sh`'s own line against the Compose file and the Builder's image |
| `fresh-vm.sh` | The browser journey failed: "Not an input element" | The create dialog's ticket type is a combobox with icons now (CORE-005); the spec waited for a select's value | `apps/web/e2e-fresh/fresh-install.spec.ts` waits for the combobox to name a type | The journey itself, run by the script |
| All | After the first pass Docker held 20 unused anonymous volumes | `smoke.sh`, `smoke-kits.sh` and `bundle.sh` removed their PostgreSQL and Taskmoor containers without `-v`, so each run left the images' data volumes behind, and a forced removal of a container started with `--rm` does not remove them either | Every `docker rm` in `tools/image` and `tools/airgap` takes `-v` | `image-scripts.test.ts`; in the second run the count did not grow |
| `smoke-kits.sh` | Docker held six `taskmoor-ext-<pid>` networks, the oldest from 2026-10-30 | The clean-up removed the network before the external kit's Taskmoor container that was on it, and Docker refuses to remove a network a container is still on | The clean-up removes every container, then the volumes, then the networks | `image-scripts.test.ts` holds every clean-up to that order |
| `fresh-vm.sh` | Left a tag `ghcr.io/rockersands/taskmoor:<version>` behind | It tags the image as the version the kit pins, and never removed the tag, so each old build stayed alive after `smoke.sh` replaced `taskmoor:dev` | The clean-up removes the tag | `image-scripts.test.ts` holds every image and air-gap script to removing the tags it adds |
| `test-offline.sh` | The install printed "running on port 18120" and a link to `http://localhost:8080/#/setup?...` | Without `PUBLIC_URL` the server builds the link from its own port inside the container | `deploy/compose/install.sh` names the host port in the link when `PUBLIC_URL` is not set | `packages/devtools/src/compose-install.test.ts`; the second run's link named 18120 |
| `install.sh` (seen while fixing the link) | A busy port never stopped an install | The check read `ss` or `netstat -ltn` in Linux's format, which a Mac has neither of; and where it saw a taken port it asked `docker compose ps -q taskmoor`, which succeeds with no output when nothing runs | `ss` where there is one, otherwise a connection to the port (as the Builder's kit does); it stops unless Compose names a running Taskmoor container | `compose-install.test.ts` |

## Found, not fixed, and not done

- **`install.ps1` still names port 8080 in the setup link** when `TASKMOOR_PORT` is another and
  `PUBLIC_URL` is not set; `install.sh` no longer does. There is no PowerShell on this Mac to
  run a change, so it waits for a Windows session; the manual's install page says so meanwhile.
- **The image build has no retry for corepack's download of pnpm**, so a dropped connection
  fails the build (once here); a rerun passed. Over a slow, unreliable link the dependency
  install can also stall without failing, as in the second run.
- `fresh-vm.sh` prints a harmless "Terminated" line when it stops its static server.
- **`fresh-vm.sh`'s journey under load** (second run, above): rerun it on a quiet machine; if
  "Add a track" is still never stable, look at what moves the create-track form.
- **`smoke.sh` at the final commit** did not run to the end (second run, above); its only change
  since its last pass adds `-v` to `docker rm`.

## Docker's disk

Measured with `docker system df` before the second run and after its clean-up (unused anonymous
volumes, dangling images, and the leftover networks removed):

| | Before | After |
|---|---|---|
| Containers | 0 | 0 |
| Volumes | 20 unused anonymous volumes, 218 MB, all from the first pass | 0 |
| Networks | 6 left by `smoke-kits.sh` (besides Docker's own and `kind`) | 0 |
| Images | 13, 6.63 GB | 13, 6.87 GB; none dangling |
| Build cache | 111 entries, 3.15 GB | 139 entries, 3.45 GB (the stopped build's downloads) |

The images kept are the ones the scripts build and reuse (`taskmoor:dev` 365 MB,
`taskmoor:dev-amd64` 368 MB, `taskmoor-allinone:dev` 410 MB, `taskmoor-vm:dev` 528 MB) and the
base images they pull; `docker rmi` the first four frees about 1.7 GB, and
`docker builder prune` the build cache, at the cost of downloading it all again on the next
run over a slow link. Colima was stopped afterwards.

## What cannot run here

- **Signing with the release key.** The key is kept offline by the maintainer
  (`docs/ops/releases.md`); the air-gap test signs with a throwaway key made for each run and
  removed after it. `bundle.sh` now runs on a Mac, so the maintainer can build and sign a real
  bundle on one.
- **Publishing images to ghcr.io** (T-036): the user runs the `gh` and `docker login` commands.
  The kits here ran against the locally built `taskmoor:dev`.
- **What waits for the M1 gate** (`CLAUDE.md`): the GitHub Actions jobs, PostgreSQL 18, Windows
  and `install.ps1`, Helm on kind (it last ran on this Mac on 2026-10-30), the install matrix.

## Running them again

```
colima start --cpu 6 --memory 12
bash tools/image/smoke.sh            # builds taskmoor:dev; the others use it
bash tools/image/smoke-kits.sh
bash tools/image/smoke-backend-kit.sh
bash tools/airgap/test-offline.sh
bash tools/image/fresh-vm.sh         # needs Playwright's Chromium (pnpm install)
colima stop
```

Colima shares only the home folder with its VM, so run the scripts from a checkout under it.
