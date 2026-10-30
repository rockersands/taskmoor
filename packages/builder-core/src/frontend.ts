import { fillRuntimeConfig, type RuntimeConfig } from '@taskmoor/webconfig';
import { sha384Integrity } from './bytes';
import { CONFIG_FILE, type Kits, MANIFEST_FILE } from './kits';

/**
 * The frontend kit (M1-111; OPS-013, ADR-031): the static app the backend image ships, made
 * ready for any static host. Its index.html gets the kit's public configuration in the slot
 * (pinned to the instance) and Subresource Integrity on every script and stylesheet. For clean
 * URLs it brings the fallbacks static hosts need to send deep links to index.html: `.htaccess`
 * (Apache), `_redirects` (Netlify, Cloudflare Pages) and `nginx.conf`. The single-file form puts
 * the scripts and styles into index.html itself, for a host that takes one file; it uses hash
 * routing, since one file cannot answer deep links.
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

function inlined(html: string, web: WebFiles): string {
  return html
    .replace(SCRIPT_SRC, (_whole, before: string, ref: string, after: string) => {
      const attrs = `${before}${after}`.replace(/\s*\bcrossorigin\b(="[^"]*")?/g, '').trimEnd();
      return `<script${attrs}>${inlineScript(text(asset(web, ref)))}</script>`;
    })
    .replace(STYLESHEET, (_whole, _a: string, _b: string, ref: string) => {
      return `<style>${text(asset(web, ref)).replace(/<\/(style)/gi, '<\\/$1')}</style>`;
    });
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
    const page = fillRuntimeConfig(inlined(indexOf(web), web), { ...config, routing: 'hash' });
    return { 'index.html': page };
  }
  const page = fillRuntimeConfig(await withIntegrity(indexOf(web), web), config);
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
