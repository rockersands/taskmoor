import { createReadStream, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XmlCleaner } from './clean';
import { generateEntitiesXml, type XmlGenStats } from './generate';
import { parseEntities } from './parse';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export interface XmlBenchResult {
  spike: 'xml';
  at: string;
  machine: { cpu: string; cores: number; node: string };
  file: { path: string; bytes: number; generateSeconds: number; elements: number };
  parse: {
    seconds: number;
    mbPerSecond: number;
    maxRssMb: number;
    rows: number;
    textChars: number;
    removed: XmlGenStats['bad'];
  };
  /** Differences between what was generated and what came out; empty means lossless. */
  problems: string[];
}

export async function runXmlSpike(options: {
  bytes: number;
  seed?: number;
  badCharRate?: number;
  /** Where the generated file goes; defaults to .cache/xml in the repository. */
  dir?: string;
  log?: (m: string) => void;
}): Promise<XmlBenchResult> {
  const log = options.log ?? (() => {});
  const dir = options.dir ?? join(REPO_ROOT, '.cache', 'xml');
  mkdirSync(dir, { recursive: true });
  const config = {
    seed: options.seed ?? 1,
    bytes: options.bytes,
    badCharRate: options.badCharRate ?? 1e-4,
  };
  const path = join(dir, `entities-${sizeLabel(options.bytes)}.xml`);
  log(`Generating ${path}`);
  let t0 = Date.now();
  const generated = await generateEntitiesXml(path, config, log);
  const generateSeconds = (Date.now() - t0) / 1000;

  log('Parsing');
  let maxRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
  }, 250);
  const cleaner = new XmlCleaner();
  const counts: Record<string, number> = {};
  t0 = Date.now();
  let lastLog = t0;
  let bytesRead = 0;
  const stream = createReadStream(path, { highWaterMark: 1 << 20 })
    .on('data', (chunk: string | Buffer) => {
      bytesRead += chunk.length;
    })
    .pipe(cleaner);
  const parsed = await parseEntities(stream, (row) => {
    counts[row.entity] = (counts[row.entity] ?? 0) + 1;
    if (Date.now() - lastLog > 10_000) {
      log(`  ${(bytesRead / 1e9).toFixed(2)} GB parsed`);
      lastLog = Date.now();
    }
  });
  const seconds = (Date.now() - t0) / 1000;
  clearInterval(sampler);

  const problems: string[] = [];
  for (const [entity, n] of Object.entries(generated.elements)) {
    if (parsed.elements[entity] !== n) {
      problems.push(`${entity}: generated ${n}, parsed ${parsed.elements[entity] ?? 0}`);
    }
  }
  if (parsed.textChars !== generated.textChars) {
    // Removed characters came out of text, so the difference must equal those removals.
    const removedFromText = generated.textChars - parsed.textChars;
    const removed = cleaner.stats.nul + cleaner.stats.control + cleaner.stats.noncharacter;
    if (removedFromText < 0 || removedFromText > removed + cleaner.stats.charRef * 8) {
      problems.push(`text chars: generated ${generated.textChars}, parsed ${parsed.textChars}`);
    }
  }
  for (const kind of ['nul', 'control', 'noncharacter', 'charRef'] as const) {
    if (cleaner.stats[kind] !== generated.bad[kind]) {
      problems.push(`${kind}: injected ${generated.bad[kind]}, removed ${cleaner.stats[kind]}`);
    }
  }
  const rows = Object.values(parsed.elements).reduce((a, b) => a + b, 0);
  log(`  ${rows.toLocaleString('en')} rows in ${seconds}s, max RSS ${Math.round(maxRss / 1e6)} MB`);
  return {
    spike: 'xml',
    at: new Date().toISOString(),
    machine: {
      cpu: cpus()[0]?.model.trim() ?? 'unknown',
      cores: cpus().length,
      node: process.version,
    },
    file: {
      path,
      bytes: generated.bytes,
      generateSeconds,
      elements: Object.values(generated.elements).reduce((a, b) => a + b, 0),
    },
    parse: {
      seconds,
      mbPerSecond: Math.round(generated.bytes / 1e6 / seconds),
      maxRssMb: Math.round(maxRss / 1e6),
      rows,
      textChars: parsed.textChars,
      removed: {
        nul: cleaner.stats.nul,
        control: cleaner.stats.control,
        noncharacter: cleaner.stats.noncharacter,
        charRef: cleaner.stats.charRef,
      },
    },
    problems,
  };
}

export function sizeLabel(bytes: number): string {
  return bytes >= 1e9 ? `${Math.round(bytes / 1e8) / 10}g` : `${Math.round(bytes / 1e6)}m`;
}

export function parseSize(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(text.trim());
  if (!m) throw new Error(`Bad size "${text}"; use 200M or 5G`);
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  return Math.round(n * (unit === 'g' ? 1e9 : unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1));
}

export function renderXmlReport(r: XmlBenchResult): string {
  const minutes = (r.parse.seconds / 60).toFixed(1);
  const lines = [
    `# Backup XML parser spike: ${(r.file.bytes / 1e9).toFixed(2)} GB`,
    '',
    `Generated ${r.at.slice(0, 16).replace('T', ' ')} UTC on ${r.machine.cpu} (${r.machine.cores} threads), Node ${r.machine.node}.`,
    '',
    `Budget (M0-022): 5 GB in under 20 minutes with RSS under 512 MB. Result: ${minutes} min at ${r.parse.mbPerSecond} MB/s, max RSS ${r.parse.maxRssMb} MB.`,
    '',
    '| Measure | Value |',
    '|---|---:|',
    `| File | ${r.file.path} |`,
    `| Bytes | ${r.file.bytes.toLocaleString('en')} |`,
    `| Entity rows | ${r.parse.rows.toLocaleString('en')} |`,
    `| Generate time | ${r.file.generateSeconds}s |`,
    `| Parse time | ${r.parse.seconds}s |`,
    `| Throughput | ${r.parse.mbPerSecond} MB/s |`,
    `| Max RSS | ${r.parse.maxRssMb} MB |`,
    `| NUL bytes removed | ${r.parse.removed.nul} |`,
    `| Other C0 controls removed | ${r.parse.removed.control} |`,
    `| U+FFFE/U+FFFF removed | ${r.parse.removed.noncharacter} |`,
    `| Invalid character references removed | ${r.parse.removed.charRef} |`,
    '',
    r.problems.length === 0
      ? 'Every generated row and text character came out of the parser; every injected bad character was removed.'
      : `Problems: ${r.problems.join('; ')}`,
  ];
  return `${lines.join('\n')}\n`;
}
