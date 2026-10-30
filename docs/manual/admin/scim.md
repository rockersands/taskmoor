---
title: "SCIM provisioning"
audience: admins
sources: apps/server/src/routes/scim.ts, apps/server/src/scim/schemas.ts, apps/server/src/scim/filter.ts, apps/server/src/scim/patch.ts, apps/server/src/scim/store.ts, apps/server/src/scim/resource.ts, apps/server/src/scim/errors.ts, apps/server/src/tokens/scopes.ts, apps/server/src/tokens/bearer.ts, apps/server/src/routes/tokens.ts, apps/server/src/sso/sign-in.ts, packages/db/src/migrations/0012_scim.ts, apps/web/src/i18n/messages.en.ts, docs/adr/0038-scim-provisioning.md, docs/adr/0035-api-tokens-and-service-accounts.md, docs/adr/0019-identity.md, docs/specs/05a-administration-security-and-self-hosting.md, https://www.rfc-editor.org/rfc/rfc7643, https://www.rfc-editor.org/rfc/rfc7644
accessed: 2026-10-30
attestation: own-words
---
# SCIM provisioning

Identity providers such as Microsoft Entra ID and Okta can create, update, deactivate and
group people in Taskmoor through SCIM 2.0, the standard of
[RFC 7643](https://www.rfc-editor.org/rfc/rfc7643) (resources) and
[RFC 7644](https://www.rfc-editor.org/rfc/rfc7644) (protocol). SCIM is included in every
install.

## How access works

An identity provider connects as a **service account** with a token that holds the
**SCIM provisioning** scope (`scim`).

- The `scim` scope is held alone: a token with it has no other scope.
- Only service accounts hold it, and only a site administrator gives it. A person's own token
  cannot have it.
- That token reaches the SCIM service and nothing else. No other token, and no browser
  session, reaches the SCIM service: other tokens get 403 `insufficient_scope`.
- Changes the provider makes are recorded in the audit log under the service account's name.

## Setting it up

1. Open **Settings** > **Service accounts** and create one for the provider, for example
   "Entra ID provisioning". See [API tokens and service accounts](api-tokens.md).
2. Show its **Tokens** and make a new token. Choose **SCIM provisioning**, which clears the
   other scopes, and an expiry. Copy the token: it is shown once.
3. In the identity provider, set the SCIM base URL (often called the tenant URL) to:

   ```text
   https://taskmoor.example.com/api/v1/scim/v2
   ```

   and the secret token to the token you copied. The provider sends it as
   `Authorization: Bearer <token>`.
4. Set up [single sign-on](sso.md) with the same provider for the same email domains, so the
   people it provisions can sign in.
5. Before the token expires, rotate it on the service account and give the provider the new
   one; the old token keeps working for the overlap you choose.

## Endpoints

All addresses are under `PUBLIC_URL/api/v1/scim/v2`. Every answer, errors included, is
`application/scim+json`.

| Method and path | What it does |
|---|---|
| `GET /ServiceProviderConfig` | What the service supports |
| `GET /ResourceTypes`, `GET /ResourceTypes/:id` | The `User` and `Group` resource types |
| `GET /Schemas`, `GET /Schemas/:id` | The schemas, with the enterprise user extension |
| `GET /Users`, `GET /Groups` | List, with `filter`, `startIndex`, `count`, `attributes`, `excludedAttributes` |
| `GET /Users/:id`, `GET /Groups/:id` | Read one |
| `POST /Users`, `POST /Groups` | Create |
| `PUT /Users/:id`, `PUT /Groups/:id` | Replace |
| `PATCH /Users/:id`, `PATCH /Groups/:id` | Change with PATCH operations |
| `DELETE /Users/:id`, `DELETE /Groups/:id` | Deprovision a person, delete a group |

Not offered: bulk operations, sorting, password changes and ETags.
`/ServiceProviderConfig` says so, and lists bearer tokens as the authentication scheme.

## Users

A SCIM user is a person's Taskmoor account. Taskmoor uses these attributes and keeps every
other attribute the provider sends (name parts, phone numbers, addresses, the enterprise
extension), so the provider reads back what it wrote.

| Taskmoor | From the SCIM user |
|---|---|
| Email | The primary entry of `emails`, else the `work` one, else the first, else `userName` when it is an address |
| Name | `displayName`, else `name.formatted`, else `name.givenName` and `name.familyName`, else `userName` |
| Active | `active` (true unless it says false) |
| Language | `locale` |
| Time zone | `timezone` |

`userName` is required and unique. Taskmoor never stores a password a provider sends:
provisioned people sign in through single sign-on, or with a password link an administrator
makes.

### Matching people who already have an account

Every person is visible to SCIM, with their email as `userName` until a provider sets another.
Service accounts are never visible. To take over an existing account, the provider first looks
it up with a filter such as `userName eq "ana@example.com"`, then updates it. Creating a user
whose `userName` or email another account already holds is refused with `uniqueness`.

## Groups

SCIM manages only the groups it created. Groups made in Taskmoor are invisible to it, and their
names are taken, so a provider can never add itself to a group an administrator gave
permissions to. Creating a group with a taken name is refused with `uniqueness`; rename the
Taskmoor group, or let the provider create its own and give that one the permissions.

A group's `displayName` is its name, and its `members` are people SCIM can see. Groups nested
inside a SCIM group in Taskmoor stay as they are, whatever the provider sends. `DELETE` deletes
the group; its members' accounts stay.

## Filtering and paging

Filters follow RFC 7644: comparisons `eq`, `ne`, `co`, `sw`, `ew`, `gt`, `ge`, `lt`, `le`,
presence `pr`, `and`, `or`, `not`, parentheses, and value paths such as
`emails[type eq "work"].value eq "ana@example.com"`. Attribute names are matched without regard
to case; an unknown attribute is an `invalidFilter` error.

Lists start at `startIndex` 1, return 100 results by default and at most 200 per page; values
out of range are read as the nearest allowed one.

## PATCH

`add`, `replace` and `remove` operations apply in order; a request changes everything or
nothing. Taskmoor also accepts the shapes providers send where the RFC leaves room: operation
names in any letter case, booleans as strings (`"False"`), a value path that creates the value
it names, members removed by value list or by filter, a bare id for the enterprise `manager`,
and read-only attributes inside a path-less value, which are ignored.

## Deprovisioning

- `active: false` (by PUT or PATCH) deactivates the account and ends its sessions. `active:
  true` reactivates it.
- `DELETE /Users/:id` deactivates the account, ends its sessions and hides it from SCIM.
- In both cases the account and everything the person did stay in Taskmoor. After a `DELETE`,
  creating a user with the same email again brings the same account back.
- Break-glass accounts and the last active site administrator cannot be deactivated or deleted
  through SCIM; the request is refused with `mutability`. They are how administrators get in
  when the provider fails.

## Errors

Errors use the SCIM error message with a `status`, a `detail` and, where it applies, a
`scimType`:

| Status | `scimType` | Typical cause |
|---|---|---|
| 400 | `invalidFilter` | A filter that cannot be parsed or names an unknown attribute |
| 400 | `invalidValue`, `invalidSyntax`, `invalidPath`, `noTarget` | A body or PATCH path Taskmoor cannot use |
| 400 | `mutability` | Deactivating a break-glass account or the last site administrator |
| 404 | | No such user or group, or one SCIM cannot see |
| 409 | `uniqueness` | A `userName`, email or group name already taken |

## Single sign-on and directories

SCIM creates and updates accounts; it does not sign anyone in. When a provisioned person first
signs in through single sign-on, the provider's sign-in links their existing account by email
address, as long as the address is in one of the provider's domains (see
[Single sign-on](sso.md)). Keep **Create accounts at a first sign-in** off on that provider if
SCIM should be the only way accounts are made.

Taskmoor does not stop SCIM and an [LDAP directory](ldap.md) from both managing the same
person; use one source per person.

## Audit

Each request that changes something emits one event, all recorded in the audit log:
`scim.user_created`, `scim.user_updated`, `scim.user_removed`, `scim.group_created`,
`scim.group_updated` and `scim.group_deleted`.
