---
title: "API tokens and service accounts"
audience: admins
sources: apps/server/src/tokens/api-tokens.ts, apps/server/src/tokens/bearer.ts, apps/server/src/tokens/scopes.ts, apps/server/src/routes/tokens.ts, apps/server/src/routes/service-accounts.ts, apps/server/src/routes/groups.ts, apps/server/src/routes/audit.ts, apps/server/src/audit/subscriber.ts, apps/server/src/app.ts, apps/server/src/config.ts, packages/iam/src/api-token.ts, packages/iam/src/throttle.ts, apps/web/src/tokens/TokenForm.tsx, apps/web/src/tokens/TokensSection.tsx, apps/web/src/tokens/AdminTokensPage.tsx, apps/web/src/tokens/ServiceAccountsPage.tsx, apps/web/src/tokens/format.ts, apps/web/src/account/AccountPage.tsx, apps/web/src/admin/SettingsPage.tsx, apps/web/src/i18n/messages.en.ts, docs/adr/0035-api-tokens-and-service-accounts.md, docs/specs/05a-administration-security-and-self-hosting.md, docs/specs/02a-platform-api-and-integrations.md, apps/server/src/ratelimit/limiter.ts, apps/server/src/routes/rate-limits.ts, apps/web/src/admin/ApiUsagePage.tsx, apps/web/src/admin/TableScroller.tsx, docs/adr/0075-rate-limits.md, apps/server/src/security/alerts.ts, docs/adr/0109-security-notices-and-alerts.md, apps/web/src/shell/DangerAction.tsx
accessed: 2026-11-13
attestation: own-words
---
# API tokens and service accounts

Programs call Taskmoor's API with API tokens. A person makes tokens for their own scripts; a
site administrator makes service accounts for programs that should not act as a person. This
page covers both, how a token is sent, what limits apply and what the audit log keeps.

## What a token is

- A token looks like `tmk_` followed by 46 letters and digits. The prefix lets secret scanners
  find a leaked token, and the last six characters are a checksum, so the server refuses
  look-alike text without a database lookup.
- Taskmoor shows a token once, when it is made. The database keeps only its SHA-256 hash, so
  nobody can read it back later, administrators included.
- Every token has a name, one or more scopes and an expiry date. There are no tokens that
  never expire.
- A token acts as its owner and never does more than the owner may. If the owner loses a
  permission, the token loses it too.

## Scopes

| Scope | Shown as | What it allows |
|---|---|---|
| `read` | **Read** | `GET` and `HEAD` requests, and the few `POST` requests that only read, such as a long search |
| `write` | **Write** | Every other method on ordinary routes: creating, changing and deleting |
| `admin` | **Administration** | Administration routes, whatever the method: people, groups, roles, access policies, service accounts, other people's tokens, sign-in security, identity providers, directories, the audit log, webhooks and everything under `/api/v1/admin` |
| `scim` | **SCIM provisioning** | Only the SCIM service at `/api/v1/scim/v2`, and nothing else |

Some rules sit on top of the table:

- A token without `admin` also leaves its owner's administrator permissions behind. A site
  administrator's `read` and `write` token acts like a token of an ordinary member, so an
  administration request made with it is refused even when the owner could make it in the
  browser.
- `scim` goes alone: a token that holds it holds no other scope. Only service accounts get
  it. See [SCIM provisioning](scim.md).
- No token reaches a person's own token routes (`/api/v1/account/tokens`), the password,
  sessions or second factors. Those need a signed-in browser, so a leaked token cannot rotate
  itself into a successor.

## Creating a personal token

1. Open **Settings**, then **Account**, and go to the **API tokens** section.
2. Under **New token**, fill in **Token name**. Say where the token is used, so you recognise
   it later.
3. Choose the **Scopes**. **Read** is ticked to begin with.
4. Choose how long it lasts in **Expires after**. The choices are 7, 30, 60, 90, 180 and 365
   days, cut to the site's longest lifetime; 30 days is the default.
5. Select **Create token**, then **Copy** the token. **This is the only time it is shown.**
   Select **Done** when it is stored in a password manager or in the program's secret store.

The Account page offers **Administration** to site administrators. Through the API, anyone
who holds an administrator permission (site, configuration, automation, AI or extension
administration) may ask for it; others get `scope_not_allowed`.

Each token in the list shows its status (**Active**, **Expired**, **Revoked** or **Replaced**),
its scopes, when it was created, when it was last used and from which address, and when it
expires. To stop a token, select **Revoke**. It stops working at once.

The Account page does not rotate tokens yet. Revoke the old token and create a new one, or call
`POST /api/v1/account/tokens/<id>/rotate` from a signed-in browser session (see
[Rotating a token](#rotating-a-token)).

## Service accounts

A service account is an account for a program, owned by the site rather than by a person.

- It has no password and never signs in, not through single sign-on either.
- It is not counted as a user and does not appear in the people list.
- Its address is made from its name in the reserved `service.invalid` domain, for example
  `build-server@service.invalid`. That domain can never receive mail.
- Groups, roles and grants apply to it as to a person, so you give it access the same way.
- It acts only through its own tokens. Deactivating it stops all of them at once;
  reactivating it brings back those that have not expired.

Only site administrators manage service accounts. Open **Administration**, then **Service
accounts**:

1. The list of accounts comes first. Select **New service account**, fill in **Name** and **What
   it is for**, then select **Create service account**. The form closes and the new account's
   tokens open.
2. In the list, select **Tokens** next to the account. The **New token** form is the same as
   on the Account page, with **Administration** and **SCIM provisioning** on offer.
3. Copy the new token when it is shown.

Because service accounts are not in the people list, add one to a group through the API:
`PUT /api/v1/groups/<group id>/members/<service account id>`. The service account's id is in
the answer of `GET /api/v1/service-accounts`. See [Permissions and access](permissions.md) for
what groups and roles grant.

To rename an account or change its description, use `PATCH /api/v1/service-accounts/<id>` with
`name` or `description`; the page does not edit them yet.

## Rotating a token

Rotating makes a successor with the same owner, name and scopes, and lets the old token keep
working for an overlap window, so a program can switch without downtime. The old token never
outlives its own expiry date. An overlap of zero stops it at once.

On the **Service accounts** page, open an account's tokens, choose **After rotating, the old
token keeps working for** (no time, 1, 24, 72 or 168 hours; 24 is the default) and select
**Rotate**. Copy the new token when it is shown.

Through the API the overlap can be anything from 0 to 720 hours:

```http
POST /api/v1/service-accounts/7/tokens/31/rotate
Authorization: Bearer <administrator token with the admin scope>
Content-Type: application/json

{ "overlapHours": 48 }
```

The answer holds the new `token` (shown once), its description as `apiToken`, and the old one
as `previous`. Without `expiresInDays` or `expiresAt`, the successor lasts as long as the old
token did, within today's policy. People rotate their own tokens with
`POST /api/v1/account/tokens/<id>/rotate` and the same body.

Administrators rotate and issue tokens only for service accounts. They never receive a secret
that acts as another person.

## The token inventory and policy

Site administrators see every token of the site on **Administration**, then **API tokens**.

- **Show** filters the list: **All tokens**, **Active**, **Due for rotation**, **Expired** or
  **Revoked**. A token is due for rotation when it is active, not yet replaced, and expires
  within the reminder window.
- **Revoke** next to a token, in the danger colour, first says what will happen: programs
  using it stop working at once, and a revoked token cannot be used again. **Revoke**, the
  token's name and its owner's, in that question, stops it; **Cancel** keeps it.
- **Revoke in bulk** handles a leak or a departure. Under **Which tokens**, choose **Every
  token of one owner**, **Tokens created before a date** or **Every token**, then **Revoke
  tokens**. Taskmoor first counts the active tokens that match and asks, as every destructive
  action does: **Confirm revocation** revokes them, **Cancel** or Escape goes back. Expired tokens are left as they are. While there is no token at all, the list says so
  and **Revoke in bulk** is not shown.
- **Token policy** sets the **Longest lifetime (days)** a new token may have (1 to 3,650,
  default 365) and the **Rotation reminder (days before expiry)** (1 to 90, default 14).
  Select **Save policy**. Lowering the lifetime does not shorten tokens that already exist.

Revoked and expired tokens stay in the inventory for 90 days, then they are removed.

Taskmoor does not yet email owners when a token is due for rotation; the list is the reminder.

| Task | API |
|---|---|
| List tokens | `GET /api/v1/admin/tokens?status=active&kind=service` (`status`: `active`, `expired`, `revoked`, `all`; also `ownerId`, `limit`, `offset`) |
| Due for rotation | `GET /api/v1/admin/tokens/expiring?withinDays=14` |
| Revoke one | `DELETE /api/v1/admin/tokens/<id>` |
| Revoke many | `POST /api/v1/admin/tokens/revoke` with `ownerId`, `createdBefore` (both narrow), or `"all": true`; `"dryRun": true` only counts |
| Read or set the policy | `GET` and `PUT /api/v1/admin/token-policy` with `maxLifetimeDays` and `reminderDays` |

## Creating a token through the API

A new token's body names it, gives its scopes and its expiry, as a number of days or as a
moment:

```json
{ "name": "nightly export", "scopes": ["read"], "expiresInDays": 90 }
```

Send it to `POST /api/v1/account/tokens` from a browser session for yourself, or to
`POST /api/v1/service-accounts/<id>/tokens` as an administrator. The answer is `201` with the
token and its description. A refused expiry answers `400` with `expiry_required` (neither or
both fields), `expiry_in_past` or `expiry_too_long` (with the `maxLifetimeDays` in force).

## Sending a token

Send the token in the `Authorization` header with the `Bearer` scheme:

```bash
curl -H "Authorization: Bearer $TASKMOOR_TOKEN" https://tracker.example.com/api/v1/tracks
```

When a request carries a bearer token, the server does not look at any session cookie.

| Answer | When |
|---|---|
| `401 invalid_token` | The token is unknown, expired or revoked, or its owner is deactivated. The body's `reason` says which (`unknown`, `expired`, `revoked`, `owner_deactivated`), and so does the `WWW-Authenticate` header |
| `403 insufficient_scope` | The route needs a scope the token lacks; `requiredScope` and the `WWW-Authenticate` header name it |
| `403 session_required` | The route needs a signed-in browser, such as managing your own tokens |
| `429 too_many_attempts` | Too many failed attempts from this address (below) |
| `429 rate_limited` | Over a rate limit; wait as `Retry-After` says (below) |

## Throttling and rate limits

Failed token attempts count per client address, apart from failed sign-ins. After 50 failures
within 15 minutes the address is locked for the rest of those 15 minutes, valid tokens
included. The answer is `429` with a `Retry-After` header and `retryAfterSeconds` in the body.
A broken script and a person mistyping a password therefore do not lock each other out.

Behind a reverse proxy, set `TASKMOOR_TRUSTED_PROXIES` so the count follows the real client
address rather than the proxy's; see [Configuration reference](configuration.md).

Every API request also counts against a rate limit: each token on its own, each signed-in
person with all their sessions together, and each address for requests with neither. A client
may send a burst of requests at once, then a steady number a second; changes to one ticket
have a limit of their own, whoever sends them. Over a limit the answer is `429 rate_limited`
with the `scope` that was reached (`token`, `user`, `address` or `ticket`), a `Retry-After`
header and `retryAfterSeconds`. Every answer carries `RateLimit-Limit`, `RateLimit-Remaining`
and `RateLimit-Reset` (seconds until the bucket is full again), so a script can slow down
before it is refused.

| Client | Requests a second | Burst |
|---|---|---|
| An API token | 50 | 200 |
| A signed-in person | 50 | 200 |
| An address without a session or token | 20 | 100 |
| Changes to one ticket | 10 | 40 |

Site administrators change these under **Administration**, **API usage and limits**, or with
`PUT /api/v1/admin/rate-limits`; the change is in the audit log. The same page lists the 20
clients with the most requests in the last hour or day, with their errors and refused
requests: a token by its name and owner, a person by name, an address as itself
(`GET /api/v1/admin/api-usage?window=hour`). On a phone each client is one block with its
figures beneath its name; on a wider screen a table that does not fit scrolls sideways, and the
keyboard can reach it with Tab. Each server process counts on its own, so with
several API processes a client may reach its limit once per process.

## What the audit log keeps

- Every change to tokens is an audit event: `token.created`, `token.revoked`, `token.rotated`,
  `token.bulk_revoked` and `token_policy.updated`, with who did it and from which address.
  Events never carry the token or its hash.
- Service accounts add `service_account.created`, `.updated`, `.deactivated` and
  `.reactivated`.
- What a program does with a token is recorded as its owner: audited events (such as
  configuration changes) and the ticket history name the owner, not the token.
- Each token remembers when and from which address it was last used. The time is written at
  most once a minute.
- A refused token is a `session.sign_in_failed` record with `method` `api_token` (or `basic`
  on the Jira-compatible API), the reason (`token_unknown`, `token_expired`, `token_revoked`,
  `token_owner_deactivated`) and, for a token Taskmoor knows, its id and owner; never the token.
  It counts towards the lockout above and the address alert rule (see
  [security alerts](people-and-groups.md#security-emails-and-alerts)). A token refused again and
  again (HTTP 403) is recorded in aggregate as `access.refused_repeatedly`.
- Tool calls through the [MCP server](mcp.md) are audited one by one.

Site administrators read the log with `GET /api/v1/audit?action=token.`; `action` matches an
event or the start of one, and `actor`, `subject`, `from` and `to` narrow it further. See
[Monitoring and logs](monitoring.md) for the audit log as a whole.
