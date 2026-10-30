---
title: "Taskmoor documentation"
audience: everyone
sources: README.md, LICENSE, docs/specs/00-terminology.md, docs/adr/0074-offline-manual.md, docs/manual/nav.json
accessed: 2026-10-30
attestation: own-words
---
# Taskmoor documentation

Taskmoor is a work tracker you run yourself. Teams plan and follow their work as tickets in
tracks, move them through workflows, and see them on boards, in sprints, on timelines and in
reports. Every feature is included in the open-source release: there is no paid edition and no
feature switched off by a licence key.

This manual has two halves. **Using Taskmoor** is for everyone who works in the web app.
The other sections are for the administrators who install the server, look after people and
access, shape tracks and workflows, connect other systems, and keep the server healthy.

## Where to start

| You want to | Read |
|---|---|
| Learn the words Taskmoor uses | [Concepts and terms](concepts.md) |
| Create and update tickets | [Working with tickets](use/tickets.md) |
| Plan a sprint or run a board | [Boards, sprints and the backlog](use/boards.md) |
| Find tickets with a query | [Search and the query language](use/search.md) |
| Install a server | [Installing Taskmoor](admin/install.md), then [First-run setup](admin/first-run.md) |
| Add people and teams, and decide who sees what | [People, groups and teams](admin/people-and-groups.md) and [Permissions and access](admin/permissions.md) |
| Sign people in with your identity provider | [Single sign-on](admin/sso.md), [LDAP directories](admin/ldap.md), [SCIM provisioning](admin/scim.md) |
| Connect a script, a service or an AI agent | [API tokens and service accounts](admin/api-tokens.md), [The REST API](admin/rest-api.md), [The MCP server](admin/mcp.md) |
| Back up, upgrade and watch the server | [Backups and restore](admin/backups.md), [Upgrades](admin/upgrades.md), [Monitoring and logs](admin/monitoring.md) |
| Bring data in from another tracker | [Importing and exporting](admin/import-export.md) |

## How this manual is organised

- **Start here:** this page and [Concepts and terms](concepts.md).
- **Using Taskmoor:** tickets, boards and sprints, the list, calendar and timeline views,
  search, dashboards and reports, notifications, and your own account.
- **Installing:** the install kits (Docker Compose, the all-in-one image, Helm and the
  Builder's kits), first-run setup, and every configuration setting.
- **People and access:** people, groups, permissions, single sign-on, LDAP and SCIM.
- **Configuring work:** tracks, workflows, fields, ticket types and layouts, email and
  notification policies.
- **Integrations:** API tokens, the REST API and the MCP server for AI agents.
- **Running a server:** backups, upgrades, monitoring, the operator command line, and imports
  and exports.

Labels in **bold** are the words you see on screen. Commands and settings are in `code`.

## Words this manual uses

Taskmoor has its own names for its building blocks: a **track** holds **tickets**; an
**outcome** groups the tickets that deliver it; a **saved search** keeps a query; a **widget**
sits on a dashboard. Where Taskmoor offers compatibility with another tracker, the manual says
**Jira-compatible** and names the other product's terms only where you need them, for example
when you map fields during an import. [Concepts and terms](concepts.md) has the whole glossary.

## Reading the manual offline

The manual ships as a folder of web pages that needs no internet connection: no page loads a
font, script or picture from anywhere. Open `index.html` from disk or put the folder on any web
server. Search works in the page itself: type in the box at the top of any page and press
Enter, or press `/` to jump to the box.

To build the folder from a copy of the source code, run this at the top of the repository:

```bash
pnpm run docs
```

It checks every page, writes the bundle to `dist/docs` (`--out <folder>` for another place),
and lists the external links the pages contain without visiting them. Set `TASKMOOR_VERSION`
to stamp the version in each page's footer.

## Licence

Taskmoor and this manual are free software under the GNU Affero General Public License,
version 3 only. If you run a modified Taskmoor for others over a network, the licence asks you
to offer them its source code.
