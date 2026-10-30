---
title: "Fields, ticket types and layouts"
audience: admins
sources: apps/server/src/fields/types.ts, apps/server/src/fields/catalog.ts, apps/server/src/fields/form-model.ts, apps/server/src/fields/layouts.ts, apps/server/src/fields/formulas.ts, apps/server/src/routes/fields.ts, apps/server/src/routes/layouts.ts, apps/server/src/routes/ticket-types.ts, apps/server/src/routes/priorities.ts, apps/server/src/routes/tracks.ts, apps/server/src/routes/tickets.ts, apps/server/src/tickets/hierarchy.ts, apps/server/src/tickets/configuration.ts, packages/formula/src/check.ts, packages/formula/src/lexer.ts, packages/formula/src/program.ts, packages/db/src/migrations/0011_ticket_types.ts, packages/db/src/migrations/0018_ticket_fields.ts, packages/db/src/migrations/0028_field_rules_layouts.ts, apps/web/src/fields/FieldsAdminPage.tsx, apps/web/src/fields/client.ts, apps/web/src/sets/ConfigurationSetsPage.tsx, apps/web/src/sets/client.ts, apps/web/src/i18n/messages.en.ts, docs/adr/0008-field-storage.md, docs/adr/0009-configuration-model.md, docs/specs/01a-core-work-tracking.md
accessed: 2026-10-30
attestation: own-words
---
# Fields, ticket types and layouts

This page covers the fields a ticket holds, the custom fields you add, formula fields, ticket
types and hierarchy levels, and the configuration sets that tell each track which types,
priorities, rules and forms it uses.

In the web app, site administrators use **Settings**, **Fields** and **Settings**,
**Configuration sets**. The rest is done through the [REST API](rest-api.md); a token that
changes shared configuration needs the `admin` scope ([API tokens](api-tokens.md)). Everyone
signed in may read these lists.

## Built-in fields

Field rules and layouts govern these built-in fields, named as the query language names them:

`summary`, `description`, `environment`, `assignee`, `requester`, `parent`, `priority`,
`closeReason`, `labels`, `startDate`, `dueDate`, `targetRelease`, `foundInRelease`, `area`,
`originalEstimate`, `remainingEstimate`.

The summary is always required and always shown: one line of up to 255 characters. Tickets also
have fields that people do not fill in on forms: key, track, ticket type, status, Closed, creator,
created, updated, rank, time spent, visibility level, followers and votes.

Labels are free words, suggested from every label in use as people type. Administrators merge
labels into one with `POST /api/v1/labels/merge` (`{ "labels": [...], "into": "..." }`), which
also renames a label.

## Custom fields

### Field types

A field's type, and whether it holds several values, are fixed when the field is made.

| Type in the web app | API type | Rules |
|---|---|---|
| Short text | `text` | One line, up to 255 characters |
| Paragraph | `paragraph` | Rich text, up to 32,767 characters unless set otherwise (at most 100,000) |
| Number | `number` | From -10^12 to 10^12, rounded to 0.001; `5e3` reads as 5000 |
| Date | `date` | A calendar day |
| Date and time | `datetime` | An instant, stored in UTC |
| Choice list | `select` | Options; one or several |
| Two-level choice list | `cascading-select` | An option and, optionally, one of its child options |
| Person | `user` | One or several people |
| Group | `group` | One or several groups |
| Labels | `labels` | Free words, with the field's own suggestions |
| Web address | `url` | An `http` or `https` address, up to 2,000 characters |
| Read-only text | `read-only-text` | Written only with API tokens and by automation, never from a browser |
| Release | `release` | Releases of the ticket's own track; one or several |
| Area | `area` | Areas of the ticket's own track; one or several |
| Formula | `formula` | Computed; see [formula fields](#formula-fields) |

Through the API, a field's `config` sets how some types behave: `maxChars` for a paragraph;
`format` (`number`, `currency`, `percentage`), `decimals` (0 to 3) and `currency` (a code such
as `EUR`) for a number; `display` (`dropdown`, `radio`, `checkboxes`) for a choice list.

Taskmoor does not yet offer track pickers, teams, checklists or the other types of the full
catalogue.

### Adding and managing fields

On **Settings**, **Fields**, **Add a field** asks for a **Field name**, a **Type** and, for types
that allow it, **Holds several values**. **Manage** on a field offers:

- **Rename**.
- The options of each context of a choice list: a **New option** with **Add the option**,
  **Rename**, **Stop offering**, **Offer again** and **Delete**.
- **Delete field**.

Formula fields, contexts' scopes and defaults, child options of a two-level list and the type
settings above are set through the API (`/api/v1/fields`).

### Contexts and options

A context says where a field applies and what it offers there.

- A context covers tracks and ticket types (`trackIds`, `ticketTypeIds`; `null` for all). A new
  shared field gets one context for every track and type.
- On a ticket, the most specific context wins: track and type, then track, then type, then the
  context for all. Two contexts of one field never cover the same track and type
  (`409 context_overlap`).
- Each context has its own options and default value. A person field's context may limit the
  choice to a group (members of nested groups included) or to the holders of a track role.
- Options keep their ids when renamed, reordered (`PUT .../options/order`) or no longer offered.
  An option that stops being offered stays on the tickets that have it and is refused for new
  values.

Endpoints: `POST /api/v1/fields/:id/contexts` adds a context;
`/api/v1/fields/:id/contexts/:contextId` takes `PATCH` and `DELETE`; options are under
`.../contexts/:contextId/options`, where a child option names its `parentId`.

### Deleting fields and options

A field, an option or a context's options are deleted only once no ticket holds the value, the
trash included; the refusal says how many tickets do. Stop offering an option instead. A field
that a formula reads cannot be deleted until the formula changes.

### Fields of local-mode tracks

A local-mode track's administrators add fields the track owns (`trackId` on create). Their
contexts cover only that track, and nothing about them reaches another track. The guardrail
**Custom fields per track** (700 by default) counts every field that reaches a track.

## Formula fields

A formula field computes its value from other fields. Create one through the API:

```http
POST /api/v1/fields
Content-Type: application/json

{ "name": "Days left", "type": "formula",
  "config": { "expression": "workingDaysUntil({Due date})", "output": "number" } }
```

- **Fields** go in braces by name, `{Points}`, or by id, `{cf[12]}`. Built-in fields: Summary,
  Due date, Start date, Created, Updated, Closed, Original estimate, Remaining estimate and Time
  spent. Of the custom fields, formulas read numbers, dates, dates and times, short text,
  read-only text, web addresses and other formulas; the other types cannot be read yet.
- **Operators**: `+ - * / ^`, `&` to join text, comparisons `= != <> < <= > >=`, and `and`, `or`,
  `not`.
- **Functions**: `if`, `isEmpty`, `ifEmpty`, `sum`, `avg`, `min`, `max`, `count`, `abs`,
  `round`, `floor`, `ceil`, `mod`, `pow`, `sqrt`, `today`, `date`, `daysBetween`,
  `workingDaysBetween`, `workingDaysUntil`, `addDays`, `year`, `month`, `day`, `weekday`,
  `hours`, `minutes`, `text`, `concat`, `upper`, `lower`, `len`.
- **Child tickets**: `sum(children.{Points})`, `count(children)`, `max(children.{Due date})`.
- **Outputs**: `number`, `currency`, `percentage` (40 means 40%), `date`, `duration`, `text`.
  The formula's type must fit the output.
- **Working days** follow the time tracking setting's days per week, counted from Monday, in UTC.
  There is no holiday calendar. Once a due date has passed, `workingDaysUntil` is negative.

A mistake is refused on save with its place (`400 invalid_formula`), and so are formulas that
need each other's values. `GET /api/v1/formulas/check?expression=...&output=...` answers the same
while you type. A formula is at most 4,000 characters.

Values are computed in the same change as the ticket write that affects them, then for the
parent's roll-ups. A new or changed formula recomputes every ticket in the background. Nobody
writes a formula's value, no rule makes it required, and create forms do not show it. A broken
calculation, such as a division by zero, gives an empty value rather than an error.

## Ticket types and hierarchy levels

A fresh site has these ticket types:

| Ticket type | Level | Description |
|---|---|---|
| Outcome | 1, Outcome | A result that several tickets deliver together |
| Feature | 0, Standard | Something new or better for the people who use the product |
| Bug | 0, Standard | Something that does not work as it should |
| Chore | 0, Standard | Work that has to be done but changes nothing people see |
| To-do | 0, Standard | A piece of work to get done |
| Idea | 0, Standard | A possible improvement to explore before committing to it |
| Subticket | -1, Subticket | A smaller part of another ticket |

There is no web page for ticket types or levels yet. Through the API:

- `/api/v1/ticket-types`: `name`, `description`, `icon`, `color`, `levelId`, and `trackId` for a
  type a local-mode track owns. A type is deleted only once no type set holds it.
- `/api/v1/hierarchy-levels`: add levels above Outcome (2, 3 and up), rename any level, move or
  remove the added ones. Removing a level moves its types to the standard level. The three
  built-in levels are renamed but never moved or removed.
- `GET /api/v1/hierarchy-levels/impact` shows what a change would do. A change that would break
  a parent link is refused with that impact.

A ticket's parent sits exactly one level higher. A subticket always has a parent in its own
track.

## Type sets

A type set lists the ticket types a track offers, in order, with one preselected.

| Type set | Types | Preselected | Default for |
|---|---|---|---|
| Software type set | Outcome, Feature, Bug, Chore, Subticket | Feature | software tracks |
| Business type set | Outcome, To-do, Subticket | To-do | business and service tracks |
| Discovery type set | Idea | Idea | discovery tracks |

On **Settings**, **Configuration sets**, **Type sets**: **Add a type set** with a **Type set
name** and the **Ticket types in the set**. **Manage** changes the types; **Save the set** and
**Delete set** (not for a default set, nor one a track uses). The preselected type, the order and
which track types a set is the default for are set through `/api/v1/type-sets`
(`defaultTypeId`, `ticketTypeIds`, `defaultFor`).

Dropping a type that tickets in the set's tracks still have is refused (`type_in_use`). Through
the API, give `ticketTypeMapping` from each dropped type's id to a type the set keeps at the
same level, and the tickets change type with the set.

## Field rules

A field rule set says, per field, whether it is required or hidden and what help text it shows.

On **Settings**, **Configuration sets**, **Field rule sets**: **Add a field rule set**, then
**Manage** it. Each field has **Required**, **Hidden** and **Help text**, for every ticket type.
**Save the set** saves them; rules for single ticket types are kept as they are.

- A rule for the ticket's type wins over the rule for every type. A field without a rule is
  optional and shown.
- A field is never required and hidden at once, and the summary is never made optional or
  hidden.
- A hidden field is not shown, and writing it is refused; its stored value stays.
- A required field must have a value when a ticket is created, cannot be emptied by an edit,
  and must be filled in when a transition asks for it.

Through `/api/v1/field-rule-sets`, a rule can also name a `ticketTypeId`, and `editableBy`: the
roles and groups that alone may set the field (`[{ "roleId": 2 }, { "groupId": 5 }]`). A field
limited to some editors is neither required nor hidden. A save replaces all of a set's rules at
once.

## Layouts and layout sets

A layout set arranges the create, edit and view forms, per ticket type or for every type. There
is no web page for layout sets yet; use `/api/v1/layout-sets`.

```json
{
  "ticketTypeId": null,
  "operation": "create",
  "definition": {
    "tabs": [
      { "name": "Details", "sections": [
        { "kind": "main", "fields": ["summary", "description", "priority"] },
        { "kind": "context", "hideWhenEmpty": true, "fields": ["assignee", "dueDate", "cf[12]"] }
      ] }
    ],
    "others": "show"
  }
}
```

- A layout has up to 20 tabs of up to 20 sections. A section is `main` or `context` (the column
  beside the main one); `hideWhenEmpty` hides it on view when none of its fields has a value.
- `others` says whether fields the layout does not place follow it (`show`) or not (`omit`).
- Without a layout, a form shows every field that applies, in one tab. Hidden fields never
  appear, and required fields always do.
- `GET /api/v1/tracks/:id/layout?ticketTypeId=` shows the form a track gives.

Fields asked for on a transition are set on the transition itself; see
[workflows](workflows.md#transitions).

## Priorities and priority sets

Priorities are the site's ordered list: Urgent, High, Normal and Low on a fresh site. There is
no web page for them yet.

- `/api/v1/priorities`: `name`, `description`, `icon`, `color`; `PUT /api/v1/priorities/order`
  lists every id in the new order. A new priority joins the default priority set.
- `/api/v1/priority-sets`: `priorityIds` and `defaultPriorityId`, the priority new tickets get.
  The **Default priority set** offers every priority, with Normal as the default; `isDefault`
  makes another set the default. Deleting a set sends its tracks back to the default.
- Deleting a priority that tickets use needs `?replacementId=`: the tickets take it, and the
  sets that offered the old one offer the replacement.

## Close reasons

Close reasons are the site's ordered list: Completed, Not planned, Duplicate and Not reproducible
on a fresh site. They are managed through `/api/v1/close-reasons` (`name`, `description`), with
`PUT /api/v1/close-reasons/order`, and a deleted reason in use needs `?replacementId=`.

Setting a close reason needs the permission **Set the close reason**. It stamps the ticket's
Closed time; clearing it clears the stamp. Workflows set it through a transition's fields or an
effect; see [workflows](workflows.md).

## Configuration sets and tracks

A track names the sets it uses; `null` means the site's default. Type sets, field rule sets,
layout sets and workflow maps list the tracks that use them, and saving a shared set changes
every one of those tracks.

| Set | Track setting | Default on a fresh site | Managed in the web app under |
|---|---|---|---|
| Type set | `typeSetId` | The track type's default set | **Configuration sets** |
| Field rule set | `fieldRuleSetId` | Default field rules | **Configuration sets** |
| Layout set | `layoutSetId` | Default layouts | API only |
| Priority set | `prioritySetId` | Default priority set | API only |
| Workflow map | `workflowMapId` | Default workflow map | **Workflow maps** |
| Access policy | `accessPolicyId` | Default access policy | **Permissions** |
| Visibility policy | `visibilityPolicyId` | None | API only |
| Notification policy | `notificationPolicyId` | The site's default | API only |

- A shared set is changed by site and configuration administrators. A local-mode track owns its
  type set, access policy and workflow map, and may own field rule and layout sets (`trackId` on
  create) that name shared fields or its own; its administrators change them.
- A default set and a set that a track uses are not deleted.
- [Tracks](tracks.md#configuration-sets) says how a track switches sets, and
  [permissions and access](permissions.md) and
  [email and notification policies](notifications.md) cover the policies.
