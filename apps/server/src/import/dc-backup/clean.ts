import { Transform, type TransformCallback } from 'node:stream';

/**
 * Removes what XML 1.0 forbids and real backups contain (IMP-001; ADR-025): NUL bytes and other
 * C0 controls (tab, LF and CR stay), U+FFFE and U+FFFF, and numeric character references to any
 * of those. Works on bytes, so it runs before decoding and handles a sequence split across
 * chunks. Taken from the parser spike (`packages/spikes/src/xml/clean.ts`, ADR-025's
 * measurements) for the backup validator (M1-087) and the backup reader (M1-088).
 */
export interface CleanStats {
  nul: number;
  control: number;
  /** U+FFFE and U+FFFF, as UTF-8 bytes. */
  noncharacter: number;
  /** `&#0;`, `&#x1F;`, `&#xFFFE;` and the like. */
  charRef: number;
  /** Byte offsets of the first removals, for the import log. */
  firstOffsets: number[];
  /** The first five offsets of each kind, for the import report's examples (M1-088). */
  offsets: Record<'nul' | 'control' | 'noncharacter' | 'charRef', number[]>;
}

const MAX_REF = 12; // "&#x10FFFF;" is 10 bytes; allow a little slack.

function invalidCodePoint(cp: number): boolean {
  return (
    cp === 0 ||
    (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
    cp === 0xfffe ||
    cp === 0xffff ||
    (cp >= 0xd800 && cp <= 0xdfff) ||
    cp > 0x10ffff
  );
}

/**
 * Length of the character reference starting at `i` ("&#...;"), or 0 when it is not one, or -1
 * when the buffer ends before it could be decided.
 */
function charRefAt(buf: Buffer, i: number, end: number): { length: number; cp: number } {
  if (i + 2 >= end) return { length: -1, cp: 0 };
  if (buf[i + 1] !== 0x23 /* # */) return { length: 0, cp: 0 };
  let j = i + 2;
  let hex = false;
  if (buf[j] === 0x78 || buf[j] === 0x58) {
    hex = true;
    j++;
  }
  let cp = 0;
  let digits = 0;
  for (; j < end && j - i < MAX_REF; j++) {
    const b = buf[j] as number;
    if (b === 0x3b /* ; */) {
      return digits === 0 ? { length: 0, cp: 0 } : { length: j - i + 1, cp };
    }
    let d = -1;
    if (b >= 0x30 && b <= 0x39) d = b - 0x30;
    else if (hex && b >= 0x61 && b <= 0x66) d = b - 0x61 + 10;
    else if (hex && b >= 0x41 && b <= 0x46) d = b - 0x41 + 10;
    if (d < 0) return { length: 0, cp: 0 };
    cp = cp * (hex ? 16 : 10) + d;
    digits++;
  }
  return j - i >= MAX_REF ? { length: 0, cp: 0 } : { length: -1, cp: 0 };
}

export class XmlCleaner extends Transform {
  readonly stats: CleanStats = {
    nul: 0,
    control: 0,
    noncharacter: 0,
    charRef: 0,
    firstOffsets: [],
    offsets: { nul: [], control: [], noncharacter: [], charRef: [] },
  };
  private pending: Buffer = Buffer.alloc(0);
  private offset = 0;

  private note(kind: keyof CleanStats['offsets'], at: number): void {
    this.stats[kind]++;
    if (this.stats.firstOffsets.length < 20) this.stats.firstOffsets.push(at);
    if (this.stats.offsets[kind].length < 5) this.stats.offsets[kind].push(at);
  }

  /** Cleans `buf[0..end)`; returns the output and how many input bytes were consumed. */
  private clean(buf: Buffer, end: number, final: boolean): { out: Buffer; consumed: number } {
    const out = Buffer.allocUnsafe(end);
    let o = 0;
    let i = 0;
    while (i < end) {
      const b = buf[i] as number;
      if (b < 0x20) {
        if (b === 0x09 || b === 0x0a || b === 0x0d) out[o++] = b;
        else this.note(b === 0 ? 'nul' : 'control', this.offset + i);
        i++;
        continue;
      }
      if (b === 0xef) {
        if (i + 2 >= end) {
          if (!final) break; // might be U+FFFE/U+FFFF split across chunks
          out[o++] = b;
          i++;
          continue;
        }
        if (buf[i + 1] === 0xbf && (buf[i + 2] === 0xbe || buf[i + 2] === 0xbf)) {
          this.note('noncharacter', this.offset + i);
          i += 3;
          continue;
        }
        out[o++] = b;
        i++;
        continue;
      }
      if (b === 0x26 /* & */) {
        const ref = charRefAt(buf, i, end);
        if (ref.length < 0) {
          if (!final) break; // reference may continue in the next chunk
          out[o++] = b;
          i++;
          continue;
        }
        if (ref.length > 0 && invalidCodePoint(ref.cp)) {
          this.note('charRef', this.offset + i);
          i += ref.length;
          continue;
        }
      }
      out[o++] = b;
      i++;
    }
    return { out: out.subarray(0, o), consumed: i };
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const { out, consumed } = this.clean(buf, buf.length, false);
    this.pending = buf.subarray(consumed);
    this.offset += consumed;
    cb(null, out);
  }

  override _flush(cb: TransformCallback): void {
    const { out } = this.clean(this.pending, this.pending.length, true);
    this.pending = Buffer.alloc(0);
    cb(null, out);
  }
}

/** One-shot helper for tests. */
export function cleanBuffer(input: Buffer): { out: Buffer; stats: CleanStats } {
  const cleaner = new XmlCleaner();
  const parts: Buffer[] = [];
  cleaner.on('data', (d: Buffer) => parts.push(d));
  cleaner.write(input);
  cleaner.end();
  // Transform streams flush synchronously when nothing is pending on the event loop.
  return { out: Buffer.concat(parts), stats: cleaner.stats };
}
