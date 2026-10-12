import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Rng } from '@taskmoor/testkit/gen';

/**
 * A synthetic backup in the shape the importer must stream (IMP-001): one root element whose
 * children are entity rows, column values as attributes, long text as child elements, with
 * forbidden characters sprinkled in the way exported data has them. The vocabulary is our own;
 * only the shape matters for the parser spike.
 */
export interface XmlGenConfig {
  seed: number;
  bytes: number;
  /** Probability that an element carries one forbidden character or reference. */
  badCharRate: number;
}

export interface XmlGenStats {
  config: XmlGenConfig;
  bytes: number;
  elements: Record<string, number>;
  bad: { nul: number; control: number; noncharacter: number; charRef: number };
  /** Total characters of child-element text, to check the parser kept it all. */
  textChars: number;
}

const WORDS =
  'login fails after upgrade board sprint field value cannot save attachment comment user review deploy regression timeout cache index ñandú café 日本語 データ'.split(
    ' ',
  );

const ENTITIES: readonly (readonly [string, number])[] = [
  ['WorkItem', 10],
  ['ChangeGroup', 25],
  ['ChangeItem', 35],
  ['Comment', 12],
  ['FieldValue', 20],
  ['Worklog', 3],
  ['ItemLink', 2],
  ['Label', 3],
  ['Person', 0.2],
  ['Space', 0.02],
];

function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function words(rng: Rng, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(rng.pick(WORDS));
  return out.join(' ');
}

const BAD: readonly (readonly [keyof XmlGenStats['bad'], () => string, number])[] = [
  ['nul', () => '\u0000', 4],
  ['control', () => String.fromCharCode(1 + Math.floor(Math.random() * 0)), 3],
  ['noncharacter', () => '￿', 1],
  ['charRef', () => '&#0;', 2],
];

export function entityXml(
  rng: Rng,
  id: number,
  stats: XmlGenStats,
  bad: XmlGenConfig['badCharRate'],
): string {
  const entity = rng.weighted(ENTITIES);
  stats.elements[entity] = (stats.elements[entity] ?? 0) + 1;
  const attrs: string[] = [`id="${id}"`];
  const children: string[] = [];
  let poison = '';
  if (rng.chance(bad)) {
    const kind = rng.weighted(BAD.map(([k, , w]) => [k, w] as const));
    stats.bad[kind]++;
    poison =
      kind === 'nul'
        ? '\u0000'
        : kind === 'control'
          ? String.fromCharCode(rng.int(1, 8))
          : kind === 'noncharacter'
            ? rng.chance(0.5)
              ? '￾'
              : '￿'
            : rng.pick(['&#0;', '&#x1;', '&#xFFFE;', '&#65535;', '&#x8;']);
  }
  const text = (n: number) => {
    const t = words(rng, n);
    stats.textChars += t.length;
    return escapeText(t);
  };
  switch (entity) {
    case 'WorkItem':
      attrs.push(
        `key="AB-${id}"`,
        `space="${rng.int(1, 300)}"`,
        `type="${rng.int(1, 5)}"`,
        `status="${rng.int(1, 9)}"`,
        `priority="${rng.int(1, 5)}"`,
        `reporter="${rng.int(1, 5000)}"`,
        `created="2024-0${rng.int(1, 9)}-1${rng.int(0, 9)} 10:0${rng.int(0, 9)}:00.0"`,
        `summary="${escapeAttr(words(rng, rng.int(3, 10)))}"`,
      );
      if (rng.chance(0.4)) children.push(`<description>${text(rng.int(20, 200))}</description>`);
      break;
    case 'ChangeGroup':
      attrs.push(
        `item="${rng.int(1, id)}"`,
        `author="${rng.int(1, 5000)}"`,
        `created="2024-05-05 09:00:00.0"`,
      );
      break;
    case 'ChangeItem':
      attrs.push(
        `group="${rng.int(1, id)}"`,
        `fieldtype="jira"`,
        `field="${rng.pick(['status', 'assignee', 'Sprint'])}"`,
      );
      children.push(`<oldvalue>${text(1)}</oldvalue>`, `<newvalue>${text(1)}</newvalue>`);
      break;
    case 'Comment':
      attrs.push(`item="${rng.int(1, id)}"`, `author="${rng.int(1, 5000)}"`, `type="comment"`);
      children.push(`<body>${text(rng.int(5, 80))}</body>`);
      break;
    case 'FieldValue':
      attrs.push(`item="${rng.int(1, id)}"`, `field="${rng.int(10000, 11500)}"`);
      if (rng.chance(0.5)) attrs.push(`numbervalue="${rng.int(0, 1000)}"`);
      else attrs.push(`stringvalue="${escapeAttr(words(rng, 2))}"`);
      break;
    case 'Worklog':
      attrs.push(
        `item="${rng.int(1, id)}"`,
        `author="${rng.int(1, 5000)}"`,
        `timeworked="${rng.int(60, 28800)}"`,
      );
      children.push(`<body>${text(rng.int(1, 12))}</body>`);
      break;
    case 'ItemLink':
      attrs.push(
        `linktype="${rng.int(1, 6)}"`,
        `source="${rng.int(1, id)}"`,
        `destination="${rng.int(1, id)}"`,
      );
      break;
    case 'Label':
      attrs.push(`item="${rng.int(1, id)}"`, `label="${rng.pick(WORDS.slice(0, 12))}"`);
      break;
    case 'Person':
      attrs.push(
        `userName="person${id}"`,
        `emailAddress="person${id}@example.test"`,
        `displayName="${escapeAttr(words(rng, 2))}"`,
      );
      break;
    case 'Space':
      attrs.push(
        `key="SP${id}"`,
        `name="${escapeAttr(words(rng, 2))}"`,
        `lead="${rng.int(1, 5000)}"`,
      );
      children.push(`<description>${text(rng.int(5, 40))}</description>`);
      break;
  }
  // The forbidden character lands in an attribute or in text, as it does in real exports.
  if (poison) {
    if (children.length > 0 && rng.chance(0.6)) {
      const last = children.length - 1;
      children[last] = (children[last] as string).replace('</', `${poison}</`);
    } else {
      attrs.push(`note="x${poison}y"`);
    }
  }
  const open = `<${entity} ${attrs.join(' ')}`;
  return children.length === 0
    ? `${open}/>\n`
    : `${open}>\n    ${children.join('\n    ')}\n</${entity}>\n`;
}

/** Writes the file unless one with the same config exists next to its stats sidecar. */
export async function generateEntitiesXml(
  path: string,
  config: XmlGenConfig,
  log: (m: string) => void = () => {},
): Promise<XmlGenStats> {
  const sidecar = `${path}.json`;
  if (existsSync(path) && existsSync(sidecar)) {
    const stats = JSON.parse(readFileSync(sidecar, 'utf8')) as XmlGenStats;
    if (JSON.stringify(stats.config) === JSON.stringify(config)) {
      log(`Reusing ${path} (${(stats.bytes / 1e9).toFixed(2)} GB)`);
      return stats;
    }
  }
  const rng = new Rng(config.seed);
  const stats: XmlGenStats = {
    config,
    bytes: 0,
    elements: {},
    bad: { nul: 0, control: 0, noncharacter: 0, charRef: 0 },
    textChars: 0,
  };
  const out = createWriteStream(path, { highWaterMark: 4 * 1024 * 1024 });
  let failure: Error | undefined;
  out.on('error', (e) => {
    failure = e;
  });
  const write = (s: string) =>
    new Promise<void>((resolve, reject) => {
      if (failure) return reject(failure);
      stats.bytes += Buffer.byteLength(s);
      if (out.write(s)) resolve();
      else out.once('drain', () => (failure ? reject(failure) : resolve()));
    });
  await write('<?xml version="1.0" encoding="UTF-8"?>\n<entity-engine-xml>\n');
  let id = 0;
  let buffer: string[] = [];
  let buffered = 0;
  let lastLog = Date.now();
  while (stats.bytes + buffered < config.bytes) {
    const s = entityXml(rng, ++id, stats, config.badCharRate);
    buffer.push(s);
    buffered += s.length;
    if (buffered >= 1 << 20) {
      await write(buffer.join(''));
      buffer = [];
      buffered = 0;
      if (Date.now() - lastLog > 10_000) {
        log(`  ${(stats.bytes / 1e9).toFixed(2)} GB written`);
        lastLog = Date.now();
      }
    }
  }
  if (buffer.length) await write(buffer.join(''));
  await write('</entity-engine-xml>\n');
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.once('error', reject);
  });
  writeFileSync(sidecar, `${JSON.stringify(stats, null, 2)}\n`);
  return stats;
}
