import { createHash } from 'node:crypto';
import { type Readable, Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { XmlCleaner } from './clean';
import type { Written } from './xml';

/**
 * Streams one XML file of a backup through a byte meter, the cleaner of forbidden characters
 * (ADR-025) and saxes, handing each element to the caller as it opens and closes. Shared by the
 * validator (M1-087) and the backup reader (M1-088), so both read exactly the same way.
 */
/** Counts and hashes the raw bytes on their way to the cleaner. */
class Meter extends Transform {
  private readonly hash = createHash('sha256');
  bytes = 0;

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    cb(null, chunk);
  }

  result(): Written {
    return { bytes: this.bytes, sha256: this.hash.digest('hex') };
  }
}

export interface XmlHandlers {
  open(tag: SaxesTagPlain, depth: number): void;
  text(text: string, depth: number, cdata: boolean): void;
  close(name: string, depth: number): void;
}

/** Streams one XML entry through the meter, the cleaner and saxes. */
export async function parseXml(
  input: Readable,
  handlers: XmlHandlers,
): Promise<{ written: Written; cleaned: XmlCleaner['stats'] }> {
  const meter = new Meter();
  const cleaner = new XmlCleaner();
  const parser = new SaxesParser({ xmlns: false, position: false });
  const decoder = new StringDecoder('utf8');
  let depth = 0;
  let failure: Error | undefined;
  parser.on('error', (e) => {
    failure ??= e;
  });
  parser.on('opentag', (tag) => {
    depth++;
    handlers.open(tag as SaxesTagPlain, depth);
  });
  parser.on('text', (t) => handlers.text(t, depth, false));
  parser.on('cdata', (t) => handlers.text(t, depth, true));
  parser.on('closetag', (tag) => {
    handlers.close(tag.name, depth);
    depth--;
  });
  const cleaned = input.pipe(meter).pipe(cleaner);
  input.on('error', (e) => cleaned.destroy(e));
  for await (const chunk of cleaned) {
    parser.write(decoder.write(chunk as Buffer));
    if (failure) throw failure;
  }
  parser.write(decoder.end());
  parser.close();
  if (failure) throw failure;
  return { written: meter.result(), cleaned: cleaner.stats };
}
