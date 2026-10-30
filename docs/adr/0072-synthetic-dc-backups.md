# ADR-072: Synthetic Data Center backups: one seeded, streaming generator with a manifest of exact counts

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-087

## Context

The Data Center importer (IMP-001, IMP-004, IMP-010; ADR-025) needs fixtures before it has a
mapping: M1-088 to M1-094 must show "golden fixture entity counts match 100%", and M1-091 needs
a 1,000,000-issue backup that imports in under 4 hours. The clean room (ADR-003) rules out real
backups and vendor samples. A fixture may only follow public descriptions of the format, which
cover much of it but not all: many attribute names and some layouts are documented nowhere
public. A backup of a million issues holds about 2 GB of XML, so it cannot be built in memory,
and its counts must be known without counting the file afterwards.

## Decision

- **Format notes first.** `docs/specs/02d-dc-backup-format.md` describes the ZIP, the entities
  file, the active-objects file and the attachments in our own words. Every statement cites a
  numbered public source or is marked **Verify** (our assumption until a design partner's
  backup confirms it) or **Our choice**. A test fails a statement with no mark. The research
  ran in passes separate from the code, and only their facts reached the notes.
  `apps/server/src/import/dc-backup/format.ts` mirrors the notes. It is the format layer, the
  only code that uses the format's own names.
- **A seeded generator that recomputes instead of remembering**
  (`generate.ts`, `world.ts`, `parts.ts`; `pnpm gen:dc-backup`). The small parts of the
  instance are built once: people, groups, roles, projects, types, statuses, boards. Every
  issue's facts and parts come from their own streams of the seed (`Random.derive(seed, label,
  issue)`). Each element is written in its own pass over the issues, and each pass recomputes
  what it needs. Memory holds the small parts, one project counter, and a few recent parents
  per project. The XML goes straight into the ZIP (yazl, ZIP64 when needed). Attachment bytes
  are made when the ZIP reaches them.
- **Rows by name, not by dependency.** Comments and history come before their issues. A reader
  must stage rows and resolve references after the file, as ADR-025's staging already does.
- **A manifest beside the ZIP** (`<name>.manifest.json`). It holds the options, the size and
  SHA-256 of both XML files and of the attachments, the rows per element and per table, the
  cases the importer must handle (deleted and inactive people, skipped numbers, sub-tasks,
  restricted comments, anonymous and custom-field changes, sprint states, CDATA splits), and
  the forbidden characters written on purpose. The same options give the same manifest on any
  machine. The 10,000-issue manifest of seed 1 is a golden file. The ZIP stays in the shape of
  a real backup, so the manifest is not inside it.
- **The cloud layout for fixtures.** `entities.xml` and `activeobjects.xml` sit at the root,
  with attachment files under `data/attachments/<project>/<bucket>/<issue key>/<id>`, so one
  file is a whole fixture. Server backups keep attachments outside the ZIP, so the reader also
  accepts a ZIP without `data`.
- **A validator that reads like the importer will** (`validate.ts`). It streams each XML file
  through the byte cleaner (moved from the parser spike, `clean.ts`) and saxes, which is now a
  server dependency (6.0.0, ISC, pinned). It checks every row against `format.ts`: elements,
  attributes, types, required values, ids, the CDATA rule. After the file it resolves every
  reference, checks issue numbers per project, the sequences, and each attachment's path and
  size, then checks the active-objects tables and rows. Finally it compares everything with
  the manifest.
- **Text that breaks readers on purpose.** Line breaks and long text go into CDATA child
  elements, and `]]>` is split across sections. There are markup characters and non-Latin
  words, and NUL, control characters, U+FFFE/U+FFFF and references to them go in at
  `--forbidden-rate`.

## Options considered

| Option | For | Against |
|---|---|---|
| Seeded passes that recompute per issue (chosen) | Constant memory at any size; any pass can be rerun alone; counts exact by construction | Eight passes over the issues; each part needs its own stream to stay independent |
| Build the instance in memory, then write it | Simplest code; any cross-reference is easy | A million issues with history and comments needs gigabytes; no 1M fixture on a laptop |
| Write in dependency order in one pass | One walk | Hides readers that resolve in-stream, which real backups do not allow; the order is undocumented |
| Extend the parser spike's generator | Exists | Its vocabulary is deliberately not the format's, rows are random and unrelated, there are no counts |
| Manifest inside the ZIP | One file | A real backup has no such entry; the importer would have to know to skip it |

## Consequences

- M1-088 onwards import the 10,000-issue fixture in their tests and compare with the golden
  manifest. M1-091 imports the 1,000,000-issue one (`dc-backup.large.test.ts` with
  `TASKMOOR_LARGE_DC_BACKUP_DIR` keeps it).
- Each mapping task extends the generator, the notes and the validator together with what it
  maps: custom fields and values, versions, components, followers and votes, key history,
  workflows, rank, board columns, sprint membership, schemes, filters and dashboards. Each
  addition changes the golden manifest; review it.
- Every **Verify** line in the notes is a question for the first design partner's backup
  (M1-119). If a real backup disagrees, the notes, `format.ts`, the generator and the reader
  change together, and the golden manifest shows the change.
- Measured (the notes, "Measured"): 1,000,000 issues give 9,490,567 rows, a 343 MB ZIP holding a
  1.85 GB entities file and 100,104 attachment files. Writing took 281 s with a live heap of at
  most 99 MB, and checking took 48 s with at most 148 MB, on a loaded laptop.
