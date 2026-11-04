# Ticket tools: tasks

The workstream the user asked for on 2026-11-03: tools on every type of ticket, for 1.0. Branch
`claude/ticket-tools`, based on `claude/ui-overhaul`. Decision record: ADR-120. Requirements:
CORE-031, CORE-032, CORE-033, NTF-013, NTF-014. Migration 0096. TT-7, built later (branch
`wave6/t196b-checklist-notice`): NTF-015, migration 0103.

| Part | What | State |
|---|---|---|
| 1 | Links from the ticket page, with a picker in the same track (CORE-031) | Built |
| 2 | Subtickets inline, with progress on the page, board cards and lists (CORE-032) | Built |
| 3 | Checklists: four states, percentage, history, clone, export, import, personal data (CORE-033) | Built |
| 4 | Slash menu and four new blocks in the rich-text editor (NTF-013, NTF-014) | Built |

## Follow-ups: TT-1 to TT-8 (T-196)

Each was first left out on purpose. T-196 (2026-11-03, branch `wave5/t196-ticket-tools-follow-ups`)
built all but TT-7, which waited on the user; T-196b (2026-11-04) built TT-7 as they chose. Decisions
are in ADR-120, sections "Follow-ups" and "Checklist notices". T-196 needed no migration and no new
requirement ID; T-196b adds migration 0103 and NTF-015.

| Ticket | What | State |
|---|---|---|
| TT-1 | A collapsible section that also collapses while editing | Built: a toggle hides its text for this person only, never in the document; hidden text takes others' changes and says so; the caret never stays in hidden text (`expandView.ts`) |
| TT-2 | Setting a column's width in the editor | Built: "Column widths" in the slash menu inside columns. The content security policy already allowed style attributes; the width property is built from numbers only |
| TT-3 | Columns in Markdown and wiki markup; files and ticket references in wiki markup | Built: `> [!COLUMNS]` quotes, `{section}`/`{column}`, `!name!`, `[^name]`, `[KEY\|/browse/KEY]`, each reading back (corpus cases) |
| TT-4 | Two files of one name told apart | Built: a reference may hold the first 16 hex digits of the file's SHA-256; the picker lists both with size, date and who added it |
| TT-5 | Dragging checklist items with a pointer | Built: a grip for mouse and finger; Move up and Move down stay the keyboard's way |
| TT-6 | Changing a subticket's status from its parent's list | Built: each status is a menu of where that ticket can go, through the ticket page's own routes |
| TT-7 | Notifying followers of checklist changes | **Built (T-196b, 2026-11-04).** The user chose (T-196a) a notice that a track's administrators turn on, off by default: followers who may see the ticket hear in the inbox and by email as each chooses, never of their own changes, a run of changes within the batch window as one notice naming no list or item. NTF-015, migration 0103, ADR-120 "Checklist notices" |
| TT-8 | A language list for the code block's prompt | Built: about thirty common languages, narrowed as you type; any one word still goes in |
| Email | The new blocks in an email's quote of a comment | Built: dates, status labels, emoji and kept inline nodes read as text (they were left out) |

## Handoff

**T-196 (2026-11-03).** The follow-ups above are on `wave5/t196-ticket-tools-follow-ups`, in steps:
the text formats and email text (`packages/richtext`, `comments.ts`), the editor (TT-1, TT-2, TT-4,
TT-8), the subticket status menu (TT-6), the checklist drag (TT-5), then the e2e journeys, the
manual and ADR-120. The new Markdown and wiki forms have not been through `pnpm fuzz` (T-197 should
cover them with the slash menu's blocks). Only TT-7 waits, on the user's answer.

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
