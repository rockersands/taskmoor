# OWASP ASVS 4.0.3, level 2: checklist

Taskmoor 1.0 as built on 2026-10-31 (M1-118, ADR-104). Every level 1 and level 2 requirement of
ASVS 4.0.3, summarised in our own words, with its state and the evidence: **Met** (with the code
and the tests that show it), **N/A** (with why), or **Gap** (with the fix or the task that closes
it). Requirements that are level 3 only, and those 4.0.3 deleted, are left out. `pnpm gate M1`
reads this file: every row marked Gap keeps the gate waiting.

Paths are relative to the repository root. Tests named here run in `pnpm verify`.

**Counts:** 258 requirements: 217 met, 25 not applicable, 16 gaps. Ten of the met ones were
fixed in this task: 5.2.8, 6.2.3, 8.1.1, 8.2.1, 12.3.4, 14.2.2, 14.4.2, 14.4.4, 14.4.5, 14.4.6.

## V1 Architecture, design and threat modelling

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 1.1.1 | A secure development lifecycle covers every stage | Met | `CLAUDE.md` definition of done, `pnpm verify` gate, ADRs in `docs/adr`, `/security-review` on risky changes (`docs/plan/risks.csv`) |
| 1.1.2 | Threat modelling for every design change | Met | `docs/security/threat-model.md`; ADRs record each boundary's decisions |
| 1.1.3 | User stories carry their security constraints | Met | Spec requirements state them with acceptance criteria (`docs/specs`, e.g. IAM-001, IAM-022, IAM-023) |
| 1.1.4 | Trust boundaries, components and data flows documented | Met | `docs/security/threat-model.md` sections 1 to 12 |
| 1.1.5 | High-level architecture and remote services defined and analysed | Met | ADR-021 (roles), ADR-028 (AI gateway), ADR-080 (origins), threat model |
| 1.1.6 | Central, vetted security controls, no duplicates | Met | One authoriser (`apps/server/src/authz/authorizer.ts`), one origin policy (`origins.ts`), one AI choke point (`apps/server/src/ai/service.ts`) |
| 1.1.7 | A secure coding checklist is available to developers | Met | `CLAUDE.md` conventions, this checklist, `docs/security/scan-triage.md` |
| 1.2.1 | Components run under unique, low-privilege accounts | Met | Image runs as `node` (`Dockerfile`); PostgreSQL as its own role; all-in-one drops privileges with `su-exec` (`deploy/allinone/entrypoint.sh`) |
| 1.2.2 | Communication between components is authenticated | Met | Database by password (`DATABASE_URL`); in-process MCP calls carry a per-process secret (`INNER_CALL_HEADER`, `apps/server/src/app.ts`) |
| 1.2.3 | One vetted authentication mechanism | Met | Sessions and tokens in `apps/server/src/auth.ts` and `tokens/bearer.ts`; SSO ends in the same session (`sso/sign-in.ts`) |
| 1.2.4 | Every authentication pathway is as strong | Met | Two-factor policy applies to password and SSO sign-in alike (`apps/server/src/two-factor.ts`); the compatible API takes tokens only (`compat/register.ts`) |
| 1.4.1 | Access control enforced at trusted points | Met | Server-side authoriser on every route (`authz/authorizer.ts`); `routes/authz.test.ts` |
| 1.4.4 | One vetted access control mechanism | Met | ADR-012; `authz/permissions.ts`, `authz/visibility.ts` |
| 1.4.5 | Feature- or attribute-based access control | Met | Permissions per track role, visibility levels, field rules (`authz/visibility.ts`, `fields/layouts.ts`) |
| 1.5.1 | Input and output requirements defined | Met | Zod schemas per route; output formats (`tickets/rich-text.ts`); spec 05b |
| 1.5.2 | No serialisation of objects from untrusted clients | Met | JSON only, parsed by Fastify's `secure-json-parse` (prototype keys refused) |
| 1.5.3 | Input validated on the trusted service layer | Met | Zod in every route; `checkRichText` (`tickets/model.ts`) |
| 1.5.4 | Output encoding close to its interpreter | Met | React escaping; `escapeHtml` in `email/render.ts`; Kysely parameters |
| 1.6.1 | A key management policy exists | Met | ADR-098 (envelope encryption, rotation), pepper ring (`packages/iam/src/password.ts`) |
| 1.6.2 | Keys are protected by the services that use them | Met | Master key and pepper from the environment or files, never the database (`apps/server/src/secrets.ts`); KMS or Vault adapters (ADR-098) |
| 1.6.3 | No hard-coded keys or passwords | Met | Secret scan of the whole history clean (`scan-triage.md`); tests build credentials at run time |
| 1.6.4 | Client-side secrets are never trusted | Met | The frontend holds no secret (`packages/webconfig`); the Builder's secrets go only into kits (`packages/builder-core/src/secrets.ts`) |
| 1.7.1 | One logging format across the system | Met | Pino JSON (Fastify), audit records (`audit/record.ts`), syslog export (`audit/syslog.ts`) |
| 1.7.2 | Logs can go to a remote system | Met | Audit syslog forwarding (`apps/server/src/audit/syslog.ts`; `syslog.test.ts`); stdout for the log collector |
| 1.8.1 | Sensitive data identified and classified | Met | Threat model assets; AI sensitive fields and redaction patterns (`packages/ai/src/redact.ts`) |
| 1.8.2 | Protection rules for each level of sensitive data | Met | Sealed secrets, hashed tokens and passwords, redaction before AI calls, visibility levels |
| 1.9.1 | Communication between components is encrypted | Gap | External PostgreSQL takes `sslmode=verify-full`; the bundled Compose PostgreSQL talks plain TCP on the kit's private network. Fix: TLS between app and bundled PostgreSQL in the Compose kit, or document the private network as the boundary (M1 gate item) |
| 1.9.2 | Components verify each other's identity | Met | TLS certificate verification for external PostgreSQL, SMTP, providers (Node's defaults, no `rejectUnauthorized: false` in production code) |
| 1.10.1 | Source control with traceable changes | Met | Git with DCO sign-off on every commit (`pnpm dco`, ADR-002) |
| 1.11.1 | Business flows documented | Met | Specs per area (`docs/specs`), workflow conformance (`packages/workflow`) |
| 1.11.2 | High-value flows are safe under concurrency | Met | Transactions with row locks for transitions and rank (`tickets/store.ts`), optimistic versions on edits (`routes/locks.test.ts`) |
| 1.12.2 | Uploaded files are served as downloads or from another origin | Met | Sandboxing CSP, `nosniff`, CORP same-origin on the app's origin; S3 serves from the bucket's origin (`routes/attachments.ts` `guard`) |
| 1.14.1 | Components of different trust levels are separated | Met | Roles api, worker, realtime, web in separate processes (ADR-021); the Builder page runs alone with no network (ADR-088) |
| 1.14.2 | Binaries are signed and verified | Gap | Release signing waits on the key the user's Mac makes (M1-100, HANDOFF); the air-gap bundle verifies a signature once it exists (`tools/airgap/bundle.sh`) |
| 1.14.3 | The build warns of outdated or insecure components | Met | `pnpm audit` and osv-scanner (`scan-triage.md`); CI scan job (`.github/workflows/ci.yml`) at the M1 gate |
| 1.14.4 | The build verifies a secure deployment | Met | `tools/image/smoke.sh` (size, health, readiness), Helm chart tests (`packages/devtools/src/helm-chart.test.ts`) |
| 1.14.5 | Deployments are containerised | Met | One image (`Dockerfile`), Compose and Helm kits (`deploy/`) |
| 1.14.6 | No unsupported client-side technology | Met | No plugins: CSP `object-src 'none'` (`packages/webconfig/src/csp.ts`) |

## V2 Authentication

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 2.1.1 | Passwords of at least 12 characters | Met | `packages/iam/src/policy.ts`; `apps/server/src/asvs.test.ts` 2.1.1 |
| 2.1.2 | 64 characters allowed, more than 128 refused | Met | `asvs.test.ts` 2.1.2 |
| 2.1.3 | No truncation | Met | `asvs.test.ts` 2.1.3 |
| 2.1.4 | Any printable Unicode allowed | Met | `asvs.test.ts` 2.1.4 |
| 2.1.5 | People can change their password | Met | `routes/account.ts` PUT `/api/v1/account/password`; `asvs.test.ts` 2.1.5 |
| 2.1.6 | Change needs the current and the new password | Met | `asvs.test.ts` 2.1.6 |
| 2.1.7 | Breached and common passwords refused | Met | `packages/iam/src/policy.ts`; `asvs.test.ts` 2.1.7 |
| 2.1.8 | A strength meter helps | Met | `asvs.test.ts` 2.1.8; the web app's password field |
| 2.1.9 | No composition rules | Met | `asvs.test.ts` 2.1.9 |
| 2.1.10 | No periodic rotation | Met | `asvs.test.ts` 2.1.10 |
| 2.1.11 | Paste and password managers work | Met | `apps/web/src/session/SignInForm.test.tsx`, `PasswordLinkPage.test.tsx` |
| 2.1.12 | The password can be shown while typing | Met | `apps/web/src/session/SignInForm.test.tsx`, `PasswordLinkPage.test.tsx` |
| 2.2.1 | Anti-automation against guessing | Met | Per-account and per-address throttling and lockout (`packages/iam/src/throttle.ts`); `asvs.test.ts` 2.2.1 |
| 2.2.2 | Weak authenticators (SMS, email codes) only as a second option | N/A | No SMS or emailed codes; email carries only one-time recovery links (2.5) |
| 2.2.3 | People are told when their credentials change | Gap | `user.password_changed` and two-factor events are audited but not mailed. Fix: a security notice by email on password, second factor and recovery code changes (todo in `asvs.test.ts`; follow-up task) |
| 2.3.1 | Initial passwords and activation codes are random and expire | Met | One-time setup and password links, hashed, expiring (`routes/password-links.ts`; `asvs.test.ts` 2.5.1) |
| 2.3.2 | Security keys and passkeys can be enrolled and used | Met | WebAuthn (`apps/server/src/two-factor.ts`, `@simplewebauthn/server`; `routes/two-factor.test.ts`) |
| 2.3.3 | Renewal of time-bound authenticators is announced | N/A | No authenticator expires (certificates are not used to sign in) |
| 2.4.1 | Passwords stored with an approved salted one-way function | Met | Argon2id (`packages/iam/src/password.ts`); `asvs.test.ts` 2.4.1 |
| 2.4.2 | A salt of at least 32 bits per password | Met | `asvs.test.ts` 2.4.2 |
| 2.4.3 | PBKDF2 with enough iterations | N/A | PBKDF2 is not used |
| 2.4.4 | bcrypt with a work factor of 10 or more | N/A | bcrypt is not used |
| 2.4.5 | A secret pepper kept outside the database | Met | `asvs.test.ts` 2.4.5; `apps/server/src/secrets.ts` |
| 2.5.1 | Activation and recovery secrets are not sent in clear | Met | Links carry one-time tokens stored as hashes; HTTPS (`asvs.test.ts` 2.5.1, 2.5.6) |
| 2.5.2 | No password hints or secret questions | Met | None exist (`routes/password-links.ts`) |
| 2.5.3 | Recovery never reveals the current password | Met | Recovery sets a new password through a link |
| 2.5.4 | No shared or default accounts | Met | `asvs.test.ts` 2.5.4; first-run setup creates the administrator (`routes/setup.ts`) |
| 2.5.5 | People are told when an authentication factor changes | Gap | As 2.2.3 |
| 2.5.6 | Recovery uses a secure mechanism | Met | `asvs.test.ts` 2.5.1, 2.5.6 |
| 2.5.7 | A lost second factor is reset with identity checks as strong as enrolment | Met | Only an administrator resets a second factor, audited (`user.two_factor_reset`, `routes/two-factor.ts`) |
| 2.6.1 | Recovery codes work once | Met | `used_at` (`apps/server/src/two-factor.ts`); `routes/two-factor.test.ts` |
| 2.6.2 | Recovery codes have enough entropy, or are hashed with a salt | Met | Hashed with the password function, salted (`packages/iam/src/totp.ts` recovery codes, `two-factor.ts`) |
| 2.6.3 | Recovery codes resist offline attacks | Met | Same hashing as passwords, peppered |
| 2.7.1 | No clear-text out-of-band authenticators by default | N/A | No SMS or telephone codes |
| 2.7.2 | Out-of-band codes expire in 10 minutes | N/A | No out-of-band authenticator |
| 2.7.3 | Out-of-band codes work once | N/A | No out-of-band authenticator |
| 2.7.4 | Out-of-band channel is secure and independent | N/A | No out-of-band authenticator |
| 2.7.5 | Out-of-band codes kept only as hashes | N/A | No out-of-band authenticator |
| 2.7.6 | Out-of-band codes from a secure random generator | N/A | No out-of-band authenticator |
| 2.8.1 | Time-based codes have a defined lifetime | Met | 30-second steps, one step of drift (`packages/iam/src/totp.ts`; `totp.test.ts`) |
| 2.8.2 | Keys that verify one-time codes are protected | Met | Sealed under the pepper with AES-256-GCM, full tags required since M1-118 (`totp.ts` `sealSecret`; `totp.test.ts` "cut short") |
| 2.8.3 | Approved algorithms for one-time codes | Met | RFC 6238 HMAC (`totp.ts`) |
| 2.8.4 | A time-based code works once in its period | Met | `lastStep` (`totp.ts`; `totp.test.ts`) |
| 2.8.5 | Reuse of a code is refused and logged | Met | Refused through `lastStep`; failed second factors count against the sign-in challenge (`CHALLENGE_MAX_ATTEMPTS`, `two-factor.ts`) |
| 2.8.6 | A lost hardware authenticator can be revoked | Met | Keys and passkeys can be removed by their owner or reset by an administrator (`routes/two-factor.ts`) |
| 2.9.1 | Keys used to verify are stored securely | Met | WebAuthn public keys only (`two-factor.ts`) |
| 2.9.2 | Challenges of at least 64 bits | Met | WebAuthn challenges from `@simplewebauthn/server` (random 32 bytes) |
| 2.9.3 | Approved algorithms for cryptographic authenticators | Met | WebAuthn's ES256 and RS256 |
| 2.10.1 | Service secrets do not rely on unchanging credentials | Met | API tokens and service accounts are revocable and rotatable (`routes/service-accounts.ts`, `tokens/api-tokens.ts`) |
| 2.10.2 | No default credentials for services | Met | Setup and kits generate every password (`packages/builder-core/src/secrets.ts`, `deploy/compose`) |
| 2.10.3 | Service passwords are protected | Met | Environment or mounted files; sealed when stored (`packages/iam/src/envelope.ts`) |
| 2.10.4 | Secrets are never in source code | Met | Secret scan clean over the whole history (`scan-triage.md`); `.gitleaks.toml` |

## V3 Session management

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 3.1.1 | Session tokens never in URLs | Met | Cookies only; one-time links put tokens after `#` (`routes/password-links.ts`) |
| 3.2.1 | A new token at every sign-in | Met | `asvs.test.ts` 3.2.1 |
| 3.2.2 | Tokens of at least 64 bits | Met | 256 bits (`asvs.test.ts` 3.2.2) |
| 3.2.3 | Tokens only in secure browser storage | Met | `HttpOnly` cookie (`auth.ts`) |
| 3.2.4 | Tokens from approved randomness | Met | `newToken`: 32 bytes of `randomBytes` (`packages/iam/src/token.ts`) |
| 3.3.1 | Signing out ends the session on the server | Met | `asvs.test.ts` 3.3.1 |
| 3.3.2 | Re-authentication after 12 hours, or 30 minutes idle | Gap | Today 14 days absolute, 3 days idle (`SESSION_LIFETIME_MS`, `SESSION_IDLE_MS`, `auth.ts`). Fix: a workspace session policy with level 2 values as an option; the default is the user's decision (`docs/plan/decisions.csv`, M1 gate) |
| 3.3.3 | Other sessions can be ended after a password change | Met | A password change signs every other browser out (`routes/account.ts`) |
| 3.3.4 | People see and end their active sessions | Met | `/api/v1/sessions`, `/api/v1/sessions/others` (`routes/identity.test.ts`) |
| 3.4.1 | Cookies are Secure | Met | `asvs.test.ts` 3.4.1 |
| 3.4.2 | Cookies are HttpOnly | Met | `asvs.test.ts` 3.4.2 |
| 3.4.3 | Cookies are SameSite | Met | `asvs.test.ts` 3.4.3 |
| 3.4.4 | Cookies use the `__Host-` prefix | Met | `asvs.test.ts` 3.4.4 |
| 3.4.5 | Cookie path is set when sharing a host | Met | `Path=/` with `__Host-` (one app per origin; base path installs keep their own origin) |
| 3.5.1 | People can revoke OAuth grants of linked apps | Met | Sessions list names an app's grant; administrators remove clients (`routes/mcp-oauth.test.ts`) |
| 3.5.2 | Session tokens rather than static secrets, except for programs | Met | Browsers use sessions; programs use scoped, revocable tokens (`tokens/scopes.ts`) |
| 3.5.3 | Stateless tokens are signed and checked | N/A | No stateless tokens: sessions, API and OAuth tokens are opaque and stored hashed |
| 3.7.1 | Sensitive changes need a fresh sign-in or the current password | Met | Password change needs the current one (`asvs.test.ts` 3.7.1); second-factor changes need a fresh challenge (`two-factor.ts`) |

## V4 Access control

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 4.1.1 | Enforced on the server | Met | `authz/authorizer.ts`; `routes/authz.test.ts`, `search/authz.test.ts` |
| 4.1.2 | People cannot change the attributes access control uses | Met | Roles, groups and levels change only through admin routes (`routes/authz.ts`, `routes/groups.ts`); SCIM cannot make administrators (`scim/store.ts`) |
| 4.1.3 | Least privilege | Met | Default roles Members, Viewers, Administrators per track (migration 0004); token scopes (`tokens/scopes.ts`) |
| 4.1.5 | Access control fails closed | Met | Unknown or missing grants deny; a ticket one cannot see answers 404 (`authz/visibility.test.ts`) |
| 4.2.1 | Objects protected against direct reference | Met | Every id is checked against the caller's visibility (`routes/visibility.test.ts`, `search.visibility.test.ts`); the AI reads as the person (`apps/server/src/ai/injection.test.ts`) |
| 4.2.2 | Protection against cross-site request forgery | Met | Foreign `Origin` refused before routing (`origins.ts` `registerCrossOrigin`; `origins.test.ts`), `SameSite` cookies |
| 4.3.1 | Administrative interfaces use a second factor | Gap | The two-factor policy can require it for site administrators (`two_factor_policy`, `two-factor.ts`), but the default is `none`. Fix: default `site_admins` is the user's decision (M1 gate) |
| 4.3.2 | No directory listing or metadata files served | Met | `@fastify/static` without listing; only the built artefact is served (`apps/server/src/frontend.ts`) |
| 4.3.3 | Step-up for sensitive actions; segregation where needed | Met | Fresh second factor for its own changes; break-glass accounts audited (`routes/session.ts`); bulk operations and exports audited (`audit/subscriber.ts`) |

## V5 Validation, sanitisation and encoding

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 5.1.1 | Defences against parameter pollution | Met | Zod parses query strings strictly; repeated keys become arrays and fail scalar schemas |
| 5.1.2 | Protection against mass assignment | Met | Strict body schemas; routes copy named fields only (e.g. `webhooks/model.ts` `.strict()`) |
| 5.1.3 | All input validated by allowlist | Met | Zod in every route; event contract scenarios (`events/contract.test.ts`) |
| 5.1.4 | Structured data typed and validated | Met | Zod; the query language parsed into a tree (`packages/query`) |
| 5.1.5 | Redirects only to allowed destinations | Met | OAuth redirects registered exactly (`oauth/clients.ts`; `apps/server/src/fuzz/targets.test.ts`); imported links redirect to app routes only (`frontend.ts`) |
| 5.2.1 | Rich text input sanitised | Met | No HTML input: rich text is a schema document; readers drop unsafe links (`packages/richtext`; `pnpm fuzz markdown`, `wiki`) |
| 5.2.2 | Unstructured data sanitised | Met | Text stays text; React escapes; email escapes (`email/render.ts`) |
| 5.2.3 | Input to mail is sanitised against header injection | Met | Nodemailer encodes headers; addresses from accounts only (`apps/server/src/email`) |
| 5.2.4 | No `eval` or dynamic code from input | Met | CSP without `unsafe-eval`; formulas are interpreted (`packages/formula`, fuzzed) |
| 5.2.5 | No template injection | Met | No server templates from input; email templates are code (`email/render.ts`) |
| 5.2.6 | Protection against SSRF | Gap | Webhooks take HTTPS to any host, site administrators only, no answer body kept (`webhooks/model.ts`, `deliver.ts`). Fix: resolve and refuse private, loopback and link-local addresses unless the operator allows them, pinned for the connection (follow-up task, M1 gate) |
| 5.2.7 | SVG content is sanitised or isolated | Met | Attachments served under the sandboxing CSP and as their sniffed type (`routes/attachments.ts`); images in rich text are links, not inline SVG |
| 5.2.8 | Markup languages (Markdown, wiki markup) sanitised | Met | Readers keep only safe links, read as browsers read them (fixed in M1-118: `isSafeHref`, `packages/richtext/src/markdown.ts`; `markdown.test.ts`; `pnpm fuzz href`) |
| 5.3.1 | Output encoded for its interpreter | Met | React; `escapeHtml` in email; JSON by Fastify |
| 5.3.2 | Output keeps the character set | Met | UTF-8 throughout; `charset=utf-8` on HTML (`frontend.ts`) |
| 5.3.3 | Context-aware escaping against XSS | Met | React and DOMSerializer from the schema (`apps/web/src/richtext/RichTextView.tsx`) |
| 5.3.4 | Queries are parameterised | Met | Kysely and `sql` templates bind values; `sql.raw` only for fixed fragments (`scan-triage.md`) |
| 5.3.5 | Where not parameterised, SQL is escaped | Met | Identifiers through `sql.id`, literals through `sql.lit` of numbers the code made (`audit/chain.ts`, `boards/data.ts`) |
| 5.3.6 | No JSON injection or JS evaluation | Met | `JSON.parse` only; no `eval` |
| 5.3.7 | Protection against LDAP injection | Met | Filter values escaped (`apps/server/src/ldap/settings.ts`, `ldap/sync`) |
| 5.3.8 | Protection against OS command injection | Met | `pg_dump` and `pg_restore` run with argument arrays, no shell (`apps/server/src/backup.ts`) |
| 5.3.9 | Protection against file inclusion | Met | No paths from input; storage keys from hashes (`packages/storage`) |
| 5.3.10 | Protection against XPath and XML injection | Met | SAML documents parsed, never built from input; the DC reader does not expand entities (`fuzz/targets.test.ts`) |
| 5.4.1 | Memory-safe string handling | N/A | TypeScript on Node: no manual memory management |
| 5.4.2 | Format strings do not take hostile input | N/A | No printf-style formatting of input |
| 5.4.3 | Integers checked against overflow | Met | Zod `int()` bounds; ids as safe integers; fuzzers check counts (`fuzz/targets.ts` `checkCsv`) |
| 5.5.1 | Serialised objects are integrity-protected | Met | Sealed values are authenticated (AES-GCM, full tags); the connection manifest is signed (`packages/builder-core/src/manifest.ts`) |
| 5.5.2 | XML parsers refuse external entities | Met | saxes without DTD support (`import/dc-backup/parse.ts`); SAML parser settings (`sso/saml.ts`) |
| 5.5.3 | No unsafe deserialisation | Met | JSON only |
| 5.5.4 | JSON parsed with `JSON.parse` | Met | Fastify, `JSON.parse` |

## V6 Stored cryptography

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 6.1.1 | Regulated private data encrypted at rest | Met | Secrets sealed; ticket data relies on the operator's disk encryption (manual); AI redaction keeps marked fields from providers |
| 6.1.2 | Regulated health data encrypted at rest | N/A | Not a health records system; operators storing such data encrypt the volume |
| 6.1.3 | Regulated financial data encrypted at rest | N/A | Not a payment system; card numbers are redacted before AI calls (`packages/ai/src/redact.ts`) |
| 6.2.1 | Crypto fails securely (no padding oracles) | Met | AES-GCM only; failures give one error (`packages/iam/src/envelope.ts`) |
| 6.2.2 | Proven algorithms and libraries | Met | Node's crypto (OpenSSL), WebCrypto, `@simplewebauthn/server` |
| 6.2.3 | IVs, modes and tags configured securely | Met | Random 96-bit IVs; 128-bit tags required on opening since M1-118 (`envelope.ts`, `totp.ts`; `envelope.test.ts`, `totp.test.ts` "cut short") |
| 6.2.4 | Algorithms can be replaced | Met | Versioned formats (`v1.`, `enc1:`), key rings with rotation (ADR-098) |
| 6.2.5 | No weak modes, paddings or hashes | Met | No ECB, DES, MD5 for security; SHA-1 only inside TOTP (RFC 6238) |
| 6.2.6 | Nonces and IVs never reused with a key | Met | Random IV per seal; data keys per secret (ADR-098) |
| 6.3.1 | Randomness from a CSPRNG | Met | `randomBytes`, WebCrypto `getRandomValues` |
| 6.3.2 | GUIDs are version 4 from a CSPRNG | Met | `randomUUID()` |
| 6.4.1 | A secrets manager is used | Met | KMS and Vault adapters for the master key (ADR-098); environment and files otherwise |
| 6.4.2 | Key material isolated from the application | Met | With a key service, only data keys reach the app (`packages/iam/src/envelope.ts` `KeyService`; `envelope.test.ts`) |

## V7 Errors and logging

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 7.1.1 | No credentials or payment data in logs | Met | Request log without headers or bodies (Fastify defaults); AI log without prompts (`packages/ai/src/gateway.ts`); tokens hashed |
| 7.1.2 | No other sensitive personal data in logs | Met | As 7.1.1; audit records name people by id and keep no content by default (ADR-100) |
| 7.1.3 | Security events are logged, failures included | Gap | Sign-ins, sign-outs, revocations, password and second-factor changes are audited (`audit/subscriber.ts`); failed sign-ins and refused requests are only counted (throttle) or in the request log as status codes. Fix: audit failed sign-ins and repeated access refusals (follow-up task) |
| 7.1.4 | Log events hold what an investigation needs | Met | Audit records: who, when, from where, what, before and after (`audit/record.ts`) |
| 7.2.1 | Authentication decisions are logged | Gap | As 7.1.3 |
| 7.2.2 | Access control decisions can be logged, failures are | Gap | As 7.1.3 |
| 7.3.1 | Logging encodes data against log injection | Met | Pino JSON; audit as structured rows |
| 7.3.3 | Security logs are protected | Met | Hash chain per partition (`audit/chain.ts`; `chain.test.ts`); `cli.mjs audit-verify` |
| 7.3.4 | Time sources are synchronised | Met | Timestamps from the database server (`now()`), UTC; the host keeps time (operations manual) |
| 7.4.1 | A generic message on unexpected errors | Met | Fastify's 500 without stack in production; the compatible API answers a fixed message (`compat/register.ts`) |
| 7.4.2 | Exceptions handled across the code | Met | Error handler (`app.ts` `setErrorHandler`); readers turn parser errors into refusals (fuzzed: `pnpm fuzz rich-text`) |
| 7.4.3 | A last-resort handler exists | Met | Fastify's error handler for every request; an error outside a request ends the process, which the orchestrator restarts (image `HEALTHCHECK`, `main.ts` shutdown) |

## V8 Data protection

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 8.1.1 | Sensitive data not cached by intermediaries | Met | API answers in JSON carry `Cache-Control: no-store` since M1-118 (`apps/server/src/security-headers.ts`; `security-headers.test.ts`) |
| 8.1.2 | Temporary copies are protected or purged | Met | Import stages under the data directory, removed with the run (`import/dc-backup/stage.ts`); AI content purged (`ai/usage.ts` `purgeAiContent`) |
| 8.1.3 | Requests carry few parameters | Met | Bodies are JSON with named fields; nothing sensitive in hidden fields |
| 8.1.4 | Abnormal request rates detected | Met | Rate limits per token, person and address with metrics (`apps/server/src/ratelimit`; `ratelimit.test.ts`; Prometheus on 9464) |
| 8.2.1 | Browsers do not cache sensitive data | Met | As 8.1.1; the app shell `no-cache` (`frontend.ts`) |
| 8.2.2 | No sensitive data in browser storage | Met | Only preferences in local storage (`apps/web/src`); the session is an `HttpOnly` cookie |
| 8.2.3 | Client storage cleared at sign-out | Met | Sign-out drops the session state and the OAuth client's (`apps/web/src/session/SessionProvider.tsx`) |
| 8.3.1 | Sensitive data in bodies or headers, not URLs | Met | Tokens in headers or cookies; one-time links after `#` |
| 8.3.2 | People can export or remove their data | Gap | Administrators export the workspace and deactivate accounts (`routes/exports.ts`, SCIM); no self-service export or erasure of one person's data. Fix: a personal data export and an erasure (anonymise) action for administrators (follow-up task) |
| 8.3.3 | People are told what is collected, consent asked | N/A | Self-hosted: the operator is the controller and publishes the notice; Taskmoor collects nothing for itself (10.2.1) |
| 8.3.4 | Sensitive data identified with a policy | Met | Threat model assets; AI policy for sensitive fields (`ai/settings.ts`) |
| 8.3.5 | Access to sensitive data is audited | Met | AI calls audited without content (ADR-100); exports audited (`workspace.exported`) |
| 8.3.6 | Sensitive memory overwritten after use | N/A | A garbage-collected runtime cannot guarantee it; keys stay in `Buffer`s for the process lifetime |
| 8.3.7 | Sensitive data encrypted with approved algorithms | Met | AES-256-GCM (`packages/iam/src/envelope.ts`) |
| 8.3.8 | Retention of personal data | Met | Audit retention (`audit/retention.ts`), trash purge (`cli.mjs purge-trash`), AI content purge |

## V9 Communication

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 9.1.1 | TLS for every client connection | Met | Kits put Caddy in front with automatic HTTPS (`deploy/compose`, backend kit); Secure cookies and HSTS behind HTTPS |
| 9.1.2 | Only strong cipher suites | Met | Caddy's defaults (TLS 1.2 strong suites, TLS 1.3) |
| 9.1.3 | Only TLS 1.2 and 1.3 | Met | Caddy's defaults |
| 9.2.1 | Trusted certificates for server connections | Met | Node's certificate verification; custom CAs only by operator choice (`NODE_EXTRA_CA_CERTS`) |
| 9.2.2 | TLS for every inbound and outbound connection | Met | Outbound HTTPS for providers, webhooks (HTTPS required), SMTP STARTTLS, LDAPS; database as in 1.9.1 |
| 9.2.3 | Connections to external systems are authenticated | Met | Provider keys, webhook signatures, SMTP and LDAP credentials |
| 9.2.4 | Certificate revocation checks | Met | Caddy staples OCSP for the instance's certificate |

## V10 Malicious code

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 10.2.1 | No phoning home or hidden data collection | Met | No telemetry; the network policy of the Builder page allows nothing (ADR-088); AI only when an administrator configures it |
| 10.2.2 | No needless permissions or sensors | Met | The web app asks for no device permission |
| 10.3.1 | Updates over secure channels and signed | N/A | No auto-update; the operator upgrades (`deploy/compose/upgrade.sh`); signing as 1.14.2 |
| 10.3.2 | Integrity protection; no code from untrusted sources | Met | CSP `script-src 'self'` or hashes; single-file kit lists hashes (`packages/webconfig/src/csp.ts`) |
| 10.3.3 | Protection from subdomain takeover | N/A | Taskmoor serves the operator's own domains; no dangling records of ours |

## V11 Business logic

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 11.1.1 | Flows run in order | Met | Workflows enforce transitions (`packages/workflow`, conformance suite) |
| 11.1.2 | Flows take realistic time | Met | Setup and password links expire; challenges last five minutes (`two-factor.ts`) |
| 11.1.3 | Limits per person for business actions | Met | Guardrails (`apps/server/src/guardrails`), AI spend limits (ADR-100), rate limits |
| 11.1.4 | Anti-automation against mass export and abuse | Met | Rate limits (`ratelimit`), export and bulk operations audited and limited (`guardrails`) |
| 11.1.5 | Limits against likely business risks | Met | Guardrails on field, workflow and board sizes (M1-055) |
| 11.1.6 | No race conditions in sensitive operations | Met | Transactions and row locks (`tickets/store.ts`), single-use tokens updated atomically (`two-factor.ts` `used_at`) |
| 11.1.7 | Unusual activity is monitored | Gap | Audit and metrics exist, but no rule watches for unusual activity. Fix: alert rules for failed sign-in bursts, bulk exports, AI spend (with 7.1.3; follow-up task) |
| 11.1.8 | Alerts on automated attacks | Gap | As 11.1.7; AI spend alerts exist (ADR-100) |

## V12 Files and resources

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 12.1.1 | Large files cannot fill storage | Met | `maxFileSize` per workspace, enforced while streaming (`routes/attachments.ts`) |
| 12.1.2 | Compressed files checked before unpacking | Gap | Export ZIPs are listed, not unpacked (`attachments/zip.ts`); DC backups are staged without a limit on uncompressed size. Fix: a ceiling on the uncompressed total and ratio while staging (follow-up task) |
| 12.1.3 | Quotas per person | Gap | No storage quota (`routes/attachments.ts`). Fix: a workspace quota with per-person limits (follow-up task) |
| 12.2.1 | Untrusted files checked by content | Met | Types sniffed (`attachments/sniff.ts`; `sniff.test.ts`) |
| 12.3.1 | File names never used as paths | Met | Keys from hashes (`packages/storage`); names cleaned (`attachments/filename.ts`) |
| 12.3.2 | File names cannot reach local files | Met | As 12.3.1 |
| 12.3.3 | File names cannot trigger remote inclusion | Met | Names are metadata only |
| 12.3.4 | Protection against reflected file download | Met | API JSON carries a fixed `attachment; filename="api.json"` since M1-118; attachments their own cleaned name (`security-headers.ts`, `attachments/filename.ts`) |
| 12.3.5 | File metadata never reaches a shell | Met | No shell use |
| 12.3.6 | No code included from untrusted sources | Met | Lockfile with integrity hashes; no runtime code loading |
| 12.4.1 | Uploads stored outside the web root | Met | Data directory or bucket (`packages/storage`) |
| 12.4.2 | Uploads scanned for malware | Met | ClamAV scanning when configured, infected files never served (`attachments/scan.ts`; `scan.test.ts`) |
| 12.5.1 | Only intended files are served | Met | Only the built artefact (`frontend.ts`, `globIgnore`) |
| 12.5.2 | Uploads never run as HTML or script | Met | Sandboxing CSP and `nosniff` (`routes/attachments.ts`) |
| 12.6.1 | Outbound requests limited to an allowlist | Gap | As 5.2.6 |

## V13 API and web services

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 13.1.1 | One set of parsers and encodings | Met | Fastify JSON everywhere; one rich text reader per format, shared by API and import (`packages/richtext`) |
| 13.1.3 | No secrets in API URLs | Met | Tokens in headers; webhook URLs refuse credentials (`webhooks/model.ts`) |
| 13.1.4 | Authorisation at route and resource level | Met | Scope classes per route (`tokens/scopes.ts`) and the authoriser per resource |
| 13.1.5 | Unexpected content types refused | Met | Fastify answers 415 for types without a parser |
| 13.2.1 | HTTP methods fit the action | Met | Routes per method; unknown methods 404 |
| 13.2.2 | JSON validated against a schema first | Met | Zod before any use; OpenAPI generated from the same (`packages/sdk`) |
| 13.2.3 | Cookie-authenticated REST is protected from CSRF | Met | Origin check (`origins.ts`); the compatible API takes no cookies (`compat/register.ts`) |
| 13.2.5 | Content type checked | Met | As 13.1.5 |
| 13.2.6 | Messages protected in transit | Met | TLS (V9); webhook HMAC signatures |
| 13.3.1 | XML validated against a schema | N/A | No XML API; SAML responses are checked by signature and structure (`sso/saml.ts`) |
| 13.3.2 | SOAP payloads signed | N/A | No SOAP |
| 13.4.1 | GraphQL depth and cost limits | N/A | No GraphQL |
| 13.4.2 | GraphQL authorisation in the business layer | N/A | No GraphQL |

## V14 Configuration

| ID | Requirement | State | Evidence or fix |
|---|---|---|---|
| 14.1.1 | Builds are secure and repeatable | Met | Frozen lockfile, multi-stage image (`Dockerfile`), deterministic kits (ADR-031) |
| 14.1.2 | Compiler flags against buffer overflows | N/A | No native code of ours |
| 14.1.3 | Server configuration hardened | Met | Non-root image without package managers (M1-118), Helm chart with a restricted security context (`deploy/helm`; Trivy config scan in `scan-triage.md`) |
| 14.1.4 | Redeployable by script in reasonable time | Met | `deploy/compose/upgrade.sh`, Helm, `cli.mjs upgrade` (M0-029) |
| 14.2.1 | Components up to date, checked at build | Met | `pnpm audit`, osv-scanner: 0 high or critical (`scan-triage.md`) |
| 14.2.2 | Unneeded features and samples removed | Met | The image drops npm, corepack and yarn (M1-118); no sample apps shipped |
| 14.2.3 | Externally hosted assets use SRI | N/A | No asset comes from a CDN; everything is served by the instance |
| 14.2.4 | Components from trusted, maintained repositories | Met | npm registry with lockfile integrity; licence allowlist (`packages/devtools/src/licences.ts`) |
| 14.2.5 | A software bill of materials is kept | Met | SBOM generated in CI (`.github/workflows/ci.yml`) and the air-gap bundle (`tools/airgap`) |
| 14.2.6 | Third-party code encapsulated | Met | Providers behind adapters (`packages/ai/src/adapters`), storage behind one interface (`packages/storage`) |
| 14.3.2 | Debug modes off in production | Met | `NODE_ENV=production` in the image; no debug routes |
| 14.3.3 | No detailed component versions exposed | Met | No `Server` or `X-Powered-By` headers; `/health` and `/api/meta` give only Taskmoor's own version, which frontend kits need (ADR-066) |
| 14.4.1 | Every response has a content type with a charset | Met | Fastify sets JSON and HTML types; `charset=utf-8` on pages |
| 14.4.2 | API answers carry a safe Content-Disposition | Met | Since M1-118 (`security-headers.ts`; `security-headers.test.ts`) |
| 14.4.3 | A content security policy | Met | `packages/webconfig/src/csp.ts`; `frontend.test.ts` |
| 14.4.4 | `nosniff` on every response | Met | Since M1-118 for every answer (`security-headers.ts`) |
| 14.4.5 | Strict-Transport-Security | Met | Since M1-118 on HTTPS instances (`security-headers.ts`; `security-headers.test.ts`) |
| 14.4.6 | A suitable Referrer-Policy | Met | `same-origin` since M1-118; `no-referrer` on attachments |
| 14.4.7 | Not embeddable by other sites | Met | `frame-ancestors 'none'` (`frontend.ts`, `csp.ts`) |
| 14.5.1 | Only the methods in use are accepted | Met | Fastify routes per method |
| 14.5.2 | The Origin header is not used for authentication | Met | It only refuses (CSRF); sessions and tokens authenticate (`origins.ts`) |
| 14.5.3 | CORS allows exact origins only, never `null` | Met | Exact match, wildcards refused at start (`network/frontends.ts` `frontendOrigin`; `pnpm fuzz addresses`) |
| 14.5.4 | Headers added by proxies are authenticated | Met | Forwarded headers trusted only from `TASKMOOR_TRUSTED_PROXIES` (`app.ts` `trustProxy`) |

## Gaps in one list

| ID | Gap | Severity | Closes with |
|---|---|---|---|
| 1.9.1 | Plain TCP to the bundled PostgreSQL inside the Compose network | Low | TLS in the Compose kit, or the private network documented as the boundary |
| 1.14.2 | Releases not yet signed | Medium | M1-100 (the key from the user's Mac) |
| 2.2.3, 2.5.5 | No email when a credential changes | Medium | Security notices by email |
| 3.3.2 | Sessions last 14 days, 3 idle | Medium | Session policy; default is the user's decision |
| 4.3.1 | Second factor for administrators not required by default | Medium | Default policy `site_admins`; the user's decision |
| 5.2.6, 12.6.1 | Webhooks may reach private addresses | Medium | Resolver that refuses private ranges |
| 7.1.3, 7.2.1, 7.2.2 | Failed sign-ins and refusals not audited | Medium | Audit events for failures |
| 8.3.2 | No per-person export or erasure | Low | Personal data export and anonymisation |
| 11.1.7, 11.1.8 | No alerting on unusual activity | Low | Alert rules (with 7.1.3) |
| 12.1.2 | No uncompressed-size ceiling when staging a backup | Low | Ceiling on total and ratio |
| 12.1.3 | No storage quota | Low | Workspace and per-person quotas |

None is high or critical: each needs a site administrator's action, a privileged position or a
second weakness to matter. The pen test of M2-021 rechecks the list.
