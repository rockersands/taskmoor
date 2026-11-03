---
title: "People, groups and teams"
audience: admins
sources: apps/server/src/routes/users.ts, apps/server/src/routes/groups.ts, apps/server/src/routes/password-links.ts, apps/server/src/routes/session.ts, apps/server/src/routes/two-factor.ts, apps/server/src/routes/setup.ts, apps/server/src/two-factor.ts, apps/server/src/directory.ts, apps/server/src/auth.ts, apps/server/src/cli.ts, apps/server/src/tokens/bearer.ts, packages/iam/src/throttle.ts, packages/iam/src/policy.ts, packages/db/src/migrations/0003_identity.ts, apps/web/src/people/UsersPage.tsx, apps/web/src/people/GroupsPage.tsx, apps/web/src/people/client.ts, apps/server/src/routes/teams.ts, packages/db/src/migrations/0060_teams.ts, apps/web/src/people/TeamsPage.tsx, apps/web/src/people/teamsClient.ts, docs/adr/0076-teams.md, apps/web/src/admin/SecurityPage.tsx, apps/web/src/admin/SettingsPage.tsx, apps/web/src/account/SessionsSection.tsx, apps/web/src/i18n/messages.en.ts, docs/adr/0019-identity.md, docs/specs/05a-administration-security-and-self-hosting.md, apps/server/src/session-policy.ts, apps/web/src/admin/SessionPolicyForm.tsx, apps/server/src/security/alerts.ts, apps/server/src/security/notices.ts, apps/server/src/security/mail.ts, apps/server/src/security/refusals.ts, apps/server/src/routes/security-alerts.ts, apps/server/src/audit/record.ts, apps/web/src/admin/SecurityAlertsForm.tsx, docs/adr/0109-security-notices-and-alerts.md, apps/server/src/privacy/erase.ts, apps/server/src/privacy/export.ts, apps/server/src/routes/personal-data.ts, apps/server/src/audit/query.ts, apps/web/src/people/EraseUserForm.tsx, apps/web/src/account/PersonalDataSection.tsx, docs/adr/0111-personal-data-and-database-tls.md
accessed: 2026-11-02
attestation: own-words
---
# People, groups and teams

Site administrators manage the people who can sign in, the groups and teams they belong to, and
the rules for two-factor authentication. This page covers the people directory, password links,
deactivation, sessions, groups and teams. Permissions given to people and groups are on
[Permissions and access](permissions.md).

## Where to find it

Open **Settings**. The **Administration** part of the page appears only for site
administrators.

| Page | Address | What it does |
|---|---|---|
| **People** | `#/admin/users` | Add people, make site administrators, deactivate and reactivate, password links, download a person's data, erase a person |
| **Groups** | `#/admin/groups` | Create and delete groups, members, groups inside groups |
| **Teams** | `#/admin/teams` | Create, rename and delete teams, their members and lead |
| **Security** | `#/admin/security` | Who must use two-factor authentication, how long sign-ins last, and security alerts |
| **Service accounts** | `#/admin/service-accounts` | Accounts for programs: see [API tokens and service accounts](api-tokens.md) |
| **Single sign-on** | `#/admin/identity-providers` | See [Single sign-on](sso.md) |
| **LDAP and Active Directory** | `#/admin/directories` | See [LDAP directories](ldap.md) |

The account made during [first-run setup](first-run.md) is a site administrator. People can
also be [invited into a track](invitations.md), or arrive through [single sign-on](sso.md), a [directory sync](ldap.md) or
[SCIM provisioning](scim.md).

## The people directory

**People** lists everyone who can sign in. Service accounts are not people and have their own
list. For each person you see the name, the email, the date they last signed in, and a
**Site administrator** or **Deactivated** badge where it applies.

- **Find by name or email** narrows the list as you type.
- **Show** picks **Active people**, **Deactivated people** or **Everyone**.

## Adding a person

1. Select **Add a person**.
2. Fill in **Name** and **Email**. Tick **Site administrator** if the person should run the
   site.
3. Select **Add**.

Taskmoor shows a one-time link for the new person to set their password. Copy it and send it
to them: it works once, expires after three days and is shown only now. Select **Done** when
you have it. Taskmoor does not yet send the link by email.

Each email belongs to one account; a second account with the same address is refused with
"Someone already has that email."

Through the API, `POST /api/v1/users` takes `email`, `name`, `isSiteAdmin`, and optionally
`timeZone`, `locale` and `password`. With a password the account is ready at once and no link
is made; the password must meet the rules below.

## Password links

A password link lets a person choose a password. **New password link** on a person's row
makes one: an activation link for someone who never had a password, a reset link otherwise.

- A link works once and expires after three days. Making a new link cancels the person's
  earlier unused links.
- The person opens the link, chooses a password and is signed in. Every other session of
  theirs ends.
- Links cannot be made for deactivated people, nor for people a directory manages (their
  password lives in the directory: "A directory keeps this person: change them there.").
- Taskmoor has no self-service "forgot password" page yet. People ask an administrator for a
  link.

If no administrator can sign in, or the password keyring was lost, run the operator command
on the server (see [the operator CLI](cli.md)):

```bash
node cli.mjs password-link admin@example.com
```

### Password rules

- From 12 to 128 characters, any characters, no composition rules and no expiry.
- Refused: common passwords from breach lists, the same with digits or symbols added, repeated
  patterns and plain sequences, and passwords containing the person's name or email or the
  word "taskmoor".
- After five wrong passwords for one email, sign-in for that email waits 30 seconds, doubling
  with each further failure up to 15 minutes. One client address may fail 50 times in 15
  minutes. Behind a reverse proxy, set `TASKMOOR_TRUSTED_PROXIES` so the real client address
  is counted (see [the configuration reference](configuration.md)).

## Changing a person

- **Make site administrator** and **Remove site administrator** switch the flag. The last
  active site administrator cannot be removed: "This is the last site administrator: make
  someone else one first." Site administration can also come from a group, see
  [Permissions and access](permissions.md).
- The **People** page does not edit names or emails yet. Use `PATCH /api/v1/users/:id` with
  `name`, `email`, `timeZone`, `locale`, `isSiteAdmin` or `breakGlass`. People change their
  own name, time zone and language on their Account page (see [your account](../use/account.md)).
- `breakGlass: true` marks an account that may still sign in with a password where single
  sign-on is enforced. See [Single sign-on](sso.md).
- For people a directory manages, a read-only directory refuses name and email changes; a
  read-and-write directory takes them. See [LDAP directories](ldap.md).

## Deactivating and reactivating

**Deactivate** stops a person from using Taskmoor. Their account stays, and everything they
did stays attributed to them.

- All their sessions end at once and their unused password links stop working.
- They hold no permissions while deactivated, and their API tokens are refused.
- You cannot deactivate yourself, nor the last active site administrator.

**Reactivate** (shown with **Deactivated people** or **Everyone**) lets them sign in again
with the password they had. Their old sessions do not come back.

A directory sync and SCIM provisioning also deactivate people. Deactivation keeps their name
and email; to remove them, erase the person (below).

## A person's data: download and erasure

When someone asks for the data Taskmoor keeps about them, or asks to be forgotten, a site
administrator handles it on the **People** page. People can also download their own data from
their account page (see [Your account](../use/account.md#your-data)).

### Downloading a person's data

**Data** on a person's row opens their downloads. **Prepare a download** asks the server to
make a ZIP file in the background; the list shows when it is ready, and **Download** fetches it.
Only the administrator who asked can download it, for seven days; after that the file is
deleted. Downloads need file storage (the same as attachments).

The ZIP holds JSON files: the profile (with groups, teams, single sign-on links, the kinds of
second factors, API tokens by name, and sessions), settings and saved searches, the tickets the
person reported, created or is assigned, their comments and time entries, the files they
uploaded, and the audit records about them. `manifest.json` lists every file with its size and
checksum. No password, token or secret is ever in it. An administrator's download has every
ticket in full; the person's own download shows only the tickets they can still see (the others
appear with their number and the person's role).

### Erasing a person

**Erase…** explains what happens and asks you to type the person's email. **Erase
permanently** then:

- replaces their name and email by a placeholder, `Former user 42` and
  `erased-42@erased.invalid` (42 being the account's number), in tickets, comments, history,
  mentions, the audit log and exports; their tickets, comments, time and files stay;
- removes their password, profile settings, sessions, API tokens, second factors and recovery
  codes, single sign-on links, notification settings and inbox, recently viewed tickets, and
  their data downloads;
- deactivates the account for good: it cannot be edited, reactivated or signed in to.

It cannot be undone, so download the person's data first when they asked for it. Taskmoor
refuses to erase yourself, the last active site administrator, and a person a directory or SCIM
still provides: remove them in the directory or the identity provider first, or the next sync
brings them back. A name someone typed as plain text (not as a mention) is not found: edit it
by hand.

The audit log is never rewritten, so it stays verifiable (`node cli.mjs audit-verify`). Its
records keep the account's number, which now shows the placeholder, and when the log is read,
searched, exported or sent to syslog it hides the name, email and addresses those records hold
about the erased person (they are marked as masked). The stored records leave with the audit
retention period. Both the download and the erasure are audited (`personal_data.export_requested`
and `user.erased`).

## Two-factor authentication

People set up their own second factors on their Account page: an authenticator app, security
keys and passkeys, and ten single-use recovery codes. See [your account](../use/account.md).

On **Settings** > **Security**, under **Two-factor authentication**, choose who must use one:

| Choice | Meaning |
|---|---|
| **Nobody: everyone decides for themselves** | No requirement |
| **Site administrators** | Everyone holding site administration, by flag or by grant |
| **Everyone** | Every person |

**Also required for members of these groups** adds groups (nested members included) to the
choice above.

**Your organization's email domains** marks everyone else as external: list your domains, one
per line (`example.com`), and a person whose email is at any other domain must use a second
factor, whatever the choice above. Leave the list empty to treat everyone alike. Service
accounts are never external. Select **Save policy**.

- A fresh install starts with **Site administrators**: the administrator that setup creates
  sets up a second factor at their next sign-in. Choose another option here to change it.
- A person the policy covers who has no second factor sets one up the next time they sign in.
  Sessions that are already open stay open.
- A person the policy covers cannot switch off their last factor.
- The second factor applies to password sign-in, also for people a directory manages. Single
  sign-on relies on the identity provider's own checks.
- If someone loses every factor, a site administrator removes them all with
  `POST /api/v1/users/:id/two-factor/reset`. The web page does not offer this yet. If the
  policy covers them, they set up a new factor at their next sign-in.

## Sessions

By default a session lasts 14 days, and ends earlier after 3 days without use. On **Settings** >
**Security**, under **Sign-in sessions**, set **A sign-in lasts (hours)** and **Sign out after this
many minutes unused**, then select **Save session settings**. The security checklist (ASVS level
2) asks for 12 hours and 30 minutes. A shorter setting also ends the sessions that are older or
idler than the new limits; it applies to frontends on another site too. On HTTPS the browser cookie is `__Host-taskmoor_session`; the database keeps
only a hash of it.

People see their sessions on their Account page under **Sessions**, and can **Sign out** one or
**Sign out all other sessions**. A session also ends when the person signs out, changes their
password (their other sessions), redeems a password link, or is deactivated. A site
administrator signs a person out everywhere with `DELETE /api/v1/users/:id/sessions`. An ended
session is refused at its next request.

## Security emails and alerts

**Security emails to people.** Taskmoor emails a person when their password changes, a second
factor is added or removed, their recovery codes are made again, an administrator resets their
second factors, or their email address changes (told to the old address). This happens whoever
made the change: the person, an administrator, SCIM or a directory. The email says what changed,
when, from which address and browser, and who made it, and holds no sign-in link. No notification
setting turns it off, and digests and quiet hours do not delay it. It goes out through the same
mail server as notifications (see [notifications](notifications.md)), within about 15 seconds;
a failed send is tried again later, ten times at most.

**Failed sign-ins in the audit log.** Every refused sign-in is a `session.sign_in_failed` record
with the account (when one matches; otherwise the email typed, if it looks like one), the IP
address, the browser or program, the `method` (`password`, `directory` for LDAP or Active
Directory, `totp`, `webauthn`, `recovery_code`, `enrollment`, `api_token`, `basic`) and the
`reason` (such as `wrong_password`, `unknown_account`, `second_factor`, `token_expired` or
`email_mismatch`). The password, code or token tried is never recorded. Attempts refused while
an account or address is locked are not recorded, so a flood cannot fill the log.

**Refused requests.** When a person or an API token is refused (HTTP 403) again and again, the
audit log gets one `access.refused_repeatedly` record when the refusals in the window reach 10,
and one more at 100, 1,000 and so on, with the count and the last route.

**Alerts.** On **Settings** > **Security**, under **Security alerts**, each rule has **Alert on
this**, **Alert after this many** and **Within this many minutes**:

| Rule | Counts | Default |
|---|---|---|
| **Failed sign-ins for one account** | Failed sign-ins and password checks for the account | 10 within 60 minutes |
| **Failed sign-ins from one address** | The same, plus refused API tokens, from one IP address | 25 within 15 minutes |
| **Refused requests of one person or token** | HTTP 403 answers | 50 within 15 minutes |
| **Bulk exports by one person** | Full exports, audit log exports and search result exports | 5 within 60 minutes |

Select **Save alert rules**. Windows are fixed: a 15-minute window starts on the quarter hour.
A rule raises at most one alert per window for the same account, address, person or token.
Every site administrator then gets an item in their inbox (under **Priority**) and an email, and
the audit log records `security.alert_raised`, so it also reaches syslog and webhooks. The
section lists the latest alerts. AI spend alerts (see [AI usage](ai-usage.md)) reach site
administrators the same way.

## Groups

Groups gather people so you can give them permissions, require two-factor authentication,
restrict who sees tickets, or share dashboards and saved searches with them.

- **Add a group** asks for a **Group name** and a **Description (optional)**. Names are unique.
- Each group in the list shows how many members and groups inside it has. **Manage** opens it.
- Under **Members of** a group, **Add a person**: type two letters or more of a name or email,
  then select **Add**. **Remove** takes a person out.
- Under **Groups inside** a group, **Put a group inside** and **Choose a group**. The page also
  says which groups this one is inside.
- **Delete group** asks to confirm. Its members stay; permissions given to the group go.

Renaming a group is done through the API (`PATCH /api/v1/groups/:id`); the page does not
rename yet.

### Groups inside groups

A member of a group inside another counts as a member of the outer group, at any depth. This
holds for permissions, visibility levels, the two-factor policy and sharing. A nesting that
would make a loop is refused: "That would put a group inside itself."
`GET /api/v1/groups/:id/effective-members` lists everyone a group counts, nested members
included.

### Groups from elsewhere

- A [directory](ldap.md) owns the names, members and nested groups of the groups it syncs.
  Rename or delete them in the directory.
- An [identity provider](sso.md) with a group mapping adds and removes people in the mapped
  groups at each sign-in.
- [SCIM](scim.md) manages only the groups it created.

Groups are for access. To say who works together, use [teams](#teams).

## Teams

A team is a set of people who work together, with a name, a description and an optional lead.
A team gives no permissions and hides nothing: that is what groups are for. Other parts of
Taskmoor point at a team:

- a board can belong to a team (**Team** in the board's settings, see
  [Board settings](../use/boards.md#board-settings));
- an area can be owned by a team (`ownerTeamId`, see [Areas](tracks.md#areas));
- a [Team field](fields.md#field-types) names one team on a ticket;
- a query finds the team's members with `membersOf("id:12")`, where 12 is the team's number
  (see [Searching](../use/search.md#functions)).

They all point at the team itself, not at its name, so renaming a team renames it everywhere at
once: on tickets, boards, areas, and in the queries that name it (a query that used the old name
must use the new one).

On **Settings** > **Teams**:

- **Add a team** asks for a **Team name** and a **Description (optional)**. Names are unique,
  ignoring case: "There is a team with that name already."
- Each team in the list shows how many members it has, who leads it and its description.
  **Manage** opens it.
- In an open team, change the **Team name**, the **Description (optional)** and the **Lead**,
  then select **Save**. The lead is chosen among the members, or **No lead**.
- Under **Members of** a team, **Add a person**: type two letters or more of a name or email,
  then select **Add**. **Remove** takes a person out. Members are people: service accounts and
  deactivated people cannot be added, and a deactivated member shows as deactivated.
- **Delete team** asks to confirm. Boards and areas let go of the team, and Team fields that
  named it become empty. The people stay.

Everyone who is signed in can read teams and their members through the API, for pickers and
the Team field; only site administrators change them. Teams travel in the
[full export](import-export.md) with their members and lead.

## API reference

Every route needs a site administrator (an API token needs the `admin` scope), except reading
teams.

| Method and path | What it does |
|---|---|
| `GET /api/v1/users?query=&status=&limit=&offset=` | List people (`status`: `active`, `deactivated`, `all`) |
| `POST /api/v1/users` | Add a person |
| `GET /api/v1/users/:id` | A person, their groups and the directory that manages them |
| `PATCH /api/v1/users/:id` | Change name, email, time zone, locale, site administration, break-glass |
| `POST /api/v1/users/:id/deactivate` | Deactivate |
| `POST /api/v1/users/:id/reactivate` | Reactivate |
| `POST /api/v1/users/:id/password-link` | Make a password link |
| `DELETE /api/v1/users/:id/sessions` | Sign the person out everywhere |
| `POST /api/v1/users/:id/two-factor/reset` | Remove every second factor |
| `GET`, `PUT /api/v1/security/two-factor` | Read or set the two-factor policy |
| `GET`, `PUT /api/v1/security/alerts` | Read the alert rules and the latest alerts, or set rules: `{"rules": {"bulk_exports": {"enabled": true, "threshold": 5, "windowMinutes": 60}}}` |
| `GET`, `POST /api/v1/groups` | List or create groups |
| `GET`, `PATCH`, `DELETE /api/v1/groups/:id` | Read, rename or delete a group |
| `PUT`, `DELETE /api/v1/groups/:id/members/:userId` | Add or remove a member |
| `PUT`, `DELETE /api/v1/groups/:id/children/:childId` | Put a group inside, or take it out |
| `GET`, `POST /api/v1/teams` | List (`?query=` finds by name) or create teams; anyone signed in lists |
| `GET`, `PATCH`, `DELETE /api/v1/teams/:id` | Read (anyone signed in), change or delete a team; `PATCH` takes `name`, `description` and `leadId` |
| `PUT`, `DELETE /api/v1/teams/:id/members/:userId` | Add or remove a member |
