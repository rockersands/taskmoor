import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import {
  ArchiveLimitError,
  archiveLimits,
  checkArchive,
  DEFAULT_ARCHIVE_LIMITS,
  holdEntry,
  holdTotals,
} from './archive';
import { checkDcBackup, DcBackupError, stageDcBackup } from './dc-backup/stage';
import { ExportFormatError, exportFolder } from './taskmoor';

/**
 * Archive limits (M1-118; IMP-001, IMP-014, NFR-008; ASVS 12.1.2; ADR-110). The ZIP bomb is
 * made here: 16 MiB of zeros deflate to about 16 KB, a ratio near 1,000, so the file on disk
 * stays small.
 */
const MIB = 1024 ** 2;

async function zipOf(path: string, entries: Record<string, Buffer>): Promise<string> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of Object.entries(entries)) zip.addBuffer(data, name);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
  return path;
}

describe('archive limits (ASVS 12.1.2)', () => {
  let dir: string;
  let bomb: string;
  let fine: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'taskmoor-archive-'));
    bomb = await zipOf(join(dir, 'bomb.zip'), {
      'entities.xml': Buffer.alloc(16 * MIB),
      'activeobjects.xml': Buffer.from('<backup/>'),
    });
    fine = await zipOf(join(dir, 'fine.zip'), {
      'entities.xml': Buffer.from('<entity-engine-xml></entity-engine-xml>'),
      // Small runs of zeros are no bomb, whatever their ratio.
      'data/attachments/P/10000/P-1/10001': Buffer.alloc(MIB),
    });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('[NFR-008] the bomb is small on disk and refused by its ratio before anything is unpacked', async () => {
    expect((await stat(bomb)).size).toBeLessThan(100 * 1024);
    const error = await checkArchive(bomb).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArchiveLimitError);
    expect((error as ArchiveLimitError).limit).toBe('ratio');
    expect((error as Error).message).toMatch(
      /^entities\.xml unpacks \d+ to 1 \(0\.016 GiB from \d+ bytes\), above the 200 to 1 allowed \(TASKMOOR_ARCHIVE_MAX_RATIO\)$/,
    );
    expect(await checkArchive(fine)).toMatchObject({ entries: 2, uncompressed: MIB + 39 });
    // The operator can raise the ratio.
    await expect(
      checkArchive(bomb, { ...DEFAULT_ARCHIVE_LIMITS, maxRatio: 5000 }),
    ).resolves.toMatchObject({
      entries: 2,
    });
  });

  it('[NFR-008] holds the uncompressed total, the entry count and the overall ratio', async () => {
    await expect(checkArchive(fine, { ...DEFAULT_ARCHIVE_LIMITS, maxBytes: MIB })).rejects.toThrow(
      'The archive unpacks to more than 0.001 GiB, the most allowed (TASKMOOR_ARCHIVE_MAX_GIB)',
    );
    await expect(checkArchive(fine, { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 })).rejects.toThrow(
      'The archive holds more than 1 entries, the most allowed (TASKMOOR_ARCHIVE_MAX_ENTRIES)',
    );
    // A directory that claims a terabyte is refused from its numbers alone.
    expect(() =>
      holdEntry(
        { entries: 0, compressed: 0, uncompressed: 0 },
        { fileName: 'entities.xml', compressedSize: 2 ** 30, uncompressedSize: 2 ** 40 },
        DEFAULT_ARCHIVE_LIMITS,
      ),
    ).toThrow(/more than 512\.0 GiB/);
    // Many small entries that each pass add up to a ratio the archive does not.
    let totals = { entries: 0, compressed: 0, uncompressed: 0 };
    for (let i = 0; i < 100; i++) {
      totals = holdEntry(
        totals,
        { fileName: `f${i}`, compressedSize: 1024, uncompressedSize: MIB },
        DEFAULT_ARCHIVE_LIMITS,
      );
    }
    expect(() => holdTotals(totals, DEFAULT_ARCHIVE_LIMITS)).toThrow(
      /^The archive unpacks 1024 to 1/,
    );
    const many = join(dir, 'many.zip');
    await zipOf(
      many,
      Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}`, Buffer.alloc(MIB)])),
    );
    await expect(checkArchive(many)).rejects.toThrow(/^The archive unpacks \d+ to 1/);
  });

  it('[NFR-008] reads the operator limits from the environment', () => {
    expect(archiveLimits({})).toEqual(DEFAULT_ARCHIVE_LIMITS);
    expect(
      archiveLimits({
        TASKMOOR_ARCHIVE_MAX_GIB: '2048',
        TASKMOOR_ARCHIVE_MAX_RATIO: '500',
        TASKMOOR_ARCHIVE_MAX_ENTRIES: '50000000',
      }),
    ).toEqual({ maxBytes: 2048 * 1024 ** 3, maxRatio: 500, maxEntries: 50_000_000 });
    expect(() => archiveLimits({ TASKMOOR_ARCHIVE_MAX_RATIO: '-1' })).toThrow(/positive/);
  });

  it('[IMP-001][NFR-008] a Data Center backup that is a bomb is refused by the route check and the stage, leaving nothing', async () => {
    await expect(checkDcBackup(bomb)).rejects.toBeInstanceOf(DcBackupError);
    await expect(stageDcBackup(bomb)).rejects.toThrow(/entities\.xml unpacks \d+ to 1/);
    expect((await readdir(dir)).filter((name) => name.includes('.staged'))).toEqual([]);
  });

  it('[IMP-014][NFR-008] a Taskmoor export ZIP that is a bomb is refused before anything is written', async () => {
    const exportBomb = await zipOf(join(dir, 'export.zip'), {
      'manifest.json': Buffer.from('{}'),
      'tickets.ndjson': Buffer.alloc(16 * MIB),
    });
    const error = await exportFolder(exportBomb).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExportFormatError);
    expect((error as Error).message).toMatch(/^tickets\.ndjson unpacks/);
    expect((await readdir(dir)).filter((name) => name.startsWith('export.zip.'))).toEqual([]);
  });
});
