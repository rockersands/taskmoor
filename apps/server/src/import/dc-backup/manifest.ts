import { z } from 'zod';

/**
 * What the generator knows about a backup it wrote (M1-087), kept beside the ZIP as
 * `<name>.manifest.json`. Everything in it follows from the options, so the same options give
 * the same manifest on every machine; the importer's golden tests (M1-088 onwards) compare
 * their counts with it, and the validator checks a ZIP against it.
 */
export const MANIFEST_FORMAT = 'taskmoor-dc-backup-manifest';

const count = z.number().int().min(0);
const written = z.object({ bytes: count, sha256: z.string().regex(/^[0-9a-f]{64}$/) });

export const generatorOptions = z
  .object({
    seed: z.number().int().min(0).max(2_147_483_647),
    issues: z.number().int().min(1).max(10_000_000),
    projects: z.number().int().min(1).max(10_000),
    users: z.number().int().min(4).max(1_000_000),
    groups: z.number().int().min(1).max(100_000),
    /** Chance that an issue has attachments. */
    attachmentRate: z.number().min(0).max(1),
    /** Chance that a text value carries one character XML forbids. */
    forbiddenRate: z.number().min(0).max(1),
    /** The moment the backup was taken: every time in it is earlier. */
    exportedAt: z.iso.datetime(),
    /** zlib level for the ZIP's entries (0 stores them). */
    compressionLevel: z.number().int().min(0).max(9),
    /** Projects renamed in the source, the first ones: their earlier key is `originalkey` (M1-128). */
    renamedProjects: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type GeneratorOptions = z.infer<typeof generatorOptions>;

export const manifestSchema = z
  .object({
    format: z.literal(MANIFEST_FORMAT),
    version: z.literal(1),
    options: generatorOptions,
    files: z.object({ entities: written, activeObjects: written }).strict(),
    attachments: z.object({ files: count, bytes: count, sha256: written.shape.sha256 }).strict(),
    /** Rows per element name in the entities file. */
    entities: z.record(z.string(), count),
    /** Rows per table in the active-objects file. */
    activeObjects: z.record(z.string(), count),
    /** Counts of the cases the importer must handle, for its golden tests. */
    cases: z.record(z.string(), count),
    /** Characters XML forbids, written on purpose (the reader must remove and log each). */
    forbidden: z
      .object({ nul: count, control: count, noncharacter: count, charRef: count })
      .strict(),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;
