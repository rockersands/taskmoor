# ADR-091: Wiki markup as a rich-text format of its own, with a reader and writer that agree

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-071

## Context

API-011 asks for rich text in the stored document, Markdown, the Jira-compatible document
format or wiki markup, chosen per request. Version 2 of the Jira-compatible API carries wiki
markup (spec 02a 1.2), and ADR-086 shipped it with Markdown as a stand-in until this task. Scripts
written for the other product send and read wiki markup on version 2, so the stand-in breaks them
on the first `*bold*`.

Wiki markup has no grammar anyone publishes in full. Renderers differ on markers inside words,
escapes and nesting. What we need is narrower than "every renderer's behaviour":
- what our writer emits must read back to the same document, for everything the markup can say;
- what people and scripts commonly send must read the way they mean it;
- the markup we write for a document read from any input must be stable, so a v2 client that
  reads, edits and writes back changes nothing it did not touch.

## Decision

`@taskmoor/richtext` gets `toWiki(doc)` and `fromWiki(text)` (`packages/richtext/src/wiki.ts`), a
hand-written reader and writer for one dialect that we define, plus `toPlainText(doc)` for
plain-text reads (API-011 (2)).

**The format in our own words (ADR-003).** Blocks are separated by blank lines and recognised at
the start of a line: `h1.` to `h6.` headings, `bq.` quoted paragraphs, `----` rules, `*`, `-` and
`#` list items (nesting repeats the marker; `#*` is a bullet inside a numbered item), table rows
starting with `|` (`||` before a header cell), and the block tags `{code:lang}`, `{noformat}`,
`{quote}` and `{panel:...}`, each closed by the bare tag. Inside a line: `*bold*`, `_italic_`,
`-strike-`, `+underline+`, `^sup^`, `~sub~`, `{{monospace}}`, `{color:#hex}...{color}`,
`[text|address]`, `[address]`, `[~accountid:id]` for a mention, `!image!` and `\\` for a line
break; a line feed inside a paragraph is a line break too.

**Rules that make the two directions agree:**
- **Markers.** A marker opens where it is not glued to a letter or digit before it and has no
  space after it, and closes where it has no space before it and no letter or digit after it. A
  run of the same marker (`--`, `**`) is text. The braced form (`{*}`) works anywhere: the writer
  uses it inside words and next to spaces.
- **Pairing.** The reader pairs each opener with the nearest closer of its kind in the same
  stretch, using precomputed next-closer tables, so unclosed markers cost linear time.
- **Escapes.** A backslash before a markup character takes it as text; numeric character
  references (`&#92;`) stand for the character. The writer escapes only what the reader could take
  as markup: a marker character that could pair with another one, `{` and `[` always, `|` and
  `]` in links and cells, `}` in monospace, `!` before a non-space, and the first character of a
  line that would start a block (`h1.` becomes `&#104;1.`).
- **Conventions for what the markup has no word for:**
  - checklists are bullet lists whose items start with `[ ]` or `[x]`; a bullet whose text only
    looks like that is written `&#91;x]`;
  - panel types are their background colour (`{panel:bgColor=#deebff}` is info), or `panelType=`
    for tip and custom;
  - a code block without a language is `{noformat}`, since a bare `{code}` means Java to some
    renderers;
  - nested quotes and panels are normalised on read the way the writer can write them back.

**Documented losses**, each a golden read-back in the corpus:
- attributes the markup has no place for: the other format's own, link titles and targets, a
  numbered list's start, column widths;
- a mention's display name (the markup names people by id only);
- empty paragraphs, line feeds inside text, marks on line breaks;
- emoji, dates and status lozenges, written as their text;
- inline code's other marks;
- list items and table cells with blocks beyond one line, and merged cells;
- quotes nested deeper than one paragraph, and panels in panels;
- link addresses with `[`, `]`, `|`, `\`, braces or edge spaces, which are percent-encoded;
- unsafe links and colours;
- code languages the tag cannot carry, and code holding its own closing tag;
- bare web and email addresses in text, which read back as links.

**On the native API**, `?format=` takes `wiki` (read and write) and `text` (read only; a write
that carries rich text in it is refused as `invalid`) wherever it takes `markdown`. The
Jira-compatible version 2 asks the native API for `wiki`, and converts search results with
`toWiki`.

**Tests**: 252 corpus documents (231 lossless) and 40 wiki sources, each with golden files in
`packages/richtext/src/__golden__/wiki`. Each document also checks that a trip through the
document format changes nothing the markup shows, and that the read-back writes the same
document-format JSON as the original (v2 and v3 agree). Three properties: any text built from
the markup's own characters, with any marks, in any place, comes back unchanged; any markup
built from its tokens writes back stably; and generated imported documents reach a fixed point.

## Options considered

| Option | For | Against |
|---|---|---|
| Hand-written reader and writer for one defined dialect (chosen) | Both directions follow the same rules, so round trips are provable by property tests; linear time; no dependency | We own the edge cases; some renderers read rare inputs differently (`x^2^` stays text for us) |
| An open-source wiki-markup library | Less code | It would have to round-trip our schema exactly, which a general parser does not promise; a new dependency needs the licence and clean-room review (ADR-003) |
| Convert through Markdown (wiki to Markdown to document) | Reuses `markdown.ts` | Two lossy hops; escapes and nesting rules differ, so stability is lost |
| Keep Markdown on version 2 | No work | Breaks every script that sends `*bold*` or `h2.` |

## Consequences

- Version 2 clients now send and read wiki markup; the conformance cases' plain sentences are
  the same in both dialects, so the suite stays green with no case changes.
- Mentions written through version 2 have no display name until a person's name is looked up
  by id; the editor shows the id. Resolving names on write is a follow-up for the shim or the
  native write path.
- HTML on the API (the last format API-011 names) is still to come.
- Revisit the marker rules if a common client's output reads wrongly; the corpus and the
  properties make such a change safe to try.
