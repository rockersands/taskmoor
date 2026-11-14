import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { runBulkOperation } from '../bulk/run';
import { EmbeddingIndexer } from '../embeddings/indexer';
import { sharedLocalEmbedder } from '../embeddings/service';
import { FieldCatalogs } from '../fields/catalog';
import { ticketRoutes } from '../routes/tickets';

// Made for this run: no password is written in the repository.
const PASSWORD = `api-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.94.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (
      list.find(
        (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
      ) ?? ''
    ).split(';')[0] ?? ''
  );
}

import { createRequire } from 'node:module';
import { afterAll as after, beforeAll as before, describe, expect, it } from 'vitest';
import { buildOpenApi, openApiPath, routeKey } from './openapi';
import { OPERATIONS } from './operations';

const require = createRequire(import.meta.url);
type Json = Record<string, unknown>;

interface Answer {
  operation: string;
  status: number;
  body: unknown;
}

/**
 * Contract tests from the API document (M1-065; API-001 (1), (2)): every stable operation is
 * called against a real server, and its status must be one the document lists and its body
 * must validate against the documented schema (ajv, JSON Schema 2020-12). Paged lists are read
 * a page at a time to their end, each ticket once. A stable operation without a call here fails
 * the coverage check.
 */
describe('API v1 contract (M1-065)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let doc: Json;
  let cookie = '';
  const answers: Answer[] = [];

  /** Calls a stable operation by method and path template, recording its answer. */
  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    template: string,
    url: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({
      method,
      url,
      remoteAddress: nextAddress(),
      headers: { cookie },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    const body = res.body ? JSON.parse(res.body) : null;
    answers.push({ operation: `${method} ${template}`, status: res.statusCode, body });
    expect(res.statusCode, `${method} ${url}: ${res.body.slice(0, 300)}`).toBeLessThan(300);
    return body;
  };

  before(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await app.ready();
    doc = buildOpenApi(OPERATIONS, (app as unknown as { routeTable: string[] }).routeTable);
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'Ada Admin',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
  });
  after(async () => {
    await app.close();
  });

  it('[API-001] answers every stable operation as documented', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    answers.push({
      operation: 'POST /api/v1/session',
      status: signIn.statusCode,
      body: signIn.json(),
    });
    cookie = sessionCookie(signIn.headers['set-cookie']);
    await call('GET', '/api/meta', '/api/meta?nonce=contract-test-nonce-0001');
    await call('GET', '/api/v1/session', '/api/v1/session');
    const track = (
      await call('POST', '/api/v1/tracks', '/api/v1/tracks', {
        key: 'API',
        name: 'Api',
        mode: 'shared',
      })
    ).track;
    await call('GET', '/api/v1/tracks', '/api/v1/tracks');
    await call('GET', '/api/v1/tracks/:id', `/api/v1/tracks/${track.id}`);
    await call('GET', '/api/v1/tracks/:id/ticket-types', `/api/v1/tracks/${track.id}/ticket-types`);
    const a = (
      await call('POST', '/api/v1/tickets', '/api/v1/tickets', {
        track: 'API',
        summary: 'First',
        dueDate: '2030-01-10',
      })
    ).ticket;
    const b = (
      await call('POST', '/api/v1/tickets', '/api/v1/tickets', { track: 'API', summary: 'Second' })
    ).ticket;
    await call('POST', '/api/v1/tickets', '/api/v1/tickets', { track: 'API', summary: 'Third' });
    await call('GET', '/api/v1/tickets/:id', `/api/v1/tickets/${a.key}?format=markdown`);
    await call('PATCH', '/api/v1/tickets/:id', `/api/v1/tickets/${a.key}`, {
      summary: 'First one',
      version: a.version,
    });
    const transitions = (
      await call('GET', '/api/v1/tickets/:id/transitions', `/api/v1/tickets/${a.key}/transitions`)
    ).transitions;
    const start = transitions.find((x: { to: { stage: string } }) => x.to.stage === 'active');
    await call('POST', '/api/v1/tickets/:id/transitions', `/api/v1/tickets/${a.key}/transitions`, {
      transitionId: start.id,
    });
    await call('PUT', '/api/v1/tickets/:id/rank', `/api/v1/tickets/${b.key}/rank`, {
      position: 'top',
    });
    await call('GET', '/api/v1/tickets/:id/history', `/api/v1/tickets/${a.key}/history?limit=2`);
    await call('GET', '/api/v1/tickets/:id/info', `/api/v1/tickets/${a.key}/info`);
    const comment = (
      await call(
        'POST',
        '/api/v1/tickets/:id/comments',
        `/api/v1/tickets/${a.key}/comments?format=markdown`,
        { body: 'Hello **there**' },
      )
    ).comment;
    await call(
      'POST',
      '/api/v1/tickets/:id/comments',
      `/api/v1/tickets/${a.key}/comments?format=markdown`,
      { body: 'Again' },
    );
    await call('GET', '/api/v1/tickets/:id/comments', `/api/v1/tickets/${a.key}/comments?limit=1`);
    await call(
      'PATCH',
      '/api/v1/tickets/:id/comments/:commentId',
      `/api/v1/tickets/${a.key}/comments/${comment.id}?format=markdown`,
      { body: 'Hello again' },
    );
    await call(
      'DELETE',
      '/api/v1/tickets/:id/comments/:commentId',
      `/api/v1/tickets/${a.key}/comments/${comment.id}`,
    );
    const linkTypes = (await call('GET', '/api/v1/link-types', '/api/v1/link-types')).linkTypes;
    const link = (
      await call('POST', '/api/v1/tickets/:id/links', `/api/v1/tickets/${a.key}/links`, {
        linkTypeId: linkTypes[0].id,
        ticket: b.key,
      })
    ).link;
    await call('GET', '/api/v1/tickets/:id/links', `/api/v1/tickets/${a.key}/links`);
    // Checklists (CORE-033).
    const lists = '/api/v1/tickets/:id/checklists';
    const listsAt = `/api/v1/tickets/${a.key}/checklists`;
    await call('GET', lists, listsAt);
    const made = await call('POST', lists, listsAt, { name: 'Steps', items: ['First'] });
    const list = made.checklists[0] as { id: number; items: { id: number }[] };
    const second = await call('POST', lists, listsAt, { name: 'More' });
    await call('PUT', `${lists}/order`, `${listsAt}/order`, {
      ids: [second.checklists[1].id, list.id],
    });
    await call('PATCH', `${lists}/:checklistId`, `${listsAt}/${list.id}`, { name: 'The steps' });
    const items = `${lists}/:checklistId/items`;
    const itemsAt = `${listsAt}/${list.id}/items`;
    const added = await call('POST', items, itemsAt, { text: 'Second' });
    const row = added.checklists[1].items[1] as { id: number };
    await call('PUT', `${items}/order`, `${itemsAt}/order`, { ids: [row.id, list.items[0]?.id] });
    await call('PATCH', `${items}/:itemId`, `${itemsAt}/${row.id}`, { state: 'done' });
    await call('DELETE', `${items}/:itemId`, `${itemsAt}/${row.id}`);
    await call('DELETE', `${lists}/:checklistId`, `${listsAt}/${list.id}`);
    await call(
      'DELETE',
      '/api/v1/tickets/:id/links/:linkId',
      `/api/v1/tickets/${a.key}/links/${link.id}`,
    );
    await call(
      'POST',
      '/api/v1/tickets/:id/time-entries',
      `/api/v1/tickets/${a.key}/time-entries`,
      { duration: '1h 30m' },
    );
    await call('GET', '/api/v1/tickets/:id/time-entries', `/api/v1/tickets/${a.key}/time-entries`);
    // Bulk changes as tasks (M1-130): no worker runs here, so it stays queued until cancelled.
    const bulk = (
      await call('POST', '/api/v1/bulk-operations', '/api/v1/bulk-operations', {
        action: 'edit',
        tickets: [a.key, b.key, 'API-999'],
        edit: { labels: ['bulk'] },
      })
    ).bulkOperation;
    await call('GET', '/api/v1/bulk-operations', '/api/v1/bulk-operations');
    await call('GET', '/api/v1/bulk-operations/:id', `/api/v1/bulk-operations/${bulk.id}`);
    await call(
      'GET',
      '/api/v1/bulk-operations/:id/items',
      `/api/v1/bulk-operations/${bulk.id}/items?limit=2`,
    );
    await call(
      'POST',
      '/api/v1/bulk-operations/:id/cancel',
      `/api/v1/bulk-operations/${bulk.id}/cancel`,
    );
    // Clone (M1-124): its operation runs here by hand, so an item shows the copy it made.
    const clone = (
      await call('POST', '/api/v1/tickets/:id/clone', `/api/v1/tickets/${a.key}/clone`, {
        summary: 'A copied',
      })
    ).bulkOperation;
    const authorizer = new Authorizer(database.db);
    const catalogs = new FieldCatalogs(database.db);
    await runBulkOperation(
      {
        db: database.db,
        authorizer,
        routes: ticketRoutes(database.db, authorizer, catalogs),
        catalogs,
      },
      String(clone.id),
      { until: Date.now() + 60_000 },
    );
    const copied = (
      await call(
        'GET',
        '/api/v1/bulk-operations/:id/items',
        `/api/v1/bulk-operations/${clone.id}/items`,
      )
    ).items;
    const copyKey = copied[0].result.ticket.key as string;
    expect(copyKey).toMatch(/^API-\d+$/);
    await call('GET', '/api/v1/search', '/api/v1/search?q=track%20%3D%20API&limit=2');
    await call('POST', '/api/v1/search', '/api/v1/search', { q: 'track = API', limit: 2 });
    // Similar tickets (M1-078) over vectors the indexer made, so the answer has items.
    await new EmbeddingIndexer(database.db, sharedLocalEmbedder()).sweep(1);
    const near = await call(
      'GET',
      '/api/v1/tickets/:id/similar',
      `/api/v1/tickets/${copyKey}/similar?limit=3`,
    );
    expect(near.similar.length).toBeGreaterThan(0);
    await call('POST', '/api/v1/tickets/similar', '/api/v1/tickets/similar', {
      text: 'A ticket like the others',
      track: 'API',
      limit: 2,
    });
    await call('GET', '/api/v1/search/check', '/api/v1/search/check?q=track%20%3D%20API');
    await call('GET', '/api/v1/search/check', '/api/v1/search/check?q=nope%20%3D%201');
    const saved = (
      await call('POST', '/api/v1/saved-searches', '/api/v1/saved-searches', {
        name: 'Mine',
        query: 'track = API',
      })
    ).savedSearch;
    await call('GET', '/api/v1/saved-searches', '/api/v1/saved-searches');
    await call('GET', '/api/v1/saved-searches/:id', `/api/v1/saved-searches/${saved.id}`);
    const board = (
      await call('POST', '/api/v1/boards', '/api/v1/boards', {
        name: 'Api',
        kind: 'scrum',
        trackId: track.id,
        source: { query: 'track = API' },
      })
    ).board;
    await call('GET', '/api/v1/boards', '/api/v1/boards');
    await call('GET', '/api/v1/boards/:id', `/api/v1/boards/${board.id}`);
    await call('GET', '/api/v1/boards/:id/data', `/api/v1/boards/${board.id}/data`);
    const sprint = (
      await call('POST', '/api/v1/boards/:id/sprints', `/api/v1/boards/${board.id}/sprints`, {})
    ).sprint;
    await call('GET', '/api/v1/boards/:id/sprints', `/api/v1/boards/${board.id}/sprints`);
    await call('POST', '/api/v1/sprints/:id/tickets', `/api/v1/sprints/${sprint.id}/tickets`, {
      tickets: [a.id],
    });
    await call('GET', '/api/v1/boards/:id/backlog', `/api/v1/boards/${board.id}/backlog`);
    await call('POST', '/api/v1/sprints/:id/start', `/api/v1/sprints/${sprint.id}/start`, {
      endAt: '2030-01-15T09:00:00Z',
    });
    await call('POST', '/api/v1/sprints/:id/complete', `/api/v1/sprints/${sprint.id}/complete`, {
      moveTo: { type: 'backlog' },
    });
    // Entity properties (M1-129): every kind, set twice (201, then 200), read, listed, deleted.
    const index = (
      await call('POST', '/api/v1/admin/property-indexes', '/api/v1/admin/property-indexes', {
        key: 'api.review',
        path: 'state',
        type: 'string',
      })
    ).propertyIndex;
    await call('GET', '/api/v1/admin/property-indexes', '/api/v1/admin/property-indexes');
    for (const [base, owner] of [
      ['/api/v1/tickets', a.key],
      ['/api/v1/tracks', track.key],
      ['/api/v1/users', 'me'],
      ['/api/v1/boards', board.id],
      ['/api/v1/sprints', sprint.id],
    ] as const) {
      const url = `${base}/${owner}/properties/api.review`;
      const template = `${base}/:id/properties/:key`;
      await call('PUT', template, url, { value: { state: 'pending' } });
      await call('PUT', template, url, { value: { state: 'approved', by: [1] } });
      await call('GET', template, url);
      await call('GET', `${base}/:id/properties`, `${base}/${owner}/properties`);
      await call('DELETE', template, url);
    }
    await call(
      'DELETE',
      '/api/v1/admin/property-indexes/:id',
      `/api/v1/admin/property-indexes/${index.id}`,
    );
    // Guardrails (M1-055): the list, with grants counted per permission, and one limit raised.
    const { guardrails } = await call(
      'GET',
      '/api/v1/admin/guardrails',
      '/api/v1/admin/guardrails',
    );
    expect(
      (guardrails as Json[]).find((g) => g.name === 'grants_per_permission')?.usage,
    ).toMatchObject({ where: { kind: 'access_policy', permission: expect.any(String) } });
    await call(
      'PUT',
      '/api/v1/admin/guardrails/:name',
      '/api/v1/admin/guardrails/areas_per_track',
      { limit: 20_000 },
    );
    const release = (
      await call('POST', '/api/v1/tracks/:id/releases', `/api/v1/tracks/${track.id}/releases`, {
        name: '1.0',
        releaseDate: '2030-02-01',
      })
    ).release;
    await call('GET', '/api/v1/tracks/:id/releases', `/api/v1/tracks/${track.id}/releases`);
    await call('GET', '/api/v1/releases/:id', `/api/v1/releases/${release.id}`);
    await call('GET', '/api/v1/fields', '/api/v1/fields');
    await call('GET', '/api/v1/priorities', '/api/v1/priorities');
    await call('GET', '/api/v1/statuses', '/api/v1/statuses');
    await call('DELETE', '/api/v1/tickets/:id', `/api/v1/tickets/${b.key}`);
    // Paged lists, read to their end a page at a time: each ticket once.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { tickets: { key: string }[]; next: string | null } = await call(
        'GET',
        '/api/v1/tickets',
        `/api/v1/tickets?track=API&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...page.tickets.map((t) => t.key));
      cursor = page.next;
    } while (cursor);
    // A's copy is in the track too.
    expect(seen.sort()).toEqual(['API-1', 'API-3', copyKey].sort());
    await call('DELETE', '/api/v1/session', '/api/v1/session');

    // Every answer against the document.
    const Ajv2020 = require('ajv/dist/2020').default;
    const addFormats = require('ajv-formats').default;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema({ $id: 'https://taskmoor.test/api', components: doc.components });
    const absolute = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(absolute);
      if (!node || typeof node !== 'object') return node;
      return Object.fromEntries(
        Object.entries(node as Json).map(([k, v]) => [
          k,
          k === '$ref' && typeof v === 'string' ? `https://taskmoor.test/api${v}` : absolute(v),
        ]),
      );
    };
    const problems: string[] = [];
    for (const answer of answers) {
      const [method, path] = answer.operation.split(' ') as [string, string];
      const operation = ((doc.paths as Record<string, Json>)[openApiPath(path)]?.[
        method.toLowerCase()
      ] ?? null) as Json | null;
      if (!operation) {
        problems.push(`${answer.operation}: not in the document`);
        continue;
      }
      const response = (operation.responses as Record<string, Json>)[String(answer.status)];
      if (!response) {
        problems.push(`${answer.operation}: status ${answer.status} is not documented`);
        continue;
      }
      const schema = (
        (response.content as Json | undefined)?.['application/json'] as Json | undefined
      )?.schema;
      if (!schema) {
        if (answer.body !== null)
          problems.push(`${answer.operation}: a body where none is documented`);
        continue;
      }
      const validate = ajv.compile(absolute(schema) as Json);
      if (!validate(answer.body)) {
        problems.push(
          `${answer.operation} ${answer.status}: ${JSON.stringify(validate.errors?.slice(0, 3))}`,
        );
      }
    }
    expect(problems).toEqual([]);
    // Every stable operation was called.
    const called = new Set(answers.map((a) => a.operation));
    expect(OPERATIONS.map(routeKey).filter((k) => !called.has(k))).toEqual([]);
  });
});
