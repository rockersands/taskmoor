/**
 * Untrusted content in prompts and answers (M1-118; IAM-023; ADR-104). Whatever people wrote
 * into tickets, comments and fields can carry instructions meant for the model (prompt
 * injection). Two defences that work without a model:
 *
 * - `fenceUntrusted` wraps such text in one element whose tag the text cannot close or open
 *   again: every `<` that would start a tag of that name (or of the generic `untrusted`), in
 *   any case, with spaces, or as a full-width look-alike, becomes `&lt;`. Removing the tags
 *   instead is not enough: `</tic<ticket>ket>` loses its inner tag and closes the fence.
 * - `screenAnswer` takes from a model's answer the images it would make a browser load from
 *   another site (a way to send data out without a click: the address carries it), and lists
 *   the links to other sites so the interface can name their host before anyone follows them.
 *   The app's content security policy already refuses images from other origins (ADR-080);
 *   this keeps the address out of what is stored and shown, too.
 */

const escapeAttr = (value: string) =>
  value.replace(
    /[&"<>]/g,
    (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c] ?? c,
  );

/** `<` and the look-alikes a model may read as one. */
const LESS_THAN = /[<\uFF1C\uFE64\u3008\u27E8]/;

/** The text with every would-be tag named `name` (or `untrusted`) made inert. */
export function neutraliseTags(text: string, name: string): string {
  const names = [...new Set([name.toLowerCase(), 'untrusted'])].map((n) =>
    n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const pattern = new RegExp(`${LESS_THAN.source}(\\s*\\/?\\s*)(${names.join('|')})`, 'giu');
  return text.replace(pattern, (_match, gap: string, tag: string) => `&lt;${gap}${tag}`);
}

/**
 * `text` as data inside `<name attr="...">...</name>`; attribute values are escaped, and the
 * text cannot end the element early (see `neutraliseTags`).
 */
export function fenceUntrusted(
  name: string,
  attrs: Readonly<Record<string, string>>,
  text: string,
): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Not a tag name: ${name}`);
  const attributes = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  return `<${name}${attributes}>\n${neutraliseTags(text, name)}\n</${name}>`;
}

export interface ScreenedAnswer {
  text: string;
  /** Images removed because they would load from another origin, by address. */
  removedImages: string[];
  /** Links to other origins, kept, for the interface to show their host. */
  externalLinks: string[];
}

/** Markdown images and links, and bare addresses. Bounded quantifiers: linear time. */
const IMAGE = /!\[([^\]\n]{0,500})\]\(\s*<?([^)\s>]{1,4000})>?(?:\s+"[^"\n]{0,500}")?\s*\)/g;
const LINK = /(?<!!)\[[^\]\n]{0,500}\]\(\s*<?([^)\s>]{1,4000})>?(?:\s+"[^"\n]{0,500}")?\s*\)/g;
const BARE = /\b(?:https?|ftp):\/\/[^\s<>()"']{1,4000}/gi;
const HTML_IMAGE = /<img\b[^>]{0,4000}>/gi;

function originOf(address: string, base: string): string | null {
  try {
    const url = new URL(address.replace(/[\t\n\r]/g, ''), base);
    return url.protocol === 'data:' ? 'data:' : url.origin;
  } catch {
    return null;
  }
}

/**
 * Screens a model's answer before it is stored or shown. `allowedOrigins` are the origins the
 * app itself serves (its own and the backend's); `base` resolves relative addresses.
 */
export function screenAnswer(
  text: string,
  options: { allowedOrigins: readonly string[]; base: string },
): ScreenedAnswer {
  const allowed = new Set([...options.allowedOrigins, originOf('/', options.base)]);
  const removedImages: string[] = [];
  const externalLinks: string[] = [];
  const foreign = (address: string) => {
    const origin = originOf(address, options.base);
    return origin === null || !allowed.has(origin);
  };
  let out = text.replace(IMAGE, (match, alt: string, address: string) => {
    if (!foreign(address)) return match;
    removedImages.push(address);
    return alt ? `[image: ${alt}]` : '[image]';
  });
  out = out.replace(HTML_IMAGE, (match) => {
    const src = /\bsrc\s*=\s*["']?([^"'\s>]{1,4000})/i.exec(match)?.[1] ?? '';
    if (src && !foreign(src)) return match;
    removedImages.push(src);
    return '[image]';
  });
  for (const m of out.matchAll(LINK)) {
    const address = m[1] as string;
    if (foreign(address)) externalLinks.push(address);
  }
  for (const m of out.matchAll(BARE)) {
    if (foreign(m[0]) && !externalLinks.includes(m[0])) externalLinks.push(m[0]);
  }
  return { text: out, removedImages, externalLinks };
}
