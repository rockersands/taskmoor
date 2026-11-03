# Ticket tools: tasks

The workstream the user asked for on 2026-11-03: tools on every type of ticket, for 1.0. Branch
`claude/ticket-tools`, based on `claude/ui-overhaul`. Decision record: ADR-120. Requirements:
CORE-031, CORE-032, CORE-033, NTF-013, NTF-014. Migration 0091.

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

**Where it stands.** All four parts are committed on the branch. It has not been through the full
gate: that is the coordinator's, after merging.

**To merge.** Base it on `claude/ui-overhaul`. Expect easy conflicts at the end of
`apps/web/src/i18n/messages.en.ts` and `messages.es.ts` (keep both sides), in
`docs/specs/requirements-index.csv`, `docs/adr/README.md`, `packages/db/src/migrations/index.ts`,
`packages/db/src/upgrade-fixtures.ts`, `packages/db/src/__golden__/schema.json`, `docs/api/*` and
`packages/sdk/src/generated/*`. The last four are generated or ordered: after joining them, run
`pnpm verify --update` and review. In `apps/web/src/tickets/view/TicketPage.tsx` the local
`LinksPanel` went away and the columns are wrapped in `EditorToolsProvider`, which reindented them.
Numbers taken: migration 0091, ADR-120, CORE-031 to 033, NTF-013 and 014.

**What is new where.** The panels are in `apps/web/src/tickets/tools`; the menu is in
`apps/web/src/richtext/slashTools.ts`, `BlockPrompt.tsx` and `EditorTools.tsx`; the routes are
`apps/server/src/routes/checklists.ts` and `subtickets.ts`; the percentage is one function,
`checklistProgress` in `apps/server/src/tickets/checklists.ts`; the import side is
`apps/server/src/import/load-checklists.ts`.

**Before relying on it.** Run the full gate. Run `pnpm fuzz adf`, `markdown` and `wiki`, which have
not seen the new nodes. Read the Spanish strings: they are a draft like the rest of `messages.es.ts`.
