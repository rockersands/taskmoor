# Clean-room protocol

Status: in force since 2026-10-12. Counsel review requested (see `docs/plan/decisions.csv`).
This protocol expands [ADR-003](../adr/0003-clean-room.md). It is engineering practice, not legal
advice.

## Why

Taskmoor offers behaviour that people know from a commercial product. Behaviour, data formats
and interfaces can be rebuilt independently. Code, documentation text, images and other
expression cannot be copied. Product terms of service also limit what an account holder may do
with a product. The protocol keeps the work on the safe side and leaves a record that shows it.

## Allowed sources

| Source | Use |
|---|---|
| Public product pages, pricing pages, public documentation, release notes, public API references, community posts | Read to learn *what* a feature does. Write the spec in our own words and list the page in `docs/research/sources.md` |
| Public format and protocol descriptions (REST API schemas, export formats, standards such as OpenAPI, SCIM, SAML, OIDC) | Implement interoperability: field names, endpoints and file layouts needed to import data or keep scripts working |
| Open-source projects under licences compatible with the project licence | Use as dependencies through the licence allowlist; borrow ideas freely; copy code only with its licence and notice kept |
| Customer-provided exports and recordings (design partners, with their written consent) | Validate the importer and fill "verify" gaps in specs; stored outside the repo unless anonymised |

## Banned sources and actions

- Signing in to, trialling or scripting any Atlassian product or account for this project.
- Copying text, tables, screenshots, icons, illustrations, colours, fonts or other assets from
  Atlassian sites or products, including in specs, tests, comments and commit messages.
- Decompiling, disassembling or reading leaked, decompiled or non-public Atlassian code, and
  reading Marketplace app source code that is not under an open-source licence.
- Using names or marks in a way that suggests endorsement. "Jira" appears only to describe
  compatibility ("Jira-compatible API", "import from Jira").

## Working rules

1. **Specs first.** Every behaviour starts as a requirement in `docs/specs` with a stable ID,
   written in our own words. Spec files carry provenance front matter (`spec`, `title`,
   `sources`, `accessed`, `attestation: own-words`). CI fails a spec without it.
2. **Code from specs.** Implementation sessions work from the specs and public format
   descriptions. They do not browse vendor documentation while writing code. When a spec is
   unclear, the session adds a "verify" note and asks for the spec to be completed.
3. **Synthetic fixtures.** Test data, importer samples and screenshots in tests are generated.
   No fixture comes from a vendor account.
4. **Original design.** The UI uses Taskmoor's own tokens, icons and layouts.
5. **Provenance record.** `docs/research/sources.md` lists the pages consulted. Each commit is
   attributable to one identity (see `CLAUDE.md`).

## Review checklist for each change

- Does any new text read like documentation from somewhere else? Rewrite it.
- Does any new asset (icon, image, colour set, font) come from outside the repo? It needs an
  allowed licence and a note in `THIRD_PARTY_NOTICES` (to be added with the first such asset).
- Do new test fixtures come from generators or hand-written synthetic data?
- Does user-visible wording avoid vendor marks except to describe compatibility?

## If contamination is suspected

1. Stop work on the affected area and record the suspicion in `HANDOFF.md`, with the files and
   the source.
2. Remove or quarantine the material in a separate commit that says why.
3. Rewrite the affected code from the spec in a fresh session that has not seen the material.
4. Add a row to `docs/plan/decisions.csv` if the user or counsel needs to decide anything.
