import { utf8 } from './bytes';

/**
 * Zip archives for the kits (M1-109), written in the Builder itself so nothing leaves the
 * browser. Entries are stored (no compression: kits are small, and a stored entry has one
 * encoding), sorted by path, dated 1980-01-01 and marked UTF-8, so one set of files always gives
 * the same bytes (OPS-016 (2)). `readZip` reads such archives back, for checks and tests.
 */
export type ZipInput = Record<string, string | Uint8Array>;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date for 1980-01-01 (day 1, month 1, year 0) and time 00:00:00. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
const UTF8_FLAG = 0x0800;

function checkPath(path: string) {
  if (!path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) {
    throw new Error(`Not a relative path in a kit: ${path}`);
  }
}

export function writeZip(files: ZipInput): Uint8Array<ArrayBuffer> {
  const entries = Object.keys(files)
    .sort()
    .map((path) => {
      checkPath(path);
      const raw = files[path] as string | Uint8Array;
      const data = typeof raw === 'string' ? utf8(raw) : raw;
      return { name: utf8(path), data, crc: crc32(data) };
    });
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, e.crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, e.name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), e.name, e.data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    // Made on Unix (3), so the external attributes below are read as file modes.
    dir.setUint16(4, 0x0314, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, UTF8_FLAG, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, DOS_TIME, true);
    dir.setUint16(14, DOS_DATE, true);
    dir.setUint32(16, e.crc, true);
    dir.setUint32(20, e.data.length, true);
    dir.setUint32(24, e.data.length, true);
    dir.setUint16(28, e.name.length, true);
    dir.setUint32(38, 0o100644 * 0x10000, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), e.name);
    offset += 30 + e.name.length + e.data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The files of a stored zip, by path; refuses compressed entries and bad checksums. */
export function readZip(zip: Uint8Array): Record<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const endAt = zip.length - 22;
  if (endAt < 0 || view.getUint32(endAt, true) !== 0x06054b50) throw new Error('not a zip');
  const count = view.getUint16(endAt + 10, true);
  let at = view.getUint32(endAt + 16, true);
  const out: Record<string, Uint8Array> = {};
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    if (method !== 0) throw new Error(`compressed entry ${name}`);
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.slice(dataAt, dataAt + size);
    if (crc32(data) !== crc) throw new Error(`bad checksum in ${name}`);
    out[name] = data;
    at += 46 + nameLength + extra + comment;
  }
  return out;
}
