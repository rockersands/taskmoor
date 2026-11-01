import { createWriteStream } from 'node:fs';
import { link, readdir, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { MANIFEST } from '../export/format';
import { STAGED } from './dc-backup/stage';

/**
 * The imports folder as the import wizard shows it (M1-097; IMP-013): the files an import can
 * read, with what each looks like, and files an administrator uploads into it. A Data Center
 * backup can be tens of gigabytes: such files are copied into the folder on the server, and the
 * upload is for the ones a browser can send.
 */
export type ImportFileKind = 'dc-backup' | 'taskmoor' | 'csv' | null;

export interface ImportFile {
  /** The path inside the folder, as an import's `path` names it. */
  name: string;
  size: number;
  modifiedAt: string;
  /** The source format it looks like, or null when it looks like none. */
  kind: ImportFileKind;
}

/** The most an upload may hold; larger files are copied into the folder. */
export const MAX_IMPORT_UPLOAD = 4 * 1024 ** 3;

/** Names of what an import writes beside its file, never sources themselves. */
const WORKING = [STAGED, '.unpacked', '.part'];

/** A file name an upload may take: one level, plain characters, a known extension. */
export function uploadName(name: string): string | null {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/.test(trimmed)) return null;
  if (!/\.(zip|csv)$/i.test(trimmed)) return null;
  if (WORKING.some((w) => trimmed.endsWith(w))) return null;
  return trimmed;
}

/** The first entries of a ZIP's directory say whether it is a backup or an export. */
async function zipKind(path: string): Promise<ImportFileKind> {
  const zip = await new Promise<yauzl.ZipFile | null>((ok) =>
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (e, z) => ok(e || !z ? null : z)),
  );
  if (!zip) return null;
  return new Promise((done) => {
    let seen = 0;
    const end = (kind: ImportFileKind) => {
      zip.close();
      done(kind);
    };
    zip.on('error', () => end(null));
    zip.on('end', () => done(null));
    zip.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName === 'entities.xml') return end('dc-backup');
      if (entry.fileName === MANIFEST) return end('taskmoor');
      if (++seen >= 1000) return end(null);
      zip.readEntry();
    });
    zip.readEntry();
  });
}

/** The files of the imports folder, its top level and one folder down, by name. */
export async function listImportFiles(root: string): Promise<ImportFile[]> {
  const base = await realpath(root);
  const out: ImportFile[] = [];
  const visit = async (dir: string, prefix: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = `${prefix}${entry.name}`;
      if (entry.name.startsWith('.') || WORKING.some((w) => entry.name.endsWith(w))) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const info = await stat(join(path, MANIFEST)).catch(() => null);
        if (info?.isFile()) {
          const own = await stat(path);
          out.push({ name, size: 0, modifiedAt: own.mtime.toISOString(), kind: 'taskmoor' });
        } else if (depth === 0) {
          await visit(path, `${name}/`, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(path);
      const lower = entry.name.toLowerCase();
      const kind = lower.endsWith('.csv')
        ? 'csv'
        : lower.endsWith('.zip')
          ? await zipKind(path)
          : null;
      out.push({ name, size: info.size, modifiedAt: info.mtime.toISOString(), kind });
    }
  };
  await visit(base, '', 0);
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export class UploadRefused extends Error {}

/**
 * Writes an upload into the folder under `name`, through a `.part` file linked into place at
 * the end, so a cut upload leaves nothing an import would read and an existing file is never
 * replaced. Refuses more than `max` bytes.
 */
export async function saveImportFile(
  root: string,
  name: string,
  body: Readable,
  max = MAX_IMPORT_UPLOAD,
): Promise<{ name: string; size: number; kind: ImportFileKind }> {
  const base = await realpath(root);
  const target = join(base, name);
  if (await stat(target).catch(() => null)) throw new UploadRefused('file_exists');
  const part = `${target}.${process.pid}.${Date.now()}.part`;
  let size = 0;
  try {
    await pipeline(
      body,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > max) throw new UploadRefused('too_large');
          yield chunk;
        }
      },
      createWriteStream(part, { flags: 'wx' }),
    );
    // A link fails when the name was taken meanwhile: nothing is replaced.
    await link(part, target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new UploadRefused('file_exists');
      throw error;
    });
  } finally {
    await rm(part, { force: true });
  }
  const kind = name.toLowerCase().endsWith('.csv') ? 'csv' : await zipKind(target);
  return { name, size, kind };
}
