import { open } from 'node:fs/promises';

/**
 * Reads up to `limit` JSON lines of a file after a byte offset (null: from the start), each
 * with the offset after it as its cursor, so a run resumes in the middle of a large file
 * without reading it again. Shared by Taskmoor's own export (M1-098) and the staged Data
 * Center backup (M1-088).
 */
export async function readJsonLines(
  path: string,
  after: string | null,
  limit: number,
): Promise<{ value: Record<string, unknown>; cursor: string }[]> {
  const handle = await open(path, 'r');
  try {
    const out: { value: Record<string, unknown>; cursor: string }[] = [];
    let position = after === null ? 0 : Number(after);
    let pending = Buffer.alloc(0);
    const chunk = Buffer.alloc(1024 * 1024);
    while (out.length < limit) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position + pending.length);
      if (bytesRead === 0) break;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (;;) {
        const end = pending.indexOf(10, start);
        if (end < 0 || out.length >= limit) break;
        const line = pending.subarray(start, end).toString('utf8');
        start = end + 1;
        if (line.trim() === '') continue;
        out.push({
          value: JSON.parse(line) as Record<string, unknown>,
          cursor: String(position + start),
        });
      }
      position += start;
      pending = pending.subarray(start);
    }
    return out;
  } finally {
    await handle.close();
  }
}
