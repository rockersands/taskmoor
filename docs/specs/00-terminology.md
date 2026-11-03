---
spec: 00
title: "Terminology: Taskmoor's own names for structural concepts"
sources: docs/research/sources.md
accessed: 2026-10-12
attestation: own-words
---
# 00 Terminology

Taskmoor names its structural concepts in its own words. The user decided this on 2026-10-12
(`docs/plan/decisions.csv`, "Structural terminology"): every term that is specific to Atlassian
products gets a Taskmoor name, including the defaults that Jira ships (Epic, Story, Task,
Subtask). Atlassian renamed its own terms in 2025 ("project" became "space", "issue" became
"work item", "issue type" became "work type"), so neither the old nor the new Atlassian names
are used. Every other file follows this one: specs, ADRs, plans, API, UI, code identifiers and
documentation.

## Rules

1. Use the Taskmoor name everywhere the product speaks for itself: UI text, the native API,
   the native query language, specs, ADRs, documentation and code identifiers.
2. Jira-compatible names appear only where compatibility needs them: the importer's mapping,
   export, the Jira-compatible REST API, the Jira-compatible query dialect, and spec text that
   names the parity target (the "Source" columns, "Jira calls this ..." notes). Write them as
   Jira's names, for example: a track (Jira: project).
3. Imported data keeps its own names. A Jira instance whose types are called Epic, Story and
   Task keeps them after import; only Taskmoor's defaults for new tracks use the names below.
4. Defaults are defaults: administrators rename hierarchy levels, ticket types, statuses,
   priorities and close reasons.
5. Vocabulary that belongs to a public method or to the whole industry stays (see "Kept
   terms"). Renaming it would confuse people and protect nothing.
6. Internal benchmark schemas from the M0 spikes (`gen.*`, `space_id` columns) keep their old
   names; they are measurement fixtures, not the product schema. The M1 product schema uses
   these names.

## Containers and work

| Taskmoor | Jira (classic) | Atlassian (2025) | Notes |
|---|---|---|---|
| **ticket** | issue | work item | The unit of tracked work; has a key such as `PAY-42` |
| **track** | project | space | Holds tickets, configuration and people; has a key (`PAY`) |
| track key, ticket key | project key, issue key | space key, work item key | |
| track type: software, business, service, discovery | project type | space type | A preset of capabilities over one ticket engine |
| track owner | project lead | space lead | |
| track admin | project admin | space admin | |
| track role | project role | space role | |
| track category | project category | space category | |
| track template | project template | space template | |
| **ticket type** | issue type | work type | |
| subticket | sub-task | subtask | Level -1 |
| ticket view, ticket search | issue view, issue navigator | work item view | |
| ticket link, link type | issue link | work item link | Link types: blocks / blocked by, relates to, duplicates / duplicated by, copy of / copied to |
| web link | remote link | remote link | |

## Hierarchy defaults

| Level | Taskmoor default | Jira default |
|---|---|---|
| 2 and above (added by admins) | for example Objective (2), Strategy (3) | Initiative, Theme (Premium) |
| 1 | **Outcome** | Epic |
| 0 (software) | **Feature**, **Bug**, **Chore** | Story, Task, Bug |
| 0 (business) | **To-do** | Task |
| 0 (service) | the request form's ticket type | (request types map to issue types) |
| 0 (discovery) | **Idea** | Idea |
| -1 | **Subticket** | Subtask |

"Bug" and "Idea" stay: they are the everyday words for those things across the industry.

## Fields

| Taskmoor | Jira |
|---|---|
| **requester** | reporter |
| creator | creator |
| **followers**, follow | watchers, watch |
| voters, votes | voters, votes |
| **close reason**; **closed** (time stamp) | resolution; resolved (resolution date) |
| **stage**: new, active, closed | status category: To Do, In Progress, Done |
| **areas**, area owner | components, component lead |
| **releases**: **target release**, **found in release** | versions: fix version, affects version |
| **points** | story points, story point estimate |
| **time entries**, record time | worklogs, log work |
| **effort ratio** | work ratio |
| **visibility level**, visibility policy | security level, issue security scheme |
| rank (fractional ranking) | rank (LexoRank) |
| customer group | organization (service) |
| request form, request channel | request type, request channel type |

## Configuration

| Taskmoor | Jira |
|---|---|
| **shared mode** | company-managed |
| **local mode** | team-managed (formerly next-gen) |
| **access policy** | permission scheme |
| **notification policy** | notification scheme |
| **visibility policy** | issue security scheme |
| **type set** | issue type scheme |
| **workflow map** (ticket type to workflow) | workflow scheme |
| **layouts**, **layout set** | screens, screen schemes, issue type screen schemes |
| **field rules**, field rule set | field configuration, field configuration scheme |
| **priority set** | priority scheme |
| configuration set (the general word) | scheme |
| site admin | site admin |
| configuration admin (tracks, types, fields, workflows; no user management) | product admin, Jira administrators |

## Workflows

Taskmoor uses the vocabulary of state machines (UML statecharts): a transition has a guard, a
check and effects.

| Taskmoor | Jira |
|---|---|
| **guard** (who may see or run a transition) | condition |
| **check** (what must hold before it completes) | validator |
| **effect** (what happens after it) | post function |
| transition layout | transition screen |
| default statuses **New**, **Active**, **Closed** | To Do, In Progress, Done |
| default priorities **Urgent**, **High**, **Normal**, **Low**, **Very low** | Highest, High, Medium, Low, Lowest |
| default close reasons **Completed**, **Not planned**, **Duplicate**, **Not reproducible** | Done, Won't Do, Duplicate, Cannot Reproduce |

## Search, reports and dashboards

| Taskmoor | Jira |
|---|---|
| the query language (native) and its Jira-compatible dialect | JQL |
| **saved search**, search subscription | filter, filter subscription |
| **board filter** | quick filter |
| **widget** | gadget |
| outcome report, release report, created vs closed | epic report, version report, created vs resolved |

## Planning, service, discovery and platform

| Taskmoor | Atlassian |
|---|---|
| **roadmaps** | Plans, Advanced Roadmaps |
| **service desk**, **service track** | Jira Service Management, service project |
| **request form** | request type |
| **help portal** | help center, customer portal |
| **customer group** | organization |
| **Inventory**: catalogs, object types, objects; inventory query | Assets (formerly Insight): object schemas, object types, objects; AQL |
| **discovery**: ideas, **evidence**, views, **delivery links** | Product Discovery: ideas, insights, views, delivery tickets |
| **automation**: triggers, conditions, actions, **variables**, **for each** blocks | Automation for Jira: triggers, conditions, actions, smart values, branches |
| **extensions**, extension registry | Forge and Connect apps, Marketplace |
| **AI features**, **AI agents**, assistant | Atlassian Intelligence, Rovo, Rovo agents |
| **wiki** pages (external) | Confluence pages |
| status pages, on-call, alerts | Statuspage, Opsgenie |
| service catalog | Compass |
| user account | Atlassian account |

## Further names

Chosen while applying this file to the specs and code.

| Taskmoor | Atlassian |
|---|---|
| ticket category | work category (service) |
| ship, unship; shipped and upcoming releases | release, unrelease; released and unreleased versions |
| link type **Copies** (copy of / copied to) | Cloners (clones / is cloned by) |
| swimlanes by subtickets, by outcomes or parents | swimlanes by stories, by epics |
| outcome burndown, release workload, time to close | epic burndown, version workload, resolution time |
| saved searches Requested by me, Closed recently | filters Reported by me, Resolved recently |
| permissions Set close reason, Record time on tickets, Manage followers, Create local-mode tracks, Share dashboards and saved searches, Manage group search subscriptions | Resolve issues, Work on issues, Manage watchers, Create team-managed projects, Share dashboards and filters, Manage group filter subscriptions |
| effects assign to owner (area owner, else track owner), assign to requester | assign to lead developer, assign to reporter |
| guards only requester, subticket blocking | only reporter, sub-task blocking |
| level-2 tickets (until an admin names the level) | initiatives |
| tickets for delivery, pieces of evidence | delivery tickets, insights |
| catalog roles, catalog templates, inventory query language | object schema roles, schema templates, AQL |
| collections (knowledge base) | knowledge-base spaces |
| commit commands | smart commits |
| template variables `{{ticket.*}}` (`issue` and `workItem` accepted) | smart values `{{issue.*}}` |
| native webhook events such as `ticket.created` | issue events (kept in the Jira-compatible API) |
| alert notification rules (on-call) | notification policies (Opsgenie) |
| visibility matrix test | security matrix test |

## Kept terms

These belong to public methods or to the industry as a whole and stay as they are: sprint,
backlog, board, Scrum, Kanban, swimlane, WIP limit, velocity, burndown, burnup, cumulative flow,
cycle time, lead time, status, workflow, transition, priority, label, assignee, due date, start
date, estimate, time spent, approval, form, queue, SLA, incident, problem, change, CMDB,
configuration item, on-call, roadmap, timeline, dashboard, goal, team, vote, comment,
attachment, archive, audit log, site, group, role.

## Query vocabulary

The native query language uses these field and function names; the Jira-compatible dialect
accepts the names on the right and `toJira` writes the first of them. The dialect also accepts
the names Atlassian introduced in 2025 (`space`, `workItemLink`, `linkedWorkItems()` and so on),
listed after the classic ones. Names not listed are the same in both (for example `status`,
`assignee`, `sprint`, `labels`).

| Native field | Jira-compatible |
|---|---|
| `track` | `project`, `space` |
| `parentTrack` | `parentProject`, `parentSpace` |
| `trackType` | `projectType`, `spaceType` |
| `trackCategory` | `category` |
| `type` | `issuetype`, `issueType` |
| `key` | `issuekey`, `issue`, `issueKey` |
| `requester` | `reporter` |
| `follower`, `followers` | `watcher`, `watchers` |
| `closeReason` | `resolution` |
| `closed` | `resolutiondate`, `resolutionDate`, `resolved` |
| `stage` | `statusCategory` |
| `area` | `component` |
| `targetRelease` | `fixVersion` |
| `foundInRelease` | `affectedVersion` |
| `effortRatio` | `workRatio` |
| `timeEntryComment`, `timeEntryDate` | `worklogComment`, `worklogDate` |
| `visibilityLevel` | `level` |
| `savedSearch` | `filter`, `request`, `savedFilter`, `searchRequest` |
| `ticketLink`, `ticketLinkType` | `issueLink`, `issueLinkType`; `workItemLink`, `workItemLinkType` |
| `linkedTicket`, `parentOutcome`, `journeyTicket` | `linkedWorkItem`, `parentEpic`, `journeyWorkItem` |
| `customerGroup` | `organization` |
| `requestForm`, `requestChannel` | `requestType`, `requestChannelType` |
| `requestLastActivity` | `requestLastActivityTime` |

| Native function | Jira-compatible |
|---|---|
| `tracksOwnedByUser` | `projectsLeadByUser`, `spacesLeadByUser` |
| `tracksWhereUserHasPermission` | `projectsWhereUserHasPermission`, `spacesWhereUserHasPermission` |
| `tracksWhereUserHasRole` | `projectsWhereUserHasRole`, `spacesWhereUserHasRole` |
| `areasOwnedByUser` | `componentsLeadByUser` |
| `linkedTickets` | `linkedIssues`, `linkedWorkItems` |
| `ticketHistory` | `issueHistory`, `workItemHistory` |
| `ticketsWithWebLinksByGlobalId` | `issuesWithRemoteLinksByGlobalId`, `workItemsWithRemoteLinksByGlobalId` |
| `votedTickets` | `votedIssues`, `votedWorkItems` |
| `followedTickets` | `watchedIssues`, `watchedWorkItems` |
| `standardTicketTypes` | `standardIssueTypes`, `standardWorkTypes` |
| `subticketTypes` | `subTaskIssueTypes`, `subtaskWorkTypes` |
| `shippedReleases` | `releasedVersions` |
| `upcomingReleases` | `unreleasedVersions` |
| `latestShippedRelease` | `latestReleasedVersion` |
| `earliestUpcomingRelease` | `earliestUnreleasedVersion` |
| `customerGroupDetail`, `customerGroupMembers` | `organizationDetail`, `organizationMembers` |

Sources: Atlassian's 2025 rename is reported in
[UC Today](https://www.uctoday.com/project-management/jira-projects-are-now-spaces-atlassian-says-its-clarity-users-arent-so-sure/)
and Atlassian's [community announcement](https://community.atlassian.com/forums/Jira-articles/Jira-Spaces-have-landed/bc-p/3121805).
