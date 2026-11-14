// What the sweep (tools/sweep/routes.mjs) may print or write: never a one-time link, a password,
// a token or a session. Every line that leaves the tool, to the terminal, to measurements.json or
// to the demo's log, goes through redact() first.

const HIDDEN = '...';
/** Names whose value in an address, a form or JSON is a secret, or a key to one. */
const SECRET_NAMES =
  'token|request|code|password|passwd|secret|api_key|apikey|key|state|signature|sig|session';

const RULES = [
  // An address's query or hash: ?token=..., &request=..., #code=...
  [new RegExp(`\\b(${SECRET_NAMES})=[^\\s&"'#)<>]+`, 'gi'), `$1=${HIDDEN}`],
  // A JSON field or a header-like pair: "password":"...", "token": "..."
  [
    new RegExp(`"(${SECRET_NAMES}|accessToken|refreshToken)"\\s*:\\s*"[^"]*"`, 'gi'),
    `"$1":"${HIDDEN}"`,
  ],
  // Credentials inside an address: the name and password between "://" and "@"
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+):[^\s@/'"]+@/gi, `$1:${HIDDEN}@`],
  // Authorization headers and cookies.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${HIDDEN}`],
  [/\b((?:Set-)?Cookie):\s*[^\n]+/gi, `$1: ${HIDDEN}`],
  // Taskmoor's own token formats (ADR-035): API, OAuth access and refresh tokens.
  [/\b(tm[kar]_)[0-9A-Za-z_-]{20,}/g, `$1${HIDDEN}`],
  // The password the sweep makes for the demo's administrator (session.mjs).
  [/\b(sweep-)[A-Za-z0-9_-]{16,}/g, `$1${HIDDEN}`],
];

/** The text with every secret it could hold replaced by "...", cut to `max` characters. */
export function redact(text, max = 300) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out.slice(0, max);
}

/** The first line of an error's message, redacted: what failed, never the address it was on. */
export function firstLine(error, max = 300) {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message.split('\n')[0], max);
}

/** Width and height of a PNG, from its header; null when the bytes are not a PNG. */
export function pngSize(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytes || bytes.length < 24) return null;
  if (signature.some((b, i) => bytes[i] !== b)) return null;
  // The first chunk is IHDR: width and height are big-endian at bytes 16 and 20.
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
