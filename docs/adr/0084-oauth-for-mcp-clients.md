# ADR-084: OAuth for MCP clients through self-registration, consent at the browser and tokens bound to the MCP endpoint

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-072

## Context

API-012 asks for the MCP server to authenticate with OAuth 2.1 as well as personal tokens.
API-002 (3) asks for the OAuth consent screen to list the requested scopes. M1-107 (ADR-080)
built the authorization and token endpoints for the first-party frontends. ADR-080 left four
things for MCP clients:

1. clients that are not known in advance;
2. a consent screen;
3. scopes on access tokens;
4. the discovery documents.

The MCP authorization rules (2025-06-18 and 2025-11-25) expect certain behaviour from the
server:

- **Discovery:** the server answers 401 with the address of its protected resource metadata
  (RFC 9728). That metadata names the authorization server, whose own metadata (RFC 8414)
  lists the endpoints.
- **Clients:** a client registers itself (RFC 7591) or names itself by a URL (client ID
  metadata documents).
- **Flow:** the code flow with PKCE (S256).
- **Tokens:** they are meant for the MCP server (RFC 8707) and must not be accepted for
  anything else.

Desktop clients listen on a loopback port they choose each time. Editors use their own URL
schemes.

## Decision

- **Discovery.**
  - `/.well-known/oauth-protected-resource/api/v1/mcp` (and the bare path) names the resource
    `<public URL>/api/v1/mcp`, this server as its authorization server, and the scopes `read`
    and `write`.
  - `/.well-known/oauth-authorization-server` lists the endpoints. It names the registration
    endpoint only while registration is on.
  - Both documents are public and readable from any origin.
  - The MCP endpoint's 401 names the metadata (`resource_metadata`) and the scopes.
- **Self-registration.** `POST /api/v1/oauth/register` (RFC 7591) registers a public client,
  with no secret and the `none` authentication method.
  - The client gets a random id (`tmc_...`), its name and up to ten redirect URIs.
  - A redirect URI may be:
    - `https`;
    - `http` on the loopback interface, matched on any port (RFC 8252 section 7.3);
    - a native app's private-use scheme.
  - `javascript:`, `data:`, `file:` and similar schemes are refused.
  - Registration is open while the MCP server and its new `oauthRegistration` setting are on
    (on by default). That is what MCP clients expect, and a registration alone grants nothing.
  - An instance keeps at most 1,000 clients. A client that is never used is pruned after a day.
- **Consent at the browser.**
  - Authorize with a registered client checks the request once: the client, the redirect URI,
    PKCE, the scope, and the resource if one is given. It then stores the request for ten
    minutes under a random id.
  - The browser goes to sign in (when needed) and then to `#/oauth/consent?request=<id>`. The
    addresses carry only that id, so they stay within the sign-in return limits.
  - The page shows the app's name, what it may do, and where the browser goes back to (a site's
    host, "an app on this computer", or the scheme). It warns that the app registered itself.
  - The person allows or refuses. They may untick changes, giving reading only, never more than
    was asked.
  - The answer (`POST /api/v1/oauth/requests/:id`) takes the request once and returns the
    client's redirect: with a code, or with `access_denied`.
  - Only a cookie session answers. Tokens and the frontends' token families are refused, and
    the routes are session-only for tokens.
- **Scoped families that outlive the browser.**
  - A registered client's code carries its scope (`read`, or `read write`).
  - Exchanging the code starts a token family (`user_session`) with that scope and no parent.
    It lasts 30 days from consent, without the 3-day idle limit, and refresh tokens still rotate
    with reuse detection (ADR-080).
  - A person signing out of the approving browser does not end it. It ends through the person's
    sessions list (which now names the app), through "sign out everywhere", through
    deactivation, or when an administrator removes the client
    (`DELETE /api/v1/admin/oauth-clients/:id`).
  - The first-party frontends keep their parented families.
- **Tokens bound to the MCP endpoint.** An access token of a scoped family is accepted only at
  `/api/v1/mcp`, and by the REST calls the MCP tools make for it in-process.
  - Those calls carry a random per-process secret header that never leaves the process. Any
    other use answers 401 `invalid_token` (`wrong_resource`).
  - The family's scope is checked like an API token's (`scopeDenial`), so session-only routes
    stay closed.
  - Administrator rights are dropped whatever the person holds.
  - The MCP tool profile and the allowed-client names still apply on top.
- **Events and audit.** `oauth_client.registered`, `oauth_client.consent` (approved or not,
  with the scope) and `oauth_client.deleted` are emitted and audited. Code exchange keeps
  emitting `session.started`.

## Options considered

| Option | For | Against |
|---|---|---|
| Open self-registration with consent (chosen) | Works with today's MCP clients unchanged; consent is the control, as on every OAuth server | Anyone can create client rows (bounded and pruned); consent phishing needs the person to approve an app they did not start, which the page warns about |
| Administrator pre-registers each client | No unknown clients | MCP clients do not support being handed a client id; every assistant would need manual setup |
| Client ID metadata documents | No registration step | The server must fetch arbitrary URLs from inside the operator's network (SSRF protection, caching); few clients send them yet. Deferred |
| Signed (JWT) access tokens with an audience | No lookup per call | ADR-080 chose stored tokens so revocation is immediate; the endpoint binding gives the audience check |
| Accept a client's token on the whole REST API | Simpler | The person approved an MCP connection, not API access; RFC 8707 and the MCP rules ask for the binding |

## Consequences

- An assistant connects with the server's address and the person's approval, with no token to
  copy. The official MCP client's OAuth support is the test (`routes/mcp-oauth.test.ts`), with a
  browser test of the consent page (`e2e/mcp-oauth.spec.ts`).
- The discovery documents are at the origin's root. An install under a path behind a proxy must
  pass `/.well-known/...` to Taskmoor (the manual says so).
- Browser-based MCP clients on other origins cannot call the token and registration endpoints:
  the API's origin policy (ADR-080) refuses them. Desktop clients, editors and server-side
  connectors are unaffected.
- Client ID metadata documents remain to do. They are where clients are heading, and where we
  revisit this ADR.
