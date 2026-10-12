# ADR-014: Rich text model and collaboration

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-020

## Context

Descriptions and comments are rich text. The importer must bring documents over from Jira
without losing anything, including node types we do not render yet, and the editor must let
several people edit at once. The Jira-compatible document format is a public JSON tree; our
model is ProseMirror, through Tiptap.

## Decision

- **One schema** (`@taskmoor/richtext`), built with Tiptap 3 and shared by the browser editor,
  the server and the importer: StarterKit (paragraphs, headings, lists, code, quotes, rules,
  marks, links), mentions, tables, task lists, plus our own `panel`, `status`, `date`, `emoji`,
  `textColor` and `subsup`.
- **Lossless conversion**: `fromAdf`/`toAdf` map every known node and mark. Nodes and marks
  the editor does not know are kept whole in `unknownBlock`, `unknownInline` and `unknownMark`
  and written back unchanged. Every converted node keeps its original attributes in a hidden
  `adfAttrs` attribute; on export those come first and the editor's values overwrite only the
  keys it owns. The original document is also stored next to the item (importer, M1), so a
  future converter can redo the conversion.
- **Collaboration**: Yjs with y-prosemirror for the editor state and Hocuspocus as the
  WebSocket server, running as the `realtime` role of the backend image. Documents persist in
  Postgres as Yjs updates (M1); the format export is derived from the Yjs state.

## Evidence (spike, 2026-10-12)

- 50 synthetic documents covering every mapped type plus seven unknown block types, three
  unknown inline types and three unknown marks round-trip with every node intact; a property
  test over random seeds found no counterexample. Adjacent text runs with equal marks are
  merged, which the format treats as the same document.
- The same documents survive Yjs: ProseMirror JSON to a `Y.Doc`, encoded as one update,
  applied to a second `Y.Doc`, and back, in well under a second for all 50.
- Two Hocuspocus providers on an in-process server see each other's changes in about 10 ms;
  the document read from the second client exports to the original.

## Options considered

| Option | For | Against |
|---|---|---|
| Tiptap + Yjs + Hocuspocus (chosen) | Mature ProseMirror stack; CRDT merging; server in our own process | Three libraries to track |
| Store the Jira format directly, no editor model | No conversion | No collaborative editing; every feature works on raw JSON |
| Markdown | Simple | Cannot represent mentions, panels, tables faithfully; lossy import |
| Lexical | Modern | Weaker collaboration story; no ProseMirror ecosystem |

## Consequences

Rendering an unknown node shows a placeholder until a mapping is added, and the content
stays safe. Mark order and text-run boundaries are not preserved byte for byte; nothing in the
format depends on them. Task items store their inline content inside a paragraph in the editor
and flatten it on export.
