---
title: "Administration"
audience: admins
sources: docs/adr/0114-glass-interface-and-clear-sections.md, apps/web/src/admin/sections.ts, apps/web/src/admin/access.ts, apps/web/src/admin/AdminLayout.tsx, apps/web/src/admin/AdminOverviewPage.tsx, apps/web/src/admin/AdminGroupPage.tsx, apps/web/src/admin/SettingsPage.tsx, apps/web/src/App.tsx, apps/web/src/i18n/messages.en.ts, apps/server/src/routes/session.ts, apps/server/src/routes/groups.ts, apps/server/src/routes/users.ts
accessed: 2026-11-03
attestation: own-words
---
# Administration

**Administration** is where the site is run. It is a section of its own, under **Manage** in the
sidebar, and separate from **Settings**, which is personal: your account, your appearance and your
tutorials. The sidebar shows **Administration** only to those allowed to use it.

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

The section has its own list of pages: beside the page on a wide screen, and folded above it on a
narrow one, under **Administration pages**. Each page shows where it sits with a breadcrumb,
**Administration**, then its group, then the page. The group's own page says what each of its pages
is for. Addresses of pages did not change, so links you saved keep working.

## The groups

| Group | Pages |
|---|---|
| **People and access** | **People**, **Groups**, **Teams**, **Permissions** (roles, access policies, global permissions), **Visibility policies**, **Permission explainer** |
| **Tracks and setup** | **Tracks**, **Workflows**, **Workflow maps**, **Fields**, **Configuration sets**, **Which sets a track uses** |
| **Sign-in and security** | **Security**, **Single sign-on**, **LDAP and Active Directory**, **Network access**, **Audit log** |
| **Integrations and AI** | **API tokens**, **Service accounts**, **MCP server**, **Frontends**, **Webhooks**, **AI**, **AI usage**, **AI limits and prices** |
| **System** | **System status**, which also shows backups, **API usage and limits**, **Imports**, **Trash**, **Guardrails** |
