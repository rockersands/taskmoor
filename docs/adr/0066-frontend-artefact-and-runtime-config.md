# ADR-066: The frontend as a versioned artefact with a runtime-config slot and two routing modes

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-105

## Context

ADR-021 makes the frontend static files that the backend image also serves (single-server
mode), and ADR-031 has the Builder turn the same files into a frontend kit for any static host,
with public settings inlined and a routing mode chosen per install. OPS-013 asks for static files
with no server code that route either with hash URLs or with clean URLs behind the host's
fallback; OPS-017 asks for frontends that report their version and for single-server mode with
no Builder run. M1-105's checks: the bundle has no server code, both routing modes pass e2e, and
the artefact's version equals the backend's. Until now the app routed by hash only
(`#/boards/7`, about 90 places in the code), the build carried no version, and the API base
was a constant.

## Decision

- **The artefact** is the folder `pnpm build` writes to `apps/web/dist`, copied into the image
  as `/app/web`. `version.json` beside index.html names it (`taskmoor-web`), carries the
  version and lists every file with its size and SHA-256 (index.html as built, before its slot
  is filled). The version comes from `TASKMOOR_VERSION` at build time, the same value
  `tools/build/server.mjs` stamps into the server bundle (`__TASKMOOR_BUILD_VERSION__`, the
  default of the server's version); `pnpm build` stops when `apps/web/dist` holds another
  version. The Dockerfile declares the build argument in the build stage after the install
  layer, so a new version keeps that layer cached. The Helm chart no longer sets
  `TASKMOOR_VERSION` from the image tag: the image knows its version.
- **The server refuses a mismatched artefact.** The web role reads `version.json` at start and
  refuses a folder without one, of another version, or whose index.html has no slot.
- **A Vite plugin** (`apps/web/build/artefact.ts`) runs in every production build of the app
  (Storybook's build is left alone). As each module is parsed it fails the build on server code:
  any module of `apps/server`, `packages/{ai,db,devtools,iam,spikes,storage,testkit}`, any
  third-party package only those depend on (read from the workspace manifests, so the list keeps
  itself), and any Node built-in. After writing, it writes `version.json` and scans the output:
  only html, js, css, json, images and fonts; nothing the repository's secret rules match; the
  slot present and empty. The plugin imports the shared code by relative path because Vite loads
  its config with Node, which cannot run workspace TypeScript; the boundary rules allow this for
  `apps/web/build/` only.
- **The runtime-config slot** is a JSON data block in index.html,
  `<script id="taskmoor-config" type="application/json">{}</script>`, read before the app
  renders. Its keys are fixed (`packages/webconfig`): `apiUrl` (the backend's URL, empty for the
  page's own origin; https only, plain http for localhost; no credentials, query or fragment),
  `routing` (`hash` or `path`), `basePath` (a plain folder path such as `/` or `/tracker/`) and
  `instanceName`. Filling refuses unknown keys and bad values, so a secret cannot ride along
  under a new name; reading ignores them with a console warning and keeps the defaults, so a
  typo on a static host leaves the app running. Values are written with `<` escaped. For clean
  URLs, filling also writes `<base href="{basePath}">` before the slot, so the page's relative
  asset URLs resolve from the base path at any depth; hash routing has no base element (it would
  turn `#/x` links into navigations). A data block rather than a `config.js` file: no request
  before the app starts, no chicken-and-egg with the base path at a deep URL, it survives the
  single-file kit of M1-111, and a strict CSP has nothing to allow (it never executes).
- **Who fills it:** the backend in single-server mode, on every index.html it serves (routing
  from `TASKMOOR_WEB_ROUTING`, `hash` by default; base path from `PUBLIC_URL`'s path; instance
  name from setup, read per request, empty while the database is away), the Builder's frontend
  kit (M1-111) with `fillRuntimeConfig` from `@taskmoor/webconfig`, or a person editing
  index.html on a static host. Nothing is rebuilt.
- **Routing.** Pages keep speaking in routes written the hash way (`#/boards/7?x=1`); a router
  (`apps/web/src/routing/router.ts`) maps them to the address. Hash mode is what the app did
  before. Path mode writes `{basePath}boards/7?x=1` with `pushState`, takes over clicks on links
  into the app (not modified clicks, other targets, downloads, other origins or `/api/`), and
  moves in-page fragment links such as the skip link itself. A hash route in the address
  (an older bookmark, an email's `/#/tickets/ABC-1`) opens its page and is rewritten to its
  path, except routes carrying `token=` (setup, password and unsubscribe links), which stay in
  the fragment so a reload never sends the token to a server or its logs. Links render
  `routeHref(route)`, so "open in new tab" and "copy link" give the mode's own address.
- **The backend's fallback:** in path mode every GET that wants HTML and is not an API or probe
  path gets the filled shell, so deep links load; in hash mode it is redirected to its hash
  route (`/boards/7` to `/#/boards/7`), so a clean link still works. Hashed assets are cached
  for a year (`immutable`); index.html, `version.json` and the other files are `no-cache`.

## Options considered

| Option | For | Against |
|---|---|---|
| JSON data block in index.html, filled per deploy (chosen) | Read synchronously before render; one file for the base element and the settings; works in a single-file kit; nothing to allow in the CSP | Editing JSON inside HTML by hand on a static host |
| `config.js` beside index.html | Easy to edit | An extra request first; at a deep clean URL its relative address resolves under the deep path unless a base element is set some other way; needs `script-src` for it |
| Build per deployment with Vite env variables | Nothing at run time | A rebuild per install and per change, against ADR-031's prebuilt kits |
| A router library and rewriting every page to paths | Idiomatic | Rewrites about 90 call sites and every page's tests for no behaviour the route-string mapping lacks |

## Consequences

- The image always pairs a frontend and a backend of one version; a hand-built mismatch fails
  at start with both versions in the message. `tools/image/smoke.sh` checks `/version.json`
  against `/health` and both deep-link behaviours.
- Single-server installs can turn on clean URLs with `TASKMOOR_WEB_ROUTING=path` without a
  rebuild; hash links keep working after the switch. Decided by the user on 2026-10-30: the
  Compose, all-in-one and Helm kits turn clean URLs on (M1-134); a bare server and static hosts
  without rewrite rules keep hash routing; Builder kits write their own setting (M1-111 writes
  `routing: "path"` and the host fallbacks). Done in M1-134: `TASKMOOR_WEB_ROUTING` defaults to
  `path` in both Compose files and the all-in-one image, Helm has `webRouting: path`, and
  `tools/image/smoke-kits.sh` and `helm test` open a deep link as a clean URL, reload it and open
  the start page that old hash links land on.
- `apiUrl` makes the client call another origin, but cross-origin sessions (CORS, credentials,
  PKCE) are M1-107; until then a split deployment needs a same-site layout or a proxy.
- M1-106 can compare `version.json` with the meta endpoint's minimum frontend version, and
  M1-111 can take SRI hashes from the manifest's files.
