import { createDb } from '@tracksmith/db';
import { useMigratedDatabase } from '@tracksmith/db/testing';
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
    expect(res.json()).toEqual({ status: 'ok', version: '1.0.0-test' });
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
