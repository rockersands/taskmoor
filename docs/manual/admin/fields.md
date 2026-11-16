---
title: "Fields, ticket types and layouts"
audience: admins
sources: apps/web/src/configuration/TrackSetsPage.tsx, apps/web/src/configuration/trackSetsClient.ts, apps/server/src/fields/types.ts, apps/server/src/fields/catalog.ts, apps/server/src/fields/form-model.ts, apps/server/src/fields/layouts.ts, apps/server/src/fields/formulas.ts, apps/server/src/routes/fields.ts, apps/server/src/routes/layouts.ts, apps/server/src/routes/ticket-types.ts, apps/server/src/routes/priorities.ts, apps/server/src/workflows/close-reasons.ts, apps/server/src/routes/tracks.ts, apps/server/src/routes/tickets.ts, apps/server/src/tickets/hierarchy.ts, apps/server/src/tickets/configuration.ts, packages/formula/src/check.ts, packages/formula/src/lexer.ts, packages/formula/src/program.ts, packages/db/src/migrations/0011_ticket_types.ts, packages/db/src/migrations/0018_ticket_fields.ts, packages/db/src/migrations/0028_field_rules_layouts.ts, packages/db/src/migrations/0092_very_low_priority.ts, apps/web/src/fields/FieldsAdminPage.tsx, apps/web/src/fields/client.ts, apps/web/src/sets/ConfigurationSetsPage.tsx, apps/web/src/sets/client.ts, apps/web/src/layouts/LayoutEditorPage.tsx, apps/web/src/layouts/LayoutCanvas.tsx, apps/web/src/layouts/GripMenu.tsx, apps/web/src/layouts/LayoutPreview.tsx, apps/web/src/layouts/refusal.ts, apps/web/src/layouts/model.ts, apps/web/src/layouts/client.ts, docs/adr/0114-glass-interface-and-clear-sections.md, apps/web/src/i18n/messages.en.ts, docs/adr/0008-field-storage.md, docs/adr/0009-configuration-model.md, docs/specs/01a-core-work-tracking.md, apps/server/src/tickets/priority-level.ts, packages/db/src/migrations/0095_points_field.ts, apps/web/src/sets/trackScope.tsx, apps/web/src/trackpeople/TrackPeoplePage.tsx, apps/server/src/workflows/board-managed.ts, apps/web/src/layouts/createForm.ts, apps/web/src/tickets/form.ts, apps/server/src/fields/values.ts, apps/server/src/import/load.ts, apps/web/src/priorities/PrioritiesPage.tsx, apps/web/src/priorities/PrioritySetsSection.tsx, apps/web/src/priorities/client.ts, apps/web/src/sets/TypeSetForm.tsx, apps/web/src/tickettypes/TicketTypesPage.tsx, apps/web/src/tickettypes/client.ts, apps/web/src/shell/TicketIcons.tsx, apps/web/src/fields/FieldPanel.tsx, apps/web/src/fields/ContextsSection.tsx, apps/web/src/fields/OptionList.tsx, apps/web/src/fields/FormulaEditor.tsx, apps/web/src/fields/formulaWords.ts, apps/web/src/fields/FieldSettings.tsx, apps/web/src/fields/numberFormat.ts, apps/web/src/fields/defaultValue.ts, apps/web/src/tickets/defaults.ts, apps/web/src/search/columns.ts, apps/web/src/tickets/view/TicketPage.tsx, apps/web/src/notifications/NotificationPoliciesPage.tsx, apps/web/src/configuration/WorkflowMapsPage.tsx, apps/web/src/permissions/VisibilityPage.tsx, apps/web/src/sets/OwnTypesSection.tsx, apps/web/src/labels/LabelsPage.tsx, apps/web/src/labels/client.ts, apps/web/src/shell/DangerAction.tsx
accessed: 2026-11-16
attestation: own-words
---
# Fields, ticket types and layouts

This page covers the fields a ticket holds, the custom fields you add, formula fields, ticket
types and hierarchy levels, and the configuration sets that tell each track which types,
priorities, rules and forms it uses.

In the web app, site and configuration administrators use **Administration**, **Fields**,
**Administration**, **Ticket types**, **Administration**, **Configuration sets**,
**Administration**, **Layout sets**, **Administration**,
[**Priorities**](#priorities-and-priority-sets) and **Administration**,
[**Labels**](#merging-and-renaming-labels). The people
who run a track with its own configuration (local mode) change that track's own sets, ticket types
and fields on its own pages; see [A track's own sets](#a-tracks-own-sets). The rest is done through the
[REST API](rest-api.md); a token that changes shared configuration needs the `admin` scope
([API tokens](api-tokens.md)). Everyone signed in may read these lists. With no custom field yet,
the **Fields** page says so and what one is for.

## Built-in fields

Field rules and layouts govern these built-in fields, named as the query language names them:

`summary`, `description`, `environment`, `assignee`, `requester`, `parent`, `priority`,
`closeReason`, `labels`, `startDate`, `dueDate`, `targetRelease`, `foundInRelease`, `area`,
`originalEstimate`, `remainingEstimate`.

The summary is always required and always shown: one line of up to 255 characters. Tickets also
have fields that people do not fill in on forms: key, track, ticket type, status, Closed, creator,
created, updated, rank, time spent, visibility level, followers and votes.

Labels are free words, suggested from every label in use as people type. Site and configuration
administrators merge and rename them on **Administration** > **Labels**.

### Merging and renaming labels

When people write one idea in several ways, such as `front-end`, `frontend` and `FE`, merge them.
Site and configuration administrators do it on **Administration** > **Labels** (`#/admin/labels`),
in the **Tracks and setup** group. Anyone else who opens the page, someone who runs a track
included, is told only that it is for administrators: the labels are the whole site's.

- **Labels on this site** lists the labels people are offered, in the order the suggestions show
  them, 50 at a time with **Show more labels**, each with how many tickets have it. The count
  includes tickets in the trash, which a merge changes too. A label no ticket has any more shows
  **No tickets** and is still suggested until you merge it into another. **Find labels that start
  with** narrows the list, ignoring case.
- Tick the labels to change, then type under **They become** the label they turn into: one already
  in use, to merge them into it, or a new word, to rename them. A label is one word of up to 255
  characters, with no spaces. Case counts: `FE` and `fe` are two labels, and merging one into the
  other makes them one. Ticks stay while you search, so labels found by different beginnings go
  into one merge; **Clear the ticks** takes them all off. One merge takes at most 100 labels.
- **Merge**, or **Rename** when one label changes, asks first and says what will happen: the
  tickets that have them (at most as many as their counts add up to) get the new label in their
  place, once each. It cannot be undone. **Merge into …**, or **Rename … to …**, does it, and the
  page says how many tickets changed. Changing the ticks or the word while it asks puts the
  question away: press **Merge** or **Rename** again to be asked about the merge as it is now.
- Each ticket that changed records it in its history, as your change, and the labels merged away
  are no longer suggested.

Through the API, `POST /api/v1/labels/merge` with `{ "labels": [...], "into": "..." }` does the
same and answers with the labels merged and the `ticketCount`; `GET /api/v1/labels/usage` (`q`,
`after`, `limit` up to 100) lists the labels with their `ticketCount`, a page at a time. Both are
for site and configuration administrators.

## Custom fields

### The Points field

A site starts with a shared number field called **Points**, stored under that name and shown as
**Puntos** to someone using Taskmoor in Spanish. It covers every track and ticket type, so it is on
the forms and in search like any custom field you add. Boards of new tracks estimate with it; their
[sprint settings](../use/boards.md#sprint-settings) choose another statistic if you prefer.

- **Rename it** and it stays the field boards estimate with, including new tracks' boards. Its own
  name then shows as you wrote it, in every language.
- **Remove it** once no ticket holds a value, as with any field. Boards that estimated with it go back
  to the original time estimate, and it does not come back on its own.

On upgrade, a site that already has a shared number field named Points or Puntos, or under the
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
| Release | `release` | Releases of the ticket's own track; one or several. An archived one stays on the tickets that have it, but no ticket takes it anew (a CSV import still may) |
| Area | `area` | Areas of the ticket's own track; one or several, archived ones as for releases |
| Formula | `formula` | Computed; see [formula fields](#formula-fields) |
| Team | `team` | One of the site's [teams](people-and-groups.md#teams); one value |

Some types have settings, a field's `config` in the API:

- A paragraph's **Most characters** (`maxChars`, 1 to 100,000; 32,767 when left empty).
- How a number **Shows as**: **Number**, **Currency** or **Percentage** (`format`), with
  **Decimals** (`decimals`, 0 to 3, or **As typed**) and, for a currency, its **Currency code**
  (`currency`, three letters such as `EUR`). The value stored is the same whatever the format,
  and a percentage stores 40 for 40%. The ticket page and the columns of search results and of a
  plan's Grid show the number that way, in the reader's language: `1234.5` as **€1,234.50**. Under
  a number box that someone may change, the ticket page writes the value that way. A formula's
  number, currency and percentage outputs show the same way.
- A choice list's `display` (`dropdown`, `radio`, `checkboxes`) is kept for the API and imports.
  The web app always shows a list, so the Fields page leaves it as it is.

Taskmoor does not yet offer track pickers, checklists or the other types of the full
catalogue. The form that makes a ticket offers pickers for person, group, team, release and area
fields, as the ticket page does.

### Adding and managing fields

On **Administration**, **Fields**, **New field** opens the form; **Add a field** asks for a
**Field name**, a **Description**, a **Type** and, for types that allow it, **Holds several
values**, then the type's settings above, or for a formula its [editor](#formula-fields). Forms
show a field's description under it, unless a field rule gives help text of its own. The list
shows each field's type and description. **Manage** on a field offers:

- Its **Field name** and **Description**, with **Save the name and description**.
- **Settings of** the field, for a paragraph or a number, with **Save the settings**; or the
  **Formula of** a formula field, with **Save the formula**. The page sends the settings whole,
  as the API replaces them.
- **Where it applies**: the field's contexts, described below.
- **Delete field**, in the danger colour, asks first: its field rules go with it and layouts stop
  showing it.

### Contexts and options

A context says where a field applies and what it offers there.

- A context covers tracks and ticket types (`trackIds`, `ticketTypeIds`; `null` for all). A new
  shared field gets one context for every track and type.
- On a ticket, the most specific context wins: track and type, then track, then type, then the
  context for all. Two contexts of one field never cover the same track and type
  (`409 context_overlap`).
- Each context has its own options and default value. A person field's context may limit the
  choice to a group (members of nested groups included) or to the holders of a track role. Such a
  field offers its own people to anyone who can fill it; a person field with no limit offers the
  site's people only to those with **See people and groups**.
- Options keep their ids when renamed, reordered (`PUT .../options/order`) or no longer offered.
  An option that stops being offered stays on the tickets that have it and is refused for new
  values.

On the Fields page, **Where it applies** lists a field's contexts. Each says what it covers, such
as **Every track; every ticket type** or **Tracks: Payments; ticket types: Bug**, and for a person
field whom it offers (**People to choose from**). Each context has:

- **Change**: its **Context name**; its **Tracks**, **Every track** or **Only these tracks**, ticked
  in a list; its **Ticket types** the same way; and for a person field, under **People to choose
  from**, **Offer** **Anyone**, **The members of a group** or **The holders of a track role**. A field
  of a local-mode track covers that track only, and the form says so instead of listing tracks.
  A track moved to the trash stays in a context's list but cannot be chosen, so the form says that
  saving leaves it out. **Save the context**; a change that would cover a track and type another
  context covers is refused in words.
- **Delete**, which asks first. The context's default and options go with it, and its tracks and
  ticket types fall to the field's other contexts. Deleting the last one is allowed, and the
  question says that the field then applies nowhere until a context is added. A context whose
  options tickets hold is not deleted; the refusal says how many tickets.
- **Default value**: what a new ticket's field holds when the create form leaves it as it starts.
  A choice list chooses among the options it still offers (several, when the field holds
  several); a two-level list an option and, if wanted, a **Default child option**; person, group
  and team fields pick by name; the other types take what is typed, labels separated by spaces.
  **Save the default**; **Remove the default** leaves none. A default that names an option no
  longer offered keeps it until it is saved again: the form names that option and leaves it out
  when saving. Release, area, read-only text and formula fields take no default, and the page says
  so.
- For a choice list, its options: a **New option** with **Add the option**, **Up** and **Down** to
  reorder them, **Rename**, **Stop offering**, **Offer again** and **Delete**; the default is
  marked **Default**. An option a ticket holds, in the trash too, is not deleted: the page says
  how many tickets hold it, and **Stop offering** is the way instead. Deleting an unused option
  goes at once, since typing its name brings it back, unless it takes more with it: its child
  options, or the context's default. Then **Delete**, in the danger colour, asks first and says
  which. Under each option of a two-level list are its child options, with the same actions and
  **New child option** with **Add the child option**.

**New context** opens a form with the same choices, and **Add a context** adds it.

The create form starts each field with its context's default, so it shows what the ticket would
get; a field emptied there is sent empty, and the ticket gets no default for it.

Endpoints: `POST /api/v1/fields/:id/contexts` adds a context;
`/api/v1/fields/:id/contexts/:contextId` takes `PATCH` and `DELETE`; options are under
`.../contexts/:contextId/options`, where a child option names its `parentId`.

### Deleting fields and options

A field, an option or a context's options are deleted only once no ticket holds the value, the
trash included; the refusal says how many tickets do. Stop offering an option instead. A field
that a formula reads cannot be deleted until the formula changes.

### Fields of local-mode tracks

A local-mode track's administrators add fields the track owns on the track's own **Fields** page
(`#/manage/tracks/<id>/fields`, see [A track's own sets](#a-tracks-own-sets)), or through the REST
API with `trackId` on create. Their contexts cover only that track, and nothing about them reaches
another track. The shared **Fields** page is for site and configuration administrators: someone
who runs tracks but is no administrator finds there only links to the tracks they run with their
own configuration, and anyone else is told only that they may not. The guardrail **Custom fields
per track** (700 by default) counts every field that reaches a track.

## Formula fields

A formula field computes its value from other fields. On **Administration**, **Fields**, choose
**Formula** as the **Type** under **New field**; **Manage** on a formula field changes it. The
editor has:

- the **Expression**;
- the **Output**: **Number**, **Currency**, **Percentage**, **Date**, **Duration** or **Text**, with
  **Decimals** and a **Currency code** where the output takes them;
- a line under the expression that checks it while you type: what it gives and the fields it
  reads, or where it is wrong, such as **Line 1, column 7: No field is called {Pionts}, or a
  formula here cannot see it.**, in your language. A save that is refused says the same;
- **What a formula can use**, which lists the fields it can read, in braces, and its functions.

Through the API:

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

On **Administration**, **Ticket types**, site and configuration administrators see the levels as
the page's headings, top first, each with the shared ticket types that sit at it, under the
names they are stored with. Anyone else who opens the page is told only that they may not.

- **New level** adds a level with a **Level name**, a **Description** and **Where it goes**:
  above Outcome or above a level added there, the top by default. A level put between two
  others moves the ones above it up by one, so it is refused when tickets of those levels would
  lose a valid parent.
- **Rename** on a level changes its name and description. The three built-in levels, Outcome,
  Standard and Subticket, are never moved or removed.
- **Up** and **Down** move an added level among the added ones.
- **Remove level**, on an added level, asks first and says what it would do: which types fall to
  the standard level (the page's own types by name, and how many types of tracks with their own
  configuration go with them) and how many tickets change level. While removing it would break a parent
  link, it is not offered, and the level says how many links would break.
- **New ticket type** adds a type with a **Ticket type name**, a **Description**, its **Level**
  and an **Icon**: one of the seven shapes (Outcome, Feature, Bug, Chore, To-do, Idea and
  Subticket) or a plain hexagon.
- **Manage** on a type changes the same settings; **Save the type**. Choosing another level says
  first how many of its tickets would change level, or why it would be refused. **Delete ticket type**
  asks first. A type still in a type set is kept, and the page names the sets; so is a type that
  tickets still have, with their number.

A change that would break a parent link is refused, with the number of links it would break and
of tickets it would leave at the subticket level without a parent, and nothing changes. A type's
colour is stored but nothing draws it, so it has no control on the page. A local-mode track's
own types are not listed here: its administrators make them on the track's own **Configuration
sets** page, under **Its own ticket types** (see [A track's own sets](#a-tracks-own-sets)), or
through the API (`trackId`).

Through the API:

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

On **Administration**, **Configuration sets**, **Type sets**: **New type set** opens the form;
**Add a type set** with a **Type set name**, the **Ticket types in the set**, their **Order in the
set** (**Up** and **Down** on each; a type ticked goes to the end), the **Preselected type** (or
none, and the create form then takes the first in the order) and, under **Default set for new
tracks of these kinds**, the kinds of track it is the default for. **Manage** changes the same;
**Save the set** and **Delete set**, which asks first (not for a default set, nor one a track
uses). A kind the set is already the default for stays ticked: tick it on another set, which
takes it over. A default set says what it is the default for, such as **Default for software
tracks**. Through the API these are `ticketTypeIds` (in order), `defaultTypeId` and `defaultFor`
on `/api/v1/type-sets`.

Dropping a type that tickets in the set's tracks still have is refused at first (`type_in_use`),
and the set asks, under **Tickets of the types you drop**, which type each dropped type's tickets
take: one the set keeps, at the same level. **Save the set** again and the tickets change type
with the set, in one change in each ticket's history; a ticket whose status the new type's
workflow lacks takes that workflow's initial status. A save that gives some dropped types a
target and not others, or drops another type meanwhile, is refused again for the rest; the
question keeps every dropped type with the choices made so far, until the set is saved. When the
set keeps no type at that level it says so: keep the type, or add one of that level. Through the
API, give `ticketTypeMapping` from
each dropped type's id to the kept type.

## Field rules

A field rule set says, per field, whether it is required or hidden and what help text it shows.

On **Administration**, **Configuration sets**, **Field rule sets**: **New field rule set** opens
the form; **Add a field rule set**, then **Manage** it. Each field has **Required**, **Hidden** and **Help text**, for every ticket type.
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

1. Pick the **Layout set**, or choose **New layout set**, type a **New set name** and press
   **Add a layout set**. While a
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
   that is not the default and that no track uses, after asking: its layouts go with it.

The **Preview** beside or under the layout shows the form as the server will give it, with the
field rules applied, and follows each change before you save. **Preview as** picks the ticket type
when you edit the layout for every type; **Fields and rules of** picks a track that uses the set,
since tracks can differ in custom fields and rules, or **No particular track** for the shared
fields and the default rules. The two choices stand side by side. A create form's preview leaves
out what the create form itself leaves out: a field set on the ticket once it exists, such as
**Close reason**, unless a rule makes it required. A **Create** layout does not offer **Close
reason** to place. Under the form the preview lists fields you placed that this form leaves out,
and why: a rule hides it, it does not apply to that type there, its value is computed, or it is
set once the ticket exists, so a create form has nothing to enter. When the server would refuse the layout as it stands, the preview says why in your
language and keeps the last form it could show; a refused save says why in the same words.

A local-mode track's own layout sets are on the same page, marked **(a track's own)**: they
place the shared fields and the track's own, and the preview starts on that track. The people who
run the track change them on its own page; see [A track's own sets](#a-tracks-own-sets).

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

Priorities are the site's ordered list: Urgent, High, Normal, Low and Very low on a fresh site.
Site and configuration administrators keep them on **Administration** > **Priorities**
(`#/admin/priorities`), in the **Tracks and setup** group. Others who open the page are told only
that it is for administrators. The page has three cards: the priorities, the priority sets and the
close reasons. Each card has its **New** button at its head and says what it did, or why not,
under its own form.

**Priorities, most urgent first** lists them in order, each with its icon:

- **New priority** asks for a name and an optional description. A new priority joins the
  default priority set and goes to the end of the list.
- **Up** and **Down** move a priority one place. The icon comes from the place in the list, the
  most urgent icon at the top and the least at the bottom, so moving a priority changes its icon
  and that of the one it trades places with; adding or deleting one can change the others'. When
  the list changed elsewhere since the page read it, nothing moves: the page says so and reads it
  again.
- **Change** renames a priority or changes its description. A name another priority has is
  refused.
- **Delete** asks first. When tickets have the priority, the page then says how many and asks
  which priority they get instead (**Instead, give them**); the tickets take it, with a line in
  their history, and the priority sets that offered the old one offer the replacement, and give
  it to new tickets where they gave the old one. A priority no ticket has is deleted at once.
- The page has no icon or colour controls: a priority's stored `icon` and `color` do not change
  what lists draw.

**Priority sets** chooses which priorities a track offers:

- Each set shows what it offers, what new tickets get and how many tracks use it. The default
  set is marked **Default set**; its count includes the tracks that choose no set.
- **New priority set** asks for a name, an optional description, **Priorities it offers** (at
  least one) and **New tickets get**: one of those, or **The middle of what it offers**.
- **Manage** opens the same form to change a set, **Make this the default set**, and **Delete**.
  Deleting asks first and says how many tracks go back to the default set. The default set has
  no **Delete**; make another set the default first.
- A link goes to [Which sets a track uses](#which-sets-a-track-uses), where a track chooses its
  set; that page links back here.

Through the API:

- `/api/v1/priorities`: `name`, `description`, `icon`, `color`; `PUT /api/v1/priorities/order`
  lists every id in the new order. The list, and a ticket's `priority`, also give `level`, from 1
  to 6: which icon it shows, from its place in the order.
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
on a fresh site. The **Close reasons** card of **Administration** > **Priorities** keeps them as
the priorities card does: **New close reason**, **Up** and **Down**, **Change** and **Delete**.
Their order is the order of the lists people choose a reason from.

A reason is in use when tickets were closed with it, or a workflow's published version or draft
sets it, as the default workflow's Closed sets Completed. **Delete** says so before anything is
sent. When the reason is in use, the page then says how many tickets have it, or names the
workflows that set it, and asks which reason takes its place. With that choice the tickets take
the replacement, and each workflow that set the old reason gets a new version that sets the
replacement.

Through the API they are managed with `/api/v1/close-reasons` (`name`, `description`), with
`PUT /api/v1/close-reasons/order`, and a deleted reason in use needs `?replacementId=`. Without
one the delete is refused (`409 in_use`, or `409 used_by_workflow` naming the workflows).

Free moves close with the reason named Completed, or with what the default workflow sets on
entering Closed when no reason has that name, so a replacement of Completed stays the closing
reason for new workflows and added statuses too. A reason named Completed made after the
replacement takes the free moves added from then on, while the ones already there keep the
replacement.

Setting a close reason needs the permission **Set the close reason**. It stamps the ticket's
Closed time; clearing it clears the stamp. Workflows set it through a transition's fields or an
effect; see [workflows](workflows.md).

## Configuration sets and tracks

A track names the sets it uses; `null` means the site's default. Type sets, field rule sets,
layout sets and workflow maps list the tracks that use them, and saving a shared set changes
every one of those tracks.

| Set | Track setting | Default on a fresh site | Managed in the web app under |
|---|---|---|---|
| Type set | `typeSetId` | The track type's default set | **Configuration sets**; a shared-mode track's chosen on **Which sets a track uses** |
| Field rule set | `fieldRuleSetId` | Default field rules | **Configuration sets** |
| Layout set | `layoutSetId` | Default layouts | **Layout sets**; chosen on **Which sets a track uses** |
| Priority set | `prioritySetId` | Default priority set | Chosen on **Which sets a track uses**; made on **Priorities** |
| Workflow map | `workflowMapId` | Default workflow map | **Workflow maps** |
| Access policy | `accessPolicyId` | Default access policy | **Permissions**; a shared-mode track's chosen on **Which sets a track uses** |
| Visibility policy | `visibilityPolicyId` | None | Chosen on **Which sets a track uses**; made on **Visibility policies** |
| Notification policy | `notificationPolicyId` | The site's default | Chosen on **Which sets a track uses**; made on **Notification policies** |

### Which sets a track uses

**Administration** > **Which sets a track uses** (`#/admin/track-sets`), for site and configuration
administrators, chooses a shared-mode track's **Access policy** and **Type set**, and every track's
**Layouts**, **Priorities**, **Visibility policy** and **Notifications**. Pick the **Track**, change
what you want and press **Save**; only what changed is sent. **Access policy** and **Type set** list
the shared policies and type sets and have no empty choice. In the other lists, which hold the
shared sets and a local-mode track's own, marked **(its own)**, the first choice is the default,
which for a visibility policy means none. A local-mode track keeps its own access policy and type
set: in their place the page says so, with a link to the track's own **Configuration sets**, where
its administrators change the type set. No page changes a track's own access policy: its
administrators change its grants through the API (`POST` and `DELETE`
`/api/v1/access-policies/:id/grants`). **Manage** on the **Tracks** page has a link here for that
track. A link under a list leads to the page that makes its sets:
[Configuration sets](#type-sets) under **Type set**, [Priorities](#priorities-and-priority-sets)
and [Notification policies](notifications.md#managing-policies), and, for site administrators only,
[Permissions](permissions.md) under **Access policy**.

Switching the access policy changes at once who may see the track and what they may do in it.
Switching the type set asks first about tickets of a type the new set lacks: **Save** is refused
with a line that says so, and a question opens under **Type set**. It says how many tickets have
such a type and, for each type, offers **Tickets of** the type **become** with the new set's types
at the same level. When the new set has no type at that level, it says the tickets have nowhere to
go: choose another type set, or add a type of that level to the set. Choose for each, then **Save**
again; the line says how many tickets took another type. Choosing another type set drops the
question. Changing the visibility policy moves tickets at a level the new policy lacks to its
default level, so some may become visible to more people.

### Who changes a set

- A shared set is changed by site and configuration administrators. A local-mode track owns its
  type set, access policy and workflow map, and may own field rule and layout sets (`trackId` on
  create) that name shared fields or its own; its administrators change them, in the web app on
  the track's own pages below.
- A default set and a set that a track uses are not deleted.
- [Tracks](tracks.md#configuration-sets) says how a track switches sets, and
  [permissions and access](permissions.md) and
  [email and notification policies](notifications.md) cover the policies.

### A track's own sets

The people who run a track with its own configuration (local mode) change its own sets without
being site or configuration administrators. On **Administration** > **Tracks you run**, **Manage**
the track: under **Its own configuration** are links to its own pages.

- **Layout sets** (`#/manage/tracks/<id>/layouts`) is the layout sets page for that track alone.
  The track's name is above the title, and the list holds only the sets it owns; the set it uses
  opens first. **New layout set** makes a set of the track's own. The fields to place are those
  that reach the track, its own and the shared ones it has, and **Ticket type** offers the types
  its type set holds. The **Preview** uses that track's fields and rules, and says so: there is no
  choice of track. A set the track does not use yet has **Use this set for** the track; from then
  on the track's forms follow it.
- **Configuration sets** (`#/manage/tracks/<id>/configuration-sets`) starts with **Its own ticket
  types**, the types only this track has. **New ticket type** adds one with a **Ticket type name**,
  a **Description**, its **Level** and an **Icon**, as on the Ticket types page; **Manage** changes
  them, and **Save the type**. Each type says its level and whether the track's type set offers
  it: a new type is offered once it is ticked in the type set. **Delete ticket type** asks first,
  and is refused while the type set holds the type (untick it and save the set first) or while
  tickets have it, with their number. A level that would leave tickets without the parent they need is
  refused with the counts; the levels themselves are the site's. Next is the track's own type
  set: **Manage** it to choose its ticket types, the shared ones and the track's own, their order
  and the preselected type, and where the tickets of a type it drops go. A track keeps this one
  type set, so none is added or deleted here, and it is never a default. Below are the field rule sets the track
  owns: add one, set its rules as on the shared page, delete one the track does not use, and
  **Use this set for** the track.
- **Fields** (`#/manage/tracks/<id>/fields`) lists the custom fields the track owns. **New field**
  adds one as on the shared page, and **Manage** offers the same controls: its name, description
  and settings or formula, its contexts with their defaults and options, and **Delete field**. Its
  contexts cover the track alone. A person field's context offers **Anyone** or **The holders of
  a track role**, from the track's roles, and a default person is found among the people who may
  be mentioned in the track, a default group by its name through the field; the site's list of
  groups is for administrators, so a limit to a group's members chosen before stays as it is, as
  **the group chosen before**. The shared fields that reach the track are not listed: they are the
  administrators'.
- **Notification policies** (`#/manage/tracks/<id>/notification-policies`) lists the notification
  policies the track owns and says which one it uses: add one, change its rules, delete one the
  track does not use, and **Use this policy for** the track. See [Managing
  policies](notifications.md#managing-policies).
- **Workflow map** (`#/manage/tracks/<id>/workflow-map`) is the map the track owns, open at once:
  which workflow each type it offers follows, the shared workflows and its own. See [Workflow
  maps](workflows.md#workflow-maps).
- **Visibility policies** (`#/manage/tracks/<id>/visibility-policies`) lists the visibility
  policies the track owns and says which one it uses: add one, give it levels and members, delete
  one the track does not use, and **Use this policy for** the track. See [Managing policies and
  levels](permissions.md#managing-policies-and-levels).

Going back to a shared set, and anything about a shared set or another track's, is for site and
configuration administrators; the server refuses the rest whatever the page shows. The shared
pages, **Administration** > **Layout sets**, **Configuration sets**, **Fields**, **Notification
policies**, **Workflow maps** and **Visibility policies**, show someone who runs
tracks but is no administrator only links to the tracks they run that have their own
configuration. A track in shared mode owns no sets, and its page says so: whoever runs it, or works
in it, gains nothing here. An archived track's sets wait until it is restored, and its pages say
so, also to someone who runs no other track.
