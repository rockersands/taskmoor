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
  - SCIM 2.0 server (users, groups, PATCH), tested against the Entra ID and Okta request
    shapes; ADR-038 records its design (M1-083).
  - Scoped expiring personal tokens, service accounts, token inventory with last use
    (implemented in M1-004; ADR-035 records the format, scopes and rotation).
- **Candidate libraries** (all MIT or Apache-2.0, pending the licence gate when added):
  `openid-client`, `@node-saml/node-saml`, `ldapts`, `@simplewebauthn/server`, `otplib`. SAML
  ended up on `xml-crypto` and `@xmldom/xmldom` instead of `@node-saml/node-saml` (M1-081,
  below).
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
- **Frontend:** the second step and the enrolment a policy requires replace the password form
  in place (an expired challenge returns to it with the email kept). The QR code of the
  otpauth URI is drawn in the browser as SVG with `qrcode` (MIT), so the secret never reaches
  an image service; security keys go through `@simplewebauthn/browser` (MIT). New recovery
  codes are shown once, with copy and a text-file download, and the person confirms saving
  them before going on. Site administrators set the policy on Settings > Security.
- Passwordless sign-in with passkeys can build on the same credentials later.

## Single sign-on with OpenID Connect (M1-080)

- **Relying party:** `openid-client` 6 (MIT, certified by the OpenID Foundation) does discovery,
  the authorization code flow with PKCE (S256), state and nonce, and the ID token checks.
  Discovery results are cached per provider for an hour or until the provider is edited.
  Issuers must use HTTPS; plain HTTP is accepted only on the loopback interface (development
  and tests) or with `TASKMOOR_OIDC_ALLOW_HTTP=true`.
- **Providers** are configured by site administrators: issuer, client id, client secret (sealed
  like TOTP secrets, never returned), scopes, an optional group claim with a map from claim
  values to Taskmoor groups, the email domains the provider serves, whether it enforces single
  sign-on there, and whether it may create accounts (just-in-time provisioning). An enabled
  provider owns its domains: a second enabled provider cannot claim one (409).
- **Browser binding:** starting a sign-in stores the state (as a hash), the nonce and the sealed
  PKCE verifier for ten minutes and sets a cookie limited to `/api/v1/auth/oidc`; the callback
  accepts only the browser holding that cookie, and only once. The return address must be a
  path on this site.
- **Accounts:** a provider's subject identifies the person after the first sign-in, so a changed
  address at the provider changes nothing. The first sign-in links an existing account or
  creates one only when the provider says the address is verified and its domain is one the
  provider serves, so a provider cannot claim an address outside its domains. Deactivated
  accounts stay out. Created accounts have no password.
- **Groups:** at each sign-in the mapped groups follow the claim (from the ID token, or from user
  info when the token lacks it): mapped groups are added and removed, groups the provider does
  not map are left alone.
- **Enforcement:** where a provider enforces single sign-on for the address's domain, password
  sign-in answers `sso_required` with the provider for every address of that domain, whether or
  not the account exists or the password is right, and wrong passwords still count towards the
  lockout. Accounts an administrator marks break-glass may still use their password there, so a
  provider outage cannot lock everyone out. `POST /api/v1/auth/discover` tells the sign-in page
  which methods a domain uses, decided by the domain alone.
- **Sign-in page:** email first. The page offers a button per enabled provider; once the email
  is entered it names the domain's provider and offers it first, and where that provider
  enforces single sign-on the password field gives way to it. The backend still decides: a
  password answered with `sso_required` leads to the same prompt. Break-glass accounts sign in
  with their password at `#/sign-in?method=password`. A failed sign-in returns to
  `#/sign-in?sso_error=<reason>` and the page explains each reason in a sentence.
- **Administration:** Settings > Single sign-on (`#/admin/identity-providers`) lists, adds,
  edits and deletes providers; an edit sends only what changed, and a blank secret keeps the
  saved one. The redirect URI to register at the provider comes from the backend, built from
  `PUBLIC_URL`, because the address an administrator's browser uses can differ (a proxy, an
  internal host name) and would register the wrong one.
- The provider's own multi-factor policy applies to single sign-on; Taskmoor's second factor
  applies to password sign-in (for Google, where a personal account may have no second factor at
  all, see ADR-119). One `sso.signed_in` event records the sign-in, the session, an
  account creation and the group changes.

## Single sign-on with SAML 2.0 (M1-081)

- **Library:** XML signatures are checked by `xml-crypto` 6.4 (MIT, maintained by the
  node-saml project; 6.x carries the fixes for the 2025 signature-wrapping advisories) on
  documents parsed by `@xmldom/xmldom` 0.8 (MIT, the version xml-crypto itself uses, so both
  read the same tree). The SAML layer on top is ours (`apps/server/src/sso/saml.ts`), not
  `@node-saml/node-saml`: wrapping defences depend on exactly which element is used after the
  signature check, and owning that step is what lets the rules below be stated and tested. It
  also avoids `xml2js`, `xmlbuilder` and `xml-encryption`, which we would not use.
- **Providers** live in `identity_provider` with `kind` 'saml' (migration 0020), beside the
  OpenID Connect ones, so domains (one enabled provider per domain, whatever its protocol),
  enforced single sign-on with break-glass accounts, just-in-time accounts, group maps, the
  links to accounts (`user_identity`) and the audit of refusals are shared; the sign-in itself
  is finished by one function for both protocols (`sso/sign-in.ts`). A SAML provider keeps its
  entity ID in `issuer` and its sign-in address (HTTP-Redirect), signing certificates (several,
  for rollover), email attribute and the IdP-initiated switch in `saml_*` columns. Administrators
  paste the identity provider's metadata (entity ID, redirect address and signing certificates
  are read from it; the metadata's own signature is not required, since an administrator vouches
  for it), or enter those by hand; explicit fields win over the metadata. Fetching metadata from
  a URL is left out on purpose (the server would reach arbitrary addresses).
- **Taskmoor's side** is per provider: entity ID `PUBLIC_URL/api/v1/auth/saml/:id/metadata`
  (an administrator may fix another one to keep an existing registration), ACS
  `/api/v1/auth/saml/:id/acs` and metadata at the entity ID's address. Two providers trusting
  the same signing key (two clients of one realm) cannot accept each other's assertions: the
  audience and recipient differ. AuthnRequests are not signed and encrypted assertions are not
  read (refused with a reason); both can come later with a service provider key.
- **Flow:** `GET /auth/saml/:id/start` sends an AuthnRequest over HTTP-Redirect and stores its
  ID for ten minutes, bound to the browser by a cookie (as the OpenID Connect state). The
  provider posts the response to the ACS. A cross-site POST carries no SameSite=Lax cookie, so
  the ACS verifies the response, records the assertion ID, checks that InResponseTo names a
  pending request of this provider, parks the person under a one-time handle (two minutes) and
  sends the browser on with a 303 to `GET /auth/saml/continue`, where the cookie is sent and
  must match: a response captured and posted from another browser cannot finish the sign-in.
  Responses without InResponseTo (IdP-initiated) are refused unless the provider allows them
  (off by default; with them on, RelayState may name a path on this site to return to).
- **What is accepted:** a plain document (no DTD or entity, no comment, processing instruction
  or CDATA, nesting below 64 levels, at most 256 KB); one Response holding exactly one
  Assertion and no element named Assertion or Response anywhere else; no encrypted assertion;
  IDs unique across the document; signatures only directly in the Response or the Assertion, at
  most one each, with exactly one Reference pointing at the element that encloses it, no
  `ds:Object`, RSA-SHA-256/512, SHA-256/512 digests and the comment-free canonicalizations.
  Signatures are verified against the configured certificates only, never a certificate in the
  response's KeyInfo; every signature present must verify, and the assertion must be covered by
  one (its own or the Response's). Everything after that is read from the canonical bytes the
  signature covered, re-parsed, never from the received tree. Then: the issuer is the
  provider's entity ID, Destination (required when the Response is signed) and the bearer
  confirmation's Recipient are this provider's ACS, the audience restrictions name this
  provider's entity ID, NotBefore, NotOnOrAfter, SessionNotOnOrAfter and IssueInstant hold
  with two minutes of clock skew, and an AuthnStatement is present. Unknown conditions refuse
  the assertion. Accepted assertion IDs stay in `saml_assertion` until they could no longer be
  accepted anyway, so a response is used once.
- **The person:** the email comes from the configured attribute, else a usual one (`email`,
  `mail`, the claims URI, the mail OID), else a NameID that is an address. SAML has no
  "verified" flag: a provider is trusted for the domains an administrator assigned it, and the
  shared rule still refuses an address outside them. The NameID identifies the person (persistent
  NameIDs are best); a transient NameID changes at each sign-in, so the address does then. The
  name comes from a display name attribute or given name and surname; groups from the attribute
  named as the provider's group claim.
- **Audit:** refusals the provider signed go to the audit log as `sso.sign_in_refused` with
  reasons such as `response_expired`, `response_audience`, `response_replayed`,
  `response_unknown_request` and `response_unsolicited`, besides the shared account reasons;
  forged or broken responses are only logged (anyone can post those). `sso.signed_in` and
  `identity_provider.created` gained an optional `protocol`; certificate changes appear in
  `identity_provider.updated` as SHA-256 fingerprints.
- **Tests:** `sso/saml.test.ts` holds our own vectors, signed in-process by
  `testing/fake-saml-idp.ts` with keys and self-signed certificates made per run
  (`testing/x509.ts`): XSW1 to XSW8, an unsigned second assertion, a signature moved to an
  element it does not cover, duplicate and namespaced IDs, misplaced and doubled signatures,
  `ds:Object`, comment injection in the NameID, DTDs, CDATA, deep nesting, SHA-1, foreign keys
  with their certificate in KeyInfo, tampering, wrong audience, recipient, destination and
  issuer, expiry and clock skew, and a property test that changes single bytes.
  `routes/saml.test.ts` runs whole sign-ins (two domains through two providers, group sync,
  linking rules, replay, browser binding, IdP-initiated, enforcement). In `pnpm verify --e2e`
  the fake provider also runs over HTTP (port 8789, from `e2e/api-server.ts`) and Chromium signs
  in through it from the admin page's setup, so the cross-site POST, the 303 and the Lax cookie
  are exercised in a real browser. `bash tools/sso/keycloak-test.sh saml` signs in through
  Keycloak 26.7.4's SAML client (`sso/keycloak-saml.e2e.test.ts`; also run by `sso.yml` in CI).
- **Administration and sign-in page:** the identity provider page adds a protocol choice to a
  new provider; a SAML one takes pasted metadata or the entity ID, sign-in URL and certificates
  (saved certificates are listed with subject, expiry and SHA-256 fingerprint), the email and
  group attributes, Taskmoor's entity ID when fixed, and the IdP-initiated switch. Each SAML
  provider in the list shows its entity ID, ACS URL and metadata link to register at the
  identity provider. Public provider summaries (`/auth/providers`, `/auth/discover`, the
  `sso_required` answer) carry the protocol, so the sign-in page starts each provider at its own
  address.

## LDAP and Active Directory (M1-082)

IAM-005 asks for several directories, sign-in against them, and scheduled incremental sync of
people and groups nested at least four levels deep, read-only or read-write: 100,000 people and
25,000 groups in under 30 minutes in full and under 2 minutes incrementally, and a person
disabled in Active Directory deactivated at the next sync.

- **Client:** `ldapts` 9 (MIT, maintained; its one dependency is `strict-event-emitter-types`,
  ISC). `ldapjs` is archived and is not used, not even in tests: the in-process test directory
  (`testing/fake-ldap.ts`) has its own BER codec, so client and server cannot share an
  encoding mistake.
- **Directories** are their own rows (`ldap_directory`, migration 0021), not identity
  providers: they are read and bound to, not redirected to. Kinds `active_directory`,
  `openldap` and `generic` set the defaults (identifier objectGUID or entryUUID, user name,
  address, name, change mark, filters, how "disabled" is told); administrators may rename any
  attribute. Several directories are allowed, ordered by `position`: where two hold the same
  address, the first manages the account (`PUT /api/v1/directories/order`).
- **Transport:** `ldaps://`, or `ldap://` upgraded with StartTLS; plain LDAP only on the
  loopback interface or with `TASKMOOR_LDAP_ALLOW_PLAIN=true`. Certificates are verified (TLS
  1.2 or later, the host name against the certificate); an administrator may give the CA
  certificates to trust for one directory instead of the system store.
- **The service account's password** is sealed under the pepper like OpenID Connect client
  secrets, never returned (`hasBindPassword` only), never logged, never in an event; a blank
  field in an edit keeps it. `POST /api/v1/directories/test` tries settings without saving them
  (connect, bind, the first thousand people and groups with a sample) and reuses the saved
  password when a directory's id is given.
- **Sign-in** of an account a directory manages binds as the person's stored DN with the typed
  password; the directory decides, with its own lockout and expiry. The DN comes from the sync,
  never from what was typed, and an empty password is refused before any bind (an
  unauthenticated bind would succeed as anonymous on many servers). Taskmoor's own lockout and
  address limits apply first, so Taskmoor cannot be used to guess against the directory; its
  second factor and single sign-on enforcement apply as for local passwords. A directory that
  cannot be reached decides nothing: the answer is the usual `invalid_credentials`, no failure
  is counted, and the audit log records `directory_unavailable`. Break-glass accounts are
  never linked to a directory, so they keep working when it does not.
- **Matching:** an entry is followed by its stable identifier, so renames and moves keep the
  account. A new entry links the existing account with its address, or creates one without a
  password; linking clears the local password, which would otherwise come back unnoticed.
  Service accounts, break-glass accounts and accounts a directory of higher precedence manages
  are never taken; entries without an address are skipped with a warning. When a person is
  deleted and created again (a new identifier, the same address) the account is taken back.
- **Disabled and removed entries:** Active Directory's ACCOUNTDISABLE bit
  (`userAccountControl`), OpenLDAP's administrative lock (`pwdAccountLockedTime`
  `000001010000Z`; a lockout after failed binds is not a disable), or, for other servers, a user
  filter that leaves disabled people out. A disabled entry, or one that left the directory or
  its filter, deactivates the account and ends its sessions (as SCIM and administrators do); the
  account and its work stay. Only accounts the sync deactivated come back when the entry does;
  an administrator's deactivation stands. Break-glass accounts and the last active site
  administrator are never deactivated by a sync (a warning says so).
- **Groups** a directory syncs are its own (`ldap_group`); a name another group holds gets the
  directory's name after it. Members and nested groups follow the directory; members outside
  the filters (or managed by another directory) are ignored and counted. Nesting is mirrored
  as `group_nesting`, so any depth works with the existing effective-membership queries.
  Directories may contain loops (Active Directory allows them); Taskmoor's nesting may not. The
  sync drops, per strongly connected component and in DN order, each edge that would close a
  loop, so the same directory always gives the same groups (`ldap/nesting.ts`); a dropped edge
  comes back at the first full run after the loop is gone. Active Directory's ranged values
  (`member;range=0-1499`) are read to the end. A group that left the directory is deleted.
- **Schedule and runs:** each directory syncs every `sync_interval_minutes` (default 60),
  incrementally, and in full every `full_sync_hours` (default 24), on its first run, after its
  settings change what is read, and when the cursor no longer fits. Administrators ask for a
  run with `POST /api/v1/directories/:id/sync`; a second request joins the waiting one. Runs
  live in `ldap_sync_run`, not the job queue, whose jobs are released after ten minutes: a
  worker claims a queued run (one running per directory, enforced by a partial unique index),
  beats every 30 seconds, and a run without a beat for five minutes is failed. Changes are
  written in chunks of 500, each a transaction with its events; a stopping worker ends its runs
  between chunks. A run that would remove more than half of a directory's people or groups (of
  ten or more) stops before changing anything, unless an administrator's run confirms it: a
  broken filter must not deactivate everyone.
- **Incremental runs:** Active Directory: `uSNChanged` above the domain controller's
  `highestCommittedUSN` read before the previous run; USNs belong to one controller
  (`dsServiceName`), so another one answering means a full run. Others: `modifyTimestamp` from
  the later of the newest change seen and the run's start by Taskmoor's clock, less ten minutes
  (and the read's own length); clocks must agree within that, and the daily full run catches
  what a wrong clock hides. Changes do not show deletions, nor entries that entered or left a
  filter through a back-link (`memberOf`) without changing themselves, so every run also reads
  the identifiers of everything in scope: missing ones are removals, unknown ones are read by
  identifier. Groups that list newly added people are re-read, since their own change mark did
  not move. Skipped entries are remembered with the cursor, so they are not read every time.
- **Read-only or read-write:** a read-only directory owns its people's passwords, names and
  addresses and its groups' names and members: changing them in Taskmoor is refused with
  `409 directory_managed` (the next sync would undo it), as are password links, break-glass on a
  managed account, and renaming or deleting a managed group. A read-write directory takes those
  changes first: a password change binds as the person and uses the Password Modify extended
  operation (RFC 3062), or, for Active Directory, removes the old `unicodePwd` and adds the new
  one (which it accepts only over TLS); name and address changes and membership changes (people
  and groups of the same directory) are written as the service account. Creating, renaming and
  deleting entries stay in the directory. Taskmoor's own settings (time zone, locale, site
  administration, description) are Taskmoor's in both modes.
- **Deleting a directory** deactivates the accounts it manages and ends their sessions (refused
  when that would deactivate the last active site administrator); its groups stay as ordinary
  groups.
- **Events and audit:** administration emits `directory.created`, `.updated` (never the
  password, only that it changed), `.deleted`, `.reordered` and `.sync_requested` with the
  administrator as actor. A run's own changes emit `directory.user_created`, `.user_updated`,
  `.user_removed`, `.group_created`, `.group_updated` and `.group_deleted`, one per account or
  group changed, with no actor and the directory and run in the payload (member lists capped at
  1,000 ids, counts complete), and one `directory.synced` per run that changed something or
  failed. All are audited. Directory sign-ins are `session.started` with `directoryId`.
- **Authorization epoch:** the per-row triggers of migration 0004 on `group_member`,
  `group_nesting` and `user_group` became per-statement ones (migration 0021): bumping one row
  thousands of times in one transaction made each bump slower than the last, and a
  100,000-person sync spent most of its time there (62 s of memberships became 10 s).
- **Evidence:** `ldap/sync.test.ts` runs both flavours of the test directory (nesting, disable
  and re-enable, deletion and re-creation, break-glass and last administrator, precedence,
  loops, ranged values, the safety stop, a domain controller change, unreachable directories,
  scheduling and stale runs); `routes/directories.test.ts` covers administration, the
  connection test, sign-in, read-only refusals and read-write write-back (LDAPS with a pinned
  CA for Active Directory). `ldap/sync.scale.test.ts` syncs 10,000 people in 2,460 groups nested
  four deep in about 4 s in full and 1 s incrementally (100,000 and 24,600: 43 s and 20 s).
  `bash tools/ldap/openldap-test.sh` runs `ldap/openldap.e2e.test.ts` against a real slapd
  built from `tools/ldap/Dockerfile` (CI: `ldap.yml`), or with `--local` against an installed
  one: OpenLDAP 2.6.10 synced 10,000 people over StartTLS in 3.0 s and 100,000 in 29 s.

| Option | For | Against |
|---|---|---|
| Sync with incremental cursors and an identifier scan (chosen) | Works on every server with standard controls; sees deletions and filter changes | Reads every identifier each run (seconds for 100,000) |
| Active Directory DirSync control | Changes and deletions in one stream | Needs replication rights; Active Directory only |
| Persistent search or syncrepl | Near real time | Server-specific, long-lived connections, still needs a full run to recover |
| Sign-in against the directory only, no sync | Simplest | No groups, no deactivation, people unknown until they sign in |
| Flattening nested groups into direct members | Simple membership queries | Loses the structure administrators grant on; large rewrites on small changes |

## SCIM provisioning (M1-083)

ADR-038 holds the design: an identity provider provisions through a service account whose
token has the `scim` scope alone; people's accounts carry what Taskmoor uses, `scim_user` keeps
the rest; deprovisioning deactivates and keeps the account; SCIM manages only the groups it
created; break-glass accounts and the last active site administrator are out of its reach.

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
