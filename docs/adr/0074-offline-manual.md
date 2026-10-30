# ADR-074: The manual is Markdown with provenance, built into an offline bundle by our own script

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-114

## Context

Release 1.0 needs original documentation for administrators and for people using Taskmoor
(M1-114: "Docs build; link check green; provenance check passes"). It must ship with the image
or a release and work where Taskmoor often runs: on a server with no internet access, opened
from disk. The clean room (ADR-003) applies to documentation as much as to specs: the pages
must be our own words, written from our specs and code, never from Atlassian's documentation,
and they must use Taskmoor's own terms (`docs/specs/00-terminology.md`).

Parts already existed for developers and operators (`deploy/README.md`, `docs/api/README.md`,
`docs/csv-import.md`, `docs/export-format.md`), next to the code they describe and full of
links into the repository, which an offline bundle cannot contain.

## Decision

1. **Source.** The manual is Markdown in `docs/manual`: `index.md` and `concepts.md`, `use/` for
   people using the web app, `admin/` for administrators. `docs/manual/nav.json` orders the
   pages into sections; every page is listed once. The repository's developer docs stay where
   they are; the manual retells what a reader needs in its own pages.
2. **Provenance, like the specs.** Each page has front matter: `title`, `audience` (`admins`,
   `users` or `everyone`), `sources` (the repository files and public non-Atlassian pages it was
   written from, comma-separated; each file must exist, Atlassian sites are refused), `accessed`
   and `attestation: own-words`. Its H1 repeats the title. A page that needs Jira's own names
   (the importer's mapping, the Jira-compatible query dialect) says why in `jira-names`;
   elsewhere a term check refuses Atlassian names ("Jira" only as "Jira-compatible", no "epic",
   "JQL", "issue type", "watchers" and the like).
3. **Links.** Pages link only to other pages of the manual (with anchors that must exist) and
   to external sites. External links are listed, never fetched: `pnpm run docs` prints them and a
   golden file (`packages/devtools/src/__golden__/manual-external-links.json`) shows every new
   one in review. Images are not supported yet.
4. **Build.** `pnpm run docs` (`packages/devtools/src/cli/docs.ts`; bare `pnpm docs` is a pnpm
   command of its own that opens a package's home page) runs the checks, then writes
   `dist/docs`: one HTML page per Markdown page, keeping the folder structure so relative links
   work from `file://` and from any web server, plus `search.html`. Markdown is rendered by
   micromark with its GitHub extensions (tables, strikethrough, autolinks, task lists), already
   in the lockfile through `@taskmoor/richtext`; raw HTML in a page is shown as text. Heading
   anchors use the same rule as the repository's link check (`anchorFor`).
5. **Offline by construction.** Each page carries its stylesheet and script inline, uses system
   fonts and loads nothing. A Content-Security-Policy on every page allows exactly that
   stylesheet and script by hash (`default-src 'none'`), so a browser refuses any request even
   if a page tried. Search runs in the browser over an index embedded as a JSON block in
   `search.html`; the header's search box on every page submits to it. Navigation, the page's
   own contents and previous and next links are plain HTML and work without JavaScript.
6. **Checks in the gate.** `pnpm verify` runs `packages/devtools/src/manual.test.ts`: the
   provenance, term, structure, navigation and link checks over `docs/manual`; the external
   links' golden file; a build into a temporary folder checked as a browser would see it (the
   policy present, no element that loads a resource, no request API in the script, every
   relative link and anchor resolving inside the bundle); every page searchable; and the same
   bytes from the same input. `TASKMOOR_VERSION` stamps the footer, as `pnpm build` stamps the
   app.

## Options considered

| Option | For | Against |
|---|---|---|
| VitePress or Docusaurus | Polished themes, built-in search | Hundreds of new packages to licence-check; their local search fetches an index, which fails from `file://`; default themes pull web fonts; a second build system |
| MkDocs or mdBook | Simple, offline search plugins | Python or Rust toolchain outside the monorepo; not checked by `pnpm verify` |
| Ship the Markdown only | No build | No navigation or search; links between files are unusable in most viewers |
| Our own script on micromark (chosen) | One small module and its tests; no new packages; offline and deterministic by design; the checks share the repository's link rules | We own the layout, the search and the HTML; fewer features than a docs framework (no images, no versioned docs) |

## Consequences

- Writing a page means filling its front matter honestly; a missing source file, a future date
  or an Atlassian source fails the gate. Renaming a cited file fails the gate until the page's
  `sources` follow it, which is also a prompt to recheck the page.
- The bundle is a folder of static files: a release can zip it, the image can copy it, a web
  server can serve it under any path. Serving it from Taskmoor itself (for example at `/docs`,
  with a Help link in the app) is not done here.
- Depending on micromark directly from devtools made the frontend build's server-code guard
  (ADR-066) take it for a server-only package, though the app already bundles it through
  `@taskmoor/richtext`. The guard now takes the browser side's dependencies transitively
  (`apps/web/build/artefact.ts`), which also stops it calling `pngjs` server code; no package
  became newly allowed beyond those two.
- The manual describes the product as built; features that change must change their page in
  the same task. Spanish pages wait for the Spanish catalogue's review (M1-116).
- Revisit if the manual needs images or diagrams (copy them into the bundle and check them like
  links) or versioned documentation per release.
