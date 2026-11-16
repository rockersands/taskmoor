# ADR-113: Ticket templates

- Status: Accepted
- Date: 2026-11-03
- Backlog: CORE-029, CORE-030 (asked for by the user on 2026-11-02 for 1.0)

## Context

Teams write the same kinds of ticket again and again: a bug report with the same outline, a
release checklist with the same subtickets. The create form could only start from an existing
ticket (M1-052), which copies that ticket's words and leaves people, releases and custom fields
out. People asked for named starting points that an administrator keeps.

A template holds values someone else chose, and the person applying it may hold fewer rights
than that someone. Applying one must never become a way round a permission, a field lock or a
field rule.

## Decision

### What a template holds

One table, `ticket_template` (migration 0085):

- `track_id`: the track, or null for every track. `ticket_type_ids`: the types it fits, empty for
  every type. The name is unique per track ignoring case (`NULLS NOT DISTINCT`, so also among the
  templates for every track). At most 500 per scope.
- `summary`: a pattern. `{date}` is today in the person's time zone (UTC without one), `{track}`
  the track's key, `{user}` the person's name. Any other text stays as written.
- `description`: an outline, a rich text document.
- `defaults`: named as the ticket create route names its body (`priorityId`, `labels`,
  `assigneeId`, `areaIds`, `targetReleaseIds`, `foundInReleaseIds`, `fields`), so a template's
  values meet the same checks as a ticket's. Dates are day offsets (`dueInDays`, `startInDays`),
  so a template made in March still means "in 7 days".
- `subtickets`: at most 50, each a summary pattern and an optional type (else the track's first
  type at the subticket level).

Areas and releases belong to a track, so a template for every track cannot name them
(`track_only`). What refers to the workspace or the track is checked when a template is saved;
what depends on the person or the ticket type (assignability, field contexts, rules) is checked
when a ticket is made.

### Who sees and keeps them

- Track templates are seen by those who browse the track and kept by "Administer track" or
  configuration and site administrators.
- Templates for every track are seen by everyone signed in and kept by configuration and site
  administrators.
- API token scope classes follow the method: reads are read, the rest are write.

### Applying a template

`POST /api/v1/ticket-templates/:id/tickets` runs the ticket create route as the person
(`callRoute`, as clone does, ADR-077). The body is a create body, plus `omit` and `subtickets`:

- The person's values win. A key the body leaves out takes the template's value, unless `omit`
  names it.
- A body value equal to the template's counts as the template's: the form starts from the
  template, and a value left as it was is not the person's choice.
- A template value the route refuses (a field a rule hides, a field locked to other roles, an
  assignment or schedule this person may not make) is left out, the create is tried again, and
  the key is listed in `left`. **The person's own value is refused, never dropped.** `track`,
  `ticketTypeId`, `summary`, `parent` and `visibilityLevelId` are never left out.
- Each subticket is its own create under the new ticket. One that fails is listed with its
  reason, and the ticket stays.

`GET /api/v1/ticket-templates/:id?track=KEY` returns `start`, the values for this person today,
which the web form fills in. The form shows them for review; nothing is created until the person
presses Create.

The form cannot edit people, areas and releases yet, so the template's values for those are
listed under the picker with a checkbox each: there is no field to clear them in.

### People, groups and teams on the template form (T-350)

The template form adds a custom person, group or team value with the create form's picker and the
create form's searches (`apps/web/src/tickets/pickerSources.ts`); no new server search was made.

- A track's template finds people with the track's search. A person field limited to a group or a
  role (CORE-009 (2)) asks `GET /fields/:id/people` once per context that limits it among the
  ticket types the template fits (all of the track's types when it names none), picking each
  type's context as the server does, and offers only those every one of them allows: a ticket
  made from the template can be of any of those types.
- A template for every track has no track, so it finds people with `GET /people/lookup`, which
  those who may change such templates (configuration and site administrators) already use. A
  person field limited in any context has no search there: the server says whom it allows only
  for a track and a type. Such a value is still set through the API.
- Groups and teams are the site's (`GET /fields/:id/groups`, `GET /teams`) everywhere.

A value is still checked only when a ticket is made from the template, as above.

Answered on 2026-11-16 (T-269): the template form's **Assignee** searches with the create form's
assignee search (`/people/mentionable?assignable=true`), so it offers only people a ticket in the
track can be given to; the apply route already left out any other (`not_assignable`).

### Whose names pickers and template starts show (T-278, T-283, T-284)

Answered on 2026-11-16. One rule: a template names a person exactly when the picker that takes the
value would offer that person to the reader.

- **The site's people are the directory.** Only holders of "Browse users and groups" may list
  them: the mention search, an unrestricted custom person field and a group field's picker (group
  names only). `GET /fields/:id/people` for a context that limits no one now answers `403
  forbidden` without the permission (T-278); before, it listed every active person to anyone who
  could browse the track, so taking the permission away did not hide the directory.
- **A list an administrator narrowed** (a person field limited to a group or a track role) goes
  to anyone who may fill the field, with or without the permission: the administrator chose who
  the field may name, and a required limited field must stay fillable on a site that took the
  permission away. `offeredPeople` in `apps/server/src/fields/values.ts` is the one check that
  route and the template start share.
- **The start takes the ticket type** (`GET /ticket-templates/:id?track=KEY&ticketTypeId=N`), as
  apply picks it: the one named, else the template's first when it fits only some; a type it does
  not fit is refused with `ticketTypeId: not_in_template`. Once the type is known, a limited
  field's value is named exactly when its list offers that person there (the field applies to the
  track and type, the person is allowed and active), for every reader, holders of the permission
  included (T-284). Someone no longer allowed is not named, so the form shows the value under
  "Also from this template" like an archived release, instead of filling a picker with a value
  the create route would refuse as `not_allowed`. Without a type, and for unrestricted fields,
  groups and teams, the rule of T-276 stays. The web form sends the type it has.
- **The system assignee** follows the same rule as the custom people (T-283): `assignee` is named
  only to holders of "Browse users and groups" and only for an active person; otherwise it is
  null and the id stays in `defaults.assigneeId`. The create form then lists it under "Also from
  this template" as Assignee; the template form shows it as "Person 21, hidden from you or gone"
  with Remove, and saving keeps it. A deactivated assignee is left out and reported when a ticket
  is made, instead of filling the picker and being refused. `createdBy` stays named to every
  reader, as a ticket's reporter is: no picker is involved.

### Events and audit

There is no template event on apply: each ticket made is its own `ticket.created`, with an
optional `templateId`. A template with N subtickets emits N+1 events, as clone does (ADR-077).
`ticket_template.created`, `.updated` and `.deleted` are in the catalogue and audited; `updated`
records an outline change as document hashes, since an outline can be long.

### Import from a Data Center backup

No import is built. Core backups hold no ticket templates. The template-like things an import
meets are per-context field default values, already imported as field context defaults (M1-090),
and third-party apps' tables, which the importer does not read.

## Options considered

| Option | For | Against |
|---|---|---|
| Run the create route as the person; leave out refused template values | Every check applies by construction, and new checks apply without touching templates | A create can run several times when several values are refused |
| Check the template's values first, then create | One create | A second copy of the permission, lock and rule logic that can drift from the route |
| Refuse the whole create when any template value is refused | Simple, and nothing is silently missing | A template becomes useless for everyone who lacks one right, such as assigning |
| Drop refused values whoever gave them | One rule | A person's own input would vanish without an error |
| A template per track only | Fewer rules | Workspaces would copy the same template into every track |
| Fixed dates in defaults | Simpler | A template's dates would go stale at once |

## Consequences

- A template cannot grant anything: what the person may not do is left out and they are told.
- New rules on the create route apply to templates with no change here.
- Refusals are found by trying, so a template with many refused values costs up to eight attempts
  (`ATTEMPTS`). A refused attempt writes nothing.
- Field values are not fully checked until a template is used: a template can hold a value a
  later change makes invalid, and it is then left out and listed.
- Revisit if people want a template's subtickets to carry more than a summary and a type.
