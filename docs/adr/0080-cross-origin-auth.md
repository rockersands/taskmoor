# ADR-080: Cross-origin sign-in with the backend's cookie on one site and OAuth across sites

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-107

## Context

The Builder makes a frontend kit for any static host and a backend kit for a server (ADR-031),
so the two often live on different origins. ADR-032 chose the layouts: sibling subdomains with
the backend's SameSite cookie, and OAuth 2.1 with PKCE when the frontend is on another site,
where browsers do not send the backend's cookie with the page's calls. IAM-024 asks for both
layouts to pass the end-to-end suite, for refresh-token reuse to end the token family and sign
the person out, and for no token in localStorage. IAM-025 asks for exact-match origins on CORS,
WebSockets and OAuth redirects, and for a strict content security policy. Until this task the
server read none of the Builder's `TASKMOOR_ALLOWED_ORIGINS`, answered `/api/meta` with
`Access-Control-Allow-Origin: *` (ADR-070), and checked WebSocket origins against its own host.

## Decision

- **One origin policy** (`apps/server/src/origins.ts`). Allowed are this instance's own origin
  (its `PUBLIC_URL`, or the host a request came to) and the frontends in
  `TASKMOOR_ALLOWED_ORIGINS`, matched exactly; https only, http for `localhost` and names under
  it. A hook before authentication applies it to every `/api/` request:
  - a listed frontend gets CORS approval for its exact origin, with credentials, and the
    preflight is answered there;
  - any other Origin gets 403 `origin_not_allowed`, whatever the method. This is the origin
    check ADR-032 asks for on state changes, and it is wider. It stops CSRF from a sibling
    subdomain that the SameSite cookie alone would let through. It also covers `/api/meta`
    (replacing ADR-070's `*`) and the sync socket's handshake;
  - requests without an Origin (programs, top-level navigations) are left to their
    credentials;
  - two routes that other sites post to by design carry their own proof and are let through
    without CORS: a SAML provider's form post and one-click unsubscribe.

  Co-editing's handshake, outside Fastify, uses the same policy.
- **The same site: the cookie.** The session cookie stays host-only on the backend
  (`__Host-` on https, `SameSite=Lax`, `HttpOnly`). It does not move to the parent domain as
  ADR-032 first said, since only the backend reads it. A frontend on a sibling subdomain calls
  with `credentials: 'include'`, and its sign-in form, two-factor steps and single sign-on work
  as on the backend's own origin. Single sign-on may now return to an allowed frontend's
  address, not only to a path of the backend.
- **Another site: OAuth 2.1 with PKCE** (`routes/oauth.ts`, `oauth/tokens.ts`).
  - The frontend kits are one public client, `taskmoor-web`. Its redirect URIs are exact:
    `TASKMOOR_OAUTH_REDIRECT_URIS`, by default each allowed origin's root.
  - `GET /api/v1/oauth/authorize` takes S256 challenges only. A browser signed in at the
    backend (its cookie is first-party there) gets a one-minute code at once, with
    `iss` (RFC 9207). Anyone else goes to the backend's own sign-in page with `continue=`,
    which returns to the authorization once signed in, also after single sign-on. The
    first-party client needs no consent screen.
  - `POST /api/v1/oauth/token` trades the code and verifier for a ten-minute access token
    (`tma_…`) and a refresh token (`tmr_…`). The refresh token is spent on use and replaced.
  - `POST /api/v1/oauth/revoke` is RFC 7009.
- **Token families are sessions.** A code exchange starts a `user_session` row with the client's
  id and, as its parent, the browser session that approved the code (migration 0064). So the
  session list, "sign out everywhere", password changes and deactivation reach it as they reach
  any session. An access token signs a request in as that session, with everything a cookie
  session may do. Ending the parent ends its families, and these end the family together with
  its parent:
  - signing out from the frontend;
  - a spent refresh token presented again (reuse detection, IAM-024 (2));
  - a used code presented again.

  The person is then signed out at the backend as well, so the next start shows the sign-in
  page instead of a silent new code.
- **Opaque tokens, hashed.** Tokens are random and stored by SHA-256, like sessions and API
  tokens, so revocation is immediate. Signed tokens would keep working until they expired, and
  every request already reads its session. `TASKMOOR_TOKEN_SIGNING_KEY` stays unread.
- **Events.** A code exchange emits `session.started` with method `oauth`. Revocation emits
  `session.ended`. Reuse detection emits `session.revoked` with `by: 'reuse'`. A refresh is the
  family's own bookkeeping, like a session's `last_seen_at`, and emits nothing: an event every
  ten minutes per open tab would only fill the audit log. The authorize request stores a
  one-minute code, transient sign-in state like the OpenID Connect start.
- **The browser side** (`apps/web/src/session/oauth.ts`). The runtime config's new `auth` key
  says `session` or `oauth`; the Builder picks it from the two URLs, and its `signIn` input
  overrides.
  - Tokens live in the page's memory, never in localStorage (IAM-024 (3)).
  - The refresh token goes to sessionStorage only while the page unloads, and the next page
    takes it out again. A reload stays signed in. A tab duplicated meanwhile finds nothing,
    instead of spending the token twice, which would read as theft.
  - On a 401 the client refreshes once and repeats the request.
  - The sockets cannot send headers, so they ask for `?auth=bearer`. The sync socket's first
    message carries the access token, and co-editing sends it as the provider's token.
  - Images, video and frames of attachments are fetched with the token into blob URLs.
  - Downloads are top-level navigations, which carry the backend's own cookie.
- **Content security policy** (`@taskmoor/webconfig` `csp.ts`), one text for three places:
  - the backend's header on the app it serves (with `frame-ancestors 'none'`);
  - a meta element in both frontend kits (the single file allows its inline blocks by their
    hashes);
  - the e2e preview, so the whole browser suite runs under it.

  Scripts and style elements come from the app's origin only. Style attributes stay allowed,
  since the editor's carets set them and they run no code. The backend's origin and an S3
  bucket's may be called and serve media. Tiptap's injected style element is turned off and
  its rules are in `richtext.css`.

## Options considered

| Option | For | Against |
|---|---|---|
| Cookie on one site, OAuth across sites, opaque tokens (chosen) | Each layout uses what browsers allow; revocation is immediate; families reuse the session machinery | Two paths to test (the e2e runs both); a database read per request, as sessions already have |
| Signed (JWT) access tokens with `TASKMOOR_TOKEN_SIGNING_KEY` | No lookup per request | A revoked family keeps working until its tokens expire, against IAM-024 (2)'s "signs the user out" |
| Refresh token in an HttpOnly cookie on the backend, where allowed (ADR-032's first idea) | The token is out of the page's reach | Third-party cookies are blocked in Safari and Firefox and may be in Chrome: two paths with no way to tell which one ran |
| CORS only for listed origins, without refusing other origins | Fewer 403s | A sibling subdomain could still post with the Lax cookie; the origin check is what stops it |

## Consequences

- An install with a frontend on another origin must list it in `TASKMOOR_ALLOWED_ORIGINS`.
  The Builder writes it, with `TASKMOOR_OAUTH_REDIRECT_URIS`, and both Compose files pass them.
- Cross-site sign-in needs the backend's own pages: the image serves them by default
  (`TASKMOOR_ROLE=all`, the web role). An API-only process cannot be the authorization server.
- Attachments in an S3 bucket are fetched by the page in the OAuth layout. The bucket then needs
  a CORS rule for the frontend's origin, which the manual says.
- Single sign-on errors still land on the backend's sign-in page.
- One realtime process holds both sockets' state, as before. An open socket stays signed in
  after its token expires, as an open cookie socket does after its session ends.
- **For MCP (M1-072, ADR-068):** the authorization and token endpoints are generic. OAuth for
  MCP clients needs four more things:
  - registered or dynamically registered clients;
  - a consent screen listing scopes (API-002 (3));
  - scopes on access tokens;
  - the discovery documents (`/.well-known/oauth-authorization-server` and the protected
    resource metadata).
- M1-108 turns the allowed origins and redirect URIs into an admin list that changes without
  a restart; `OriginPolicy` and the route options are where that list plugs in.
