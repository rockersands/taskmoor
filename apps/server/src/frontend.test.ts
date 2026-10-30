import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { DEFAULT_RUNTIME_CONFIG, readRuntimeConfig } from '@taskmoor/webconfig';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { basePathOf } from './frontend';
import { INSTANCE_KEY, writeSetting } from './setup';

/** A built index.html as the artefact ships it: an empty slot before relative asset URLs. */
const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script id="taskmoor-config" type="application/json">{}</script>
    <title>Taskmoor</title>
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`;

async function artefact(version: string, index = INDEX): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'taskmoor-frontend-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), index);
  await writeFile(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
  await writeFile(join(dir, 'skin-boot.js'), 'void 0');
  await writeFile(
    join(dir, 'version.json'),
    JSON.stringify({ name: 'taskmoor-web', version, files: [] }),
  );
  return dir;
}

const page = (app: FastifyInstance, url: string) =>
  app.inject({ method: 'GET', url, headers: { accept: 'text/html,*/*;q=0.8' } });

describe('frontend artefact with clean URLs', () => {
  const database = useMigratedDatabase();
  let dir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = await artefact('2.0.0-test');
    app = await buildApp({
      db: database.db,
      version: '2.0.0-test',
      roles: ['api', 'web'],
      webDir: dir,
      webRouting: 'path',
      publicUrl: 'https://tracker.example.com/tm',
    });
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('[OPS-017] fills the runtime configuration for this instance, nothing else', async () => {
    const before = await page(app, '/');
    expect(readRuntimeConfig(before.body)).toEqual({
      config: {
        apiUrl: '',
        routing: 'path',
        basePath: '/tm/',
        instanceName: '',
        instanceId: '',
        instanceKey: '',
      },
      problems: [],
    });
    // The name given at setup appears once there is one.
    await writeSetting(database.db, INSTANCE_KEY, { name: 'Acme </script> Works' });
    const after = await page(app, '/index.html');
    expect(after.statusCode).toBe(200);
    expect(after.headers['content-type']).toMatch(/^text\/html/);
    expect(after.headers['cache-control']).toBe('no-cache');
    expect(readRuntimeConfig(after.body)?.config.instanceName).toBe('Acme </script> Works');
    const slot = /<script id="taskmoor-config"[^>]*>([^<]*)<\/script>/.exec(after.body)?.[1] ?? '';
    expect(Object.keys(JSON.parse(slot)).sort()).toEqual(
      Object.keys(DEFAULT_RUNTIME_CONFIG).sort(),
    );
  });

  it('[OPS-013] serves the app shell for deep links, with a base for its relative assets', async () => {
    for (const url of ['/boards/7', '/tickets/ABC-1?comment=3', '/admin/workflows/2']) {
      const res = await page(app, url);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<base href="/tm/" />');
      expect(res.body.indexOf('<base')).toBeLessThan(res.body.indexOf('./assets/index-abc.js'));
    }
  });

  it('[OPS-013] keeps files, API paths and non-page requests apart from the shell', async () => {
    const asset = await app.inject({ method: 'GET', url: '/assets/index-abc.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const boot = await app.inject({ method: 'GET', url: '/skin-boot.js' });
    expect(boot.headers['cache-control']).toBe('no-cache');
    const manifest = await app.inject({ method: 'GET', url: '/version.json' });
    expect(manifest.json()).toMatchObject({ name: 'taskmoor-web', version: '2.0.0-test' });
    expect((await page(app, '/api/v1/nope')).statusCode).toBe(404);
    expect((await page(app, '/api/v1/nope')).json()).toMatchObject({ statusCode: 404 });
    expect((await app.inject({ method: 'GET', url: '/boards/7' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/boards/7' })).statusCode).toBe(404);
    const missing = await app.inject({ method: 'GET', url: '/assets/gone.js' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('frontend artefact checks', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });
  const made = async (version: string, index?: string) => {
    const dir = await artefact(version, index);
    dirs.push(dir);
    return dir;
  };

  it('[OPS-017] refuses a frontend of another version than the backend', async () => {
    const webDir = await made('1.9.0');
    await expect(buildApp({ version: '2.0.0', roles: ['web'], webDir })).rejects.toThrow(
      /holds frontend 1\.9\.0 but this server is 2\.0\.0/,
    );
    const same = await buildApp({ version: '1.9.0', roles: ['web'], webDir });
    expect((await same.inject({ method: 'GET', url: '/health' })).json().version).toBe('1.9.0');
    await same.close();
  });

  it('[OPS-013] refuses a folder that is no frontend build', async () => {
    const noManifest = await made('1.0.0');
    await rm(join(noManifest, 'version.json'));
    await expect(
      buildApp({ version: '1.0.0', roles: ['web'], webDir: noManifest }),
    ).rejects.toThrow(/no version\.json/);
    const noSlot = await made('1.0.0', '<!doctype html><div id="root"></div>');
    await expect(buildApp({ version: '1.0.0', roles: ['web'], webDir: noSlot })).rejects.toThrow(
      /no runtime-config slot/,
    );
  });

  it('[OPS-013] takes the base path from the public URL', () => {
    expect(basePathOf('http://localhost:8080')).toBe('/');
    expect(basePathOf('https://tracker.example.com/')).toBe('/');
    expect(basePathOf('https://example.com/tm')).toBe('/tm/');
    expect(basePathOf('https://example.com/a/b//')).toBe('/a/b/');
  });

  it('[OPS-013] redirects a clean link under hash routing below the base path', async () => {
    const webDir = await made('1.0.0');
    const app = await buildApp({
      version: '1.0.0',
      roles: ['web'],
      webDir,
      publicUrl: 'https://example.com/tm/',
    });
    const res = await page(app, '/boards/7?quick=mine');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/tm/#/boards/7?quick=mine');
    const index = await page(app, '/');
    expect(index.body).not.toContain('<base');
    expect(readRuntimeConfig(index.body)?.config).toEqual({
      ...DEFAULT_RUNTIME_CONFIG,
      basePath: '/tm/',
    });
    await app.close();
  });
});
