---
title: "Fields, ticket types and layouts"
audience: admins
sources: apps/web/src/configuration/TrackSetsPage.tsx, apps/web/src/configuration/trackSetsClient.ts, apps/server/src/fields/types.ts, apps/server/src/fields/catalog.ts, apps/server/src/fields/form-model.ts, apps/server/src/fields/layouts.ts, apps/server/src/fields/formulas.ts, apps/server/src/routes/fields.ts, apps/server/src/routes/layouts.ts, apps/server/src/routes/ticket-types.ts, apps/server/src/routes/priorities.ts, apps/server/src/routes/tracks.ts, apps/server/src/routes/tickets.ts, apps/server/src/tickets/hierarchy.ts, apps/server/src/tickets/configuration.ts, packages/formula/src/check.ts, packages/formula/src/lexer.ts, packages/formula/src/program.ts, packages/db/src/migrations/0011_ticket_types.ts, packages/db/src/migrations/0018_ticket_fields.ts, packages/db/src/migrations/0028_field_rules_layouts.ts, packages/db/src/migrations/0092_very_low_priority.ts, apps/web/src/fields/FieldsAdminPage.tsx, apps/web/src/fields/client.ts, apps/web/src/sets/ConfigurationSetsPage.tsx, apps/web/src/sets/client.ts, apps/web/src/layouts/LayoutEditorPage.tsx, apps/web/src/layouts/LayoutCanvas.tsx, apps/web/src/layouts/GripMenu.tsx, apps/web/src/layouts/LayoutPreview.tsx, apps/web/src/layouts/refusal.ts, apps/web/src/layouts/model.ts, apps/web/src/layouts/client.ts, docs/adr/0114-glass-interface-and-clear-sections.md, apps/web/src/i18n/messages.en.ts, docs/adr/0008-field-storage.md, docs/adr/0009-configuration-model.md, docs/specs/01a-core-work-tracking.md, apps/server/src/tickets/priority-level.ts, packages/db/src/migrations/0095_points_field.ts
accessed: 2026-11-03
attestation: own-words
---
# Fields, ticket types and layouts

This page covers the fields a ticket holds, the custom fields you add, formula fields, ticket
types and hierarchy levels, and the configuration sets that tell each track which types,
priorities, rules and forms it uses.

In the web app, site and configuration administrators use **Administration**, **Fields**,
**Administration**, **Configuration sets** and **Administration**, **Layout sets**. The rest is done through the [REST API](rest-api.md); a token that
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

### The Points field

A workspace starts with a shared number field called **Points**, stored under that name and shown as
**Puntos** to someone using Taskmoor in Spanish. It covers every track and ticket type, so it is on
the forms and in search like any custom field you add. Boards of new tracks estimate with it; their
[sprint settings](../use/boards.md#sprint-settings) choose another statistic if you prefer.

- **Rename it** and it stays the field boards estimate with, including new tracks' boards. Its own
  name then shows as you wrote it, in every language.
- **Remove it** once no ticket holds a value, as with any field. Boards that estimated with it go back
  to the original time estimate, and it does not come back on its own.

On upgrade, a workspace that already has a shared number field named Points or Puntos, or under the
name an imported one usually has, keeps it and gets no second one (the oldest counts, if it has
several). The boards that follow are
those on the default statistic, unless the track's tickets already hold time estimates; a board that
names a field or counts tickets stays as it is. If a shared field of another type is already called
Points, no field is made and the boards stay as they are. Tickets keep their values.

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
| Team | `team` | One of the site's [teams](people-and-groups.md#teams); one value |

Through the API, a field's `config` sets how some types behave: `maxChars` for a paragraph;
`format` (`number`, `currency`, `percentage`), `decimals` (0 to 3) and `currency` (a code such
as `EUR`) for a number; `display` (`dropdown`, `radio`, `checkboxes`) for a choice list.

Taskmoor does not yet offer track pickers, checklists or the other types of the full
catalogue. The web page that makes a ticket does not yet offer people, group, team, release or
area values; set them through the API, a CSV import or bulk changes.

### Adding and managing fields

On **Administration**, **Fields**, **Add a field** asks for a **Field name**, a **Type** and, for types
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
  type a local-mode track owns. A type is deleted only once no type set holds it. `icon` is a
  name: `outcome`, `feature`, `bug`, `chore`, `to-do`, `idea` or `subticket` draw that icon, and
  any other shows a plain hexagon; with none, a type named like one of those draws its icon.
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

On **Administration**, **Configuration sets**, **Type sets**: **Add a type set** with a **Type set
name** and the **Ticket types in the set**. **Manage** changes the types; **Save the set** and
**Delete set** (not for a default set, nor one a track uses). The preselected type, the order and
which track types a set is the default for are set through `/api/v1/type-sets`
(`defaultTypeId`, `ticketTypeIds`, `defaultFor`).

Dropping a type that tickets in the set's tracks still have is refused (`type_in_use`). Through
the API, give `ticketTypeMapping` from each dropped type's id to a type the set keeps at the
same level, and the tickets change type with the set.

## Field rules

A field rule set says, per field, whether it is required or hidden and what help text it shows.

On **Administration**, **Configuration sets**, **Field rule sets**: **Add a field rule set**, then
**Manage** it. Each field has **Required**, **Hidden** and **Help text**, for every ticket type.
**Save the set** saves them; rules for single ticket types are kept as they are.

- A rule for the ticket's type wins over the rule for every type. A field without a rule is
  optional and shown.
- A field is never required and hidden at once, and the summary is never made optional or
  hidden.
- A hidden field is not shown, and writing it is refused; its stored value stays.
- A required field must have a value when a ticket is created, cannot be emptied by an edit,
  and must be filled in when a transition asks for it.

Field rules and layouts work together, and each page says so and links to the other. A layout
decides where a field appears and in what order; a rule decides whether it is required, hidden or
has help text. A hidden field never appears, even where a layout places it, and a required field
always does: after the placed ones when a layout leaves it out.

Through `/api/v1/field-rule-sets`, a rule can also name a `ticketTypeId`, and `editableBy`: the
roles and groups that alone may set the field (`[{ "roleId": 2 }, { "groupId": 5 }]`). A field
limited to some editors is neither required nor hidden. A save replaces all of a set's rules at
once.

## Layouts and layout sets

A layout set arranges the create, edit and view forms, per ticket type or for every type. A form
uses its type's own layout, else the set's layout for every type; with neither, it shows every
field that applies, in one tab.

### The Layout sets page

**Administration** > **Layout sets** (`#/admin/layouts`), for site and configuration
administrators:

1. Pick the **Layout set**, or type a **New set name** and press **Add a layout set**. While a
   set has unsaved changes the list and adding a set are locked: save or discard first.
2. Under **Form**, choose the **Ticket type** (or **Every ticket type**) and the operation:
   **Create**, **Edit** or **View**. A line says which layout that form uses now. A type with a
   layout of its own is marked **(own layout)** in the list.
3. **Make a layout for this form** starts one tab, **Details**, with a main and a side column.
   For one type, **Make its own layout from the one for every type** starts from a copy of that.
   **Remove this type's layout** sends the type back to the layout for every type.
4. Put fields in place. **Fields not placed** lists the rest. Each field, section and tab has a
   grip (six dots):
   - Drag the grip with a mouse or a finger: a field into a section, onto another field to go
     beside it, or back to **Fields not placed** to take it off; a section onto another section or
     into another tab; a tab onto another tab. Near the top or bottom of the window, a drag
     scrolls the page.
   - Or press the grip (Enter or Space) for a menu of the same moves: **Move earlier**, **Move
     later**, **Move to** a section or a tab, **Put in** a section, **Take off the layout**.
   - Or hold Alt and press an arrow key on a grip: a field moves one place, and from the end of a
     section into the next one; a section moves within its tab; a tab moves among the tabs.
   Screen readers hear where each move left the field, section or tab.
5. **Add a tab** and **Add a section** (up to 20 of each), rename a tab in **Tab name**, set a
   section's **Column** (main or side) and **Hide when empty**, and **Remove** a tab or section;
   its fields go back to **Fields not placed**.
6. **Show only the fields I placed** leaves the other fields off the form; required ones still
   appear.
7. **Save the layouts** sends the set's layouts as a whole, and the server checks them as it
   checks any save. **Discard changes** goes back to what was saved. **Delete set** removes a set
   that is not the default and that no track uses.

The **Preview** beside or under the layout shows the form as the server will give it, with the
field rules applied, and follows each change before you save. **Preview as** picks the ticket type
when you edit the layout for every type; **Fields and rules of** picks a track that uses the set,
since tracks can differ in custom fields and rules, or none for the shared fields and the default
rules. Under the form it lists fields you placed that this form leaves out, and why: a rule hides
it, it does not apply to that type there, or its value is computed, so a create form has nothing
to enter. When the server would refuse the layout as it stands, the preview says why in your
language and keeps the last form it could show; a refused save says why in the same words.

A local-mode track's own layout sets are on the same page, marked **(a track's own)**: they
place the shared fields and the track's own, and the preview starts on that track. Its
administrators who are not site or configuration administrators change them through the API.

### Through the API

`/api/v1/layout-sets` takes and gives each layout like this:

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
- `POST /api/v1/layout-sets/:id/preview` with `ticketTypeId`, `operation`, an optional `trackId`
  (`null` for none) and optional draft `layouts` answers the form they would give, the fields
  placed but left out with the reason, and the custom fields named. It checks a draft as a save
  would and stores nothing, so a token with the `read` scope may call it. Anyone who reads the set
  may preview its saved layouts; draft `layouts` come only from those who may change the set
  (`403` otherwise). A ticket type of a local-mode track you do not see is `unknown_ticket_type`,
  as one that does not exist is.

Fields asked for on a transition are set on the transition itself; see
[workflows](workflows.md#transitions).

## Priorities and priority sets

Priorities are the site's ordered list: Urgent, High, Normal, Low and Very low on a fresh site. There is
no web page for them yet.

- `/api/v1/priorities`: `name`, `description`, `icon`, `color`; `PUT /api/v1/priorities/order`
  lists every id in the new order. A new priority joins the default priority set. The list, and a
  ticket's `priority`, also give `level`, from 1 to 6: which icon it shows, from its place in the
  order. The stored `icon` and `color` of a priority do not change what lists draw.
- A ticket always has a priority. A new ticket takes its track's set's `defaultPriorityId`; a set
  with no default gives the middle of what it offers. `priorityId: null` means the same when
  creating, and an edit that sends it is refused. Only imports leave it empty, as their source
  did; `priority IS EMPTY` finds those. Upgrading added Very low only to lists that were still
  the original four by name and order, and gave the default to tickets with none, except imported
  ones, without a line in their history.
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
| Layout set | `layoutSetId` | Default layouts | **Layout sets**; chosen on **Which sets a track uses** |
| Priority set | `prioritySetId` | Default priority set | Chosen on **Which sets a track uses**; made through the API |
| Workflow map | `workflowMapId` | Default workflow map | **Workflow maps** |
| Access policy | `accessPolicyId` | Default access policy | **Permissions** |
| Visibility policy | `visibilityPolicyId` | None | Chosen on **Which sets a track uses**; made on **Visibility policies** |
| Notification policy | `notificationPolicyId` | The site's default | Chosen on **Which sets a track uses**; made through the API |

### Which sets a track uses

**Administration** > **Which sets a track uses** (`#/admin/track-sets`), for site and configuration
administrators, chooses a track's **Layouts**, **Priorities**, **Visibility policy** and
**Notifications**. Pick the **Track**, change what you want and press **Save**; only what changed is
sent. Each list holds the shared sets and a local-mode track's own, marked **(its own)**. The first
choice in each list is the default, which for a visibility policy means none. **Manage** on the
**Tracks** page has a link here for that track.

Changing the visibility policy moves tickets at a level the new policy lacks to its default level, so
some may become visible to more people.

### Who changes a set

- A shared set is changed by site and configuration administrators. A local-mode track owns its
  type set, access policy and workflow map, and may own field rule and layout sets (`trackId` on
  create) that name shared fields or its own; its administrators change them.
- A default set and a set that a track uses are not deleted.
- [Tracks](tracks.md#configuration-sets) says how a track switches sets, and
  [permissions and access](permissions.md) and
  [email and notification policies](notifications.md) cover the policies.
