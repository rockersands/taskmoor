---
title: "Administration"
audience: admins
sources: docs/adr/0114-glass-interface-and-clear-sections.md, docs/plan/page-review-findings.md, apps/web/src/admin/sections.ts, apps/web/src/admin/access.ts, apps/web/src/admin/AdminLayout.tsx, apps/web/src/styles/admin.css, apps/web/src/sets/trackScope.tsx, apps/web/src/workflow/WorkflowEditorPage.tsx, apps/web/src/admin/AdminOverviewPage.tsx, apps/web/src/admin/AdminGroupPage.tsx, apps/web/src/admin/SettingsPage.tsx, apps/web/src/App.tsx, apps/web/src/i18n/messages.en.ts, apps/server/src/routes/session.ts, apps/server/src/routes/groups.ts, apps/server/src/routes/users.ts, apps/web/src/shell/PageHeader.tsx, apps/web/src/shell/EmptyState.tsx, apps/web/src/webhooks/WebhooksPage.tsx, apps/web/src/admin/AiLimitsPage.tsx, apps/web/src/permissions/VisibilityPage.tsx, apps/web/src/permissions/PermissionExplainerPage.tsx, apps/web/src/configuration/TrackSetsPage.tsx, apps/web/src/layouts/LayoutEditorPage.tsx, apps/web/src/admin/TrashPage.tsx, apps/web/src/admin/NewButton.tsx, apps/web/src/guardrails/GuardrailsPage.tsx, apps/web/src/shell/DangerAction.tsx, apps/web/src/permissions/PermissionsPage.tsx, apps/web/src/sets/ConfigurationSetsPage.tsx, apps/web/src/tokens/ServiceAccountsPage.tsx, apps/web/src/people/GroupsPage.tsx, apps/web/src/people/TeamsPage.tsx, apps/web/src/fields/FieldsAdminPage.tsx, apps/web/src/configuration/WorkflowMapsPage.tsx, apps/web/src/directories/DirectoriesPage.tsx, apps/web/src/sso/IdentityProvidersPage.tsx, apps/web/src/admin/FrontendsPage.tsx, apps/web/src/admin/AiSettingsPage.tsx, apps/web/src/workflow/StatusInspector.tsx, apps/web/src/workflow/TransitionInspector.tsx, apps/web/src/tokens/TokensSection.tsx, apps/web/src/plans/PlanSettingsPage.tsx, apps/web/src/releases/CrossTrackReleasePage.tsx
accessed: 2026-11-13
attestation: own-words
---
# Administration

**Administration** is where the site is run. It is a section of its own, under **Manage** in the
sidebar, and separate from **Settings**, which is personal: your account, your appearance and your
tutorials. The sidebar shows **Administration** only to those allowed to use it.

A list page shows its list first: a **New …** button at the top, such as **New group** or **New
field**, opens the form above the list, and the form closes once the thing is added or you choose
**Cancel**; the focus then goes back to the **New …** button. A page with several lists, such as
**Permissions** (roles and access policies) or **Configuration sets** (type sets and field rule
sets), has a **New …** button at the head of each list's card. **Visibility policies**, **Layout
sets** and **Service accounts** work the same way. Every add button has the same filled look.
Taking the way back from a confirmation, with its button or with Escape, puts the focus back on
the button that asked.

An action that removes something or locks someone out looks and works the same everywhere:
**Deactivate** a person or a service account, **Revoke** a token, **Remove** a frontend or an AI
key, and **Delete** a role, access or visibility policy, visibility level, workflow, status,
transition, workflow map, group, team, field, type set, field rule set, layout set, webhook, AI
limit, directory or identity provider. The same goes outside Administration for deleting a
comment, an attachment, a ticket template, a dashboard, a plan or a release across tracks, and for
revoking your own API token. Its
button is in the danger colour, and pressing it does nothing yet: a question opens in its place,
says what will happen, and offers the action by name beside **Cancel**, which has the focus.
**Cancel** or Escape puts the button back and focuses it. While the action runs, both answers
wait; if Taskmoor refuses, the question stays open with the reason, to try again or cancel. Once
it is done, the focus goes back to the button, or, when the thing is gone with its button, to the
heading of its list. **Erase…** has the same danger colour but asks you to type the person's
email instead.

Every page here opens with its name and a line on what it is for, and a small round button
beside the name explains more, the group pages too. Pages of forms and lists keep a reading
width; the audit log and the usage tables take the page's full width. A list with nothing in it says what would be there
and how it gets there. Someone who may not use a page is told so, without the rest.

## Who sees what

| You are | You see |
|---|---|
| A **site administrator** | Every group below |
| A **configuration administrator** | Only **Tracks and setup** |
| Anyone else | No **Administration** in the sidebar. An address that leads there says only administrators can use it |

What the sidebar shows follows what the server allows; the server still checks every request. See
[who holds which right](permissions.md#site-and-configuration-administrators).

A configuration administrator does the setup work in the web app. To give a track's role they read
the list of groups, and find a person by name or by the start of their address: the answer gives a
name and nothing else. Changing groups and people, and the full list of people, stay with site
administrators.

## The overview

**Administration** opens on an overview. For a site administrator it shows:

- **System health**: whether the database answers, migrations are done, more than a tenth of the disk
  is free and a backup is less than a day old, then the version. **See every detail** opens
  [System status](monitoring.md).
- **People who have not signed in yet**: people you added who have no password and have never signed
  in. They are waiting for their [activation link](people-and-groups.md). It looks at the first 200
  people and says so when there are more.
- **Security alerts**: the latest [alerts](people-and-groups.md), with a link to change their rules.

Each panel reads on its own, so one that fails says so and the others still show.

A configuration administrator sees the list of setup pages instead.

## Finding a page

The section has its own list of pages. On a wide screen it sits beside the page and stays in view
while the page scrolls. On the overview every group shows its pages. On any other page only the
group of the page you are on does; the heading of any group opens or closes it, and a group you
opened stays open while you stay within the group. On a group's own page its heading is marked as
the page you are on. On a narrow screen the list is a bar
named **Administration pages** at the top of every page, the overview too, with a chevron: it opens
the same list.

Each page shows where it sits with a breadcrumb: **Administration**, then its group, then the page.
A page inside another one goes further: a workflow ends at its name, under **Workflows**, and a
track's own pages go through **Tracks you run** and the track, as in **Tracks you run › OPS ›
Layout sets**. A group you may not open, such as **Tracks and setup** for someone who only runs
tracks, is named without a link, and so are its pages: someone who opens their track's own workflow
sees **Workflows** in its breadcrumb, but not as a link to the list they may not use. The group's own page says what each of its pages is for. Addresses
of pages did not change, so links you saved keep working.

## The groups

| Group | Pages |
|---|---|
| **People and access** | **People**, **Groups**, **Teams**, **Permissions** (roles, access policies, global permissions), **Visibility policies**, **Permission explainer** |
| **Tracks and setup** | **Tracks**, **Workflows**, **Workflow maps**, **Fields**, **Ticket types**, **Configuration sets**, **Layout sets**, **Which sets a track uses** |
| **Sign-in and security** | **Security**, **Single sign-on**, **LDAP and Active Directory**, **Network access**, **Audit log** |
| **Integrations and AI** | **API tokens**, **Service accounts**, **MCP server**, **Frontends**, **Webhooks**, **AI**, **AI usage**, **AI limits and prices** |
| **System** | **System status**, which also shows backups, **API usage and limits**, **Imports**, **Trash**, **Guardrails** |

## Guardrails

**Guardrails** lists every limit with its default and where it is used most, in one form with one
**Save the limits**. Type a limit as a whole number, with or without the thousands separator of
your language (20,000 in English, 20.000 in Spanish); a decimal is refused. The limits are saved
one by one: if one cannot be saved, the page names the limits that were saved and those that were
not, and the form keeps what you typed, so **Save the limits** again sends only what is left.
