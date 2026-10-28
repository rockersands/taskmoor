import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { assertObjectKey, InvalidKeyError } from './keys';
import {
  type ByteRange,
  Meter,
  ObjectNotFoundError,
  type ObjectStore,
  type PutOptions,
  type PutResult,
} from './store';

/** Where unfinished uploads are written before they move into place. */
const INCOMING = '.incoming';

/**
 * Files on local disk (ADR-040), the default store: `<root>/w<workspace>/<aa>/<bb>/<key>`. An
 * upload is written to `<root>/.incoming` on the same file system, flushed, then renamed into
 * place, so a file under its key is always complete; an interrupted upload leaves only a
 * `.part` file, which `sweepIncomplete` removes. Folders are owner-only (0700), files 0600.
 *
 * Paths come from keys alone, and only keys of the shape `keys.ts` makes are accepted; the
 * resolved path is checked to sit under the root as well, so no input can reach outside it.
 * The API streams these files itself (no signed URLs).
 */
export class LocalStore implements ObjectStore {
  readonly kind = 'local' as const;
  private readonly incoming: string;

  private constructor(readonly root: string) {
    this.incoming = join(root, INCOMING);
  }

  static async open(root: string): Promise<LocalStore> {
    const absolute = resolve(root);
    await mkdir(join(absolute, INCOMING), { recursive: true, mode: 0o700 });
    return new LocalStore(absolute);
  }

  /** The file of a key, refused unless it is a key and stays under the root. */
  pathOf(key: string): string {
    assertObjectKey(key);
    const path = resolve(this.root, ...key.split('/'));
    if (!path.startsWith(this.root + sep)) throw new InvalidKeyError();
    return path;
  }

  async put(key: string, body: NodeJS.ReadableStream, options: PutOptions): Promise<PutResult> {
    const target = this.pathOf(key);
    const temp = join(this.incoming, `${randomBytes(16).toString('hex')}.part`);
    const meter = new Meter(options.maxBytes, options.onChunk);
    try {
      await pipeline(
        body,
        meter,
        // `flush` syncs the file before it closes, so the rename never publishes a torn file.
        createWriteStream(temp, { flags: 'wx', mode: 0o600, flush: true }),
      );
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(temp, target);
      return meter.result();
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async read(key: string, range?: ByteRange): Promise<NodeJS.ReadableStream> {
    const path = this.pathOf(key);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError();
      throw error;
    }
    return handle.createReadStream(range ? { start: range.start, end: range.end } : {});
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.pathOf(key))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async signedUrl(): Promise<null> {
    return null;
  }

  async sweepIncomplete(olderThan: Date): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.incoming)) {
      if (!name.endsWith('.part')) continue;
      const path = join(this.incoming, name);
      try {
        if ((await stat(path)).mtime < olderThan) {
          await rm(path, { force: true });
          removed += 1;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }
}
