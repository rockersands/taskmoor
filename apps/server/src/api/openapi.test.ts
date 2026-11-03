import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { stableJson } from '@taskmoor/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { breakingChanges } from './diff';
import { buildOpenApi, routeKey } from './openapi';
import { OPERATIONS } from './operations';
import { renderReference, slug } from './reference';

const require = createRequire(import.meta.url);
type Json = Record<string, unknown>;

/** OpenAPI 3.1's own schema, from the OpenAPI Initiative (via @apidevtools/openapi-schemas). */
function openApiValidator() {
  const Ajv2020 = require('ajv/dist/2020').default;
  const addFormats = require('ajv-formats').default;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const dir = `${require.resolve('@apidevtools/openapi-schemas').replace(/lib[\\/]index\.js$/, '')}schemas/v3.1/`;
  // ajv resolves `$dynamicRef` only in part; without a custom dialect, `#meta` is the
  // schema object's own definition, so it is referred to directly.
  const direct = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(direct);
    if (!node || typeof node !== 'object') return node;
    const entries = Object.entries(node as Json).map(([k, v]) =>
      k === '$dynamicRef' && v === '#meta' ? ['$ref', '#/$defs/schema'] : [k, direct(v)],
    );
    return Object.fromEntries(entries);
  };
  return ajv.compile(direct(JSON.parse(readFileSync(`${dir}schema.json`, 'utf8'))) as Json);
}

/**
 * The API document (M1-065; API-001): every stable operation is a route the server answers and
 * every route is in the document; the document is valid OpenAPI 3.1; it is committed as
 * `docs/api/openapi.json` (rewritten by `pnpm verify --update`, reviewed in the diff); and no
 * stable operation changes incompatibly from the published baseline of v1.
 */
describe('the API document (M1-065)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let doc: Json;
  let routes: string[];

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await app.ready();
    routes = (app as unknown as { routeTable: string[] }).routeTable;
    doc = buildOpenApi(OPERATIONS, routes);
  });
  afterAll(async () => {
    await app.close();
  });

  it('[API-001] documents only routes the server answers, each once, and every route there is', () => {
    const table = new Set(routes);
    expect(OPERATIONS.filter((o) => !table.has(routeKey(o))).map(routeKey)).toEqual([]);
    const ids = OPERATIONS.map((o) => o.id);
    expect(ids.filter((x, i) => ids.indexOf(x) !== i)).toEqual([]);
    const listed = new Set(
      Object.entries(doc.paths as Record<string, Json>).flatMap(([path, item]) =>
        Object.keys(item).map((m) => `${m.toUpperCase()} ${path}`),
      ),
    );
    const missing = routes
      .filter((r) => r.split(' ')[1]?.startsWith('/api/v1/') && !/^(HEAD|OPTIONS) /.test(r))
      .map((r) => r.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}'))
      .filter((r) => !listed.has(r));
    expect(missing).toEqual([]);
  });

  it('[API-001] is a valid OpenAPI 3.1 document', () => {
    const validate = openApiValidator();
    const ok = validate(doc);
    expect(ok, JSON.stringify(validate.errors?.slice(0, 5), null, 2)).toBe(true);
  });

  it('[API-001] is committed as docs/api/openapi.json', async () => {
    await expect(stableJson(doc)).toMatchFileSnapshot('../../../../docs/api/openapi.json');
  });

  it('[API-001] [NFR-010] changes no stable operation incompatibly since the v1 baseline', () => {
    const baseline = JSON.parse(
      readFileSync(
        new URL('../../../../docs/api/baseline/openapi-v1.json', import.meta.url),
        'utf8',
      ),
    ) as Json;
    expect(breakingChanges(baseline, doc)).toEqual([]);
  });

  it('[API-001] writes the reference page from the document', async () => {
    await expect(renderReference(doc)).toMatchFileSnapshot('../../../../docs/api/reference.md');
  });

  it('[API-001] has no broken links in the API docs', () => {
    const dir = new URL('../../../../docs/api/', import.meta.url);
    const anchorsOf = (file: URL) =>
      new Set(
        readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => /^#{1,6} /.test(line))
          .map((line) => slug(line.replace(/^#{1,6} /, ''))),
      );
    const broken: string[] = [];
    for (const name of ['README.md', 'reference.md']) {
      const file = new URL(name, dir);
      const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (!target || /^[a-z]+:/i.test(target)) continue;
        const [path, anchor] = target.split('#') as [string, string | undefined];
        const into = path ? new URL(path, file) : file;
        let ok = true;
        try {
          readFileSync(into);
        } catch {
          ok = false;
        }
        if (ok && anchor && into.pathname.endsWith('.md') && !anchorsOf(into).has(anchor))
          ok = false;
        if (!ok) broken.push(`${name}: ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('[API-001] tells breaking changes from compatible ones', () => {
    const base = structuredClone(doc);
    const paths = (d: Json) => d.paths as Record<string, Record<string, Json>>;
    const ticket = (d: Json) => paths(d)['/api/v1/tickets/{id}'] as Record<string, Json>;
    // Compatible: a new optional parameter and a new operation.
    const grown = structuredClone(doc);
    ((ticket(grown).get as Json).parameters as Json[]).push({
      name: 'expand',
      in: 'query',
      required: false,
      schema: { type: 'string' },
    });
    paths(grown)['/api/v1/new'] = { get: { 'x-taskmoor-stability': 'stable', responses: {} } };
    expect(breakingChanges(base, grown)).toEqual([]);
    // Breaking: an operation gone, a required parameter added, a response property gone.
    const broken = structuredClone(doc);
    delete ticket(broken).delete;
    ((ticket(broken).get as Json).parameters as Json[]).push({
      name: 'tenant',
      in: 'query',
      required: true,
      schema: { type: 'string' },
    });
    const schemas = (broken.components as Json).schemas as Record<string, Json>;
    const ticketSchema = schemas.Ticket as Json;
    delete (ticketSchema.properties as Json).summary;
    const found = breakingChanges(base, broken).map((c) => `${c.operation}: ${c.change}`);
    expect(found).toContain(
      'DELETE /api/v1/tickets/{id}: the operation is gone or no longer stable',
    );
    expect(found).toContain('GET /api/v1/tickets/{id}: new required parameter query:tenant');
  });
});
