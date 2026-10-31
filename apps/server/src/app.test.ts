import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

describe('probes with a working database', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: '1.0.0-test' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports the version', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: '1.0.0-test', roles: ['api'] });
  });

  it('GET /ready is 200 when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('unknown routes return a JSON 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

/** The smallest frontend artefact: an index.html with the runtime-config slot, and a manifest. */
const webShell =
  '<!doctype html><head><script id="taskmoor-config" type="application/json">{}</script></head>' +
  '<div id="root"></div>';
const webManifest = (version: string) =>
  JSON.stringify({ name: 'taskmoor-web', version, files: [] });

describe('web role', () => {
  let dir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'taskmoor-web-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), webShell);
    await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');
    await writeFile(join(dir, 'version.json'), webManifest('1.0.0-test'));
    app = await buildApp({ version: '1.0.0-test', roles: ['web'], webDir: dir });
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('[OPS-013] serves the built files and sends deep links to their hash route', async () => {
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('id="root"');
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    const deep = await app.inject({
      method: 'GET',
      url: '/boards/7',
      headers: { accept: 'text/html,*/*' },
    });
    expect(deep.statusCode).toBe(302);
    expect(deep.headers.location).toBe('/#/boards/7');
    // A link from the tracker an import came from goes to its own route (M1-128).
    const old = await app.inject({ method: 'GET', url: '/browse/ABC-1' });
    expect(old.headers.location).toBe('/#/tickets/ABC-1');
  });

  it('keeps JSON 404s for API paths and non-HTML clients', async () => {
    const api = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: 'Not Found', statusCode: 404 });
    const fetchLike = await app.inject({ method: 'GET', url: '/boards/7' });
    expect(fetchLike.statusCode).toBe(404);
  });

  it('is ready without a database and names its roles on /health', async () => {
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({
      status: 'ok',
      version: '1.0.0-test',
      roles: ['web'],
    });
  });

  it('refuses a web directory without an index.html', async () => {
    await expect(
      buildApp({ version: 'x', roles: ['web'], webDir: join(dir, 'assets') }),
    ).rejects.toThrow(/no index.html/);
  });
});

describe('probes without a database', () => {
  // Port 1 refuses connections immediately, standing in for a database that is down.
  const db = createDb({
    connectionString: 'postgres://nobody@127.0.0.1:1/none',
    maxConnections: 1,
  });
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ db, version: '1.0.0-test' });
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('GET /health stays 200, so the process is not restarted for a database outage', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /ready is 503 and names the failing dependency', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable', reason: 'database' });
  });
});
