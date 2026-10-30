---
title: "Permissions and access"
audience: admins
sources: apps/server/src/authz/permissions.ts, apps/server/src/authz/authorizer.ts, apps/server/src/authz/visibility.ts, apps/server/src/routes/authz.ts, apps/server/src/routes/visibility.ts, apps/server/src/routes/tracks.ts, apps/server/src/routes/rich-text.ts, apps/server/src/routes/saved-searches.ts, apps/server/src/routes/bulk.ts, apps/server/src/routes/dashboards.ts, apps/server/src/sharing/shares.ts, apps/server/src/guardrails/model.ts, apps/server/src/auth.ts, packages/db/src/migrations/0004_authorization.ts, packages/db/src/migrations/0029_visibility_levels.ts, apps/web/src/permissions/PermissionsPage.tsx, apps/web/src/configuration/TracksAdminPage.tsx, apps/web/src/admin/SettingsPage.tsx, apps/web/src/dashboards/DashboardPage.tsx, apps/web/src/search/SavedSearchBar.tsx, apps/web/src/tickets/view/TicketPage.tsx, apps/web/src/i18n/messages.en.ts, docs/adr/0012-authorization-engine.md, docs/adr/0051-configuration-guardrails.md, docs/specs/05a-administration-security-and-self-hosting.md, apps/server/src/network/allowlist.ts, apps/server/src/routes/ip-allowlist.ts, apps/web/src/admin/NetworkAccessPage.tsx
accessed: 2026-10-30
attestation: own-words
---
# Permissions and access

Three layers decide what a person may do in Taskmoor:

- **Global permissions** apply everywhere: running the site, changing configuration, sharing,
  bulk changes.
- **Track permissions** come from the track's **access policy**, which gives each permission
  to track roles, groups, people and others.
- **Visibility levels** hide single tickets from everyone who is not a member of the level.

Groups and people are managed on [People and groups](people-and-groups.md).

## Where to find it

- **Settings** > **Permissions** (`#/admin/permissions`) has three parts: **Roles**,
  **Access policies** and **Global permissions**.
- **Settings** > **Tracks** > **Manage** shows "Who does what in" the track: the people and
  groups in each role.
- Visibility policies and the permission explainer have no page yet; they are in the API.

The **Administration** part of **Settings**, and most administration pages, are for site
administrators only. Configuration administrators do their work through the API for now.

## Site and configuration administrators

- A **site administrator** holds every global permission and every track permission in every
  track. A person becomes one through the flag on the **People** page, or through the global
  permission **Run the site** given to them or to one of their groups.
- A **configuration administrator** holds **Change configuration**. They manage roles, access
  policies, visibility policies, workflows, workflow maps, ticket types, layouts and the other
  shared configuration, and hold **Run the track**, **Change screens and layouts**,
  **Edit workflows** and **See the workflow** in every track. They do not manage people,
  groups or global permissions.
- Neither can go to **Anyone signed in**: "Administration cannot go to everyone."
- An API token without the `admin` scope acts without the owner's administrator permissions.

## Global permissions

On **Global permissions**, **Give a global permission** to **A group**, **A person** or
**Anyone signed in**; **Remove** takes it back.

| Permission | Code | What it allows | Given by default to |
|---|---|---|---|
| **Run the site** | `site_admin` | Everything, see above | (the flag on the first account) |
| **Change configuration** | `configuration_admin` | Configuration, see above | Nobody |
| **See people and groups** | `browse_users` | Look people up, for example to mention them | Anyone signed in |
| **Share saved searches** | `share_saved_searches` | Share saved searches and dashboards beyond "only me" | Anyone signed in |
| **Subscribe groups to searches** | `manage_group_subscriptions` | Subscribe a group to a saved search | Nobody |
| **Change many tickets at once** | `bulk_change` | Bulk operations | Anyone signed in |
| **Create tracks with their own configuration** | `create_local_tracks` | Create local-mode tracks | Anyone signed in |

The list also holds **Manage onboarding**, **Connect goals**, **Manage automation**,
**Manage AI features** and **Manage extensions**. They belong to features that are not built
yet, and nothing checks them today.

## Track roles

A role names what people do in a track. Roles are shared by every track; each track says who
holds them. New installs have three:

| Role | Description |
|---|---|
| **Administrators** | Run the track: configuration, members and everything in it |
| **Members** | Do the work: create, edit, move and close tickets |
| **Viewers** | Read and comment |

Under **Roles**, **Add a role** asks for a **Role name** and **What the role does**. **Change**
renames, **Delete** removes a role no policy uses.

To put people in a role, open **Settings** > **Tracks**, **Manage** the track, choose the
**Role**, then **Give the role to a person** or **Give the role to a group**. Anyone with
**Run the track** in that track may do this.

## Access policies

Every track uses one access policy. New shared-mode tracks use the policy marked **Default**
("Default access policy" on a new install). A local-mode track gets its own copy, which its
own administrators may change.

A policy is a list of grants: a permission and who gets it.

| Grantee | Shown as |
|---|---|
| A track role | **Role** name |
| A group | **Group** name |
| A person | Their name |
| The track's owner | **The track owner** |
| Every signed-in person | **Anyone signed in** |
| Everyone, also anonymous visitors | **Anyone, signed in or not** |
| The ticket's requester | **The requester** |
| The ticket's assignee | **The assignee** |
| People in a user field of the ticket | **People in field** (API only) |
| Groups in a group field of the ticket | **Groups in field** (API only) |

The last four are decided per ticket: they grant on tickets that name the person, never on
the whole track.

To work with policies under **Access policies**:

1. **Add an access policy**: give a **Policy name** and **Start from** another policy's
   grants, or **No grants**.
2. **Manage** a policy to see its grants by permission and the tracks it is **Used by**.
3. **Give a permission**: choose the **Permission** and who it goes **To**, then **Give**.
   **Remove** takes a grant away.
4. **Delete policy** works only when no track uses it.

One permission may go to at most 50 grantees in one policy. The **Guardrails** page changes
that limit (`grants_per_permission`).

A shared-mode track switches policy with `PATCH /api/v1/tracks/:id` and `accessPolicyId`, by a
site or configuration administrator.

### Track permissions

| Group | Permissions |
|---|---|
| Administration | **Run the track**, **Change screens and layouts**, **Edit workflows** |
| Track | **See the track**, **Manage sprints**, **Answer service requests**, **See reports**, **See development links**, **See the workflow** |
| Tickets | **Archive tickets**, **Be given tickets**, **Give tickets to people**, **Close tickets**, **Create tickets**, **Delete tickets**, **Edit tickets**, **Link tickets**, **Change the requester**, **Move tickets**, **Set the close reason**, **Set due dates**, **Set visibility levels**, **Move tickets through the workflow**, **Restore archived tickets**, **Send tickets by email** |
| Followers | **Manage followers**, **See voters and followers** |
| Comments | **Add comments**, **Delete any comment**, **Delete own comments**, **Edit any comment**, **Edit own comments** |
| Attachments | **Add attachments**, **Delete any attachment**, **Delete own attachments** |
| Time | **Log time**, **Edit any time entry**, **Edit own time entries**, **Delete any time entry**, **Delete own time entries** |

In the default policy, **Viewers** see the track, its reports, its workflow, voters and
followers, and add, edit and delete their own comments. **Members** get the everyday work on
top. **Administrators** get what members get plus the administration permissions, deleting,
archiving and restoring tickets, and changing anyone's comments, attachments and time entries.
Nobody gets **Answer service requests** by default. The track owner may see and run their
track.

## Visibility levels

A visibility policy holds levels, such as "Internal" or "Security", and may name a default
level. Each level has members, of any grantee kind in the table above. A track uses one
visibility policy, or none.

- A ticket without a level is visible to everyone who sees its track.
- A ticket with a level is visible only to people who see its track and are members of the
  level. **This applies to site administrators too**: one who is not a member does not see the
  ticket. They may add themselves to the level; the audit log records it.
- A ticket a person cannot see answers "not found" everywhere, as if it did not exist, also in
  search, lists and counts.
- Choosing a level needs **Set visibility levels**. A new ticket without one takes the
  policy's default. A moved ticket takes the target track's default.
- A track that changes policy gives tickets at levels the new policy lacks its default. A level
  still in use is deleted only with a replacement level (or none).
- A policy holds up to 50 levels by default (guardrail `visibility_levels_per_track`).

The ticket view shows **Visibility level** ("Everyone" when there is none). Policies and levels
are managed through the API:

| Method and path | What it does |
|---|---|
| `GET`, `POST /api/v1/visibility-policies` | List or create policies (`trackId` for a local-mode track's own) |
| `GET`, `PATCH`, `DELETE /api/v1/visibility-policies/:id` | Read, change (name, `defaultLevelId`) or delete |
| `POST /api/v1/visibility-policies/:id/levels` | Add a level |
| `PATCH`, `DELETE /api/v1/visibility-policies/:id/levels/:levelId` | Change or delete a level (`?replaceWith=<id>` or `none`) |
| `POST .../levels/:levelId/members` | Add a member |
| `DELETE .../levels/:levelId/members/:memberId` | Remove a member |
| `PATCH /api/v1/tracks/:id` with `visibilityPolicyId` | Choose a track's policy (`null` for none) |

## Archived and trashed tracks

An archived track is read-only for everyone, site administrators included: only the read
permissions hold there. A track in the trash grants nothing to anyone until it is restored.

## Sharing dashboards and saved searches

A dashboard or saved search is private to its owner until shared. Sharing it beyond "only me"
needs **Share saved searches**. A share can reach:

- a person, a group, or the people of a track (optionally only one role there);
- everyone signed in;
- the public, also without signing in.

Sharing with a track needs permission to see that track. In the web app, **Who sees this
saved search** and **Who sees it** (dashboards) offer **Only me**, **Everyone signed in** and
**Anyone, also without signing in** (**Anyone, signed in or not** for dashboards). Shares with
people, groups and tracks are made through the API for now. See
[Dashboards and reports](../use/dashboards-and-reports.md) and
[Search](../use/search.md).

## How Taskmoor decides

For a person and a track, Taskmoor computes every permission they hold there in one step:

1. A deactivated person holds nothing. An anonymous visitor holds only what is given to
   **Anyone, signed in or not**.
2. A site administrator holds everything (only the read permissions in an archived track,
   nothing in the trash).
3. Otherwise the person holds each permission the track's access policy gives to them, to a
   group they are in (nested groups included), to a role they or their groups hold in the
   track, to the track owner if they own it, or to anyone.
4. A configuration administrator adds the four configuration permissions.
5. For one ticket, the per-ticket grantees are added, then the ticket's visibility level must
   let the person in.

Answers are cached and dropped whenever grants, roles, memberships, nesting, policies or the
administrator flag change, so a removed permission stops working at the next request.

## Asking why: the explainer

A site administrator can ask why someone may or may not do something:

```http
GET /api/v1/permissions/explain?userId=42&trackId=7&permission=edit_tickets
```

Use `ticket=PAY-12` instead of `trackId` for one ticket, and leave out `userId` to ask about an
anonymous visitor. The answer says whether it is `allowed` and lists the `reasons`: site or
configuration administration, or the grants (with their role or group) that allowed it. It
also flags an archived or trashed track and the per-ticket grants that might apply. For a
ticket it adds its visibility level, whether the person is a member, and the members that let
them in.

Anyone can ask about themselves: `GET /api/v1/me/permissions?trackId=7` lists their global
permissions and their permissions in the track. `GET /api/v1/permissions/catalogue` lists
every permission code and grantee kind.

## Network access: the IP allowlist

**Settings**, **Network access** limits where people may connect from. With **Only allow these
addresses** on, the web app this server serves and every API, administration and MCP included,
answer only requests from the addresses and ranges listed: one per line, an IPv4 or IPv6
address or a range such as `203.0.113.0/24` or `2001:db8::/32`, with a note after `#` if you
like. There is no limit on how many. Everyone else gets `403 ip_not_allowed`, signing in
included. Members of the groups under **Allowed from anywhere** get in from any address once
signed in, for people who travel. The health probes `/health` and `/ready` always answer.

The page shows the address you are connecting from and whether the list lets it in. Saving a
list that would not let you in asks you to confirm with **Save and lock me out**, so a typo
cannot lock out the person making the change; the API answers `409 would_lock_you_out` unless
the request says `"confirmLockout": true`. Each change is in the audit log, with what was
added and removed.

Behind a reverse proxy, set `TASKMOOR_TRUSTED_PROXIES` so the list sees the real client address
rather than the proxy's ([configuration](configuration.md)). A frontend kit on a static host
outside this server is not covered (its files are public), but everything it asks the API is.
Through the API: `GET` and `PUT /api/v1/admin/ip-allowlist`, with `enabled`, `entries`
(`range` and `note`) and `exemptGroupIds`.

If you lock yourself out, turn the list off from the server itself:

```bash
docker compose exec taskmoor node cli.mjs allowlist-off
```

