# Image and kit scripts on a Mac (T-023)

The bash scripts that build the image and install the kits cannot run on the Windows setup, so
they had not run since the merges of late October. This page records their first run on a Mac,
on 2026-11-05, what failed and what was fixed. The scripts are the ones in `CLAUDE.md`'s command
table; none of them reaches a registry other than Docker Hub for base images.

## The machine

| | |
|---|---|
| Computer | Apple M3 Pro (11 cores, 36 GB), macOS 26.3.1, arm64 |
| Docker | Colima 0.10.3 (`vz` VM with Rosetta, `colima start --cpu 6 --memory 12`, 60 GB disk); Docker Engine 29.5.2, CLI 29.9.2, Buildx 0.38.1, Compose 5.6.1 |
| Shell and tools | `/bin/bash` 3.2.57 (the macOS bash), Node 22 (Homebrew `node@22`), OpenSSL 4.0.3 (Homebrew), the system's `python3` 3.9.6, `sha256sum` and `base64` |
| Network | About 0.4 MB/s, so first pulls and the first image build are slow |

## Final result

All five scripts passed, one after the other, at commit `3bf55903` (this page was added after it
and changes only documentation). Times are with Docker's caches warm; the first runs, with every
base image pulled over the slow link, are under "Runs and fixes".

| Script | Result | Time | What it showed |
|---|---|---|---|
| `bash tools/image/smoke.sh` | Passed | 32 s | Image 96 MB (limit 400 MB), built for arm64 (this host) and for amd64 under emulation; the frontend artefact and the server are the same version; a deep link goes to its hash route and `/browse/ABC-1` to its ticket, in both routing modes; all roles ready next to PostgreSQL 16; the amd64 image answers `/health` |
| `bash tools/image/smoke-kits.sh` | Passed | 46 s | All-in-one image 107 MB: ready, clean URLs, PostgreSQL on its Unix socket only, data kept across a restart and an unclean stop, `upgrade` up to date. Compose kit with bundled PostgreSQL: TLS only, plain TCP refused, `verify-full` accepted, `upgrade.sh` to the same image keeps the certificate authority. Compose kit with an external PostgreSQL: ready, clean URLs |
| `bash tools/image/smoke-backend-kit.sh` | Passed | 13 s | The Builder's backend kit for `https://localhost:18443`: `install.sh` prints the setup link, health answers through Caddy's HTTPS, `/api/meta` serves the kit's instance, a second `install.sh` changes nothing |
| `bash tools/airgap/test-offline.sh` | Passed | 34 s | A 258 MB bundle signed with a throwaway key made for the run; a changed file and another key are refused; the offline install on an internal network with no route out; the new-version check off; the bundled model embeds tickets and finds the similar one, with pgvector's HNSW index |
| `bash tools/image/fresh-vm.sh` | Passed | 28 s | M1-113: both kits on an empty Docker-in-Docker machine, installed in 18 s; fresh machine to first sign-in 22 s (limit 15 minutes); setup, sign-in at another site, a track, a ticket, a board, a query; the open board updated 310 ms after a change elsewhere |

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

## Found, not fixed

- **The setup link names port 8080 whatever `TASKMOOR_PORT` is.** With `TASKMOOR_PORT=18120` and
  no `PUBLIC_URL`, `deploy/compose/install.sh` (and the air-gap installer through it) prints
  "running on port 18120" and then a link to `http://localhost:8080/#/setup?...`, because the
  server builds the link from its own port inside the container. Anyone who moves the port
  because 8080 is taken gets a link to the wrong place. A fix would rewrite the link's origin to
  the published port when `PUBLIC_URL` is not set, in `install.sh` and `install.ps1` alike.
- **`install.sh`'s busy-port check does not work on a Mac.** It reads `ss` or `netstat -ltn` in
  Linux's format; a Mac has no `ss`, and its `netstat` writes `127.0.0.1.8080`, so a busy port
  is not seen and Docker's own "port is already allocated" error comes instead.
- **The image build has no retry for corepack's download of pnpm**, so a dropped connection
  fails the build (once here); a rerun passed.
- `fresh-vm.sh` prints a harmless "Terminated" line when it stops its static server.

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
