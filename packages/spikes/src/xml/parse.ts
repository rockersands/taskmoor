import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { SaxesParser } from 'saxes';

/** One entity row: its attributes plus the text of its child elements. */
export interface EntityRow {
  entity: string;
  attrs: Record<string, string>;
  children: Record<string, string>;
}

export interface ParseStats {
  elements: Record<string, number>;
  textChars: number;
  bytes: number;
}

/**
 * Streams a backup through saxes, building one row per child of the root element and handing
 * it to `sink`. Only the current row is in memory, whatever the file size.
 */
export async function parseEntities(
  input: Readable,
  sink: (row: EntityRow) => void,
): Promise<ParseStats> {
  const stats: ParseStats = { elements: {}, textChars: 0, bytes: 0 };
  const parser = new SaxesParser({ xmlns: false, position: false });
  const decoder = new StringDecoder('utf8');
  let depth = 0;
  let row: EntityRow | undefined;
  let child: string | undefined;
  let text = '';
  let failure: Error | undefined;

  parser.on('error', (e) => {
    failure ??= e;
  });
  parser.on('opentag', (tag) => {
    depth++;
    if (depth === 2) {
      row = { entity: tag.name, attrs: tag.attributes as Record<string, string>, children: {} };
    } else if (depth === 3) {
      child = tag.name;
      text = '';
    }
  });
  parser.on('text', (t) => {
    if (depth === 3) text += t;
  });
  parser.on('closetag', () => {
    if (depth === 3 && row && child) {
      row.children[child] = text;
      stats.textChars += text.length;
      child = undefined;
    } else if (depth === 2 && row) {
      stats.elements[row.entity] = (stats.elements[row.entity] ?? 0) + 1;
      sink(row);
      row = undefined;
    }
    depth--;
  });

  for await (const chunk of input) {
    const buf = chunk as Buffer;
    stats.bytes += buf.length;
    parser.write(decoder.write(buf));
    if (failure) throw failure;
  }
  parser.write(decoder.end());
  parser.close();
  if (failure) throw failure;
  return stats;
}
