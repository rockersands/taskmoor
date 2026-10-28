import { PassThrough, type Readable } from 'node:stream';
import type { ByteRange } from '@taskmoor/storage';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { safeFilename, uniqueNames } from './filename';

/**
 * ZIP attachments (CORE-021): their entries are listed and single entries streamed out, read
 * from the store by byte ranges, never extracted to disk. And a ticket's attachments download
 * as one streamed ZIP.
 *
 * Guards: at most `MAX_LISTED` entries are listed (the rest are counted), an entry streams only
 * when its declared size is within the workspace's file size limit and its bytes then match
 * that size (yauzl checks), so a bomb stops where its header says it ends. Entry names are
 * display text: a name with an absolute path or `..` (zip slip) is listed as unsafe, and a
 * downloaded entry is named by its last segment only.
 */
export const MAX_LISTED = 10_000;
/** Reads go through 1 MiB blocks, so listing a large archive on S3 takes a few GETs. */
const BLOCK = 1024 * 1024;
const CACHED_BLOCKS = 8;

export type RangeReader = (range: ByteRange) => Promise<NodeJS.ReadableStream>;

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** yauzl's random access over a store: small reads from cached blocks, large ones streamed. */
class StoreReader extends yauzl.RandomAccessReader {
  private readonly blocks = new Map<number, Promise<Buffer>>();

  constructor(
    private readonly readRange: RangeReader,
    private readonly size: number,
  ) {
    super();
  }

  private block(index: number): Promise<Buffer> {
    let found = this.blocks.get(index);
    if (!found) {
      const start = index * BLOCK;
      const end = Math.min(this.size, start + BLOCK) - 1;
      found = this.readRange({ start, end }).then(readAll);
      this.blocks.set(index, found);
      if (this.blocks.size > CACHED_BLOCKS) {
        this.blocks.delete(this.blocks.keys().next().value as number);
      }
    }
    return found;
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const out = new PassThrough();
    if (end <= start) {
      out.end();
      return out;
    }
    if (end - start <= 64 * 1024) {
      const first = Math.floor(start / BLOCK);
      const last = Math.floor((end - 1) / BLOCK);
      const indexes = Array.from({ length: last - first + 1 }, (_, i) => first + i);
      Promise.all(indexes.map((i) => this.block(i))).then(
        (buffers) => {
          // Slices of the blocks, never a copy of a whole block.
          const pieces = buffers.map((block, n) => {
            const blockStart = (first + n) * BLOCK;
            return block.subarray(
              Math.max(0, start - blockStart),
              Math.min(block.length, end - blockStart),
            );
          });
          out.end(pieces.length === 1 ? pieces[0] : Buffer.concat(pieces));
        },
        (error: Error) => out.destroy(error),
      );
      return out;
    }
    this.readRange({ start, end: end - 1 }).then(
      (stream) => {
        stream.on('error', (error: Error) => out.destroy(error));
        stream.pipe(out);
      },
      (error: Error) => out.destroy(error),
    );
    return out;
  }
}

function open(readRange: RangeReader, size: number): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromRandomAccessReader(
      new StoreReader(readRange, size),
      size,
      { lazyEntries: true, decodeStrings: false, validateEntrySizes: true, autoClose: false },
      (error, zip) => (error ? reject(error) : resolve(zip)),
    );
  });
}

export interface ZipEntryView {
  /** Position in the archive's central directory; entries are fetched by it. */
  index: number;
  /** The path as stored, cleaned of control characters, for display. */
  path: string;
  size: number;
  compressedSize: number;
  directory: boolean;
  encrypted: boolean;
  /** An absolute path or a `..` segment: harmless here, dangerous to a naive unzip tool. */
  unsafe: boolean;
  modifiedAt: string | null;
}

export interface ZipListing {
  entries: ZipEntryView[];
  /** Entries in the archive, listed or not. */
  total: number;
  truncated: boolean;
}

export type ZipErrorCode =
  | 'not_a_zip'
  | 'no_such_entry'
  | 'directory'
  | 'encrypted'
  | 'too_large'
  | 'unsupported';

export class ZipError extends Error {
  constructor(
    readonly code: ZipErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

function entryPath(entry: yauzl.Entry): { path: string; unsafe: boolean } {
  const raw = entry.fileName as unknown as Buffer;
  const decoded = yauzl.getFileNameLowLevel(
    entry.generalPurposeBitFlag,
    raw,
    entry.extraFields,
    false,
  );
  const unsafe = raw.includes(0x5c) || yauzl.validateFileName(decoded) !== null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are removed
  const path = decoded.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 1000);
  return { path, unsafe };
}

function view(entry: yauzl.Entry, index: number): ZipEntryView {
  const { path, unsafe } = entryPath(entry);
  let modifiedAt: string | null = null;
  try {
    modifiedAt = entry.getLastModDate({ timezone: 'UTC' }).toISOString();
  } catch {
    modifiedAt = null;
  }
  return {
    index,
    path,
    size: entry.uncompressedSize,
    compressedSize: entry.compressedSize,
    directory: path.endsWith('/'),
    encrypted: entry.isEncrypted(),
    unsafe,
    modifiedAt,
  };
}

/** Walks the central directory; `visit` returns false to stop. */
async function walk(
  zip: yauzl.ZipFile,
  visit: (entry: yauzl.Entry, index: number) => boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let index = 0;
    zip.on('entry', (entry: yauzl.Entry) => {
      if (visit(entry, index++)) zip.readEntry();
      else resolve();
    });
    zip.on('end', () => resolve());
    zip.on('error', reject);
    zip.readEntry();
  });
}

export async function listZip(readRange: RangeReader, size: number): Promise<ZipListing> {
  let zip: yauzl.ZipFile;
  try {
    zip = await open(readRange, size);
  } catch (error) {
    throw new ZipError('not_a_zip', (error as Error).message);
  }
  try {
    const entries: ZipEntryView[] = [];
    await walk(zip, (entry, index) => {
      entries.push(view(entry, index));
      return entries.length < MAX_LISTED;
    });
    return { entries, total: zip.entryCount, truncated: zip.entryCount > entries.length };
  } catch (error) {
    throw new ZipError('not_a_zip', (error as Error).message);
  } finally {
    zip.close();
  }
}

export interface OpenedEntry {
  entry: ZipEntryView;
  /** The file name to offer: the last segment of its path, made safe. */
  name: string;
  stream: Readable;
}

/** One entry's bytes, decompressed as they stream; `maxBytes` bounds its declared size. */
export async function openZipEntry(
  readRange: RangeReader,
  size: number,
  index: number,
  maxBytes: number,
): Promise<OpenedEntry> {
  let zip: yauzl.ZipFile;
  try {
    zip = await open(readRange, size);
  } catch (error) {
    throw new ZipError('not_a_zip', (error as Error).message);
  }
  if (index < 0 || index >= zip.entryCount) {
    zip.close();
    throw new ZipError('no_such_entry');
  }
  let found: yauzl.Entry | null = null;
  try {
    await walk(zip, (entry, i) => {
      if (i === index) {
        found = entry;
        return false;
      }
      return true;
    });
  } catch (error) {
    zip.close();
    throw new ZipError('not_a_zip', (error as Error).message);
  }
  const entry = found as yauzl.Entry | null;
  if (!entry) {
    zip.close();
    throw new ZipError('no_such_entry');
  }
  const shown = view(entry, index);
  const refuse = (code: ZipErrorCode) => {
    zip.close();
    return new ZipError(code);
  };
  if (shown.directory) throw refuse('directory');
  if (shown.encrypted) throw refuse('encrypted');
  if (entry.uncompressedSize > maxBytes) throw refuse('too_large');
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw refuse('unsupported');
  const stream = await new Promise<Readable>((resolve, reject) =>
    zip.openReadStream(entry, (error, s) => (error ? reject(error) : resolve(s))),
  ).catch((error: Error) => {
    zip.close();
    throw new ZipError('not_a_zip', error.message);
  });
  stream.on('close', () => zip.close());
  const last = shown.path.split('/').filter(Boolean).pop() ?? '';
  return { entry: shown, name: safeFilename(last), stream };
}

/** Types already compressed, stored as they are in an archive. */
const COMPRESSED =
  /^(image\/(png|jpeg|gif|webp|avif)|video\/|audio\/|application\/(zip|pdf|gzip|x-7z|x-rar|zstd))/;

export interface ArchiveItem {
  name: string;
  size: number;
  contentType: string;
  createdAt: Date;
  open: () => Promise<NodeJS.ReadableStream>;
}

/**
 * A ZIP of the items, streamed: each file is read from the store only when the archive reaches
 * it. Names are made unique; ZIP64 is used where sizes need it.
 */
export function archive(items: readonly ArchiveItem[]): NodeJS.ReadableStream {
  const zip = new yazl.ZipFile();
  const names = uniqueNames(items.map((i) => i.name));
  items.forEach((item, i) => {
    zip.addReadStreamLazy(
      names[i] as string,
      { mtime: item.createdAt, size: item.size, compress: !COMPRESSED.test(item.contentType) },
      (done) => {
        item.open().then(
          (stream) => done(null, stream),
          (error: unknown) => done(error, undefined as unknown as NodeJS.ReadableStream),
        );
      },
    );
  });
  // A file that cannot be read (or has another size than recorded) ends the download with an
  // error rather than the process: yazl reports it on the archive, not on its stream.
  zip.on('error', (error: Error) => (zip.outputStream as unknown as Readable).destroy(error));
  zip.end();
  return zip.outputStream;
}
