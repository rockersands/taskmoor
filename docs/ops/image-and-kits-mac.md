# Image and kit scripts on a Mac (T-023)

The bash scripts that build the image and install the kits cannot run on the Windows setup, so
they had not run since the merges of late October. This page records their first run on a Mac,
on 2026-11-05, what failed and what was fixed, a second run that evening after the fixes
for what the runs left behind, and a third on 2026-11-06 after a review of that work, in which
all five passed. A fourth that day, after a re-check, made an air-gap bundle for amd64 servers
on this arm64 Mac for the first time and ran the image and fresh-machine scripts again; after a
second re-check, the bundle's SBOM was checked against a tag that holds both platforms. On
2026-11-14 `smoke.sh` ran twice more after T-247 bounded the image's dependency install. The
scripts are the ones in `CLAUDE.md`'s command table; none of them reaches a registry other than
Docker Hub for base images.

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
| `bash tools/image/smoke.sh` | Passed | 32 s | Image "96 MB" against the 400 MB limit, which was no check: that is the compressed download here (see [The image size](#the-image-size)); built for arm64 (this host) and for amd64 under emulation; the frontend artefact and the server are the same version; a deep link goes to its hash route and `/browse/ABC-1` to its ticket, in both routing modes; all roles ready next to PostgreSQL 16; the amd64 image answers `/health` |
| `bash tools/image/smoke-kits.sh` | Passed | 46 s | All-in-one image "107 MB" (the compressed download, as above): ready, clean URLs, PostgreSQL on its Unix socket only, data kept across a restart and an unclean stop, `upgrade` up to date. Compose kit with bundled PostgreSQL: TLS only, plain TCP refused, `verify-full` accepted, `upgrade.sh` to the same image keeps the certificate authority. Compose kit with an external PostgreSQL: ready, clean URLs |
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

### Third run, after the review

On 2026-11-06 at `401ac5ee`, which has the review's fixes below (the stand-in tag made on the
fresh machine, the unpacked size, the bundle's platform), on a quiet machine (load average
about 5). `fresh-vm.sh` and `test-offline.sh` first ran on the image built at `20570481` and
passed in 29 s and 34 s; then `smoke.sh` built the image at `401ac5ee` and the other four ran
again on it, which is the table. The machine was left with no container, volume or network from
the scripts, and no `ghcr.io/rockersands/taskmoor` tag.

| Script | Result | Time | What it showed |
|---|---|---|---|
| `bash tools/image/smoke.sh` | Passed | 156 s | Image 269 MB unpacked (limit 400 MB), version `401ac5ee` in the server and the frontend artefact, the deep and imported links in both routing modes, all roles next to PostgreSQL 16, the amd64 build under emulation. The dependency install was not cached and its 820 packages were downloaded again, in about a minute over a faster link than the day before |
| `bash tools/image/smoke-kits.sh` | Passed | 41 s | As in the first pass; the all-in-one image 303 MB unpacked |
| `bash tools/image/smoke-backend-kit.sh` | Passed | 15 s | As in the first pass |
| `bash tools/airgap/test-offline.sh` | Passed | 33 s | As in the first pass, with a bundle for `linux/arm64`, this machine's platform, which `install-offline.sh` checked before loading the images |
| `bash tools/image/fresh-vm.sh` | Passed | 31 s | Installed in 18 s; fresh machine to first sign-in 22 s; the whole journey, "Add a track" included; the open board updated 205 ms after a change elsewhere |

### Fourth run, after the re-check

On 2026-11-06 at `4006d1ee`, which has the re-check's fix for the bundle's platform (its row
under "Runs and fixes"), one after the other while holding the machine's test lock, on a quiet
machine: the load average stayed between 5 and 8 (one-minute figure, sampled every 20 s), well
below the 15 to 120 of the second run. Docker Engine 29.5.2 (API 1.54) with the containerd image
store, CLI 29.9.2. `smoke-kits.sh` and `smoke-backend-kit.sh` did not run again: nothing they
exercise changed since the third run.

| Script | Result | Time | What it showed |
|---|---|---|---|
| `bash tools/image/smoke.sh` | Passed | 35 s | Built `taskmoor:dev` at `4006d1ee` with the dependency install cached; 269 MB unpacked; the version in the server and the frontend artefact; both routing modes; all roles next to PostgreSQL 16; `taskmoor:dev-amd64` under emulation |
| `bash tools/image/fresh-vm.sh` | Passed | 30 s | Installed in 19 s; fresh machine to first sign-in 23 s; the whole journey, "Add a track" included, with nothing changed in the spec or the page; the open board updated 311 ms after a change elsewhere. With the third run's two, that is three passes on a quiet machine and the one failure at a load near 120 |
| `bundle.sh`, `PLATFORM=linux/amd64` | Passed | 13 s | See below: a 258 MB bundle for amd64 servers, signed with a throwaway key made for the run and removed after it (no release key here) |
| `bash tools/airgap/test-offline.sh` | Passed | 34 s | The arm64 bundle, now saved with `--platform linux/arm64` from a database tag that held amd64 too: loaded and installed offline, the similar tickets found with pgvector's HNSW index |

The amd64 bundle took `TASKMOOR_IMAGE=taskmoor:dev-amd64` (the image `smoke.sh` had just built
under emulation) and the database image the Compose kit names,
`pgvector/pgvector:0.8.1-pg16-trixie`, which this Mac held for arm64 only:

1. Before the pull, `bundle.sh` refused in 1 s: the tag "has no linux/amd64 image here", with
   `docker pull --platform linux/amd64 pgvector/pgvector:0.8.1-pg16-trixie` as the remedy (and
   `PLATFORM=linux/arm64` as the other choice).
2. That pull took 114 s (about 160 MB at 1.5 to 2 MB/s; no stall). Afterwards the tag held both
   platforms, and a plain `docker image inspect` still reported `linux/arm64`: the check before
   the fix would have refused again, as the re-check said. `docker image inspect --platform
   linux/amd64` reported `linux/amd64`; before the pull it had answered `/` and succeeded,
   since the image index lists amd64 even when none of it was pulled.
3. `bundle.sh` then passed in 13 s. `images.txt` names the amd64 manifests and `platform
   linux/amd64`. Unpacked, each archive holds one image, `linux/amd64` in its config: the
   Taskmoor archive 97 MB (11 layers), the database archive 160 MB (16 layers, and a second
   manifest that names no platform); nothing of arm64. All 144 package URLs in the SBOM that
   name an architecture say `x86_64`, so syft read the amd64 image. The bundle checked itself
   with `verify.sh`.
4. Afterwards the amd64 variant was taken out of the tag again with
   `docker image rm --force --platform linux/amd64 pgvector/pgvector:0.8.1-pg16-trixie` (without
   `--force` Docker refuses, since the content goes from every image that refers to it; only
   this tag did). The machine was left with no container, volume or network from the runs, and
   no air-gap or `ghcr.io` tag.

### The SBOM from a tag that holds both

On 2026-11-06, after the second re-check, while holding the machine's test lock (Docker Engine
29.5.2 with the containerd image store, CLI 29.9.2). The test image was `node:22-alpine` with a
page at `/app/web`, built for both platforms under one tag with `docker buildx build --platform
linux/arm64,linux/amd64 --load`; a plain `docker image inspect` reported `linux/arm64`.

| What made the SBOM | Bundle | Architectures in the SBOM's package URLs | Name and version |
|---|---|---|---|
| syft given the tag (`bundle.sh` before the fix) | | 81 `aarch64` | the repository, the tag |
| `bundle.sh` with the fix, `PLATFORM=linux/amd64` | Passed in 8 s | 81 `x86_64` | the same |
| `bundle.sh` with the fix, `PLATFORM=linux/arm64` | Passed in 8 s | 81 `aarch64` | the same |

`bash tools/airgap/test-offline.sh` then passed in 32 s with the fix: syft read the archive of
`taskmoor:dev` saved for `linux/arm64`, and the bundle installed offline as in the fourth run.
The test image was removed afterwards, which left the same images as before, no container and
no volume, and Colima was stopped.

### After T-247: the dependency install bounded

On 2026-11-14, while holding the machine's test lock, with Colima started for the run and
stopped after it (Docker Engine 29.5.2, arm64). T-247 gave the Dockerfile's install step pnpm's
network settings through that step's environment (a download that receives nothing for 60 s is
dropped and tried again, up to five more times after 10 s to 2 min, eight downloads at once), a
30-minute limit on the whole step with a message naming the build arguments to change
(`PNPM_INSTALL_TIMEOUT`, `PNPM_INSTALL_FETCH_TIMEOUT`, `PNPM_INSTALL_FETCH_RETRIES`,
`PNPM_INSTALL_NETWORK_CONCURRENCY`), and pnpm's store as a BuildKit cache mount outside the
image's layers. The link was fast that morning, so neither run could show the limit at work; the
limit, its message and the settings pnpm receives are shown by
`packages/devtools/src/dockerfile.test.ts`, which runs the step's own script with stand-ins.

| Script | Result | Time | What it showed |
|---|---|---|---|
| `bash tools/image/smoke.sh` at `c4c09a3c` | Passed | 58 s | The install step ran (its text had changed): 820 packages, none from the empty store, downloaded in 15.7 s. Image 269 MB unpacked, as before; the version in the server and the frontend artefact; both routing modes; all roles next to PostgreSQL 16; the amd64 image under emulation, every builder step cached. pnpm printed a notice that a newer pnpm exists, a request to the registry the build does not need, so the next commit turned the notifier off |
| `bash tools/image/smoke.sh` at `8ab9088f` | Passed | 31 s | The install step ran again (its text had changed once more) and took everything from the store: "reused 816, downloaded 0", done in 3 s, with no notice. The same checks passed. The store's cache mount held 697.6 MB afterwards |

The second run is what a build stopped by the limit, or one whose install layer Docker lost (as
in the second run of 2026-11-05), now does: it takes from the store what an earlier build
downloaded instead of fetching all 820 packages again.

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
| `fresh-vm.sh` | Left a tag `ghcr.io/rockersands/taskmoor:<version>` behind | It tags the image as the version the kit pins, and never removed the tag, so each old build stayed alive after `smoke.sh` replaced `taskmoor:dev` | First the clean-up removed the tag. The review found that this deletes the image when the pinned name is `$TAG` itself (a published release under test) or an image pulled before the run, so the tag is now made on the fresh machine after the archive is loaded, and this machine's tags are left as they were | `image-scripts.test.ts` holds every image and air-gap script to removing the tags it adds and only names made up for the run, and `fresh-vm.sh` to tagging on the fresh machine only; the third run left no tag behind |
| `test-offline.sh` | The install printed "running on port 18120" and a link to `http://localhost:8080/#/setup?...` | Without `PUBLIC_URL` the server builds the link from its own port inside the container | `deploy/compose/install.sh` names the host port in the link when `PUBLIC_URL` is not set | `packages/devtools/src/compose-install.test.ts`; the second run's link named 18120 |
| `smoke.sh` (the review) | Checked "96 MB" against the 400 MB limit | With the containerd image store `docker image inspect`'s Size is the compressed download (see [The image size](#the-image-size)) | `smoke.sh` adds up the layers' sizes from `docker history` and checks that; `smoke-kits.sh` reports the all-in-one image's the same way | `image-scripts.test.ts` runs the scripts' own lines with a stand-in for Docker: an image of 450 MB with a 120 MB download is over the limit |
| `bundle.sh` (the review) | A bundle made on this Mac would carry arm64 images | `docker save` writes the images as the local Docker holds them, and a Mac builds and pulls arm64; an amd64 air-gapped server could not start them and has no registry to fetch others from | `bundle.sh` takes `PLATFORM` (`linux/amd64` unless set), pulls a missing database image for it, refuses an image of another platform before writing anything, and names the platform in `images.txt`; `install-offline.sh` refuses a bundle for another platform before loading anything; `test-offline.sh` makes its bundle for the machine it installs on | `airgap-verify.test.ts` runs the real `bundle.sh` and `install-offline.sh` with a stand-in for Docker; the third run's bundle was for `linux/arm64` |
| `bundle.sh` (the re-check) | With `PLATFORM=linux/amd64` it refused the database image after `docker pull --platform linux/amd64`, and its message asked for that same pull | With the containerd image store a tag holds every platform pulled for it: the pull added amd64 beside the arm64 the tag held, a plain `docker image inspect` still reported arm64, and a plain `docker save` would have written both | Where `docker image inspect` and `docker save` take `--platform` (Docker 28.1, API 1.49; the help hides the flag when the daemon is older, checked here with `DOCKER_API_VERSION=1.48`), `bundle.sh` checks and saves `PLATFORM`'s image by name, and copies the frontend from it. An older Docker keeps the check on the whole tag, and the refusal there says to remove the tag (`docker image rm`) before pulling for the platform. `tools/airgap/README.md` and `releases.md` say the same | `airgap-verify.test.ts`: the stand-in for Docker keeps several platforms per tag, as the containerd store does, and can be an older Docker; a tag holding arm64 and amd64 makes an amd64 bundle (refused before the fix), the pull the refusal names makes the next run pass, and the older Docker's advice works too. The fourth run made an amd64 bundle here |
| `bundle.sh` (the second re-check) | Found by reading the script after the fourth run: the SBOM came from the tag, not from the archive saved | syft was given `TASKMOOR_IMAGE` and asked Docker for it without a platform, and where a tag holds both Docker answers with the host's. Tried here (see [The SBOM from a tag that holds both](#the-sbom-from-a-tag-that-holds-both)): syft read the arm64 image, so an amd64 bundle made from such a tag would have carried the arm64 image's SBOM, signed, with nothing to flag it | `bundle.sh` saves the Taskmoor archive unpacked, copies it into syft's container with `docker cp` (no folder has to be shared with Docker's machine), makes the SBOM from it with syft's `docker-archive:` source, then packs it. The SBOM names the image as before: the repository, with the tag as its version. `tools/airgap/README.md` and `releases.md` say so | `airgap-verify.test.ts`: the stand-in for syft reads what it is given, and an amd64 bundle from a tag holding both carried the arm64 image's SBOM before the fix; a failing syft stops the bundle before it is signed and removes its container. The run above |
| `install.sh` (seen while fixing the link) | A busy port never stopped an install | The check read `ss` or `netstat -ltn` in Linux's format, which a Mac has neither of; and where it saw a taken port it asked `docker compose ps -q taskmoor`, which succeeds with no output when nothing runs | `ss` where there is one, otherwise a connection to the port (as the Builder's kit does); it stops unless Compose names a running Taskmoor container | `compose-install.test.ts` |

## Found, not fixed, and not done

- **Fixed by T-235 (2026-11-13): `install.ps1` named port 8080 in the setup link** when
  `TASKMOOR_PORT` was another and `PUBLIC_URL` was not set. It now names the host port as
  `install.sh` does; `compose-install.test.ts` runs it with a stand-in for Docker on Windows.
- **Fixed by T-236 (2026-11-06): corepack's download of pnpm had no retry**, so a dropped
  connection failed the build (once here) and a slow link could stall it. The Dockerfile now
  fetches pnpm in a step of its own: four attempts, each stopped after `PNPM_FETCH_TIMEOUT`
  seconds (300 unless raised), with corepack's signature check kept and its network switched
  off afterwards. `smoke.sh` passed with it at `98cb9df7`, both architectures, in 4,042 s; that
  step took 1.1 s.
- **Bounded by T-247 (2026-11-14): the dependency install could stall over a slow, unreliable
  link**, as in the second run and again in T-236's run: with the install layer rebuilt (the new
  step comes before it), it took 3,060 s, nearly all of it waiting: nothing for about 950 s after
  connection resets at 10 s, then about 35 minutes at 807 of 820 packages, broken once by socket
  time-outs and resets at 1,968 s, before pnpm's own retries finished. Each quiet stretch lasted
  16 to 18 minutes. The step now stops after 60 minutes (`PNPM_INSTALL_TIMEOUT`; T-247 set 30,
  and T-279 raised it on 2026-11-16 so that a run as slow as this one, 51 minutes, still finishes)
  and says what to change, and a build run again takes what the stopped one downloaded from pnpm's store in the
  build cache (see [After T-247](#after-t-247-the-dependency-install-bounded)). Not yet seen on
  a slow link: whether the settings shorten such a run, or whether it now stops at the limit and
  finishes on the next build.
- `fresh-vm.sh` prints a harmless "Terminated" line when it stops its static server.
- **`fresh-vm.sh`'s journey under heavy load** (second run, above): on a quiet machine it passed
  twice in the third run and again in the fourth, so the second run's failure did not come
  back. If "Add a track" is ever again found but never stable, look at what moves the
  create-track form while it opens; the load that run had (an average up to 120) was not made
  again on purpose.

## The image size

ADR-021 and M0-025 hold the image under 400 MB unpacked: the size it takes once pulled. Until
the review of this work, `smoke.sh` checked the figure `docker image inspect` gives, and this
Docker uses the containerd image store (`docker info` names the `io.containerd.snapshotter.v1`
driver, as Docker 29 does by default), where that figure is the compressed download. So the
first pass's "96 MB" checked nothing: an image of 450 MB unpacked downloads in about 120 MB and
would have passed. Measured on 2026-11-06, on the images the first pass built:

| Image | Layers added up (`docker history`) | Files in a container | Download (`docker image inspect`) | Disk here (`docker images`) |
|---|---|---|---|---|
| `taskmoor:dev` (arm64) | 269 MB | 242 MB | 96 MB | 365 MB |
| `taskmoor:dev-amd64` | 272 MB | | 96 MB | 368 MB |
| `taskmoor-allinone:dev` (arm64) | 303 MB | 274 MB | 107 MB | 410 MB |

The limit holds, at 269 MB for the image and 272 MB for the amd64 build. With the containerd
store the disk figure is the unpacked layers plus the compressed download, which it keeps too;
the classic image store's `docker image inspect` gives the layers added up, which is what
`smoke.sh` now measures on either (`docker history`), with the limit checked against it, and
`smoke-kits.sh` reports the all-in-one image's the same way. The files in a container (their
sizes added up by a short Node script run inside the image, leaving out Docker's mounts) come to
less than the layers, since a later layer's file hides an earlier one's without freeing it.

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

The images kept are the ones the scripts build and reuse (on disk here, which is the unpacked
size and the download together: `taskmoor:dev` 365 MB, `taskmoor:dev-amd64` 368 MB,
`taskmoor-allinone:dev` 410 MB, `taskmoor-vm:dev` 528 MB) and the
base images they pull; `docker rmi` the first four frees about 1.7 GB, and
`docker builder prune` the build cache, at the cost of downloading it all again on the next
run over a slow link. Colima was stopped afterwards.

Since T-247 the build cache also holds pnpm's store for the image's dependency install, a cache
mount of about 700 MB (`docker buildx du --filter type=exec.cachemount`). `docker builder
prune` removes it too, and the next build downloads every package again.

## What cannot run here

- **Signing with the release key.** The key is kept offline by the maintainer
  (`docs/ops/releases.md`); the air-gap test signs with a throwaway key made for each run and
  removed after it. `bundle.sh` now runs on a Mac, so the maintainer can build and sign a real
  bundle on one, for one platform at a time: `PLATFORM` names the servers' (`linux/amd64`
  unless set), and the images must be pulled for it (`docker pull --platform linux/amd64`),
  since what a Mac pulls or builds is arm64. With this Docker the pull goes beside the arm64
  image under the same tag, and `bundle.sh` saves amd64's alone (the fourth run) and makes the
  SBOM from that archive. It refuses an image the tag does not hold for `PLATFORM`, and
  `install-offline.sh` a server of another platform (the review's and the re-checks' rows under
  "Runs and fixes").
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

An air-gap bundle for amd64 servers, as in the fourth run; a release is signed with the release
key, a trial with a throwaway one:

```
docker pull --platform linux/amd64 pgvector/pgvector:0.8.1-pg16-trixie
TASKMOOR_IMAGE=taskmoor:dev-amd64 PLATFORM=linux/amd64 SIGNING_KEY=<key.pem> \
  PUBLIC_KEY=<public key> bash tools/airgap/bundle.sh <version> <out-dir>
```

Colima shares only the home folder with its VM, so run the scripts from a checkout under it.
