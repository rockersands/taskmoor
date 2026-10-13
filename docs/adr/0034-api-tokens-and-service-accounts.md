# ADR-034: API tokens and service accounts

- Status: Accepted
- Date: 2026-10-12
- Backlog: M1-004

## Context

IAM-007 asks for personal tokens with scopes and an expiry up to an administrator's maximum
(which may exceed one year), a central inventory with revoke, last use and rotation reminders,
and service accounts with named, expiring credentials that are not counted as users. Its
criteria: an administrator revokes all tokens of a user in one action; a reminder goes out 14
days before expiry; a service-account token rotates with a configurable overlap and no
downtime. ADR-019 put tokens and service accounts in the in-process identity code; ADR-032 left
bearer tokens to programs while browsers keep their cookie session. Jira caps tokens at a year
and has no central renewal.

## Decision

- **Format.** `tmk_` + 40 random base62 characters (238 bits) + a 6-character base62 CRC32 of
  them (`@taskmoor/iam` `newApiToken`). The prefix lets secret scanners match leaked tokens with
  one pattern (`tmk_[0-9A-Za-z]{46}`); the checksum lets them, and the server, discard
  look-alike text without a lookup. Shown once; the row keeps the SHA-256, as for sessions.
- **Table `api_token`** (migration 0007): owner, name, scopes, created by, created, expires,
  last used (time and address, written at most once a minute), revoked (time and by whom) and
  `replaced_by` for rotation. Revoked and expired tokens stay listed for 90 days, then pruning
  removes them; events keep the history. `token_policy` holds per workspace the maximum
  lifetime (default 365 days, 1 to 3,650) and the reminder window (default 14 days).
- **Every token expires.** The expiry is required and capped by the policy; an administrator
  may raise the cap to ten years. Rotation keeps the old lifetime within today's cap.
- **Scopes** `read`, `write`, `admin`, checked once in the request pipeline by the matched
  route (`apps/server/src/tokens/scopes.ts`): public routes need none; reading needs `read`,
  other methods `write`; administration (people, groups, roles, policies, grants, service
  accounts, the token inventory, `/admin/*`) needs `admin` whatever the method. A token never
  reaches the person's own tokens, password or browser sessions (`session_required`), so a
  leaked token cannot mint, rotate or list tokens to keep itself alive. A fitness test fails
  when a listed route disappears and checks that every administration route is in the admin
  class.
- **A token never grants more than its owner.** Authorization still runs through
  `request.authz` as the owner. Without the admin scope the owner also acts without the
  administrator permissions (site, configuration, automation, AI and extension
  administration), as an ordinary user would (GitLab's `admin_mode` works the same way); so an
  administration route missing from the scope list is still refused. Cookie sessions keep the
  person's full rights.
- **Bearer resolution** in the API's `onRequest`: `Authorization: Bearer` is read before the
  cookie and replaces it. Unknown, malformed, expired and revoked tokens and tokens of
  deactivated owners answer 401 `invalid_token` with a `reason` and a `WWW-Authenticate`
  header (RFC 6750); only the holder of the token learns the reason. Failed attempts count per
  address under their own key with sign-in's address rule (50 in 15 minutes lock the address
  for the rest of the window, valid tokens included), so a mistyped password and a broken
  script do not lock each other out.
- **Service accounts** are `app_user` rows with `kind = 'service'`: no password, never a
  session (sign-in, password links, the CLI link and session lookup refuse them), an address in
  the reserved `service.invalid` domain, a description, group memberships and grants like
  anyone. They are left out of the people list and its total (not counted as users) and are
  managed by site administrators under `/api/v1/service-accounts`. Deactivating one stops its
  tokens at once; reactivating restores them.
- **Who issues and rotates.** People issue, revoke and rotate their own tokens from a browser
  session. Administrators revoke anyone's tokens but issue and rotate only service-account
  tokens: they never receive a secret that acts as another person.
- **Rotation with overlap.** Rotating issues a successor with the same owner, name and scopes;
  the old token keeps working for `overlapHours` (24 by default, 0 to 720; never past its own
  expiry), so a program switches without downtime. Zero revokes the old one at once.
- **Inventory and bulk revocation.** `GET /api/v1/admin/tokens` lists every token with owner,
  scopes, dates and status; `POST /api/v1/admin/tokens/revoke` revokes the live tokens of an
  owner, those created before a date (both narrow together), or all, reports the count, and
  offers a dry run for the confirmation step. Criteria are required: an empty body revokes
  nothing.
- **Reminders.** `GET /api/v1/admin/tokens/expiring` lists live, unreplaced tokens of active
  owners expiring within the window, soonest first. Email delivery to owners (IAM-007's
  14-day reminder) reads this list when mail arrives with M1-057.
- **Events.** `token.created`, `token.revoked`, `token.rotated`, `token.bulk_revoked`,
  `token_policy.updated` and `service_account.created / updated / deactivated / reactivated`,
  never carrying the token or its hash.

## Options considered

| Option | For | Against |
|---|---|---|
| Opaque random tokens with a prefix and checksum, hashed (chosen) | Revocable at once; leaked ones findable by scanners; one indexed lookup | A database read per request (the same as sessions) |
| Signed JWTs | No lookup | Revocation needs a deny list anyway; long-lived JWTs are hard to retire |
| Scopes per route group (`tickets:read`, ...) | Finer control | The API is young; three scopes cover IAM-007 and finer ones can be added as more names in the same column |
| Service accounts as a separate table | Clean separation | Groups, grants, authorization and attribution would all need a second principal kind |
| Self-rotation with the token itself | Fully automatic renewal | A leaked token could keep itself alive forever; rotation stays with people and administrators |

## Consequences

Programs get the same permission model as people, and administrators get one place to see
and end every credential. The scope list must grow with every new administration area (the
fitness test and the authz fallback catch omissions). Finer scopes, token use per address in
the audit log (M1-003) and email reminders (M1-057) build on this table. OAuth access tokens
for cross-site frontends (ADR-032) will be a second bearer kind, told apart by their prefix.
