import { appendFileSync, createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Files the stage spills rows into while it reads a backup (M1-091; IMP-001 (1), ADR-092), so
 * memory stays flat however large the backup is: plain JSON-lines files appended through a
 * buffer, and buckets of such files by id range, which a later step reads one at a time to
 * join rows that belong together (an issue and its custom values, a change group and its
 * items) with memory for one bucket only.
 */

const FLUSH = 128 * 1024;

/** One JSON-lines file appended through a buffer. */
export class SpillFile {
  private buffer: string[] = [];
  private size = 0;
  rows = 0;

  constructor(readonly path: string) {}

  add(value: unknown): void {
    const line = `${JSON.stringify(value)}\n`;
    this.buffer.push(line);
    this.size += line.length;
    this.rows++;
    if (this.size >= FLUSH) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    appendFileSync(this.path, this.buffer.join(''));
    this.buffer = [];
    this.size = 0;
  }

  /** The rows in the order they were added (none when nothing was). */
  async *read(): AsyncGenerator<unknown> {
    this.flush();
    if (!existsSync(this.path)) return;
    yield* readLines(this.path);
  }
}

export async function* readLines(path: string): AsyncGenerator<unknown> {
  const lines = createInterface({
    input: createReadStream(path, { highWaterMark: 1 << 20 }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) if (line !== '') yield JSON.parse(line);
}

/**
 * Rows in buckets by id range: ids `0 .. width - 1` in the first, and so on; ids that are not
 * whole numbers share one bucket of their own. A backup's ids are close to dense, so a range
 * holds about `width` of them; past `maxBuckets` ranges fold onto each other, which keeps the
 * number of files bounded and only loses the order between them.
 */
export class Buckets {
  private readonly files = new Map<number, SpillFile>();

  constructor(
    private readonly prefix: string,
    private readonly width: number,
    private readonly maxBuckets = 4096,
  ) {}

  bucketOf(id: string): number {
    if (!/^\d{1,15}$/.test(id)) return -1;
    return Math.floor(Number(id) / this.width) % this.maxBuckets;
  }

  add(id: string, value: unknown): void {
    const bucket = this.bucketOf(id);
    let file = this.files.get(bucket);
    if (!file) {
      file = new SpillFile(`${this.prefix}-${bucket < 0 ? 'x' : bucket}.ndjson`);
      this.files.set(bucket, file);
    }
    file.add(value);
  }

  /** Every bucket in ascending id order (non-numeric ids last), each as its rows. */
  *buckets(): Generator<SpillFile> {
    const order = [...this.files.keys()].sort((a, b) => (a < 0 ? 1 : b < 0 ? -1 : a - b));
    for (const b of order) yield this.files.get(b) as SpillFile;
  }

  get rows(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.rows;
    return n;
  }
}

/** Ids as the backup writes them, compared as numbers when both are. */
export function byId(a: string, b: string): number {
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
}
