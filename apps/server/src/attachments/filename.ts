/**
 * File names as people give them, made safe to show and to offer back in a download (CORE-021,
 * ADR-040). A name is display text only: stored files live under random keys, so nothing here
 * ever becomes part of a path on the server. What it guards against is the browser and the
 * person: a name that hides its real extension behind a right-to-left override, carries a path
 * a careless client might honour, breaks the Content-Disposition header, or cannot be saved on
 * Windows.
 */
export const MAX_NAME_BYTES = 255;
const FALLBACK = 'attachment';

/** Control characters, and the format characters that reorder or hide text. */
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;
const WINDOWS_RESERVED = /[<>:"|?*]/g;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Cuts text to at most `bytes` UTF-8 bytes without splitting a character. */
function cutUtf8(text: string, bytes: number): string {
  let out = '';
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (used + size > bytes) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * The name to keep: the last segment of whatever path it came with (either separator), NFC,
 * no control or bidirectional formatting characters, no characters Windows refuses, single
 * spaces, no dots or spaces at the end, not a Windows device name, at most 255 UTF-8 bytes
 * with the extension kept. Empty or dot-only names become "attachment".
 */
export function safeFilename(input: string): string {
  let name = input.normalize('NFC').replace(/\\/g, '/');
  name = name.slice(name.lastIndexOf('/') + 1);
  name = name
    .replace(/[\t\n\v\f\r]/g, ' ')
    .replace(INVISIBLE, '')
    .replace(WINDOWS_RESERVED, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s]+/, '')
    .replace(/[\s.]+$/, '');
  if (name === '' || /^\.+$/.test(name)) return FALLBACK;
  if (WINDOWS_DEVICE.test(name)) name = `_${name}`;
  // Removing a character can leave a sequence that composes differently.
  name = name.normalize('NFC');
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    const stem = extension ? name.slice(0, dot) : name;
    name = cutUtf8(stem, MAX_NAME_BYTES - Buffer.byteLength(extension)).trimEnd() + extension;
  }
  return name;
}

/** RFC 5987 attr-char: everything else in a filename* value is percent-encoded. */
function encodeExtValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * A Content-Disposition header (RFC 6266): an ASCII `filename` for old clients and the exact
 * name as UTF-8 in `filename*`. Quotes, backslashes and anything outside printable ASCII are
 * replaced in the fallback, so the header can never be broken out of.
 */
export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const safe = safeFilename(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeExtValue(safe)}`;
}

/** Names unique within one archive, compared without case: "a.png", "a (2).png", ... */
export function uniqueNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((original) => {
    const name = safeFilename(original);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
      candidate = `${stem} (${n})${extension}`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}
