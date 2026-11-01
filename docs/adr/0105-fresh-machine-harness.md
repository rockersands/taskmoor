# ADR-105: The fresh-machine harness: both kits on an empty Docker host, the full journey in a browser

- Status: Accepted
- Date: 2026-11-01
- Backlog: M1-113

## Context

NFR-013 and the M1 gate ask that the Builder's two kits work with zero manual configuration:
`install.sh` brings the backend kit up on a fresh machine, the frontend kit on a plain static
server at another origin passes the journey (sign-in, a ticket, a board, a query, a live update),
and a fresh machine reaches a working app in under 15 minutes. The pieces were tested apart:
`smoke-backend-kit.sh` ran `install.sh` against the build machine's own Docker,
`cross-origin.spec.ts` ran both sign-in layouts against a development server, `kits.spec.ts`
served kits from a test server. Nothing ran them together, on a machine with nothing on it.

Release images are not published until 1.0 (decisions.csv), and the cloud machines the work runs
on have Docker but no spare virtual machines.

## Decision

`tools/image/fresh-vm.sh` runs the whole path on one host:

1. **The kits** come from the Builder CLI and two addresses only: the backend at
   `https://localhost:18443` and the frontend at `http://127.0.0.1:18181/`. These are different
   sites, so the frontend signs in through the backend's page with OAuth and PKCE (the harder
   layout). The frontend uses hash routing (the new `--routing hash` of the CLI), since a plain
   static server sends no deep link to `index.html`. The kits carry the image's own web build,
   copied out of the image, because the backend refuses a frontend of another version.
2. **The fresh machine** is a privileged Docker-in-Docker container (`tools/image/vm`):
   - Docker with Compose, bash, curl and unzip, and nothing else;
   - its own image store, checked empty before anything is loaded;
   - the images arrive as a saved archive, as on an air-gapped server, with `TASKMOOR_PULL=never`.
3. **`install.sh`** runs on it unchanged, behind Caddy's HTTPS (its local authority for
   localhost), and prints the setup link.
4. **The frontend kit** is unzipped and served by `python3 -m http.server`, the plainest static
   server there is.
5. **Playwright** (`apps/web/e2e-fresh/fresh-install.spec.ts`, its own config, no servers of its
   own) runs the journey:
   - the setup link creates the administrator;
   - in a new browser, the frontend's start page says to sign in, and sign-in goes to the backend
     and back;
   - a track is added with its board, and a ticket is made in the create dialog;
   - the board shows the ticket, and a query finds it;
   - an edit made elsewhere reaches the open ticket and the open board without a reload.

   The run fails above 15 minutes from the machine's start to the first sign-in.

The image build gains an optional build secret, `build_ca`, mounted only for the steps that
download (pnpm, apk) and never written to a layer, so the image builds behind a proxy that
re-signs TLS (a company's, or a sandbox's).

## What the harness found, fixed in the same change

- **Live updates were not shown.** NTF-008 asks for changes pushed to open ticket views and
  boards; changes reached the browser's local copy through the socket, but no page re-read them.
  The ticket page now reads the ticket again when its row in the local copy moves on; the board
  reads its cards again at most once in 100 ms, and not while a card is being moved.
- **The create dialog lost its ticket types** when the person chose the track already chosen
  (always the case with one track): the list emptied and never reloaded. Choosing the same track
  again now changes nothing; a unit test covers it.
- **The signed-out start page** said "This area is under construction". It now says to sign in,
  with a link.

## Measurements

| Run | `install.sh` on the fresh machine | Fresh machine to first sign-in | Board updated after a change |
|---|---|---|---|
| First green run (batching at 250 ms, board and cards reloaded) | 33 s | 41 s | 914 ms |
| Batching at 100 ms, cards only | 33 s | 40 s | 401 ms |
| Three runs in a row, same | 33 to 36 s | 40 to 43 s | 284, 891, 896 ms |

The board's time is measured from before the edit's request: the edit itself, the socket's poll
of the change log (every 250 ms, `sync/socket.ts`), the client's read of the changes, 100 ms of
batching and one read of the board's cards. It stays under NTF-008's second, with little to spare
on a busy machine; the next step if it does not is pushing the change from the socket instead of
polling.

The 15-minute budget is far away: the time is the images' load and Postgres's first start. A real
fresh virtual machine adds its boot and the Docker install; the image pull from ghcr.io replaces
the archive once images are published.

## Options considered

| Option | For | Against |
|---|---|---|
| Docker-in-Docker as the fresh machine (chosen) | Runs anywhere Docker runs; an empty daemon is as fresh as a new server for what the kit touches | Not a real kernel or a real Docker install; no DNS |
| A real VM per run (cloud or QEMU) | The real thing, boot included | Needs an account or nested virtualisation, neither available here |
| The build machine's own Docker (as `smoke-backend-kit.sh`) | Simplest | Not fresh: images and volumes of earlier runs are there |

## Consequences

- Each run removes its machine with its volumes (`docker rm -v`): the Docker-in-Docker image
  keeps its image store in an anonymous volume, about 1.3 GB a run.
- `fresh-vm.sh` needs Docker and the image (`tools/image/smoke.sh`); it is not part of
  `pnpm verify`. The M1 gate and release runs call it, as do the nightly jobs once Actions run.
- The real-VM run with a real domain and DNS stays the job of the install matrix at the gate.
- The fresh-install spec doubles as the only browser test of live board updates; the regular
  suite's NTF-008 tests cover the local copy and co-editing.
