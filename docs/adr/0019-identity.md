# ADR-019: Identity: OIDC, SAML, LDAP, SCIM, TOTP and WebAuthn, all free

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

Atlassian spreads single sign-on, SCIM and audit across Guard tiers; OpenProject sells SCIM. The
spec puts local sign-in with 2FA (IAM-001), SAML (IAM-002), OIDC (IAM-003), policies and sessions
(IAM-004), LDAP and Active Directory (IAM-005), SCIM (IAM-006), tokens and service accounts
(IAM-007) and user administration (IAM-008) in release 1.0 at no tier.

## Decision

- **In-process identity**, in `packages/iam`, so an install needs no identity server:
  - Local accounts with Argon2id hashes, a configurable password policy with an offline breached
    password check, progressive lockout, TOTP and WebAuthn passkeys with recovery codes.
  - OIDC relying party (authorization code with PKCE, several providers, group claims).
  - SAML 2.0 service provider (SP- and IdP-initiated, signed assertions, metadata import,
    several IdPs routed by email domain, JIT provisioning, attribute to group mapping).
  - LDAP and Active Directory (several directories, nested groups, scheduled incremental sync).
  - SCIM 2.0 server (users, groups, PATCH), tested against the Entra ID and Okta suites.
  - Scoped expiring personal tokens, service accounts, token inventory with last use.
- **Candidate libraries** (all MIT or Apache-2.0, pending the licence gate when added):
  `openid-client`, `@node-saml/node-saml`, `ldapts`, `@simplewebauthn/server`, `otplib`.
  Passwords use Node's built-in scrypt (`packages/iam`, no native addon in the image) with the
  parameters stored in the hash, so a move to Argon2id in M1 re-hashes on sign-in.
- **Policies** apply per group or email domain: allowed methods, SSO enforcement, 2FA
  requirement, session lifetime and idle timeout. Deactivation keeps attribution; erasure
  replaces personal data with a tombstone (IAM-008).
- **Sessions** are server-side rows (revocable, listed in the user's profile) referenced by a
  cookie or bearer token (ADR-032).

## Options considered

| Option | For | Against |
|---|---|---|
| In-process providers (chosen) | One service; works air-gapped; every method free | Security-sensitive code we own; reviewed per change (`/security-review`) |
| Delegate to Keycloak or Authentik | Mature, many protocols | A second service with its own database and upgrades for every install; still needs SCIM into our model |
| OIDC only, external IdP required | Smallest code | Small teams without an IdP could not sign in; SAML-only enterprises excluded |

## Consequences

Keycloak and the like remain supported as OIDC providers for sites that already run them. The
protocol implementations get conformance fixtures (recorded SAML responses, SCIM suites) and are
in the security review list.
