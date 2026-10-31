# ADR-093: The Data Center import of workflows and workflow schemes, with every rule mapped or held and reported

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-090

## Context

M1-090 maps a Data Center backup's workflows and workflow schemes (IMP-004; spec 02a section 3:
"Workflows with functions, properties, triggers, layout" to workflows; WF-011: each condition,
validator and post function maps by class to a guard, check or effect, and the ones that cannot
map are reported and become disabled placeholders). It is done when the golden tests are green
and every unmapped rule is listed in the fidelity report. IMP-005 asks for identical objects to
merge, and ADR-090 left the custom events of notification schemes to this task.

Taskmoor already had every target: versioned workflows with a published definition (M1-023),
transitions from a list of statuses or from any (WF-001), layouts, guards in nested all/any
groups, checks, effects and properties (M1-024 to M1-027, WF-003 to WF-006), per-status
permissions (WF-007), custom events that notification policies name (NTF-001 (2)), workflow
maps per track and ticket type (M1-028, ADR-045), and framework loaders for workflows and maps
that Taskmoor's own export uses (M1-098). `JIRA_FUNCTION_MAP` (M1-022) names the classes the
public workflow format shows, with the guard, check or effect each becomes; the effect
`placeholder` keeps a class it cannot run. The synthetic generator (ADR-072) wrote no
workflows. Taskmoor's guards and checks read system fields only.

## Decision

- **The fixture grows, in our own words** (`dc-backup/workflows.ts`; the descriptor model,
  writer and reader in `workflow-format.ts`; format notes 02d, every statement **Verify** or
  **Our choice**). Six workflows: software work, defects, sub-tasks with global transitions
  only, business requests, a copy of the first but for its name, and an old one no scheme uses.
  They have the initial action, global and common actions and steps' own, screens, nested
  condition groups, the built-in kinds of `JIRA_FUNCTION_MAP` with their arguments, and rules
  Taskmoor cannot hold: a negated condition, a conditional result, a script, conditions on
  custom fields, apps' classes, the webhook function, a security level from a role, an update
  that sets a priority, and a step property for deleting. Three schemes (the third repeats the
  first through the copy), one custom event and a transition screen of its own. Every workflow
  in use holds all six statuses, so no issue changes and the earlier fixtures' data stays the
  same: only the new elements' rows and counts are added. The validator reads every descriptor,
  checks its references, scheme entities and each issue's status against its workflow, and
  counts the workflow cases from the XML, so the writer and the reader must agree.
- **Staged in the format's model** (`dc-backup/stage-workflows.ts`). The stage parses each
  descriptor (saxes, a small tree) and records what it names, resolved: statuses, groups, roles,
  screens (`FieldCollector.screen`) and custom events. Workflows identical but for name and
  description merge into the lowest id, and schemes that become identical once their workflows
  merged merge too (IMP-005); each merged record is skipped with `merged_identical` and the
  warning `merged_into: <name>`. A scheme with no default entity, or one naming the built-in
  `jira` workflow the backup does not hold, gets a record of that workflow which links to the
  target's default (`system_workflow_linked_to_default`). Projects without a scheme keep the
  target's default map. Workflow state rows (`OSWorkflowEntry` and the others) are `not_needed`:
  the issue's status is the truth.
- **Mapped to a published workflow and a workflow map** (`import/dc-workflows.ts`), loaded by
  the existing framework loaders: the workflow is created and published as version 1 with its
  statuses mapped by source id, or linked by name to a workflow the target has. Steps are
  statuses, the initial action gives the initial status and the `onCreate` effects, global
  actions become transitions from any status, common actions transitions from each step that
  offers them, and a step's own actions transitions from its status. The action id is the
  transition id. A screen becomes the layout (its system fields; custom fields are reported),
  action meta becomes properties, `jira.description` the description, a custom event fired by
  `FireIssueEventFunction` the transition's event. Step properties become per-status
  permissions: `jira.issue.editable=false` lets nobody edit, `jira.permission.<p>.group` or
  `.projectrole` limit edit, comment, attach, assign or transition to that grantee.
- **Never wider than the source.** A rule that cannot map is listed in the report with the
  workflow, the transition, its id, the class and why (`import_record` warnings and the
  report's warnings, grouped by code and detail, so nothing is capped). What stands in its place
  depends on what the rule does:
  - a condition becomes `always-false` (`condition_not_mapped`): its transition stays closed,
    or its alternative in an any-group falls away, until an administrator replaces it;
  - a validator is left out (`check_not_mapped`): checks guard data, not who may act, and
    holding every transition with an app's validator closed would stop the work;
  - a post function becomes a disabled `placeholder` with its class (`effect_not_mapped`), as
    WF-011 (2) says.

  Conditions on custom fields cannot map because Taskmoor's workflows read system fields only.
  An update that sets a reference (a priority, a resolution) cannot map because definitions do
  not remap effect values; clearing one maps. A security level from a role needs the levels,
  which the format names by source id. Conditional results, extra initial actions and
  conditions or validators on creating are reported too (Taskmoor's create asks for "Create
  tickets" itself, so that permission validator is implied).
- **Custom events by name.** `customEventName` (`dc-schemes.ts`) turns an event's name into a
  transition event (`escalated`), and notification schemes' rules for it now import as
  `custom:<name>` instead of the warning `custom_event_not_imported`.
- **Statuses a workflow holds are not warned about.** `StatusCommand.inWorkflow` (set by the
  stage) drops `status_not_in_workflow` for them.

## Options considered

| Option | For | Against |
|---|---|---|
| Unmapped conditions as `always-false`, validators dropped, functions as placeholders (chosen) | Nobody can do more than in the source; work is not stopped by apps' validators; each case reported | A transition with an app's condition is closed until someone edits it |
| Drop every unmapped rule | Every transition works at once | Conditions often restrict who may close or approve: dropping them widens access silently |
| Fail a workflow with an unmapped rule | Nothing imported wrong | One app's condition loses a whole workflow and its tracks' maps |
| A placeholder guard and check kind in the model | Mirrors the effect placeholder | A model and engine change for every reader; `always-false` already says "never" |
| Keep identical workflows apart | Simpler | Against IMP-005; copies drift apart |
| Re-parse descriptors in the mapper | Smaller stage records | The stage must resolve references anyway; two parsers would drift |

## Consequences

- Measured on the M1-090 fixture (2,000 issues, seed 90, six projects): 5 workflows created
  and 1 merged, 2 maps created and 1 merged, 28 transitions, every one of the 2,000 tickets on
  the workflow its project's scheme gives its type and in one of its statuses. 14 rules are
  listed as not mapped (5 conditions, 2 validators, 5 post functions, a conditional result and a
  step property), and 5 screen fields. The test file runs in about 45 s on the shared cloud
  container, generation and import included.
- An imported ticket takes "Start work" and is refused "Send to review" by `only-assignee`;
  the held-closed transitions answer `always-false`; a finished ticket cannot be edited.
- The report does not count the tickets each unmapped rule affects (IMP-005 (2)); the workflow's
  record names the rule and the maps name the tracks. Revisit with a design partner's backup.
- Webhook post functions, function properties beyond the transition's meta, draft workflows,
  each issue's workflow state and transition triggers are not imported. Remapping effect values
  (`update-system-field` with an id) would let an update that sets a priority or resolution map;
  it would also fix the same gap in Taskmoor's own export round trip (`remap.ts`).
- Every **Verify** in the format notes still holds for the reader: class and argument names,
  the meta keys, the default entity `0` and the built-in workflow's name are read as written
  here until a real backup confirms them.
