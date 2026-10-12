# ADR-032: Cross-origin authentication and frontend version compatibility

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

With the frontend on one origin and the backend on another (ADR-031), browsers' third-party
cookie restrictions decide whether logins work. The spec requires both the same-site layout and
fully cross-site layouts (IAM-024), strict origin controls (IAM-025), a public meta endpoint
(API-017) and an N-1 compatibility window (API-018, OPS-017).

## Decision

- **Recommended layout: sibling subdomains** (`app.example.com`, `api.example.com`). The
  session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, scoped to the parent domain; CSRF is
  covered by SameSite plus an origin check on every state-changing request.
- **Cross-site layout: OAuth 2.1 with PKCE.** The frontend is a public client; the backend
  issues short-lived bearer access tokens (default 10 minutes) and rotating refresh tokens with
  reuse detection that revokes the whole token family; tokens are kept in memory with the
  refresh token in a `HttpOnly` cookie on the backend origin where the browser allows it, and
  in `sessionStorage` otherwise. The Builder picks the mode from the two URLs; admins can
  override it.
- **Origin controls:** CORS, WebSocket origin and OAuth redirect URIs are exact-match lists
  managed in the admin area (OPS-017) and seeded by the Builder; the frontend ships a strict
  CSP and SRI, refuses non-HTTPS backends except localhost, and verifies the connection
  manifest (ADR-031).
- **Meta endpoint** (`/api/meta`, unauthenticated): API version, minimum and recommended
  frontend versions, enabled sign-in methods with public SSO details, instance id, instance name
  and public key, plus a nonce signature.
- **Versioning:** the backend serves API N and N-1; a frontend kit reports its version on
  connect; a kit one version behind shows an "update available" banner and keeps working; a kit
  older than N-1 shows "update required" instead of failing silently. The admin area lists
  connected frontends and their versions.

## Options considered

| Option | For | Against |
|---|---|---|
| SameSite cookies same-site, PKCE cross-site (chosen) | Works under third-party cookie blocking; standard flows; the Builder removes the choice from users | Two auth paths to test (the e2e suite runs both layouts) |
| Cookies everywhere | One path | Breaks cross-site as browsers block third-party cookies |
| Bearer tokens everywhere | One path | Token theft surface on same-site installs where cookies are safer |

## Consequences

The release checklist runs the previous release's frontend kit against the candidate backend.
Breaking API changes wait for a major and come with a migration period for frontends.
