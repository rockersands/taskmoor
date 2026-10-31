# ADR-087: Registered frontend origins in the database, read by the origin policy with a short cache, and versions the frontends report

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-108

## Context

OPS-017 asks for administrators to add and remove allowed frontend origins (and with them the
CORS, WebSocket and OAuth redirect lists), for a list of the frontends with the versions they
report, and for the backend to serve the frontend itself. Its first criterion: adding a second
origin lets a second frontend kit sign in without a restart. IAM-025 asks for exact matches on
all three lists.

M1-107 (ADR-080) built one origin policy (`apps/server/src/origins.ts`) from
`TASKMOOR_ALLOWED_ORIGINS` and `TASKMOOR_OAUTH_REDIRECT_URIS`, read once at start. The policy
runs before authentication on every `/api/` request and on both WebSocket handshakes, and the
OAuth, OpenID Connect and SAML routes each kept their own copy of the list. An install with
several API or realtime processes (Helm, ADR-021) has no shared memory between them.

## Decision

- **A table beside the environment** (migration 0068, `frontend_origin`). Each row holds:
  - the exact origin;
  - a label;
  - the OAuth return addresses, each on that origin; none means the frontend signs in with the
    backend's cookie only;
  - whether it may open the sync and co-editing sockets;
  - who added it and when;
  - the last version it reported, and when.

  The environment's list keeps working and stays read-only in the admin area: what the Builder
  writes into `.env` is not overwritten from a web page. An origin may be in both: the row then
  carries its label and version, and removing the row does not refuse it. The admin list says
  so.
- **One rule for origins**: `https://`, or `http://` for `localhost`, names under it and the
  loopback addresses; scheme, host and port only, with no path, query, fragment, user or
  wildcard (also percent-encoded). The same function (`frontendOrigin`) checks the environment,
  which now also refuses a wildcard at start. Such a wildcard never matched anything. A check
  constraint repeats the rule in the database. The backend's own origin is refused: it needs no
  entry.
- **The policy reads both, cached** (`OriginPolicy.current()`):
  - one snapshot of the frontends allowed over HTTP, those allowed on the sockets, the OAuth
    redirect URIs, and which origins are registered;
  - the table is read at most every five seconds per process, and at once after a change made
    through the same process (`changed()`). One read runs at a time, and a read that started
    before a change is not kept;
  - the CORS hook, both socket handshakes, the OAuth authorization, and the OpenID Connect and
    SAML return addresses all ask the same policy, so one change reaches all of them;
  - a WebSocket handshake needs the socket grant. The CORS hook refuses it with 403 like any
    other refused origin.
- **Admin API** under `/api/v1/admin/frontends` (site administrators, the admin token scope):
  - `GET` lists this server's own origin and the version it serves (when this process has the
    web role), the backend's version window, the environment's origins with their redirect
    URIs, and the registered frontends;
  - `POST` adds one, with the origin's root as its redirect URI unless given;
  - `PATCH /:id` changes the label, redirect URIs or socket grant. The origin itself does not
    change: remove the entry and add the other one;
  - `DELETE /:id` removes one.

  Each change emits one event: `frontend_origin.created`, `.updated` or `.deleted`. The audit
  log records all three as security configuration.
- **Versions come from the frontends.** A frontend on another origin already reads `/api/meta`
  when it loads and every half hour (ADR-070). It now adds `frontend=<version>`, the version
  stamped into its build and its `version.json`. When the request's Origin is a registered
  frontend and the value looks like a version, the backend writes it with the time. It writes
  when the version changes and otherwise at most once an hour. Like a token's last use this is
  bookkeeping, so it emits no event. The page then compares each version with the backend's
  window: up to date, an update available, or too old. The backend's own pages send nothing:
  same-origin GETs carry no Origin, and the backend knows the version it serves.
- **The page** is Settings > Frontends (`#/admin/frontends`). It shows this server, the
  registered frontends with their versions, return addresses, socket grant and who added them,
  and the environment's list apart. It has a form to add one and a confirmed remove. Labels,
  redirect URIs and the socket grant change through the API; the page only adds and removes.
- **Same-origin mode** needs nothing registered: the backend's own origin is always allowed.
  An end-to-end test signs in on the backend that serves the built app (`TASKMOOR_ROLE=all`),
  opens the sync socket and finds the server on its frontends page with the version it serves.
  A second test registers a kit the backend does not list, signs in from it at once, sees its
  version in the list, removes it and finds it refused.

## Options considered

| Option | For | Against |
|---|---|---|
| A table, a cache of a few seconds per process, refreshed at once on local changes (chosen) | No restart; works with any number of processes; one read every few seconds | Other processes follow within the cache's lifetime, not at the same instant |
| Postgres LISTEN/NOTIFY to every process | Every process at once | A dedicated connection per process and reconnect handling for a list that changes rarely; nothing else uses it yet |
| Write the admin list into the environment file and restart | One source | A restart, which OPS-017 (1) rules out; the web page would edit files on the host |
| The administrator types each frontend's version | No traffic | Wrong as soon as the frontend is updated; the page would show what someone remembered |
| A header with the version on every API call | Always current | A header on every request and a write path in the hot hook; the meta call already happens on load |

## Consequences

- A frontend added on one API process is accepted by the others within five seconds
  (`originsTtlMs` in tests). A removed one may still get answers from another process for that
  long.
- Removing a frontend refuses its next request. Open sockets stay open until they close, as
  with an expired token (ADR-080), and its OAuth token families stay valid for calls without
  an Origin. Ending them would need token families to record their origin.
- The reported version is what the page sent. Anyone can send any version for a registered
  origin without a browser. The value is only shown, never trusted, and only an origin already
  on the list is written.
- Environment-only frontends show no version. To see one, register the origin too.
- `GET /api/meta` takes the `frontend` query parameter (OpenAPI and SDK updated). It accepts any
  value up to 200 characters, so an unusual version never costs a frontend its meta answer.
