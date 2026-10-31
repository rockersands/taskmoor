import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';
// By path: Vite loads its config with Node and bundles only relative imports (artefact.ts).
import { WEB_BUILD_ELEMENT_ID, WEB_BUILD_FORMAT } from '../src/builder/web-build-format';

/**
 * The Builder page's build (M1-112, ADR-088): one static `index.html` that runs from any
 * folder, a USB stick or `file://`, with nothing to fetch.
 * - The page's script and stylesheet go inline (`</script>` and `</style>` escaped), and every
 *   other asset was inlined as a data URL by the build options, so the page names no file.
 * - The web build the frontend kit is made from goes into a JSON data block of the same page.
 * - A content security policy in a meta element allows the inline blocks by their SHA-256 and
 *   nothing else: no request of any kind (`connect-src 'none'`, `default-src 'none'`), so the
 *   page cannot send what people type anywhere even if a dependency tried to.
 */
export interface BuilderPageOptions {
  /** The web build to carry: apps/web/dist after `vite build`. */
  webDir: string;
}

/** Every file under a folder, by its relative path with forward slashes. */
export function readWebBuild(dir: string): Record<string, Uint8Array> {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e): [string, Uint8Array] => {
        const path = join(e.parentPath, e.name);
        return [relative(dir, path).replaceAll('\\', '/'), new Uint8Array(readFileSync(path))];
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** The data block's JSON: paths to base64url bytes, safe inside a script element. */
export function encodeWebBuild(files: Record<string, Uint8Array>): string {
  const encoded = Object.fromEntries(
    Object.entries(files).map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64url')]),
  );
  return JSON.stringify({ format: WEB_BUILD_FORMAT, files: encoded }).replace(/</g, '\\u003c');
}

const dataBlock = (json: string) =>
  `<script id="${WEB_BUILD_ELEMENT_ID}" type="application/json">${json}</script>`;

/** The policy of the page: its own inline blocks, data and Blob URLs for images, and no more. */
export function builderPolicy(scripts: string[], styles: string[]): string {
  const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
  return [
    "default-src 'none'",
    `script-src ${scripts.map(hash).join(' ') || "'none'"}`,
    `style-src ${styles.map(hash).join(' ') || "'none'"}`,
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

const SCRIPT = /<script\b[^>]*\bsrc="\.\/([^"]+)"[^>]*><\/script>/g;
const STYLESHEET = /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\.\/([^"]+)"[^>]*>/g;

/** The built index.html as one page: assets inline, the web build inside, the policy on. */
export function singlePage(
  html: string,
  asset: (path: string) => string,
  webBuildJson: string,
): string {
  // Checked on the page around the tags it inlines: the inlined code may name anything.
  const left = html
    .replace(SCRIPT, '')
    .replace(STYLESHEET, '')
    .match(/<(?:script|link|img)\b[^>]*\b(?:src|href)="[^"]*"/);
  if (left) throw new Error(`The Builder page still names a file: ${left[0]}`);
  const scripts: string[] = [];
  const styles: string[] = [];
  let page = html
    .replace(SCRIPT, (_m, path: string) => {
      const code = asset(path).replace(/<\/(script)/gi, '<\\/$1');
      scripts.push(code);
      return `<script type="module">${code}</script>`;
    })
    .replace(STYLESHEET, (_m, path: string) => {
      const css = asset(path).replace(/<\/(style)/gi, '<\\/$1');
      styles.push(css);
      return `<style>${css}</style>`;
    });
  const policy = builderPolicy(scripts, styles);
  page = page.replace(
    /(<meta charset="[^"]*"\s*\/?>)/i,
    (charset) =>
      `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
  );
  return page.replace('</body>', () => `  ${dataBlock(webBuildJson)}\n  </body>`);
}

export function builderPage(options: BuilderPageOptions): Plugin {
  const webBuild = () => {
    if (!existsSync(join(options.webDir, 'index.html'))) return null;
    return encodeWebBuild(readWebBuild(options.webDir));
  };
  return {
    name: 'taskmoor-builder-page',
    // In development the page gets the web build too, when there is one, without the policy
    // (Vite's client injects styles and connects back for hot reloads).
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.server) return html;
        const json = webBuild();
        return json ? html.replace('</body>', () => `${dataBlock(json)}</body>`) : html;
      },
    },
    writeBundle: {
      order: 'post',
      handler(output) {
        const outDir = output.dir ?? '';
        const json = webBuild();
        if (!json) {
          throw new Error(
            `The Builder page carries the web build, and ${options.webDir} has none: run the web build first (pnpm build).`,
          );
        }
        const html = readFileSync(join(outDir, 'index.html'), 'utf8');
        const page = singlePage(html, (path) => readFileSync(join(outDir, path), 'utf8'), json);
        for (const entry of readdirSync(outDir)) rmSync(join(outDir, entry), { recursive: true });
        writeFileSync(join(outDir, 'index.html'), page);
      },
    },
  };
}
