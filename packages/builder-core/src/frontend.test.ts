import { readRuntimeConfig } from '@taskmoor/webconfig';
import { describe, expect, it } from 'vitest';
import { sha384Integrity, utf8 } from './bytes';
import { assembleFrontendKit, frontendKit, kitText } from './frontend';
import { generateSecrets, secretValues, systemRandom } from './index';
import { validateInputs } from './inputs';
import { buildKits, MANIFEST_FILE } from './kits';
import { readZip, writeZip } from './zip';

/** A web build in miniature, shaped as Vite writes it. */
const JS = 'console.log("app"); const s = "</script>";';
const CSS = 'body{background:url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")}';
const WEB = {
  'index.html': utf8(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script id="taskmoor-config" type="application/json">{}</script>
    <title>Taskmoor</title>
    <script src="./skin-boot.js"></script>
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-def.css">
  </head>
  <body><div id="root"></div></body>
</html>
`),
  'skin-boot.js': utf8('document.documentElement.dataset.skin = "light";'),
  'assets/index-abc.js': utf8(JS),
  'assets/index-def.css': utf8(CSS),
  'version.json': utf8('{"name":"taskmoor-web","version":"1.4.2","files":[]}'),
};

async function kitsFor(raw: Record<string, unknown> = {}) {
  const form = validateInputs({
    backendUrl: 'https://api.example.com',
    frontendUrl: 'https://tracker.example.com/',
    ...raw,
  });
  if (!form.ok) throw new Error('inputs');
  const secrets = await generateSecrets(systemRandom);
  return {
    secrets,
    kits: await buildKits(
      form.inputs,
      secrets,
      {},
      { backendVersion: '1.4.2', kitVersion: '1.4.2' },
    ),
  };
}

describe('the frontend kit (M1-111)', () => {
  it('[OPS-013] fills the configuration, pinned to the instance, with integrity on every asset', async () => {
    const { kits, secrets } = await kitsFor();
    const files = await frontendKit(kits, WEB);
    const page = kitText(files['index.html']);
    expect(readRuntimeConfig(page)?.config).toMatchObject({
      apiUrl: 'https://api.example.com',
      routing: 'path',
      instanceId: secrets.instanceId,
      instanceKey: secrets.instanceKey.publicKey,
    });
    expect(page).toContain(
      `<script type="module" crossorigin src="./assets/index-abc.js" integrity="${await sha384Integrity(utf8(JS))}"></script>`,
    );
    expect(page).toContain(
      `href="./assets/index-def.css" integrity="${await sha384Integrity(utf8(CSS))}"`,
    );
    expect(page).toContain(`src="./skin-boot.js" integrity="sha384-`);
    // The app's content security policy, before any script: the kit's files and its backend.
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/.exec(page);
    expect(page.indexOf('Content-Security-Policy')).toBeLessThan(page.indexOf('<script'));
    expect(csp?.[1]).toContain("script-src 'self';");
    expect(csp?.[1]).toContain("connect-src 'self' https://api.example.com wss://api.example.com");
    expect(csp?.[1]).not.toContain('unsafe-inline;');
    expect(kitText(files[MANIFEST_FILE])).toBe(kits.frontend[MANIFEST_FILE]);
    const all = Object.values(files).map(kitText).join('\n');
    for (const s of secretValues(secrets)) expect(all).not.toContain(s);
  });

  it('[OPS-013] brings the host fallbacks for clean URLs, below the base path', async () => {
    const { kits } = await kitsFor({ frontendUrl: 'https://example.com/tracker/' });
    const files = await frontendKit(kits, WEB);
    expect(kitText(files['.htaccess'])).toContain('RewriteRule . /tracker/index.html [L]');
    expect(kitText(files._redirects)).toContain('/tracker/* /tracker/index.html 200');
    expect(kitText(files['nginx.conf'])).toContain('try_files $uri $uri/ /tracker/index.html;');
    // Hash routing needs none.
    const hash = await frontendKit((await kitsFor({ routing: 'hash' })).kits, WEB);
    expect(Object.keys(hash)).not.toContain('.htaccess');
  });

  it('[OPS-013] (2) puts everything in one index.html for a single-file host, with hash routing', async () => {
    const { kits } = await kitsFor();
    const files = await frontendKit(kits, WEB, { singleFile: true });
    expect(Object.keys(files)).toEqual(['index.html']);
    const page = kitText(files['index.html']);
    expect(page).not.toMatch(/src="\.\/|href="\.\//);
    expect(page).toContain(
      '<script type="module">console.log("app"); const s = "<\\/script>";</script>',
    );
    expect(page).toContain(`<style>${CSS}</style>`);
    expect(readRuntimeConfig(page)?.config.routing).toBe('hash');
    // Exactly the page's own script elements remain: the config, skin-boot and the app.
    expect(page.match(/<\/script>/g)).toHaveLength(3);
    // Its inline scripts and styles run by their hashes alone, never 'unsafe-inline' for them.
    const csp = /content="([^"]+)"/.exec(page)?.[1] ?? '';
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src ')) ?? '';
    expect(scriptSrc.match(/'sha256-/g)).toHaveLength(2);
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(csp.split('; ').find((d) => d.startsWith('style-src-elem '))).toMatch(/'sha256-/);
  });

  it('[OPS-013] keeps the fonts as files in the kit, and the single file carries them and their licence (T-262)', async () => {
    const { kits } = await kitsFor();
    const font = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 255]);
    const css =
      '@font-face{font-family:"Google Sans";src:url(./googlesans-500-latin-x1.woff2) format("woff2")}' +
      `@font-face{font-family:"Google Sans";src:url('../assets/googlesans-500-latin-ext-x2.woff2')}` +
      `.a{background:url("data:image/svg+xml,%3csvg fill='url(%23g)'/%3e")}.b{mask:url(#m)}`;
    const web = {
      ...WEB,
      'assets/index-def.css': utf8(css),
      'assets/googlesans-500-latin-x1.woff2': font,
      'assets/googlesans-500-latin-ext-x2.woff2': font,
      'assets/OFL.txt': utf8('Copyright 2025 The Authors\r\nSIL OPEN FONT LICENSE Version 1.1\r\n'),
    };
    const kit = await frontendKit(kits, web);
    expect(kit['assets/googlesans-500-latin-x1.woff2']).toEqual(font);
    expect(kit['assets/OFL.txt']).toEqual(web['assets/OFL.txt']);
    expect(kitText(kit['index.html'])).not.toContain('OPEN FONT LICENSE');

    const single = await frontendKit(kits, web, { singleFile: true });
    expect(Object.keys(single)).toEqual(['index.html']);
    const page = kitText(single['index.html']);
    const data = `url("data:font/woff2;base64,${btoa(String.fromCharCode(...font))}")`;
    expect(page.split(data)).toHaveLength(3);
    expect(page).not.toContain('.woff2');
    // Data URLs, Blob URLs and ids stay as they were.
    expect(page).toContain(`.a{background:url("data:image/svg+xml,%3csvg fill='url(%23g)'/%3e")}`);
    expect(page).toContain('.b{mask:url(#m)}');
    // The fonts' licence once, in the head, as a comment the browser shows to no one.
    expect(page.match(/SIL OPEN FONT LICENSE/g)).toHaveLength(1);
    expect(page).toMatch(
      /<!--\nCopyright 2025 The Authors\nSIL OPEN FONT LICENSE Version 1.1\n-->\n\s*<\/head>/,
    );
    // The policy lets the page use them: fonts from data URLs.
    expect(/content="([^"]+)"/.exec(page)?.[1]).toContain("font-src 'self' data:");
  });

  it('[OPS-013] refuses a single file whose stylesheet names a file the build lacks', async () => {
    const { kits } = await kitsFor();
    const web = { ...WEB, 'assets/index-def.css': utf8('@font-face{src:url(./gone.woff2)}') };
    await expect(frontendKit(kits, web, { singleFile: true })).rejects.toThrow(
      'assets/index-def.css names ./gone.woff2, which the build lacks',
    );
  });

  it('[OPS-016] zips to the same bytes for the same build and kits', async () => {
    const { kits } = await kitsFor();
    const zip = async () => writeZip(await frontendKit(kits, WEB));
    const [a, b] = [await zip(), await zip()];
    expect(a).toEqual(b);
    expect(Object.keys(readZip(a))).toContain('assets/index-abc.js');
  });

  it('[OPS-013] refuses a page that names an asset the build lacks', async () => {
    const { kits } = await kitsFor();
    const broken = { ...WEB, 'assets/index-abc.js': undefined } as unknown as typeof WEB;
    delete (broken as Record<string, unknown>)['assets/index-abc.js'];
    await expect(
      assembleFrontendKit(broken, JSON.parse(kits.frontend['taskmoor-config.json'] ?? '{}')),
    ).rejects.toThrow(/lacks/);
  });
});
