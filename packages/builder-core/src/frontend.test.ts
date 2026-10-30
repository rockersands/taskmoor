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
