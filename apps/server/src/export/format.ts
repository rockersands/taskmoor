import { z } from 'zod';
import type { EntityKind } from '../import/model';

/**
 * Taskmoor's full export format (M1-098; IMP-014; ADR-063), version 1. A workspace exports as
 * a folder (or the same folder as a ZIP): `manifest.json`, one newline-delimited JSON file per
 * kind of record, and `attachments/` with one file per attachment. The reference for people
 * who read or write it is `docs/export-format.md`; this module is the contract the writer and
 * the importer share.
 *
 * - Every line is one record in canonical JSON (keys sorted, no spaces), so the same data
 *   always gives the same bytes and files can be compared by checksum.
 * - Records carry `id`, the source's own id as text, and name other records by those ids.
 *   Values Taskmoor stores with ids inside (custom values, history entries, rich text,
 *   workflow definitions, formula expressions) are written as stored; an import maps them
 *   (`import/remap.ts`).
 * - Files come in the order an import reads them: each kind needs only kinds before it.
 * - The manifest lists every file with its record count, size and SHA-256, and the
 *   attachments with one SHA-256 over their names and checksums.
 */
export const EXPORT_FORMAT = 'taskmoor-export';
export const EXPORT_VERSION = 1;
export const MANIFEST = 'manifest.json';
export const ATTACHMENTS_DIR = 'attachments';

/** The files of an export, in the order an import reads them. */
export const EXPORT_FILES: readonly { kind: EntityKind; file: string }[] = [
  { kind: 'user', file: 'users.ndjson' },
  { kind: 'group', file: 'groups.ndjson' },
  { kind: 'role', file: 'roles.ndjson' },
  { kind: 'status', file: 'statuses.ndjson' },
  { kind: 'priority', file: 'priorities.ndjson' },
  { kind: 'close_reason', file: 'close-reasons.ndjson' },
  { kind: 'ticket_type', file: 'ticket-types.ndjson' },
  { kind: 'link_type', file: 'link-types.ndjson' },
  { kind: 'track', file: 'tracks.ndjson' },
  { kind: 'release', file: 'releases.ndjson' },
  { kind: 'area', file: 'areas.ndjson' },
  { kind: 'field', file: 'fields.ndjson' },
  { kind: 'field_context', file: 'field-contexts.ndjson' },
  { kind: 'field_option', file: 'field-options.ndjson' },
  { kind: 'workflow', file: 'workflows.ndjson' },
  { kind: 'workflow_map', file: 'workflow-maps.ndjson' },
  { kind: 'ticket', file: 'tickets.ndjson' },
  { kind: 'comment', file: 'comments.ndjson' },
  { kind: 'link', file: 'links.ndjson' },
  { kind: 'time_entry', file: 'time-entries.ndjson' },
  { kind: 'attachment', file: 'attachments.ndjson' },
  { kind: 'history', file: 'history.ndjson' },
];

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().min(0);

export const manifestSchema = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    version: z.literal(EXPORT_VERSION),
    /** Who wrote it: the instance and workspace, stable across exports (external ids). */
    system: z.string().min(1).max(200),
    workspace: z.string(),
    exportedAt: z.iso.datetime({ offset: true }),
    /** The tracks chosen, by key; null for the whole workspace. */
    tracks: z.array(z.string()).nullable(),
    files: z.array(
      z
        .object({
          name: z.string(),
          kind: z.string(),
          records: count,
          bytes: count,
          sha256,
        })
        .strict(),
    ),
    attachments: z
      .object({
        files: count,
        bytes: count,
        /** SHA-256 over `<name> <sha256>\n` of every file, by name. */
        sha256,
      })
      .strict(),
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;
