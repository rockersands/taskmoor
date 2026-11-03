# Ticket tools: tasks

The workstream the user asked for on 2026-11-03: tools on every type of ticket, for 1.0. Branch
`claude/ticket-tools`, based on `claude/ui-overhaul`. Decision record: ADR-120. Requirements:
CORE-031, CORE-032, CORE-033, NTF-013, NTF-014. Migration 0096.

| Part | What | State |
|---|---|---|
| 1 | Links from the ticket page, with a picker in the same track (CORE-031) | Built |
| 2 | Subtickets inline, with progress on the page, board cards and lists (CORE-032) | Built |
| 3 | Checklists: four states, percentage, history, clone, export, import, personal data (CORE-033) | Built |
| 4 | Slash menu and four new blocks in the rich-text editor (NTF-013, NTF-014) | Built |

## Not built: named for later

None of these blocks 1.0. Each was left out on purpose, to keep to what is safe.

| Ticket | What | Why it waits |
|---|---|---|
| TT-1 | A collapsible section that also collapses while editing | In the editor it stays open with its title as a field; it collapses where it is read. Hiding content under the caret needs its own keyboard and co-editing design |
| TT-2 | Setting a column's width in the editor | Columns are equal on screen. Widths from the other format are kept for export only, because a style attribute would need a change to the content security policy |
| TT-3 | Columns in Markdown and wiki markup; files and ticket references in wiki markup | The formats have no place for them: the losses are listed in ADR-120 |
| TT-4 | Two files of one name told apart | A reference holds the name, and shows the first file of that name |
| TT-5 | Dragging checklist items with a pointer | Move up and Move down work with both keyboard and pointer, which is what was asked for |
| TT-6 | Changing a subticket's status from its parent's list | The list shows the status; moving it happens on its own page or on a board |
| TT-7 | Notifying followers of checklist changes | Left out so a run of ticks does not flood them; the event is there for webhooks. The user can ask for it |
| TT-8 | A language list for the code block's prompt | It takes one word, such as `sql`, and the editor does not highlight by language yet |

## Handoff

**Where it stands (2026-11-03).** All four parts are committed, and `origin/main` (at `6015efc`, with
the ticket pop-up and migrations through 0095) is merged into this branch. Nothing is known to fail.
It has not been through `pnpm verify`.

**Migration.** Renumbered from 0091 to 0096, with its file, index and upgrade seed; 0096 was free on
`origin/main`, and the schema golden and upgrade test pass. Check again that it is still free if main
moves. Numbers taken: migration 0096, ADR-120, CORE-031 to 033, NTF-013 and 014.

**What ran after the merge, one file at a time.** Web, server, db, richtext and SDK test files for
these tools, the stories of the tools and the pop-up, `tsc -b`, `i18n:check`, and the whole e2e suite
once with `CI=1`: 187 passed, 45 skipped, none failed.

**What the merge changed.** The panels work in the pop-up, tested in `TicketPopup.test.tsx`: they tell
the page beneath when they change, and a closed picker leaves no list for Escape to find. A block's
prompt in the editor is no longer a form, since the editor often sits inside one. The subticket
field is now **New subticket**, because "Summary of a new one" also answered to the ticket's Summary
field and failed two e2e journeys.

**Next steps.** 1. Run `corepack pnpm verify --e2e`. 2. Fast-forward or merge to main. 3. Run
`pnpm fuzz adf`, `markdown` and `wiki`, which have not seen the new nodes. If main moved before step
1, merge it here again, and regenerate with `vitest run --project=<name> <file> -u` for
`apps/server/src/api/openapi.test.ts`, `packages/sdk/src/generate.test.ts` and
`packages/db/src/schema.test.ts`; a full `verify --update` has hung here.

**What is new where.** The panels are in `apps/web/src/tickets/tools`; the menu is in
`apps/web/src/richtext/slashTools.ts`, `BlockPrompt.tsx` and `EditorTools.tsx`; the routes are
`apps/server/src/routes/checklists.ts` and `subtickets.ts`; the percentage is one function,
`checklistProgress` in `apps/server/src/tickets/checklists.ts`; the import side is
`apps/server/src/import/load-checklists.ts`.

**Before relying on it.** Read the Spanish strings: they are a draft like the rest of
`messages.es.ts`.
