import {
  contentSecurityPolicy,
  cspMetaElement,
  fillRuntimeConfig,
  type RuntimeConfig,
} from '@taskmoor/webconfig';
import { sha384Integrity } from './bytes';
import { CONFIG_FILE, type Kits, MANIFEST_FILE } from './kits';

/**
 * The frontend kit (M1-111; OPS-013, ADR-031): the static app the backend image ships, made
 * ready for any static host. Its index.html gets the kit's public configuration in the slot
 * (pinned to the instance) and Subresource Integrity on every script and stylesheet. For clean
 * URLs it brings the fallbacks static hosts need to send deep links to index.html: `.htaccess`
 * (Apache), `_redirects` (Netlify, Cloudflare Pages) and `nginx.conf`. The single-file form puts
 * the scripts and styles into index.html itself, for a host that takes one file; it uses hash
 * routing, since one file cannot answer deep links. Both forms carry the app's content security
 * policy in a meta element (M1-107, IAM-025): scripts and styles from the kit itself (the single
 * file allows its inline blocks by their hashes) and calls to the configured backend only.
 */
export type WebFiles = Record<string, Uint8Array>;
export type KitFiles = Record<string, Uint8Array | string>;

const SCRIPT_SRC = /<script\b([^>]*?)\bsrc="(\.\/[^"]+)"([^>]*)><\/script>/g;
const STYLESHEET = /<link\b([^>]*?)\brel="stylesheet"([^>]*?)\bhref="(\.\/[^"]+)"([^>]*)>/g;

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

function indexOf(web: WebFiles): string {
  const index = web['index.html'];
  if (!index) throw new Error('The web build has no index.html');
  return text(index);
}

/** A file the page names, by its `./path`; throws when the build lacks it. */
function asset(web: WebFiles, ref: string): Uint8Array {
  const file = web[ref.replace(/^\.\//, '')];
  if (!file) throw new Error(`index.html names ${ref}, which the build lacks`);
  return file;
}

async function withIntegrity(html: string, web: WebFiles): Promise<string> {
  const replacements: [string, string][] = [];
  for (const m of html.matchAll(SCRIPT_SRC)) {
    const [whole, before = '', ref = '', after = ''] = m;
    const sri = await sha384Integrity(asset(web, ref));
    replacements.push([whole, `<script${before}src="${ref}" integrity="${sri}"${after}></script>`]);
  }
  for (const m of html.matchAll(STYLESHEET)) {
    const [whole, a = '', b = '', ref = '', c = ''] = m;
    const sri = await sha384Integrity(asset(web, ref));
    replacements.push([
      whole,
      `<link${a}rel="stylesheet"${b}href="${ref}" integrity="${sri}"${c}>`,
    ]);
  }
  return replacements.reduce((h, [from, to]) => h.replace(from, to), html);
}

/** Script text safe inside a script element: nothing in it can close the element. */
const inlineScript = (code: string) => code.replace(/<\/(script)/gi, '<\\/$1');

/** The media types of the files a stylesheet of the build may name. */
const CSS_FILE_TYPES: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  ico: 'image/x-icon',
};

/** Every `url()` of a stylesheet, quoted or not, a data URL with `url(` inside it whole. */
const CSS_URL = /url\(\s*("[^"]*"|'[^']*'|[^"')\s]*)\s*\)/gi;
/** What names a file of the build: not data, a Blob, a host, an absolute path or an `#id`. */
const BUILD_FILE = /^(?![a-z][\w+.-]*:|#|\/)./i;

/** `assets/a/../b.woff2` as `assets/b.woff2`. */
function joinPath(dir: string, ref: string): string {
  const parts: string[] = [];
  for (const part of `${dir}${ref}`.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** A font licence in the build: `OFL.txt`, or `OFL-<hash>.txt` as the frontend build names it. */
const FONT_LICENCE = /^OFL(-[\w-]+)?\.txt$/;

/**
 * A stylesheet for the single file: every file it names (the fonts, T-262) as a data URL, which
 * the policy allows (`font-src data:`), since the one file has nothing beside it to name. The
 * licence that sits beside a font in the build (`OFL-<hash>.txt`) comes back too, for the page to
 * carry.
 */
function selfContained(
  css: string,
  cssPath: string,
  web: WebFiles,
): { css: string; licences: Set<string> } {
  const dir = cssPath.slice(0, cssPath.lastIndexOf('/') + 1);
  const licences = new Set<string>();
  const out = css.replace(CSS_URL, (whole: string, value: string) => {
    const ref = value.replace(/^(["'])([\s\S]*)\1$/, '$2');
    if (!BUILD_FILE.test(ref)) return whole;
    const path = joinPath(dir, ref.split(/[?#]/)[0] ?? '');
    const bytes = web[path];
    if (!bytes) throw new Error(`${cssPath} names ${ref}, which the build lacks`);
    const type = CSS_FILE_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
    if (!type) throw new Error(`${cssPath} names ${ref}, which the single-file kit cannot carry`);
    if (type.startsWith('font/')) {
      const folder = path.slice(0, path.lastIndexOf('/') + 1);
      for (const file of Object.keys(web)) {
        const name = file.slice(folder.length);
        if (file.startsWith(folder) && FONT_LICENCE.test(name)) licences.add(file);
      }
    }
    return `url("data:${type};base64,${base64(bytes)}")`;
  });
  return { css: out, licences };
}

/** A licence as an HTML comment: line breaks as they are, and nothing in it can close it. */
const comment = (licence: string) =>
  `<!--\n${licence.replace(/\r\n/g, '\n').replace(/--!?>/g, '-- >').trimEnd()}\n-->`;

function inlined(html: string, web: WebFiles): string {
  const licences = new Set<string>();
  const page = html
    .replace(SCRIPT_SRC, (_whole, before: string, ref: string, after: string) => {
      const attrs = `${before}${after}`.replace(/\s*\bcrossorigin\b(="[^"]*")?/g, '').trimEnd();
      return `<script${attrs}>${inlineScript(text(asset(web, ref)))}</script>`;
    })
    .replace(STYLESHEET, (_whole, _a: string, _b: string, ref: string) => {
      const sheet = selfContained(text(asset(web, ref)), ref.replace(/^\.\//, ''), web);
      for (const licence of sheet.licences) licences.add(licence);
      return `<style>${sheet.css.replace(/<\/(style)/gi, '<\\/$1')}</style>`;
    });
  // The licences of the fonts the page now holds: SIL OFL 1.1 asks for one with every copy.
  if (licences.size === 0) return page;
  const notes = [...licences].map((path) => comment(text(web[path])));
  return page.replace('</head>', () => `${notes.join('\n')}\n  </head>`);
}

const INLINE_SCRIPT = /<script\b(?![^>]*\btype="application\/json")[^>]*>([\s\S]*?)<\/script>/g;
const INLINE_STYLE = /<style\b[^>]*>([\s\S]*?)<\/style>/g;

async function sha256Source(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `'sha256-${btoa(binary)}'`;
}

/** The page with its policy in a meta element right after the charset, before any script. */
async function withPolicy(html: string, config: RuntimeConfig, inline: boolean): Promise<string> {
  const hashes = async (pattern: RegExp) =>
    Promise.all(
      [...html.matchAll(pattern)]
        .filter((m) => (m[1] ?? '') !== '')
        .map((m) => sha256Source(m[1] ?? '')),
    );
  const policy = contentSecurityPolicy({
    apiUrl: config.apiUrl,
    ...(inline
      ? { scriptHashes: await hashes(INLINE_SCRIPT), styleHashes: await hashes(INLINE_STYLE) }
      : {}),
  });
  return html.replace(/(<meta charset="[^"]*"\s*\/?>)/i, `$1\n    ${cspMetaElement(policy)}`);
}

/** Where a host sends a deep link: the app's index.html below its base path. */
function fallbacks(basePath: string): Record<string, string> {
  const index = `${basePath}index.html`;
  return {
    '.htaccess': [
      '# Clean URLs (Taskmoor frontend kit): unknown paths load the app.',
      'Options -MultiViews',
      'RewriteEngine On',
      `RewriteBase ${basePath}`,
      'RewriteCond %{REQUEST_FILENAME} !-f',
      'RewriteCond %{REQUEST_FILENAME} !-d',
      `RewriteRule . ${index} [L]`,
      '',
    ].join('\n'),
    _redirects: `# Clean URLs (Taskmoor frontend kit): unknown paths load the app.\n${basePath}* ${index} 200\n`,
    'nginx.conf': [
      '# Clean URLs (Taskmoor frontend kit): put this in the server block that serves the kit.',
      `location ${basePath} {`,
      `  try_files $uri $uri/ ${index};`,
      '}',
      '',
    ].join('\n'),
  };
}

/**
 * The kit's files from the web build and a configuration (with an optional connection
 * manifest to ship beside it). Zip the result with `writeZip`, or take `index.html` alone for
 * the single-file form.
 */
export async function assembleFrontendKit(
  web: WebFiles,
  config: RuntimeConfig,
  options: { singleFile?: boolean; manifest?: string } = {},
): Promise<KitFiles> {
  if (options.singleFile) {
    const single = { ...config, routing: 'hash' as const };
    const page = fillRuntimeConfig(inlined(indexOf(web), web), single);
    return { 'index.html': await withPolicy(page, single, true) };
  }
  const page = await withPolicy(
    fillRuntimeConfig(await withIntegrity(indexOf(web), web), config),
    config,
    false,
  );
  const files: KitFiles = { ...web, 'index.html': page };
  if (options.manifest) files[MANIFEST_FILE] = options.manifest;
  if (config.routing === 'path') Object.assign(files, fallbacks(config.basePath));
  return files;
}

/** The frontend kit of a Builder run: its configuration and manifest around the web build. */
export function frontendKit(
  kits: Kits,
  web: WebFiles,
  options: { singleFile?: boolean } = {},
): Promise<KitFiles> {
  const config = JSON.parse(kits.frontend[CONFIG_FILE] ?? '{}') as RuntimeConfig;
  return assembleFrontendKit(web, config, {
    ...options,
    manifest: kits.frontend[MANIFEST_FILE] ?? '',
  });
}

/** Text of a kit file, whatever form it is kept in. */
export const kitText = (file: Uint8Array | string | undefined) =>
  typeof file === 'string' ? file : text(file);
