# Threat model

Taskmoor 1.0, as built on 2026-10-31 (M1-118, ADR-104). It names what Taskmoor protects, where
untrusted data crosses into it, what can go wrong at each crossing (grouped by STRIDE: spoofing,
tampering, repudiation, information disclosure, denial of service, elevation of privilege), what
stops it, with the code and the tests that show it, and what is left. Review it with every change
to a boundary; the ASVS level 2 checklist (`asvs-l2.md`) and the scan triage (`scan-triage.md`)
go with it.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Tickets, comments, attachments, history | PostgreSQL (`ticket`, `comment`, `change_set` ...), file store (`packages/storage`) | The customer's work; some tracks restricted (visibility levels, private tracks) |
| Accounts and sessions | `app_user`, `user_session` (hashed tokens), cookies | Who acts; a stolen session acts as the person |
| Credentials Taskmoor keeps | Password hashes (`packages/iam/src/password.ts`, peppered), API and OAuth tokens (hashed), sealed secrets (AI keys, SSO and SCIM secrets, import tokens: `packages/iam/src/envelope.ts`, `totp.ts`) | Reuse elsewhere; the AI key spends money |
| The pepper and the master key | Environment or mounted files (`apps/server/src/secrets.ts`), never the database | Open every sealed secret, verify passwords offline |
| Configuration | Workflows, permission schemes, field rules, origins, webhooks | Changing it changes who sees what |
| The audit log | `audit_event`, hash-chained per partition (`apps/server/src/audit/chain.ts`) | Evidence; tampering must show |
| Backups and exports | `cli.mjs backup` files, full exports (`apps/server/src/export`) | Everything above, offline |
| Availability | API, workers, sockets, queue | A tracker that is down stops the team |
| The release artefacts and kits | Image, Builder kits (`packages/builder-core`), the signed manifest | A tampered kit installs someone else's code |

## People and the trust they get

- **Anonymous visitors** reach the sign-in, setup (once), password-link, OAuth discovery and the
  public health probes. Nothing else.
- **People with an account** act within their track roles, visibility levels and the
  workspace's permissions (`apps/server/src/authz/authorizer.ts`).
- **Track and configuration administrators** change a track's or the workspace's configuration.
- **Site administrators** are trusted with the instance: they set SSO, SCIM, webhooks, AI keys,
  origins, imports. They are not trusted with the pepper (it is outside the database) nor able to
  edit the audit log without it showing.
- **Programs**: API tokens (scoped, `apps/server/src/tokens/scopes.ts`), OAuth clients of MCP
  (consent per person, ADR-084), SCIM provisioning clients, the Jira-compatible API's clients.
- **The operator** runs the containers and holds the environment; fully trusted.

## Trust boundaries and threats

Each boundary lists threats, then mitigations with their code and tests, then what is left.

### 1. Browser to the web app and the API

Threats: XSS through rich text, links, filenames or imported content (E, I); CSRF from another
site (T); clickjacking (T); session theft or fixation (S); a frontend kit on another origin
abused by a hostile page (S, I); user enumeration and password guessing (S, I).

Mitigations:
- One content security policy everywhere (`packages/webconfig/src/csp.ts`): scripts only from
  the app's own origin or hashed inline blocks, no `eval`, `object-src 'none'`, `base-uri`,
  `form-action`, `frame-ancestors 'none'` on the header (`apps/server/src/frontend.ts`). Images
  only from the app, `data:` and the configured media origins, so an image cannot carry data to
  a third site.
- Rich text never becomes HTML by parsing: the shared ProseMirror schema builds the elements
  (`apps/web/src/richtext/RichTextView.tsx`); links keep only `http`, `https`, `mailto` and
  `tel` targets, read as a browser reads the scheme (`isSafeHref`,
  `packages/richtext/src/markdown.ts`; fixed in M1-118 for `java\tscript:` and leading control
  characters; `pnpm fuzz href` checks it against the URL parser; test
  `markdown.test.ts` "reads the scheme as a browser does"). Readers of Markdown and wiki markup
  drop unsafe links (`pnpm fuzz markdown`, `pnpm fuzz wiki`).
- Attachments are served with `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, a
  sandboxing CSP and `no-referrer` (`apps/server/src/routes/attachments.ts`, `guard`); their
  type is sniffed (`apps/server/src/attachments/sniff.ts`), names cleaned
  (`attachments/filename.ts`).
- Cookies are `__Host-`, `Secure`, `HttpOnly`, `SameSite` on HTTPS, a new 256-bit token at every
  sign-in, idle and absolute lifetimes (`apps/server/src/auth.ts`; `apps/server/src/asvs.test.ts`
  V3).
- Cross-origin requests: only this instance's origin and registered frontends get CORS answers
  or open sockets; any other `Origin` is refused with 403 before routing
  (`apps/server/src/origins.ts`, `registerCrossOrigin`; `origins.test.ts`,
  `routes/frontends.test.ts`). State-changing requests from another site carry that site's
  `Origin` and are refused; `SameSite` cookies add a second layer.
- Sign-in: generic failures, per-account and per-address throttling and lockout
  (`packages/iam/src/throttle.ts`, `apps/server/src/throttle.ts`; `asvs.test.ts` 2.2.1),
  breached-password check, second factor (`apps/server/src/two-factor.ts`).
- Strings never build markup in the web app: React escapes, `dangerouslySetInnerHTML` is not
  used (`pnpm i18n:check` and review; Semgrep found none).

Left: style attributes stay allowed (`style-src-attr 'unsafe-inline'`, the editor needs them);
they cannot run code. A browser extension or a compromised device is outside the model.

### 2. API and the Jira-compatible API

Threats: broken object-level authorisation (reading or changing another track's ticket by id)
(I, E); mass assignment (E); query injection through the query language or text search (I, T);
expensive queries (D); token theft or overreach (S, E).

Mitigations:
- Every ticket read and write goes through the authoriser with the caller's context
  (`apps/server/src/authz/authorizer.ts`, `visibility.ts`); search is compiled with the
  person's visibility as a pre-filter (`apps/server/src/search/compile.ts`; `search/authz.test.ts`,
  `authz/visibility.test.ts`). A ticket a person cannot see answers 404, not 403.
- Bodies are parsed with Zod schemas, strict where it matters, so unknown fields are refused or
  ignored, never stored (`routes/*.ts`; contract tests in `apps/server/src/events/contract.test.ts`).
- The query language is parsed into a tree and compiled to SQL with bound parameters
  (`packages/query`, `apps/server/src/search/compile.ts`; the few `sql.raw` uses take fixed
  fragments, see `scan-triage.md`). Parsers are fuzzed (`pnpm fuzz query`, `pnpm fuzz text`).
- Limits: request bodies 1 MiB (Fastify's default), rich text by size and characters
  (`RICH_TEXT_MAX_BYTES`, `apps/server/src/tickets/model.ts`), results paged, ranked search
  capped at 10,000 (`RANKED_CAP`), per-token and per-person rate limits
  (`apps/server/src/ratelimit`), query timeouts.
- Tokens are stored as hashes, scoped by route class (`tokens/scopes.ts`; `scopes.test.ts`); an
  OAuth client's token works only at `/api/v1/mcp` (`app.ts`, ADR-084).
- The compatible API (`apps/server/src/compat/register.ts`, ADR-086) accepts only Bearer or
  Basic with an API token (no cookies, no passwords) and calls the native routes in process as
  the caller, so it has no authorisation of its own to get wrong.
- Rich text bodies are checked before they are stored: shape (no non-object attributes, lists
  where content goes, depth at most 128, table spans from 1 to 1,000; `adfShapeProblem`, `docShapeProblem` in
  `packages/richtext/src/adf.ts`), then the schema (`checkRichText`). Fixed in M1-118: such
  documents used to be stored and then fail every read and the notification mail
  (`pnpm fuzz rich-text`, `pnpm fuzz adf`; `apps/server/src/fuzz/targets.test.ts`).

- Workflow regex validators run administrators' patterns on anyone's ticket text; a pattern
  that can backtrack catastrophically is refused when the workflow is saved and never run
  (`unsafePattern`, `packages/workflow/src/pattern.ts`; M1-118, from the SAST scan).

Left: a person who may see a ticket sees all of its non-hidden fields; field-level read
permissions are field rules (hidden), not a separate grant.

### 3. Sockets: sync and collaboration

Threats: subscribing to changes of tickets one cannot see (I); editing a document without the
right (E); cross-site WebSocket hijacking (S).

Mitigations: the handshake checks the `Origin` against the origin policy and the socket grant of
registered frontends (`origins.ts` `allowsSocket`); the session cookie or token authenticates;
sync deltas are filtered by the person's visibility (`apps/server/src/sync/socket.ts`,
`sync/log.ts`; `sync/log.test.ts`); the collaboration server authorises each document on
connect and on every change of rights (`apps/server/src/collab/server.ts`; `collab.test.ts`).

Left: a socket that is open when a person loses access keeps it until the next check
(seconds); closing sockets when a frontend is removed is open (HANDOFF, M1-108).

### 4. MCP and OAuth

Threats: a malicious client registering and phishing consent (S); open redirect via
`redirect_uri` (S, I); code interception (S); a token used beyond MCP (E).

Mitigations: dynamic registration can be turned off; consent names the client and the scope
(`apps/web/src/oauth/ConsentPage.tsx`); redirect URIs must be registered exactly, or loopback
HTTP with only the port changed (RFC 8252); M1-118 refuses a user name, password or fragment in
such a loopback redirect (`apps/server/src/oauth/clients.ts` `redirectMatches`;
`apps/server/src/fuzz/targets.test.ts`; `pnpm fuzz addresses`); PKCE S256 is required
(`routes/oauth.ts`); unknown clients or URIs get an error page, never a redirect; tokens are
bound to `/api/v1/mcp` and to their family, revocable per app (`routes/mcp-oauth.test.ts`).

Left: client ID metadata documents are not supported until an SSRF-safe fetch exists.

### 5. Importers reading untrusted files

Threats: XML entity expansion and external entities (D, I); zip slip (T); parser crashes or
hangs on malformed input (D); formula injection in CSV exports (T); a crafted backup that
grants rights (E).

Mitigations:
- DC backups are read by saxes, which does not expand entities and never fetches external ones
  (`apps/server/src/import/dc-backup/parse.ts`; test "never expands entities a file declares"),
  after a cleaner of forbidden characters (`clean.ts`); `pnpm fuzz dc-xml` checks the reading
  does not depend on how the input is split, `pnpm fuzz dc-stage` stages whole edited backups
  and accepts only a stage or an `Error`.
- ZIP entries are read by offset, never written to disk by their names; attachments are indexed
  by id (`stage.ts`); export ZIPs list unsafe names as unsafe (`attachments/zip.ts`).
- CSV reading never throws and always moves forward (`pnpm fuzz csv`); exports guard cells
  that start like a formula (`cellText` reads them back).
- Imports are site-administrator actions; imported grants are reported, and the system
  administrators of a backup map to an import setting (ADR-090).
- The Cloud importer refuses Atlassian hosts in tests and recording (`ATLASSIAN_HOST`,
  `apps/server/src/import/cloud/client.ts`); its token is sealed.

Left: no size or ratio limit on a backup's compressed entries (a ZIP bomb fills the disk while
staging); acceptable for an administrator's own backup, listed as V12.1.2 in the checklist.

### 6. Attachments and the file store

Threats: malware shared through the tracker (T); stored XSS through HTML or SVG (E); path
traversal in the local store (T, I); public buckets (I).

Mitigations: optional ClamAV scanning with quarantine (`attachments/scan.ts`), served with the
sandbox headers above; the local store builds keys from hashes, not names
(`packages/storage`); S3 downloads go through signed, short-lived URLs; thumbnails are rendered
from images only (`attachments/thumbnail.ts`).

Left: without ClamAV configured, files are not scanned (documented in the manual).

### 7. AI providers

Threats: prompt injection through ticket text making the model reveal other tickets, act beyond
the person's rights or write without asking (E, I); data sent to the provider that should not
leave (I); key theft (S); runaway spend (D).

Mitigations:
- `AiContext` (`apps/server/src/ai/context.ts`) reads a ticket through the ticket route as the
  person asking: a ticket they cannot see is never sent. Fields marked sensitive and fields
  hidden by field rules become placeholders, and their values are redacted wherever else they
  appear (`packages/ai/src/redact.ts`; `apps/server/src/ai/spend.test.ts`).
- The ticket's text sits in one fence it cannot close (`fenceUntrusted`,
  `packages/ai/src/untrusted.ts`; M1-118 fixed `</tic<ticket>ket>`).
- Agent tools are an allowlist; the gateway refuses calls to tools it did not offer; a tool
  marked `effect: 'write'` runs only when the person confirms (`packages/ai/src/agent.ts`).
- `screenAnswer` takes out images that would load from other origins and lists external links.
- The corpus `packages/ai/src/injection/corpus.ts` and its harnesses
  (`packages/ai/src/injection/injection.test.ts`, `apps/server/src/ai/injection.test.ts`) check
  all of this with an obedient fake model.
- Keys are sealed per slot with envelope encryption (ADR-098), never shown again (last four
  only), scrubbed from provider error messages (`packages/ai/src/secrets.ts`); spend limits stop
  calls before they are made (ADR-100, ADR-101).

Left: whether a real model follows an injection in its answer text (misleading summaries) is
measured only with a live model; M1-079 runs the corpus against one (ADR-104).

### 8. Webhooks

Threats: SSRF to internal services (I); forged deliveries to receivers (S); secrets in URLs (I).

Mitigations: site administrators only; HTTPS, or HTTP to this machine; no credentials in the
URL (`apps/server/src/webhooks/model.ts` `urlProblem`; `pnpm fuzz addresses`); redirects not
followed, answer bodies not kept, a timeout per attempt (`webhooks/deliver.ts`); HMAC signature
with the webhook's secret (`x-taskmoor-signature`).

Left: a site administrator can point a webhook at an internal HTTPS address and learn its status
code and timing (blind SSRF). A resolver that refuses private addresses is listed as V12.6.1 and
V5.2.6 in the checklist.

### 9. Identity providers: SAML, OpenID Connect, LDAP, SCIM

Threats: signature wrapping and unsigned assertions (S); replay (S); LDAP injection (I, E);
SCIM filter injection or crashes (D, E); a provisioning client creating administrators (E).

Mitigations: SAML signatures are checked on the element that is used, with the referenced id
resolved once (`apps/server/src/sso/saml.ts`; `saml.test.ts`), audiences, recipients and
validity windows enforced, assertion ids remembered against replay; OIDC with PKCE and nonce
(`sso/oidc.ts`); LDAP filters are built with escaping (`apps/server/src/ldap`); SCIM filters
and paths are parsed against the schema, every name resolved or refused with a SCIM 400
(`apps/server/src/scim/filter.ts`; `filter.test.ts`; `pnpm fuzz scim`); SCIM writes only the
attributes of its schemas (`scim/schemas.ts`), and site administration is not one of them.

### 10. The Builder and its kits

Threats: a tampered kit (T); secrets leaking from the Builder page (I); the page calling out (I).

Mitigations: the Builder page makes no request (its policy allows none,
`apps/web/build/builder-page.ts`; `apps/web/e2e/builder-page.spec.ts`); secrets are generated with
WebCrypto in the browser and only written into the kit (`packages/builder-core/src/secrets.ts`);
kits are deterministic for a seed (`kits.test.ts`), so a rebuild can be compared byte for byte;
the connection manifest is signed (`manifest.ts`). Release signing (M1-100) waits for the key
the user's Mac makes (HANDOFF).

### 11. Backups, exports and the operator's side

Threats: backups readable by others (I); restoring a tampered backup (T); secrets in images or
logs (I); a container running as root (E).

Mitigations: backups are written by the app user into the data volume, checksummed
(`cli.mjs checksum`), drilled (`apps/server/src/backups/drill.ts`); restore needs `--yes` and
checks the checksum; the pepper and master key are never in backups (environment only); the request log holds
method, URL, host and address, never headers or bodies (Fastify's default serialisers,
`apps/server/src/app.ts`), and the AI gateway's logger never receives prompt content
(`packages/ai/src/gateway.ts` `AiLogger`); the image runs as `node`, without
npm, corepack or yarn since M1-118 (`Dockerfile`); the all-in-one image starts as root only to
start PostgreSQL and the app under their own users (`deploy/allinone/entrypoint.sh`).

Left: backups are not encrypted by Taskmoor; the operator encrypts the volume or the copy. The
all-in-one image's PostgreSQL trusts local connections inside its container (127.0.0.1 only).

### 12. Supply chain

Threats: a vulnerable or malicious dependency (T, E); unpinned CI actions (T).

Mitigations: the lockfile is committed and installs are frozen; the licence allowlist and the
secret scan run in `pnpm verify` (M0-012); dependencies are scanned with osv-scanner and
`pnpm audit` (`scan-triage.md`); the image is scanned with Trivy.

Left: GitHub Actions use version tags, not commit hashes (31 Semgrep findings); they do not run
until M1 is finished, and pinning them is on the M1 gate list (`scan-triage.md`).

## Residual risks, in one place

| Risk | Severity | Why accepted for now | Where it is tracked |
|---|---|---|---|
| Blind SSRF from webhooks by a site administrator | Medium | Site administrators are trusted with the instance; no body is kept | ASVS 5.2.6, 12.6.1 gaps |
| ZIP bomb in an administrator's own DC backup | Low | Administrator action on their own file | ASVS 12.1.2 gap |
| Model behaviour under injection (live) | Medium | No AI feature exists yet; defences around the model hold | M1-079, gate |
| Unscanned PostgreSQL client layer of the image | Low | Alpine packages from the distribution; scanned at the M1 gate | scan-triage.md |
| Actions not pinned by hash | Low | CI does not run until M1 | gate |
| Backups unencrypted by the app | Low | Operator's storage encryption | manual, operations |
| External pen test | n/a | M2-021 | backlog |
