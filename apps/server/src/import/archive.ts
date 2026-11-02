import yauzl from 'yauzl';

/**
 * Ceilings on what an uploaded archive may unpack to (M1-118; ASVS 12.1.2; ADR-110), checked
 * against the ZIP's central directory before any entry is read, and held while reading: yauzl
 * checks every entry's stream against the size its directory declares (`validateEntrySizes`),
 * so an entry that lies about its size fails when it passes the declared size.
 *
 * - `maxBytes`: the uncompressed total. Default 512 GiB: a backup of a million tickets with tens
 *   of gigabytes of attachments stays far below it.
 * - `maxRatio`: uncompressed to compressed, for each entry above 1 MiB and for the archive as a
 *   whole above 64 MiB. Default 200: XML compresses about 10 to 30 times, attachments mostly not
 *   at all; a ZIP bomb's single layer reaches about 1,000.
 * - `maxEntries`: entries in the archive. Default 10 million.
 *
 * The operator raises them with `TASKMOOR_ARCHIVE_MAX_GIB`, `TASKMOOR_ARCHIVE_MAX_RATIO` and
 * `TASKMOOR_ARCHIVE_MAX_ENTRIES`.
 */
export interface ArchiveLimits {
  maxBytes: number;
  maxRatio: number;
  maxEntries: number;
}

const GIB = 1024 ** 3;
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxBytes: 512 * GIB,
  maxRatio: 200,
  maxEntries: 10_000_000,
};
/** Entries smaller than this unpacked are not held to the ratio: a page of zeros is no bomb. */
export const RATIO_FLOOR_ENTRY = 1024 ** 2;
/** Nor is an archive smaller than this unpacked. */
export const RATIO_FLOOR_TOTAL = 64 * 1024 ** 2;

export class ArchiveLimitError extends Error {
  constructor(
    message: string,
    readonly limit: 'bytes' | 'ratio' | 'entries',
  ) {
    super(message);
    this.name = 'ArchiveLimitError';
  }
}

const positive = (text: string | undefined, name: string): number | undefined => {
  if (text === undefined || text.trim() === '') return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

/** The limits, with the operator's from the environment. */
export function archiveLimits(env: NodeJS.ProcessEnv = process.env): ArchiveLimits {
  const gib = positive(env.TASKMOOR_ARCHIVE_MAX_GIB, 'TASKMOOR_ARCHIVE_MAX_GIB');
  return {
    maxBytes: gib === undefined ? DEFAULT_ARCHIVE_LIMITS.maxBytes : Math.floor(gib * GIB),
    maxRatio:
      positive(env.TASKMOOR_ARCHIVE_MAX_RATIO, 'TASKMOOR_ARCHIVE_MAX_RATIO') ??
      DEFAULT_ARCHIVE_LIMITS.maxRatio,
    maxEntries: Math.floor(
      positive(env.TASKMOOR_ARCHIVE_MAX_ENTRIES, 'TASKMOOR_ARCHIVE_MAX_ENTRIES') ??
        DEFAULT_ARCHIVE_LIMITS.maxEntries,
    ),
  };
}

export interface ArchiveTotals {
  entries: number;
  compressed: number;
  uncompressed: number;
}

const gibText = (bytes: number) => `${(bytes / GIB).toFixed(bytes < GIB ? 3 : 1)} GiB`;
const ratioText = (ratio: number) => `${Math.round(ratio)} to 1`;

/** Holds one more entry to the limits; the running totals after it. */
export function holdEntry(
  totals: ArchiveTotals,
  entry: { fileName: string; compressedSize: number; uncompressedSize: number },
  limits: ArchiveLimits,
): ArchiveTotals {
  const next = {
    entries: totals.entries + 1,
    compressed: totals.compressed + entry.compressedSize,
    uncompressed: totals.uncompressed + entry.uncompressedSize,
  };
  if (next.entries > limits.maxEntries) {
    throw new ArchiveLimitError(
      `The archive holds more than ${limits.maxEntries} entries, the most allowed (TASKMOOR_ARCHIVE_MAX_ENTRIES)`,
      'entries',
    );
  }
  if (next.uncompressed > limits.maxBytes) {
    throw new ArchiveLimitError(
      `The archive unpacks to more than ${gibText(limits.maxBytes)}, the most allowed (TASKMOOR_ARCHIVE_MAX_GIB)`,
      'bytes',
    );
  }
  if (entry.uncompressedSize > RATIO_FLOOR_ENTRY) {
    const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
    if (ratio > limits.maxRatio) {
      throw new ArchiveLimitError(
        `${entry.fileName.slice(0, 200)} unpacks ${ratioText(ratio)} (${gibText(entry.uncompressedSize)} from ${entry.compressedSize} bytes), above the ${ratioText(limits.maxRatio)} allowed (TASKMOOR_ARCHIVE_MAX_RATIO)`,
        'ratio',
      );
    }
  }
  return next;
}

/** Holds the totals of a whole archive to the overall ratio. */
export function holdTotals(totals: ArchiveTotals, limits: ArchiveLimits): void {
  if (totals.uncompressed <= RATIO_FLOOR_TOTAL) return;
  const ratio = totals.uncompressed / Math.max(1, totals.compressed);
  if (ratio > limits.maxRatio) {
    throw new ArchiveLimitError(
      `The archive unpacks ${ratioText(ratio)} (${gibText(totals.uncompressed)} from ${totals.compressed} bytes), above the ${ratioText(limits.maxRatio)} allowed (TASKMOOR_ARCHIVE_MAX_RATIO)`,
      'ratio',
    );
  }
}

/**
 * Reads a ZIP's central directory and holds it to the limits before anything is unpacked;
 * throws `ArchiveLimitError` naming the limit and the numbers.
 */
export async function checkArchive(
  path: string,
  limits: ArchiveLimits = archiveLimits(),
): Promise<ArchiveTotals> {
  const zip = await new Promise<yauzl.ZipFile>((ok, fail) =>
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (error, file) =>
      error || !file ? fail(error ?? new Error('zip')) : ok(file),
    ),
  );
  let totals: ArchiveTotals = { entries: 0, compressed: 0, uncompressed: 0 };
  await new Promise<void>((done, fail) => {
    zip.on('error', fail);
    zip.on('end', () => done());
    zip.on('entry', (entry: yauzl.Entry) => {
      try {
        totals = holdEntry(totals, entry, limits);
      } catch (error) {
        zip.close();
        fail(error);
        return;
      }
      zip.readEntry();
    });
    zip.readEntry();
  });
  holdTotals(totals, limits);
  return totals;
}
