---
title: "LDAP directories"
audience: admins
sources: apps/server/src/routes/directories.ts, apps/server/src/routes/session.ts, apps/server/src/routes/users.ts, apps/server/src/routes/groups.ts, apps/server/src/routes/account.ts, apps/server/src/ldap/settings.ts, apps/server/src/ldap/sync.ts, apps/server/src/ldap/scheduler.ts, apps/server/src/ldap/gateway.ts, apps/server/src/ldap/accounts.ts, apps/server/src/ldap/nesting.ts, packages/db/src/migrations/0021_ldap.ts, apps/web/src/directories/DirectoriesPage.tsx, apps/web/src/directories/DirectoryForm.tsx, apps/web/src/i18n/messages.en.ts, docs/adr/0019-identity.md, docs/specs/05a-administration-security-and-self-hosting.md, apps/server/src/authz/create-tracks.ts, docs/adr/0118-track-invitations.md, apps/web/src/shell/DangerAction.tsx
accessed: 2026-11-14
attestation: own-words
---
# LDAP directories

Taskmoor reads people and groups from LDAP directories, Active Directory included, on a
schedule, and signs people in with their directory password. A person disabled or removed in
the directory is deactivated at the next sync and keeps everything they did. You can connect
several directories.

## Before you start

- You need a service account in the directory that can read people and groups (and write them,
  for a read-and-write directory), and its distinguished name (DN) and password.
- Taskmoor must reach the directory over TLS: an `ldaps://` URL, or an `ldap://` URL upgraded
  with StartTLS. Plain LDAP is accepted only on the loopback interface, or anywhere when
  `TASKMOOR_LDAP_ALLOW_PLAIN=true`, which is meant for tests.
- People sign in with their **email address** and their directory password. An entry without
  an email address is skipped.

Directories are on **Administration** > **LDAP and Active Directory** (`#/admin/directories`), for
site administrators. With no directory yet the list says so: people and groups are managed in
Taskmoor until you connect one.

## Adding a directory

Select **New directory** and fill in the form:

| Section | Field | Notes |
|---|---|---|
| | **Kind of directory** | **Active Directory**, **OpenLDAP** or **Other LDAP server**; sets the defaults below |
| | **Name** | For administrators, such as "Head office" |
| **Connection** | **URL** | `ldaps://host:636`, or `ldap://host:389` with StartTLS; no path |
| | **Upgrade to TLS with StartTLS** | For `ldap://` URLs only |
| | **CA certificates to trust** | Blank uses the server's trusted authorities; otherwise paste the CA certificate in PEM |
| **Service account** | **Bind DN** | Such as `CN=Taskmoor,OU=Services,DC=example,DC=com` |
| | **Password** | Stored encrypted and never shown again; blank in an edit keeps it |
| **What to read** | **Base DN** | Where the directory starts, such as `DC=example,DC=com` |
| | **People under**, **Groups under** | Blank means the base DN |
| | **People filter**, **Groups filter** | One LDAP filter in parentheses each |
| **Attribute names** | | Blank uses the default for the kind |
| **Changes made in Taskmoor** | **Read only** or **Read and write** | See below; read only by default |
| **Schedule** | **Minutes between syncs** | 5 to 1,440; default 60 |
| | **Hours between full syncs** | 1 to 720; default 24 |
| | **Enabled** | A disabled directory does not sync, and its people cannot sign in with a password |

Select **Test connection** to try the settings before saving, then **Add directory**. The first
sync starts shortly.

TLS connections need TLS 1.2 or later, and the certificate must name the host in the URL.

## Defaults per kind

| Attribute | Active Directory | OpenLDAP and other servers |
|---|---|---|
| **Identifier** | `objectGUID` | `entryUUID` |
| **User name** | `sAMAccountName` | `uid` |
| **Email** | `mail` | `mail` |
| **Email when empty** | `userPrincipalName` | (none) |
| **Display name**, **Given name**, **Surname** | `displayName`, `givenName`, `sn` | `displayName`, `givenName`, `sn` |
| **Changed marker** | `uSNChanged` | `modifyTimestamp` |
| **Group name**, **Group members** | `cn`, `member` | `cn`, `member` |

The default filters:

```text
Active Directory   people  (&(objectCategory=person)(objectClass=user))
                   groups  (objectClass=group)
Other kinds        people  (objectClass=inetOrgPerson)
                   groups  (|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames))
```

How a disabled person is recognised:

- **Active Directory**: the account-disabled bit of `userAccountControl`.
- **OpenLDAP**: the password policy's administrative lock (`pwdAccountLockedTime` set to
  `000001010000Z`). A lock after failed sign-ins is not a disable.
- **Other LDAP server**: write the people filter so it leaves disabled people out; they are
  then treated as removed.

## Testing the connection

**Test connection** connects, binds as the service account and reads up to a thousand people
and groups, without saving anything. On an existing directory it reuses the saved password.

| Result | What to check |
|---|---|
| "Connected. ... match the filters." | Nothing; the counts show what the filters find |
| The directory could not be reached | The URL, and that this server can reach the host |
| The secure connection failed | The certificate is not trusted or does not name the host: paste the CA certificate |
| The directory refused the service account | The bind DN and password |
| The saved password cannot be read any more | Enter the password again |
| The directory refused the search | The base DNs and the filters |

## How people are matched

- Taskmoor follows each entry by its identifier, so renames and moves keep the same account.
- A new entry links the existing account with the same email address, or creates an account
  without a password. Linking clears any local password: from then on the directory checks it.
- Service accounts, break-glass accounts and accounts a directory earlier in the order manages
  are never taken over.
- A person deleted and created again in the directory (a new identifier, the same address) gets
  their old account back.

## Groups and nesting

The groups a directory syncs belong to it. Members and groups inside groups follow the
directory, at any depth, and count in Taskmoor like any nested group. If a group name is
already taken in Taskmoor, the synced group gets the directory's name after it. Members outside
the filters are ignored. A group that leaves the directory is deleted.

Directories may contain nesting loops; Taskmoor groups may not. The sync leaves out the link
that would close a loop, the same one every time, and warns about it.

## Synchronisation

Each directory syncs every **Minutes between syncs**, reading only what changed, and in full
every **Hours between full syncs**. A full sync also runs first, after you change what is read
(URL, bind DN, base DNs, filters, attribute names), and when Taskmoor cannot continue from
where it stopped.

Every sync also reads the identifiers of everything in scope, so it notices removals and people
who left a filter. On servers other than Active Directory, the changed-since search relies on
clocks agreeing within ten minutes; the regular full sync catches anything a wrong clock hides.

Each directory in the list shows how many accounts and groups it manages, its schedule, and
its last and next sync. Its buttons:

- **Sync now** asks for a sync of changes; **Full sync** reads everything. A request while one
  is waiting joins it.
- **History** shows recent syncs: what was created, linked, updated, deactivated, reactivated
  or removed, and any warnings, such as entries skipped for having no email address or one
  another account holds.

Syncs run in the server's worker role, one at a time per directory. A sync whose worker stops
fails and the next one tries again.

### The safety stop

A sync that would remove more than half of a directory's people or groups (when it has ten or
more) stops before changing anything, because a broken filter must not deactivate everyone.
The history says so. If the removals are right, select **Sync and remove**, in the danger
colour. It asks first, saying how many people or groups the full sync will remove and what
happens to them: people are deactivated and keep their work, and groups are deleted, which
cannot be undone. Whichever the stop counted, the question also says what happens to the other.
Its answer, **Sync** *directory* **and remove what left it**, runs the full
sync that confirms them; **Cancel** leaves everything as it is.

## Signing in through a directory

For an account a directory manages, Taskmoor binds to the directory as the person's DN with the
typed password, and the directory decides, with its own lockout and expiry. The DN comes from
the sync, never from what was typed, and an empty password is refused.

- Taskmoor's own lockout, two-factor policy and single sign-on enforcement still apply.
- If the directory cannot be reached, or is disabled, the sign-in fails as a wrong password
  would, without counting a failure. The audit log records `directory_unavailable`.
- Break-glass accounts are never linked to a directory, so they keep working when it does not.
- Taskmoor does not create accounts at a first directory sign-in: a person appears after a
  sync.

## Read only or read and write

| | **Read only** | **Read and write** |
|---|---|---|
| Passwords | Changed only in the directory | A change in Taskmoor is written to the directory |
| Name and email | Changed only in the directory | Written to the directory |
| Group members and nested groups | Changed only in the directory | Written to the directory (same directory only) |
| Password links, break-glass | Refused | Refused |
| Renaming or deleting a synced group | Refused | Refused |

In read-only mode, Taskmoor refuses these changes ("A directory keeps this person: change them
there.") because the next sync would undo them. Creating, renaming and deleting entries always
happen in the directory. Active Directory accepts password changes only over TLS. Time zone,
language and site administration are Taskmoor's in both modes.

## Removed and disabled people

A person disabled in the directory, removed from it, or no longer matching the people filter
is deactivated at the next sync, and their sessions end. Their account and work stay. A
permission to create tracks that came with a role that runs a track goes, as with any
deactivation ([Letting a manager create tracks](invitations.md#letting-a-manager-create-tracks)),
and does not come back with the account. When the
entry comes back, the account is reactivated, but only if the sync deactivated it: a
deactivation by an administrator stands. A sync never deactivates a break-glass account or the
last active site administrator; it warns instead.

## Several directories

Directories are listed in order; **Move up** and **Move down** change it. When two directories
hold the same email address, the first one manages that account.

## Deleting a directory

**Delete**, in the danger colour, first says what will happen, with the number of accounts.
It deactivates every account the directory manages and ends their sessions; their work
stays. Its groups stay as ordinary Taskmoor groups. Deleting is refused while the directory
manages the last active site administrator: make another account a site administrator first.

## API reference

All routes need a site administrator.

| Method and path | What it does |
|---|---|
| `GET`, `POST /api/v1/directories` | List or add directories |
| `GET`, `PATCH`, `DELETE /api/v1/directories/:id` | Read, change or delete one |
| `PUT /api/v1/directories/order` | Set the order (`{"ids": [...]}`, every directory once) |
| `POST /api/v1/directories/test` | Test settings without saving (`id` reuses a saved password) |
| `POST /api/v1/directories/:id/sync` | Ask for a sync (`mode`: `incremental` or `full`; `confirmRemovals`) |
| `GET /api/v1/directories/:id/runs` | Recent syncs |
