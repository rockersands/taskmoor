# ADR-090: The Data Center import of permissions, issue security, notifications and global permissions

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-092

## Context

M1-092 maps a Data Center backup's permission schemes, issue security schemes, notification
schemes and global permissions (IMP-004; spec 02a section 3 maps them to access policies, roles
and global grants, visibility policies and levels, and notification policies). It is done when a
visibility parity test shows that each fixture user sees exactly the expected tickets. IMP-005
(1) asks for identical permission schemes to become one shared access policy. The synthetic
generator (ADR-072) wrote none of these elements. Tickets come with M1-089 (ADR-089), so issues'
security levels can be carried on them.

Taskmoor's models already have every piece: access policies with grants to roles, groups,
people, the track owner, anyone signed in, anyone, the requester, the assignee and user or
group fields (M1-004, M1-020); visibility policies whose levels take the same grantees; notification
policies with rules per event and recipient (M1-056); and global grants (M1-020). They differ in
one place that matters for parity: a Taskmoor site administrator holds every track permission,
while a Data Center system administrator does not browse every project by that alone.

## Decision

- **The fixture grows** (`dc-backup/schemes.ts`; format notes 02d, every statement **Verify** or
  **Our choice**). It writes four permission schemes, two of them identical but for their name,
  with every grantee type and a plugin's permission. It writes two issue security schemes with
  five levels, one with a default, and two notification schemes with an event and a recipient
  that have no counterpart and a custom event. It writes eight global permissions, one of them a
  plugin's and one to anyone, and each project's scheme associations. Each issue's level comes
  from its own seed stream, and a sub-task takes its parent's. Project role actors are now made
  by one function (`roleActors`) that the generator and the test share, with the same output.
- **Mapped one to one** (`dc-backup/stage-schemes.ts`, `import/dc-schemes.ts`,
  `import/load-access.ts`). The new framework kinds are `access_policy`, `visibility_policy`,
  `visibility_level`, `notification_policy` and `global_grant`, after the forms and before
  tickets. Permission keys map to track permissions. Group grants map to groups; a group grant
  without a group means anyone. The other grantees map as their names suggest: user, project
  role, reporter to requester, assignee, lead to track owner, user and group fields, and any
  signed-in user. Event numbers map to the notification events, and recipient types to
  recipients. `SYSTEM_ADMIN` becomes `site_admin`, `ADMINISTER` becomes `configuration_admin`,
  and the user picker, shared objects, group subscriptions and bulk change permissions map to
  their counterparts. `USE` is not needed. Anything else is warned about by name.
- **Never wider than the source.** A grant or level member whose person, group, role or field
  did not come along is dropped with a warning, which can only narrow. A ticket whose level did
  not map fails rather than being imported without one, because without a level everyone who
  browses its track would see it.
- **Identical permission schemes merge** (IMP-005 (1)). The same grants, names aside, give one
  access policy, named after the scheme with the lowest id. That policy takes the merged
  schemes' projects, and each merged scheme is skipped with `merged_identical` and the warning
  `merged_into: <name>`.
- **Linked by name, like other configuration.** A policy of the same name in the target is
  used as it is, and the imported tracks are put on it (ADR-048). Levels link by name within
  their policy. A global grant that is already there is linked.
- **Site administrators are the one widening, and it is reported.** Members of a group with
  `SYSTEM_ADMIN` become site administrators, who browse every track (visibility levels still
  apply to them). The report warns `site_admin_browses_every_track`. The parity test expects
  exactly that for them, and the source's model for everyone else.
- **Inactive people see nothing.** They are deactivated accounts, which cannot sign in, as in
  the source. Like anyone, they can still browse what anonymous visitors may see.
- **Shared writes.** Notification rules are replaced through `notifications/rules.ts`, which the
  routes now use too. Grants keep the `grants_per_permission` guardrail.

## Options considered

| Option | For | Against |
|---|---|---|
| Map system administrators to site administrators, warn (chosen) | Someone can run the instance after the import; the difference is named | They browse every track, which their source role did not imply |
| Map them to configuration administrators | No widening | Nobody imported can manage the site; an administrator must re-grant by hand |
| Keep each identical scheme as its own policy | Simpler | Against IMP-005 (1); forty copies to keep in step |
| Import a ticket without its level when the level fails | The ticket is not lost | It becomes visible to everyone who browses its track |
| Merge identical security or notification schemes too | Fewer objects | Not asked for, and a merged level would need its tickets moved; later if needed |

## Consequences

- Measured on the M1-092 fixture (3,000 issues, seed 92, six projects, six groups): an
  anonymous visitor and all 20 people see exactly the tickets the fixture's model lets them see.
  That is 1,642 for the anonymous visitor, 1,746 to 2,656 for the others, and none for the
  inactive account. Six of the 20 are site administrators. The result is checked with the list
  predicate (`Authorizer.visibleTicketIds`), and one person's tickets are sampled through
  `GET /api/v1/tickets/:key`. 3 access policies (one merged), 2 visibility policies with 5
  levels, 2 notification policies and 6 global grants were imported, and nothing failed.
- Custom events, comment-edited and comment-deleted events and email address recipients are
  warned about; Taskmoor has no counterpart yet. Workflows (M1-090) bring the custom events
  through their transitions.
- Projects without a permission scheme association keep the target's default access policy.
  Data Center's default scheme is the one with id 0, which the reader does not treat specially
  yet.
- Revisit the grantee and event names when a design partner's backup confirms or corrects the
  **Verify** notes.
