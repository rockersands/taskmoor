import { createHash } from 'node:crypto';
import type { Writable } from 'node:stream';

/** Escapes a value for a double-quoted attribute; line breaks stay as references. */
export function escapeAttr(value: string): string {
  return value.replace(/[&<>"\n\r\t]/g, (c) => ATTR[c] as string);
}

/** Escapes element text. */
export function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (c) => TEXT[c] as string);
}

const ATTR: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\n': '&#10;',
  '\r': '&#13;',
  '\t': '&#9;',
};
const TEXT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

export interface Written {
  bytes: number;
  sha256: string;
}

/**
 * Text written to a stream in large chunks: `push` collects, and says when a chunk is ready so
 * the caller can `await flush()` (which waits for `drain`). Counts and hashes the bytes, so the
 * manifest can name the uncompressed file exactly.
 */
export class TextOut {
  private parts: string[] = [];
  private size = 0;
  private bytes = 0;
  private readonly hash = createHash('sha256');

  constructor(
    private readonly out: Writable,
    private readonly chunk = 1 << 18,
  ) {}

  /** Adds text; true when a chunk is ready and the caller should `await flush()`. */
  push(text: string): boolean {
    this.parts.push(text);
    this.size += text.length;
    return this.size >= this.chunk;
  }

  async flush(): Promise<void> {
    if (this.parts.length === 0) return;
    const buffer = Buffer.from(this.parts.join(''), 'utf8');
    this.parts = [];
    this.size = 0;
    this.bytes += buffer.length;
    this.hash.update(buffer);
    if (!this.out.write(buffer)) {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => reject(error);
        this.out.once('error', fail);
        this.out.once('drain', () => {
          this.out.off('error', fail);
          resolve();
        });
      });
    }
  }

  async close(): Promise<Written> {
    await this.flush();
    this.out.end();
    return { bytes: this.bytes, sha256: this.hash.digest('hex') };
  }
}
