# ADR-089: The Data Center import of custom fields and forms, and tickets carrying their values

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-089

## Context

M1-089 maps a Data Center backup's custom fields, their contexts and options, field
configurations and screens (IMP-004; spec 02a section 3: "Custom fields, contexts, options" to
fields and contexts, "Screens ... field configurations and schemes" to layout sets and field
rule sets). It is done when 99.9% of field values match the golden fixture. Field values live
on tickets, and tickets are M1-091's task (with history, comments, links and the rest of an
issue's content), so values could only be checked if this task brought tickets too.

The importer framework (ADR-048) already had loaders for fields, contexts and options (M1-098,
Taskmoor's own export), but none for field rule sets or layout sets. The routes of M1-012 wrote
rules and layouts in closures of their own. The synthetic generator (M1-087, ADR-072) wrote no
custom fields, contexts, field configurations or screens.

## Decision

- **The fixture grows, in our own words.** The generator (`dc-backup/fields.ts`) writes 18
  custom fields: one of each of 17 built-in types and one app type. They come with contexts
  per project and issue type, options (disabled ones, cascading children), default values,
  three field configurations in two schemes, three screens in screen schemes and issue type
  screen schemes, and the projects' scheme associations. Each issue's values come from a seed
  stream of their own. The format notes (02d) describe every new element, each statement
  marked **Verify** or **Our choice**. The validator checks the new references (associations
  to projects and schemes) and counts the new cases in the manifest.
- **Tickets with their own fields and values come now.** The minimum M1-091 builds on: each
  issue becomes a ticket with its track, number, type, status, priority, close reason, people,
  summary and description (as plain text paragraphs; wiki markup is M1-091's), dates,
  estimates, labels, its parent (from its sub-task link) and its custom values. Everything
  else about issues is still counted under "Not imported", now including the links that are
  not sub-task links. The stage streams issue rows to a raw file during the pass and writes
  the ticket records after it, issues without a parent first. Custom values and labels are held
  per issue until the end of the file, because the format does not promise an order.
- **Values in stored form, through the type catalogue.** The mapper (`import/dc-fields.ts`)
  turns each value into the stored form of `fields/types.ts` with `parseValue`. References stay
  source ids (options by id, people by staged user key, groups by name), and the ticket loader
  maps them as it does for Taskmoor's own export (`remap.ts`). A value Taskmoor cannot hold is
  dropped with a warning that names the field.
- **Fields of apps become read-only text holding their raw values**, as spec 02a's last row
  says, with the warning `app_field_as_read_only_text`. Their contexts come along; their
  options do not.
- **Contexts never widen.** A context's scopes are its projects times its issue types. A scope
  row the reader cannot keep (a project category, an unknown project or type) is warned about.
  A context left with no scope fails rather than becoming global.
- **Field configuration schemes become field rule sets, and issue type screen schemes become
  layout sets.** They are two new framework kinds (`field_rule_set`, `layout_set`, after the
  options) with loaders in `import/load-forms.ts`. Each links to the target's shared set of the
  same name or creates one, and puts its tracks on it. A scheme's default entity gives the
  rules for every type. A type's own field configuration gives rules only where it differs
  from the default, including explicit "neither required nor hidden" rules, because a type's
  rule replaces the general one. A project without a scheme gets a set made from the default
  field configuration. Each operation's screen comes from the screen scheme, or else from its
  default screen, as a layout with one tab per screen tab and `others: omit`. Time tracking
  stands for both estimates. Fields with no Taskmoor counterpart (security, attachments) are
  warned about (`field_rule_not_mapped`, `layout_field_not_mapped`).
- **One code path for rules and layouts.** The checks and writes moved from
  `routes/layouts.ts` into `fields/sets.ts` (`checkRules`, `replaceRules`, `checkLayouts`,
  `replaceLayouts`), and the routes and the loaders use them.
- **A configuration-only scope.** `"scope": "configuration"` imports everything but the
  issues, which are counted with the reason `configuration_only`. This allows a first look at
  a large backup, and keeps M1-088's 10,000-issue test about configuration.

## Options considered

| Option | For | Against |
|---|---|---|
| Tickets with their own fields now (chosen) | The done-when is measured on real ticket rows; M1-091 adds content to tickets that exist | Part of M1-091 lands here; its million-issue run must revisit memory |
| Golden of the configuration only, values left to M1-091 | Smaller task | The done-when cannot be measured; values would first be met at a million issues |
| Skip fields of apps | Simpler | Against spec 02a; their data would be lost |
| Rule sets per field configuration, picked by type | Fewer duplicates | Taskmoor sets are per track, not per type; a scheme is the unit tracks share |
| Raw inserts for rules and layouts in the loader | No refactor | Two copies of the checks; an import could save what the API refuses |

## Consequences

- Measured on the M1-089 fixture (4,000 issues, seed 89, six projects): 18,464 custom values,
  all 18,464 equal to the fixture's (100%), with 18 fields, 19 contexts, 29 options, 3 rule
  sets, 2 layout sets and 4,000 tickets, none failed. Every mismatch would be listed in
  `import/__golden__/dc-fields-seed89.values.json`.
- M1-091 keeps the ticket kind and adds history, comments, time, links, attachments, followers,
  votes and key history to it. The stage's per-issue values and labels are in memory. The
  million-issue run (about 5 million value rows) decides whether they need a sort on disk.
- Identical schemes are not merged yet (IMP-005 (1)). M1-092 merges identical permission
  schemes, and the same merge can follow here.
- Issue type schemes are not generated or mapped, so tickets warn `type_not_offered` when
  their track does not offer the type. Ticket types are still set.
- Revisit the format of default values (`GenericConfiguration`) and of the `NodeAssociation`
  rows when a design partner's backup confirms or corrects the **Verify** notes.
