import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { createDb, type Database, poolStats } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import {
  buildMetricsServer,
  createMetrics,
  type Metrics,
  queryObserver,
  startTracing,
  type Tracing,
} from './observability';
import { issueSetupToken } from './setup';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_ID = '00f067aa0ba902b7';

describe('observability', () => {
  const database = useMigratedDatabase();
  const exporter = new InMemorySpanExporter();
  let db: Kysely<Database>;
  let app: FastifyInstance;
  let metricsServer: FastifyInstance;
  let metrics: Metrics;
  let tracing: Tracing;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'taskmoor-obs-'));
    mkdirSync(join(dataDir, 'backups'));
    writeFileSync(join(dataDir, 'backups', 'last'), 'x\n');
    tracing = startTracing({ version: 'test', roles: ['api'], exporter }) as Tracing;
    metrics = createMetrics({
      version: 'test',
      roles: ['api'],
      pool: () => poolStats(db),
      dataDir,
      processMetrics: false,
    });
    db = createDb({
      connectionString: database.url,
      maxConnections: 3,
      onQuery: queryObserver({ metrics, tracer: tracing.tracer }),
    });
    app = await buildApp({
      db,
      version: 'test',
      roles: ['api'],
      metrics,
      tracer: tracing.tracer,
      dataDir,
    });
    metricsServer = await buildMetricsServer(metrics);
  });
  afterAll(async () => {
    await app.close();
    await metricsServer.close();
    await tracing.shutdown();
    await db.destroy();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('[OPS-011] publishes request, statement, pool, backup and build metrics for Prometheus', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/setup' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const res = await metricsServer.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    const text = res.body;
    expect(text).toMatch(
      /taskmoor_http_request_duration_seconds_count\{method="GET",route="\/api\/v1\/setup",status_code="200"\} 1/,
    );
    expect(text).not.toMatch(/route="\/health"/);
    expect(text).toMatch(/taskmoor_db_query_duration_seconds_count\{outcome="ok"\} [1-9]/);
    expect(text).toMatch(/taskmoor_db_pool_connections\{state="max"\} 3/);
    expect(text).toMatch(/taskmoor_backup_age_seconds \d/);
    expect(text).toMatch(/taskmoor_build_info\{version="test",roles="api"\} 1/);
  });

  it('[OPS-011] traces a request, continues an incoming trace and parents its statements', async () => {
    exporter.reset();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/setup?x=1',
      headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` },
    });
    expect(res.statusCode).toBe(200);
    const spans = exporter.getFinishedSpans();
    const server = spans.find((s) => s.name === 'GET /api/v1/setup');
    expect(server).toBeDefined();
    expect(server?.spanContext().traceId).toBe(TRACE_ID);
    expect(server?.parentSpanContext?.spanId).toBe(PARENT_ID);
    expect(server?.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/api/v1/setup',
      'url.path': '/api/v1/setup',
      'http.response.status_code': 200,
    });
    const queries = spans.filter((s) => s.name === 'db.query');
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.parentSpanContext?.spanId).toBe(server?.spanContext().spanId);
      expect(q.spanContext().traceId).toBe(TRACE_ID);
      expect(String(q.attributes['db.query.text'])).toMatch(/select/i);
    }
  });

  it('[OPS-011] leaves probes untraced and statements outside a request unparented', async () => {
    exporter.reset();
    await app.inject({ method: 'GET', url: '/ready' });
    await db.selectFrom('app_user').select('id').execute();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('[OPS-011] ships example alerts and a dashboard that only use metrics the server publishes', async () => {
    const published = new Set(
      (
        await createMetrics({
          version: 'x',
          roles: ['api'],
          pool: () => undefined,
          dataDir: '.',
        }).registry.getMetricsAsJSON()
      ).map((m) => m.name),
    );
    const root = join(__dirname, '..', '..', '..', 'deploy', 'observability');
    for (const file of ['alerts.yml', 'grafana-dashboard.json']) {
      const text = readFileSync(join(root, file), 'utf8');
      const used = new Set(
        [...text.matchAll(/\b((?:taskmoor|process)_[a-z_]+)\b/g)].map((m) =>
          (m[1] as string).replace(/_(bucket|sum|count)$/, ''),
        ),
      );
      expect(used.size, file).toBeGreaterThan(2);
      for (const name of used) expect(published.has(name), `${file} uses ${name}`).toBe(true);
    }
    expect(() =>
      JSON.parse(readFileSync(join(root, 'grafana-dashboard.json'), 'utf8')),
    ).not.toThrow();
  });

  it('[OPS-011] starts no tracer unless an OTLP endpoint is configured', () => {
    expect(startTracing({ version: 'test', roles: ['api'], env: {} })).toBeUndefined();
    expect(
      startTracing({
        version: 'test',
        roles: ['api'],
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.invalid:4318' },
      }),
    ).toBeDefined();
  });

  it('[OPS-010] shows the system status to site administrators only', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/system' })).statusCode).toBe(401);

    const token = (await issueSetupToken(db)) as string;
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: {
        token,
        instanceName: 'Ops',
        admin: { name: 'Ada', email: 'ada@example.com', password: 'a long enough passphrase' },
      },
    });
    expect(setup.statusCode).toBe(201);
    const adminCookie = cookieOf(setup.headers['set-cookie']);

    await db
      .insertInto('app_user')
      .values({
        email: 'bo@example.com',
        name: 'Bo',
        password_hash: await hashPassword('another long passphrase'),
      })
      .execute();
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'bo@example.com', password: 'another long passphrase' },
    });
    expect(signIn.statusCode).toBe(200);
    const userCookie = cookieOf(signIn.headers['set-cookie']);
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system',
      headers: { cookie: userCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const info = res.json();
    expect(info).toMatchObject({
      version: 'test',
      roles: ['api'],
      runtime: { node: process.version },
      database: {
        reachable: true,
        migrations: { pending: [], unknown: [] },
        pool: { max: 3 },
      },
      disk: { path: dataDir },
      backup: { ageSeconds: expect.any(Number) },
    });
    expect(info.database.version).toMatch(/^\d+/);
    expect(info.database.sizeBytes).toBeGreaterThan(0);
    expect(info.database.migrations.applied).toBeGreaterThan(0);
    expect(info.disk.freeBytes).toBeGreaterThan(0);
    expect(JSON.stringify(info)).not.toMatch(/password|secret|token/i);
  });
});

function cookieOf(header: string | string[] | undefined): string {
  const first = Array.isArray(header) ? header[0] : header;
  return (first ?? '').split(';')[0] ?? '';
}
