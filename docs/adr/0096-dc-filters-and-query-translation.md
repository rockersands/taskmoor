# ADR-096: Translating saved filters, dashboards and subscriptions from a Data Center backup

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-094

## Context

M1-094 imports a Data Center backup's saved filters, dashboards and filter subscriptions
(IMP-004; spec 02a section 3), and translates the filters' queries. It is done when a translation
corpus is 100% parsed and the unsupported items are listed in the report. The importer framework
(ADR-048) and the backup stage (ADR-081) are in place, and saved searches with shares, stars and
subscriptions (M1-063, ADR-053) and dashboards with widgets (M1-064, ADR-060) are the targets.
The native parser already reads the Jira-compatible vocabulary (M1-035, `dialect.ts`). A query
from a backup still names the source's own objects: projects, statuses, custom fields, options,
sprints and other filters by id, and people by user name or key. Those ids mean nothing in
Taskmoor, so renaming alone is not a translation.

## Decision

- **Two steps, one on each side** (`import/translate/jql.ts`). Only the stage knows the source's
  custom fields, people, projects and filters by id and name; only the load knows what each
  became. Step 1, `analyseQuery`, runs in the stage (`dc-backup/stage-filters.ts`): it parses,
  renames with `toNative`, and turns everything that names a source object into a reference
  (`Ref`) in a template of the query tree: a custom field by `cf[id]` or by name, numeric ids of
  statuses, priorities, close reasons, ticket types, tracks, levels, areas, releases, options,
  sprints, tickets and saved searches, a track by name, a person by user name or key, and a
  saved search by name. Step 2, `renderQuery`, runs in the loader: it puts the target's values in
  place (names for named objects, keys for tracks, addresses for people, values for options,
  `cf[<new id>]`, ids for tickets, sprints and saved searches) and prints the canonical native
  text. The loader resolves references through the external ids like any other command.
- **What cannot translate is still imported, and flagged** (migration 0073:
  `saved_search.import_problem`). A query with an unknown function (an app's), an unknown or
  ambiguous field, a field that was not imported, a person, project or filter the source does
  not have, broken text, a value that did not import, or one the target refuses when it is
  prepared as its owner would run it (`prepareSearch`, the search route's own path), keeps its
  text (the source's, or the translation) and says why in `import_problem`. The API shows it as
  `importProblem`, the search page as a note, and saving a new query clears it. Each record warns
  `query_not_translated` with `<code>: <name>`, so the report lists the reason and the function
  or field by name. Fields and functions of modules this version lacks (service tracks, journeys)
  translate but are flagged (`query_flagged`); ORDER BY terms Taskmoor does not sort by (`Rank`,
  an app's field) are left out (`query_changed`), which only changes the order.
- **A corpus of queries as scripts write them** (`translate/corpus.ts`, our own words): 100
  entries covering every field and function the dialect reads, names and ids of every kind of
  object, history clauses, ORDER BY, grammar, the service module, apps' functions and fields,
  and text that does not parse, each with its expected outcome and, when untranslated, its
  reason. Entries are written against a vocabulary, so the unit test (`jql.test.ts`, a golden of
  every outcome) and the synthetic backup's filters (`dc-backup/filters.ts`) use the same corpus.
- **Shares and stars never widen.** `global` becomes public, `loggedin` any signed-in person,
  `group` and `project` (with a role) the same scopes. A share naming something the backup does
  not have is left out; change rights are not kept (Taskmoor's shares only grant viewing);
  favourites become stars. Dashboards cannot be starred, which is warned.
- **Subscriptions keep their schedule or are skipped.** The source's cron expression (seconds
  first, `?`, names, Sunday as 1; **Verify**) becomes daily, weekly, monthly or a five-field cron
  on UTC; one that needs `L`, `W`, `#`, a year or seconds has no counterpart and is skipped with
  the reason rather than run at another time. A group that did not import fails it: sending to
  the creator instead would change who gets it.
- **Dashboards keep the gadgets that have a widget.** Thirteen gadget modules map to widget
  kinds with their settings (a filter or project becomes the widget's query, statistic types
  become group-by fields, periods round to a day, week or month); others are reported by module
  (`gadget_not_mapped`). Sprint gadgets name boards, which resolve once the board import
  (M1-093) gives boards external ids.
- **New framework kinds** `saved_search`, `subscription` and `dashboard` run last
  (`model.ts`), since queries name everything else; the stage writes filters that name other
  filters after them. The synthetic format's example of an unsupported kind is now `automation`.

## Options considered

| Option | For | Against |
|---|---|---|
| Analyse in the stage, render in the loader (chosen) | Each step has what it needs; refs go through the framework's resolver | The stage depends on the translator; a translator change needs a new stage version |
| Translate at load from the source's ids alone | One step | The load does not know the source's field names, people or filters by name |
| Keep the source's text and translate when run | No import work | Every run pays it; ids would need the import's tables forever |
| Leave untranslatable filters out | Nothing broken arrives | People lose their filters and subscriptions, and cannot see what they had |
| Import untranslatable filters with a query that matches nothing | Runs | Silently wrong; the owner cannot tell |
| A disabled flag instead of a reason | Simpler column | The owner needs to know why to fix it |

## Consequences

- Measured on the M1-094 fixture (1,500 issues, seed 94, four projects): 106 saved searches
  (102 filters and the four boards' filters), all created. 88 run clean (6 of them with an ORDER
  BY term left out), 2 are flagged for the service module, and 16 keep their text with the
  reason: the corpus's 13 by design, plus a sprint by name and a sprint by id (sprints are not
  imported from a backup yet) and `ticketHistory()` ordered by last viewed, which the target
  refuses. 23 subscriptions: 18 created, 5 skipped for their schedules. 15 dashboards with every
  mappable gadget kind; two gadget modules are reported. A translated saved search finds exactly
  the tickets the source's query names in the generated instance. The test file runs in about
  35 s on the shared cloud container. The corpus: 83 translated, 2 changed, 2 flagged and 13
  untranslatable, every one with its reason.
- The corpus test (`translate/jql.test.ts`) runs in about 6 s; its golden is the review point
  for any change to the dialect, the functions or the translator.
- Boards' filters are imported as saved searches too; M1-093's boards may name them.
- Not done: user shares (newer versions), edit rights, dashboard stars, gadget colours and
  titles, a source time zone for schedules, interval schedules that do not divide an hour or a
  day, and `cascadeOption(parent, none)`. Every **Verify** in the format notes (02d) holds for
  the reader until a design partner's backup confirms it.
