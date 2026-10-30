import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

/**
 * Where an export goes (M1-098): a folder on disk (the CLI, tests, the importer's own input) or
 * a ZIP streamed to a response. Both take files one after the other, lines or bytes, wait
 * whenever the far side is behind (so a large export never piles up in memory), and report
 * each file's size and SHA-256 for the manifest.
 */
export interface Written {
  bytes: number;
  sha256: string;
}

export interface LineFile {
  /** Writes one line (a newline is added); resolves when the sink can take more. */
  line(text: string): Promise<void>;
  close(): Promise<Written>;
}

export interface ExportSink {
  open(name: string): Promise<LineFile>;
  /** Copies a file from a stream. */
  copy(name: string, body: NodeJS.ReadableStream): Promise<Written>;
  /** Everything is written (or, for a ZIP, handed to the stream). */
  finish(): Promise<void>;
}

/** Writes to a stream, waiting for `drain` when it is full; counts and hashes the bytes. */
function lineFile(out: Writable, done: () => Promise<void>): LineFile {
  const hash = createHash('sha256');
  let bytes = 0;
  return {
    async line(text) {
      const chunk = Buffer.from(`${text}\n`);
      hash.update(chunk);
      bytes += chunk.length;
      if (!out.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          const fail = (error: Error) => reject(error);
          out.once('error', fail);
          out.once('drain', () => {
            out.off('error', fail);
            resolve();
          });
        });
      }
    },
    async close() {
      out.end();
      await done();
      return { bytes, sha256: hash.digest('hex') };
    },
  };
}

/** Hashes and counts what passes. */
function meter(): { stream: PassThrough; result: () => Written } {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  let digest: string | null = null;
  return {
    stream,
    result: () => {
      digest ??= hash.digest('hex');
      return { bytes, sha256: digest };
    },
  };
}

/**
 * An export into a folder. Files are written under a temporary name and renamed when complete,
 * so a reader never takes a half-written file for a whole one.
 */
export function folderSink(root: string): ExportSink {
  const place = async (name: string) => {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    return path;
  };
  return {
    async open(name) {
      const path = await place(name);
      const out = createWriteStream(`${path}.part`);
      const finished = new Promise<void>((resolve, reject) => {
        out.once('finish', () => resolve());
        out.once('error', reject);
      });
      return lineFile(out, async () => {
        await finished;
        await rename(`${path}.part`, path);
      });
    },
    async copy(name, body) {
      const path = await place(name);
      const m = meter();
      await pipeline(body as Readable, m.stream, createWriteStream(`${path}.part`));
      await rename(`${path}.part`, path);
      return m.result();
    },
    async finish() {},
  };
}

/**
 * An export as a ZIP read from `output` while it is written: entries are deflated NDJSON and
 * stored attachments (already compressed, mostly), each added when the one before it is done.
 */
export function zipSink(): ExportSink & { output: NodeJS.ReadableStream } {
  const zip = new yazl.ZipFile();
  /** Resolves when yazl has read the entry added last. */
  let previous: Promise<void> = Promise.resolve();
  const add = (name: string, compress: boolean) => {
    const entry = new PassThrough();
    const consumed = new Promise<void>((resolve, reject) => {
      entry.once('end', () => resolve());
      entry.once('error', reject);
    });
    zip.addReadStream(entry, name, { compress, mtime: new Date(0) });
    previous = consumed;
    return { entry, consumed };
  };
  return {
    output: zip.outputStream,
    async open(name) {
      await previous;
      const { entry, consumed } = add(name, true);
      return lineFile(entry, () => consumed);
    },
    async copy(name, body) {
      await previous;
      const { entry, consumed } = add(name, false);
      const m = meter();
      await pipeline(body as Readable, m.stream, entry);
      await consumed;
      return m.result();
    },
    async finish() {
      await previous;
      zip.end();
    },
  };
}
