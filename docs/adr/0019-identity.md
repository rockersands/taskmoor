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
  Passwords use Argon2id through `hash-wasm` (MIT, WebAssembly, so the image still needs no
  native addon) with OWASP's cost (19 MiB, two passes, one lane); M0's scrypt hashes verify and
  are replaced at the next sign-in (M1-001).
- **Policies** apply per group or email domain: allowed methods, SSO enforcement, 2FA
  requirement, session lifetime and idle timeout. Deactivation keeps attribution; erasure
  replaces personal data with a tombstone (IAM-008).
- **Sessions** are server-side rows (revocable, listed in the user's profile) referenced by a
  cookie or bearer token (ADR-032). The browser holds a random 256-bit token; the row keeps its
  SHA-256. Sessions end after 14 days or 3 idle days until IAM-004's policies make these per
  group; signing out, a password change (other sessions), deactivation and an administrator's
  "sign out everywhere" delete rows, so the next request is signed out. On HTTPS the cookie is
  `__Host-taskmoor_session`, Secure, HttpOnly, SameSite=Lax.

## Passwords, lockout and recovery (M1-001)

- **Policy (IAM-001, ASVS V2.1):** 12 to 128 characters counted after Unicode normalisation,
  any characters, no composition rules, no expiry. Refused: entries of the zxcvbn-ts common
  password list (MIT, 49,000 entries from breach corpora), the same with digits or symbols
  added at either end, repeated patterns and plain sequences, and passwords containing the
  person's name, email or the product name. `POST /api/v1/password-check` gives the same
  answer while typing, without shipping the list to browsers.
- **Pepper (ASVS 2.4.5):** the password is keyed with HMAC-SHA-256 under a secret before
  Argon2id; hashes read `pepper:<key id>:<argon2id>`. The keys are a keyring file in the data
  directory (`secrets/password-peppers`, created on first start, first line active) or
  `TASKMOOR_PASSWORD_PEPPER` (Helm creates one Secret for all pods and keeps it). Backups carry
  the keyring and a restore merges it, so restored passwords verify; sign-in then moves hashes
  to the active key. A lost keyring means password links for everyone
  (`node cli.mjs password-link <email>`).
- **Lockout and rate limits (ASVS 2.2.1):** counters in Postgres, so every pod agrees. Per
  submitted email, existing or not: five free failures, then a lock of 30 s doubling to
  15 minutes; a success clears it and failures fade after a day. Per client address: 50
  failures in 15 minutes lock the address for the rest of the window. Unknown emails,
  deactivated accounts and wrong passwords get the same answer after the same work (a dummy
  hash is checked). Behind a reverse proxy, `TASKMOOR_TRUSTED_PROXIES` names it so the real
  client address is counted; unset, the socket peer is the client, so the header cannot be
  spoofed.
- **Recovery:** until email arrives (M1-057), an administrator creates a one-time link (three
  days, single use, stored as a hash) for a new account or a reset; redeeming it signs every
  other session out. The CLI makes the same link for an administrator who is locked out.

## Two-factor sign-in (M1-084)

- **Factors:** authenticator-app codes (TOTP, RFC 6238: SHA-1, 6 digits, 30-second steps, one
  step of drift, each step usable once), WebAuthn security keys and passkeys through
  `@simplewebauthn/server` (MIT; "none" attestation, counters checked), and ten single-use
  recovery codes stored as hashes. TOTP is implemented in `packages/iam/src/totp.ts` against the
  RFC's test vectors; `otplib` was not needed. TOTP secrets are sealed with AES-256-GCM under a
  key derived (HKDF) from the active password pepper, so the database alone does not reveal them.
- **Sign-in:** a correct password with a second factor enrolled answers `second_factor` with a
  five-minute challenge (five tries); the session starts only after the second factor. Wrong
  factors count against the account's lockout like wrong passwords, and failures clear only when
  the whole sign-in succeeds.
- **Policy:** nobody, site administrators, or everyone, plus chosen groups. A person the policy
  covers who has no factor gets `enrollment_required` and enrols during the challenge; the last
  required factor cannot be switched off. Administrators reset a person who lost every factor.
- **Setup without stored state:** a TOTP secret waiting for its first code and a WebAuthn
  registration challenge travel in a sealed setup token (ten minutes), so starting a setup writes
  nothing. Without a pepper (development) the seal uses a key that lives as long as the process.
- Passwordless sign-in with passkeys can build on the same credentials later.

## Options considered

Argon2id: Node 22 has no built-in Argon2 (Node 24 adds an experimental one). Native addons
(`argon2`, `@node-rs/argon2`) need a binary per platform in the bundled server; `hash-wasm`
runs everywhere at about twice the native time, which the cost above allows (tens of
milliseconds per hash). When the image moves to a Node with stable `crypto.argon2`, the stored
format stays the same.

| Option | For | Against |
|---|---|---|
| In-process providers (chosen) | One service; works air-gapped; every method free | Security-sensitive code we own; reviewed per change (`/security-review`) |
| Delegate to Keycloak or Authentik | Mature, many protocols | A second service with its own database and upgrades for every install; still needs SCIM into our model |
| OIDC only, external IdP required | Smallest code | Small teams without an IdP could not sign in; SAML-only enterprises excluded |

## Consequences

Keycloak and the like remain supported as OIDC providers for sites that already run them. The
protocol implementations get conformance fixtures (recorded SAML responses, SCIM suites) and are
in the security review list.
