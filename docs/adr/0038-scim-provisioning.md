# ADR-038: SCIM provisioning through a service account's scim token

- Status: Accepted
- Date: 2026-10-28
- Backlog: M1-083

## Context

Identity providers create, update, deactivate and group people in the applications they serve
through SCIM 2.0 (RFC 7643 and 7644). IAM-006 asks for users and groups with PATCH, the Entra
ID and Okta provisioning suites passing, and a deprovisioned person deactivated rather than
deleted, keeping authorship. ADR-019 put SCIM in the free identity stack; ADR-035 gave
programs service accounts with scoped tokens. A provider that can change accounts and groups
can also lock people out or raise their rights, so what it may reach has to be narrow.

## Decision

- **The client is a service account holding a token with the `scim` scope** (migration 0012).
  The scope is held alone (a database check and the API both refuse it beside another), only
  site administrators issue it, and only to service accounts: a person's own token cannot
  have it. It reaches `/api/v1/scim/v2` and nothing else, and nothing else reaches SCIM: other
  tokens get `insufficient_scope`, browser sessions 401. Its events name the service account.
- **Users are people's accounts.** Email, display name, locale, time zone and active state are
  `app_user` columns, so the rest of Taskmoor sees what the provider set; userName, externalId
  and every other attribute (name parts, phone numbers, addresses, the enterprise extension)
  are kept in `scim_user` so the provider reads back what it wrote. The account email is the
  primary email, else the work one, else the userName when it is an address. Every person is
  visible, with the email as userName until a provider sets one, so a provider can match
  existing accounts with `userName eq`. Service accounts are never visible. Passwords sent by
  a provider are never stored: provisioned people sign in through single sign-on.
- **Deprovisioning deactivates.** `active` false deactivates the account and ends its sessions;
  DELETE does the same and hides the account from SCIM (`scim_user.removed_at`). The account
  and its work stay (IAM-006 (2)); provisioning its email again brings the same account back.
  Break-glass accounts and the last active site administrator cannot be deactivated or
  removed through SCIM: they are how people get in when the provider fails.
- **Groups are the ones the provider created** (`scim_group`). Groups made in Taskmoor are
  invisible to SCIM and their names are taken, so a provider can never add itself to a group
  an administrator granted rights to. Members are people SCIM can see; members it cannot see
  (service accounts, nested groups) stay whatever the provider sends.
- **The protocol surface:** discovery (`/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`),
  list with filter, paging and attribute selection, read, create, replace and PATCH, delete.
  Bulk, sorting, password changes and ETags are not offered, and discovery says so. Errors use
  the SCIM error message with its `scimType`; every answer is `application/scim+json`.
- **Filters** are parsed against the schemas, so unknown attributes are an `invalidFilter`.
  Equality terms on userName, externalId, id, displayName and active narrow the list in SQL;
  the whole filter then decides on each candidate. Without a filter the list pages in SQL.
- **PATCH** works on the resource as the provider sees it and writes the result as a
  replacement, so every way to say a change ends in one code path. It takes the shapes
  providers send that the RFC leaves open: op names in any case, string booleans, a bare id
  for the manager, a value path that creates the value it names (Entra ID), members removed
  by value or by filter, a path-less object carrying read-only attributes (Okta).
- **Events:** `scim.user_created`, `.user_updated`, `.user_removed`, `.group_created`,
  `.group_updated` and `.group_deleted`, one per request that changes something, all audited.

## Evidence

`routes/scim.test.ts` is our own compliance suite over HTTP (access, discovery, users, groups,
deprovisioning, the guards); `routes/scim.idp.test.ts` replays synthetic request sequences in
the shapes Entra ID and Okta send (`testing/scim-idp.ts`); `scim/filter.test.ts` and
`scim/patch.test.ts` cover the parser (including 2,000 random inputs that may only produce a
filter or a SCIM error) and the PATCH rules. The providers' own validators need a public URL
and were not run; that is a step for a test instance.

## Options considered

| Option | For | Against |
|---|---|---|
| Service account with a scim-only token (chosen) | Reuses tokens, rotation, revocation and audit; narrow by construction | An administrator issues one more token |
| A separate SCIM secret per provider | Mirrors some products | A second credential system to store, rotate and audit |
| Admin-scoped tokens reach SCIM | No new scope | A provisioning credential could do everything an administrator can |
| SCIM sees and manages every group | Providers can link to existing groups | A provider could join administrator groups |

## Consequences

Linking a provider to an existing account works through `userName eq` with the email; linking
to an existing Taskmoor group does not (its name is taken), which an administrator settles by
renaming or by letting the provider create its own group. Filters without an equality term
read every visible person; that is fine for the directories of M1 and moves to SQL if a
large one needs it. Migration 0012 was reserved for this; a long-lived development database
that ran 0013 or 0014 first must be recreated (Kysely applies migrations in name order).
