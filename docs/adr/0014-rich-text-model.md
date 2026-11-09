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
  keys it owns. The original document is also stored next to the ticket (importer, M1), so a
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

## Implementation (M1-017)

Migration 0034 adds `ticket_text_original` and `ticket_text_state`. The editor is in
`apps/web/src/richtext/`, the conversions in `packages/richtext`, the realtime server in
`apps/server/src/collab/`.

- **One schema, now also in the browser.** `editorExtensions()` builds the shared extensions
  with an editor's options (mention suggestions, checkbox names, no ProseMirror history when
  Yjs keeps it); none of them changes the schema. Inline atoms (mention, emoji, status, date)
  take no marks: the other format gives them none and Yjs keeps marks only on text, so a mark
  on one would have reached nobody else. Mentions read their label without the format's "@"
  and write it back with one.
- **Editor** (`RichTextEditor`): Tiptap with a one-tab-stop toolbar (arrow keys move along it),
  Markdown input rules, pasted plain-text Markdown converted (`looksLikeMarkdown`), "@" with a
  listbox driven by `aria-activedescendant` on the text box, a link form (Ctrl+K) that refuses
  unsafe schemes, table tools while the caret is in a table, placeholders for nodes kept whole,
  and Escape to leave the text (Tab then moves on; Tab still indents lists and moves between
  cells). The create form uses it for description, environment and paragraph fields; the ticket
  page (until M1-051) co-edits the description.
- **Markdown** (`markdown.ts`, mdast with the GFM table, strikethrough, task list and literal
  autolink extensions; no footnotes): lossless for what Markdown expresses, plus our conventions
  for what it does not: mentions as `[@Name](mention:<id>)` links, panels as alert quotes
  (`> [!WARNING]`; GitHub's IMPORTANT reads as info and CAUTION as error), underline, subscript,
  superscript and colour as `<ins>`, `<sub>`, `<sup>` and `<span style="color: …">`. No other
  HTML is interpreted: inline HTML stays text and HTML blocks become code blocks of their source.
  The losses are listed in the module comment (attributes of the other format, empty paragraphs,
  emoji, dates and status as text, tables beyond GFM, addresses in text becoming links). A corpus
  of 63 documents and sources has golden Markdown and read-back files; documents in the
  Markdown-expressible subset must come back unchanged, every document reaches a fixed point
  after one pass (property test over the synthetic generator). Two writer bugs in
  `mdast-util-to-markdown` 2.1.2 are worked around locally (half an emoji encoded as a
  reference; `~~` next to a letter), and links are written for web addresses in text because GFM
  finds them after escapes are read.
- **API formats** (API-011): `?format=doc|adf|markdown` on ticket reads and writes (create,
  edit, view, list and every answer that returns a ticket); `doc` is the default and what is
  stored. HTML and wiki markup come with the compatibility API (M1-071).
- **Originals** (IMP-008): a description or environment written as `adf` keeps that document
  in `ticket_text_original` with the SHA-256 of the canonical document converted from it.
  Editing the text in another format leaves the original; `GET
  /api/v1/tickets/:id/rich-text/:field/original` returns it with `current` (whether the text is
  still what was converted from it). Writing it again as `adf` replaces it; clearing it drops it.
  Reading `?format=adf` converts the stored document, so later edits show; the original is for
  audits and for redoing the conversion with a better converter while `current` holds.
- **Collaboration**: Hocuspocus runs inside the realtime role on the process's own HTTP server
  (`/api/v1/collab`, a `ws` upgrade, no separate port); the default `all` role and the e2e
  servers have it. Documents are `ticket/<id>/<field>`. The upgrade needs a session cookie and,
  from a browser, this instance's origin (public URL or Host). Opening a document needs what
  editing the field through the API needs: seeing the ticket (browse, visibility level), "Edit
  tickets" (none in an archived track or the trash) and the field on the edit form; others are
  refused (`forbidden` for those who see the ticket, `not-found` otherwise) and read the text
  through the API. Saves are debounced (2 s, at most 10 s, and when the last person leaves)
  and go through the same rules as PATCH: lock, history rows, version, one `ticket.updated`
  event attributed to the last editor, auto-follow, required fields; refused saves put the
  ticket's text back and let go of people who lost access. The Yjs state is kept in
  `ticket_text_state` with the hash of the text it holds and is used again only while the
  ticket still holds that text. After any successful API mutation (and every 30 s) open
  documents are checked again: text written another way replaces the live text (last write
  wins; history keeps what was replaced) and people who lost access are disconnected.
- **Opening is not editing** (T-250): a collaborative editor changes the shared document only
  for the person's own edits. StarterKit's trailing node added an empty paragraph after a last
  block that is not one (a code block, a list, a table) as the document arrived, which the
  server saved as an edit by whoever had only opened the ticket. There the editor uses
  `trailingParagraph: 'own-edits'`: the paragraph goes in only after a change made in that
  editor, never after one Yjs brings in (the loaded document, others' changes, undo). The
  field's "Also editing" leaves out every page of the person (a second tab, a page just
  reloaded): each page puts the person's id in its awareness state.
- **People to mention** (NTF-005): `GET /api/v1/people/mentionable?ticket=|track=&q=` needs
  "Browse users and groups"; it lists active people by name or email prefix with `canView`, those
  who can see the ticket first. The editor marks the others and says they will not be notified.

Not yet: a document lives in one process, so several realtime processes need routing by
document until they relay updates (Redis-free, through Postgres, later); notifications for
mentions (M1-056, M1-058); collaborative saves carry no client address; emoji, date, status and
panel pickers, inline images and syntax highlighting in the editor; HTML and wiki markup.
