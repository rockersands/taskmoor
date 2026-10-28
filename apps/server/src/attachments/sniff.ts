/**
 * What a file is, from its first bytes as well as from what the uploader said (CORE-021,
 * ADR-040). The declared type comes from the browser (usually from the extension) and can be
 * anything; the sniffed type comes from magic numbers. A file is shown in the browser (inline)
 * only when its bytes are one of a few harmless kinds: raster images, PDF, video, or UTF-8
 * text served as plain text. Everything else downloads, as `application/octet-stream` when its
 * declared type could be rendered as a page.
 */
export type MediaKind = 'image' | 'pdf' | 'video' | 'text' | 'zip' | 'other';

/** How much of the start of a file sniffing looks at. */
export const SNIFF_BYTES = 8192;

const startsWith = (head: Buffer, bytes: readonly number[], at = 0) =>
  head.length >= at + bytes.length && bytes.every((b, i) => head[at + i] === b);
const ascii = (head: Buffer, text: string, at = 0) =>
  head.length >= at + text.length && head.toString('latin1', at, at + text.length) === text;

const VIDEO_BRANDS: Record<string, string> = {
  isom: 'video/mp4',
  iso2: 'video/mp4',
  iso4: 'video/mp4',
  iso5: 'video/mp4',
  iso6: 'video/mp4',
  mp41: 'video/mp4',
  mp42: 'video/mp4',
  avc1: 'video/mp4',
  dash: 'video/mp4',
  M4V: 'video/mp4',
  'M4V ': 'video/mp4',
  'qt  ': 'video/quicktime',
};

/** The type the magic numbers name, or null. */
export function sniffType(head: Buffer): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(head, 'GIF87a') || ascii(head, 'GIF89a')) return 'image/gif';
  if (ascii(head, 'RIFF') && ascii(head, 'WEBP', 8)) return 'image/webp';
  if (ascii(head, 'ftyp', 4)) {
    const brand = head.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (VIDEO_BRANDS[brand]) return VIDEO_BRANDS[brand] as string;
    return null;
  }
  if (ascii(head, '%PDF-')) return 'application/pdf';
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    // Matroska; WebM names its doc type early in the header.
    return head.subarray(0, 64).includes('webm') ? 'video/webm' : 'video/x-matroska';
  }
  if (ascii(head, 'OggS')) return 'video/ogg';
  if (ascii(head, 'PK\u0003\u0004') || ascii(head, 'PK\u0005\u0006')) return 'application/zip';
  return null;
}

/**
 * Whether the bytes are UTF-8 text: valid UTF-8 (a character cut by the end of the sniffed
 * head is allowed when the file goes on), no NUL, and almost no other control characters.
 */
export function looksLikeText(head: Buffer, complete: boolean): boolean {
  if (head.length === 0) return true;
  if (head.includes(0)) return false;
  let controls = 0;
  for (const byte of head) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) {
      controls += 1;
    }
  }
  if (controls > head.length / 100) return false;
  // Allow up to three bytes of a character cut off at the end of a partial head.
  for (let cut = 0; cut <= (complete ? 0 : 3); cut++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - cut));
      return true;
    } catch {
      // try a shorter head
    }
  }
  return false;
}

const TOKEN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** The declared type as `type/subtype` in lower case, or octet-stream when it is not one. */
export function normalizeType(declared: string | undefined): string {
  const bare = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return TOKEN.test(bare) ? bare : 'application/octet-stream';
}

/** Types a browser would render as a page or run; never served under their own type. */
const ACTIVE = /html|xml|svg|javascript|ecmascript|x-shockwave-flash|x-msdownload|wasm/;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']);
const ZIP_DECLARED = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
  'multipart/x-zip',
  'application/octet-stream',
]);

/** What the panel can preview, from the sniffed type first. */
export function mediaKind(sniffed: string | null, declared: string, name: string): MediaKind {
  if (sniffed && IMAGE_TYPES.has(sniffed)) return 'image';
  if (sniffed === 'application/pdf') return 'pdf';
  if (sniffed && VIDEO_TYPES.has(sniffed)) return 'video';
  if (sniffed === 'text/plain') return 'text';
  // Office documents and Java archives are ZIP files too; only a ZIP is offered as one.
  if (
    sniffed === 'application/zip' &&
    (ZIP_DECLARED.has(declared) || name.toLowerCase().endsWith('.zip'))
  ) {
    return 'zip';
  }
  return 'other';
}

/** The sniffed type to record: magic numbers, else plain text when the bytes are text. */
export function sniff(head: Buffer, complete: boolean): string | null {
  return sniffType(head) ?? (looksLikeText(head, complete) ? 'text/plain' : null);
}

/** Whether the panel makes a thumbnail of it (the decoders handle PNG and JPEG). */
export function thumbnailable(sniffed: string | null): boolean {
  return sniffed === 'image/png' || sniffed === 'image/jpeg';
}

export interface Served {
  contentType: string;
  /** Whether the browser may show it in place; otherwise it downloads. */
  inline: boolean;
  kind: MediaKind;
}

/** The type and disposition a file is served with. */
export function servedAs(sniffed: string | null, declared: string, name: string): Served {
  const kind = mediaKind(sniffed, declared, name);
  switch (kind) {
    case 'image':
    case 'pdf':
    case 'video':
      return { contentType: sniffed as string, inline: true, kind };
    case 'text':
      return { contentType: 'text/plain; charset=utf-8', inline: true, kind };
    case 'zip':
      return { contentType: 'application/zip', inline: false, kind };
    default:
      return {
        contentType: ACTIVE.test(declared) ? 'application/octet-stream' : declared,
        inline: false,
        kind,
      };
  }
}
