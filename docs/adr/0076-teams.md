# ADR-076: Teams: their own table, named by id everywhere, granting nothing

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-123

## Context

CORE-027 asks for site-wide teams with members, a lead and a description, a Team field, and
team references that boards, roadmaps, on-call and ownership can use. Its acceptance criteria:
`membersOf("id:<teamId>")` returns the team's members (also in spec 01b section 1.6), and
renaming a team updates every reference. Spec 01a section 1.4 lists Team among the custom field
types. Until now the manual told administrators to use groups as teams, and
`membersOf("id:...")` was refused as not built (ADR-010).

Groups (IAM-008) already gather people, but they carry permissions, visibility, the two-factor
policy and sharing, they nest, and directories, SCIM and identity providers write them. Who
works together is a different question: a person is often in a team without that changing what
they may see, and a team is kept by hand even where a directory owns the groups.

Another branch adds read-only info field types in a migration numbered before this one
(0058, M1-125), so the field type constraint may change underneath this one.

## Decision

- **Tables** (migration 0060): `team` (name unique in the workspace ignoring case, description,
  an optional `lead_id` cleared when the account goes) and `team_member` (people, removed with
  the team or the account). A team grants nothing and does not nest.
- **References by id**: `board.team_id` (the team a board belongs to) and `area.owner_team_id`
  (the team that owns an area), both cleared when the team is deleted; a custom field type
  `team` whose values are team ids. Every answer shows a team by its current name, so a rename
  is one row and shows everywhere at once. History keeps ids, as for every reference, and
  shows the name a value has now.
- **The Team field** is a custom field type (`team`), one value, indexed in `v_option` like
  groups (ADR-008). The query language reads it by name (any case) or id, with equality, lists,
  emptiness, ordering by name and the history operators. CSV imports read team names.
- **`membersOf("id:<teamId>")`** returns the team's members; an id no team has is refused as
  an unknown value. `membersOf(name)` stays the group function: a team is never found by name
  there, so a team and a group may share a name.
- **Who changes them**: site administrators (`/api/v1/teams`, the **Teams** page under
  Settings). Everyone signed in reads teams and their members, because pickers and the Team
  field need them. Members and leads are active people, never service accounts. Events
  `team.created`, `.updated`, `.deleted`, `.member_added` and `.member_removed` go to the audit
  log, like groups.
- **Export and import** (ADR-063): `teams.ndjson` after groups, with lead and members; an area
  record carries `ownerTeam` only when a team owns it, so exports without teams keep their
  bytes. Imports link a team by name and add members, as they do for groups.
- **The field type constraint** is extended from the definition the database holds
  (`pg_get_constraintdef`), not rewritten from a list, so 0058's types survive whichever lands
  first.

## Options considered

| Option | For | Against |
|---|---|---|
| Teams as groups with a flag | One table, `membersOf(name)` already works | A team would grant whatever its group is given, directories could own it, nesting would leak into who is on a team |
| Teams as their own table (chosen) | Says who works together and nothing else; ids keep renames free | A second "set of people" for administrators to understand; the manual says which is which |
| A built-in Team column on every ticket | No field to create | A ticket column, its history, CSV and form handling for one field; spec 1.4 lists Team as a custom field type, and some sites need two (owning team, reporting team) |
| A multiple-value Team field | More flexible | Every board and report reads "the" team of a ticket; Jira-compatible data has one team per work item |

## Consequences

- Planning with teams (PLN-005, M2) and on-call (M3) name teams by id; capacity and schedules
  get their own tables then.
- Not built in this task: velocity per team (AGL-011 (3)) and a team filter on reports;
  choosing a Team value in the web app's ticket form, which offers no reference pickers yet
  (people, groups, releases and areas are set through the API, CSV or bulk changes too); team
  pages for people who are not administrators.
- A migration numbered after 0060 that rewrites `field_type_check` from a fixed list must keep
  `team`.
