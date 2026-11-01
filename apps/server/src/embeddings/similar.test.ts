import { randomBytes } from 'node:crypto';
import { LOCAL_MODEL_ID } from '@taskmoor/ai';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { expectWithinBudget } from '@taskmoor/testkit/budget';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { backfillEmbeddings } from './backfill';
import { registerEmbeddingJobs, scheduleBootSweeps } from './jobs';
import { EmbeddingService, sharedLocalEmbedder } from './service';
import { decodeRealArray } from './similar';
import { ensureVectorIndex, indexName } from './vector';

/** Generated per run: no credential is kept in the repository. */
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.79.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

const PEOPLE = ['admin', 'alice', 'bob'] as const;
type Person = (typeof PEOPLE)[number];

interface Hit {
  ticket: { id: number; key: string; summary: string };
  score: number;
  match: 'ticket' | 'comment';
  commentId?: number;
}

/**
 * Similar tickets with the bundled model and no AI provider (M1-078; AI-012, AI-016, NFR-011):
 * the indexer fed by the event bus, lookups by ticket and by typed text, the permission filter
 * (track browsing, a visibility level, a restricted comment), and both ways of searching: the
 * exact scan without pgvector (forced here) and pgvector's HNSW index where the database
 * server has the extension.
 */
describe('similar tickets (M1-078)', () => {
  const database = useMigratedDatabase();
  let exactApp: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const keys: Record<string, string> = {};
  const ids: Record<string, number> = {};
  let restrictedComment = 0;
  const embedder = sharedLocalEmbedder();
  let service: EmbeddingService;

  const as = (app: FastifyInstance, who: Person, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who].cookie },
    });
  const roleId = async (name: string) =>
    (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', name)
        .executeTakeFirstOrThrow()
    ).id;

  /** Relays events and runs jobs until the queue is empty: what the worker does. */
  let bus: EventBus;
  let runner: JobRunner;
  const drain = async () => {
    for (;;) {
      const relayed = await bus.relayOnce();
      const ran = await runner.runOnce();
      if (relayed === 0 && ran === 0) return;
    }
  };

  beforeAll(async () => {
    service = new EmbeddingService(database.db, embedder, { search: 'exact' });
    bus = new EventBus(database.db);
    runner = new JobRunner(database.db, 'similar-test');
    registerSubscribers(bus, { db: database.db, embeddings: service.indexer });
    registerEmbeddingJobs(runner, database.db, service.indexer);
    bus.attach(runner);
    exactApp = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      embedder,
      vectorSearch: 'exact',
    });
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: name === 'admin',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const res = await exactApp.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      users[name] = { id: row.id, cookie: sessionCookie(res.headers['set-cookie']) };
    }
    const members = await roleId('Members');
    // OPS: alice and bob. SEC: bob only.
    for (const [key, people] of [
      ['OPS', ['alice', 'bob']],
      ['SEC', ['bob']],
    ] as const) {
      const track = await as(exactApp, 'admin', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name: key, mode: 'shared' },
      });
      expect(track.statusCode, track.body).toBe(201);
      for (const who of people) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: track.json().track.id,
            role_id: members,
            user_id: users[who].id,
          })
          .execute();
      }
    }
    const create = async (name: string, track: string, summary: string, description?: string) => {
      const res = await as(exactApp, 'admin', {
        method: 'POST',
        url: '/api/v1/tickets?format=markdown',
        payload: { track, summary, ...(description ? { description } : {}) },
      });
      expect(res.statusCode, res.body).toBe(201);
      keys[name] = res.json().ticket.key;
      ids[name] = res.json().ticket.id;
    };
    await create('login', 'OPS', 'Login fails after password reset');
    await create(
      'signIn',
      'OPS',
      'Cannot sign in following credential change',
      'After changing my password the sign-in page says the account is locked.',
    );
    await create('chart', 'OPS', 'Quarterly revenue chart has the wrong colours');
    await create('export', 'OPS', 'CSV export drops the last column');
    await create('secret', 'SEC', 'Sign-in broken after resetting a password');
    await create('levelled', 'OPS', 'Password reset leaves people unable to log in');
    // The last OPS ticket is for bob alone, by a visibility level.
    const policy = await as(exactApp, 'admin', {
      method: 'POST',
      url: '/api/v1/visibility-policies',
      payload: {
        name: 'Private',
        levels: [{ name: 'Bob only', members: [{ grantee: 'user', userId: users.bob.id }] }],
      },
    });
    expect(policy.statusCode, policy.body).toBe(201);
    const ops = await database.db
      .selectFrom('track')
      .select('id')
      .where('key', '=', 'OPS')
      .executeTakeFirstOrThrow();
    const used = await as(exactApp, 'admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${ops.id}`,
      payload: { visibilityPolicyId: policy.json().visibilityPolicy.id },
    });
    expect(used.statusCode, used.body).toBe(200);
    const levelled = await as(exactApp, 'admin', {
      method: 'PATCH',
      url: `/api/v1/tickets/${keys.levelled}`,
      payload: { visibilityLevelId: policy.json().visibilityPolicy.levels[0].id },
    });
    expect(levelled.statusCode, levelled.body).toBe(200);
    // The chart ticket has a comment for the Leads group (bob) about the sign-in problem.
    const leads = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'Leads' })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const who of ['admin', 'bob'] as const) {
      await database.db
        .insertInto('group_member')
        .values({ workspace_id: 1, group_id: leads.id, user_id: users[who].id })
        .execute();
    }
    const comment = await as(exactApp, 'admin', {
      method: 'POST',
      url: `/api/v1/tickets/${keys.chart}/comments?format=markdown`,
      payload: {
        body: 'Users cannot log in any more after they reset their password',
        visibility: { groupId: leads.id },
      },
    });
    expect(comment.statusCode, comment.body).toBe(201);
    restrictedComment = comment.json().comment.id;
    await drain();
  });
  afterAll(async () => {
    await exactApp.close();
  });

  const similar = async (app: FastifyInstance, who: Person, key: string, extra = '') => {
    const res = await as(app, who, {
      method: 'GET',
      url: `/api/v1/tickets/${key}/similar?limit=10${extra}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { model: string; similar: Hit[] };
  };
  const names = (hits: Hit[]) => {
    const byId = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
    return hits.map((h) => byId.get(h.ticket.id) ?? `#${h.ticket.id}`);
  };

  it('[AI-012] [NFR-011] embeds tickets and comments in the background with no AI provider or key', async () => {
    const settings = await database.db.selectFrom('ai_setting').selectAll().execute();
    expect(settings).toEqual([]);
    const rows = await database.db
      .selectFrom('ticket_embedding')
      .select(['ticket_id', 'model', 'embedding'])
      .execute();
    expect(rows.map((r) => r.ticket_id).sort()).toEqual(Object.values(ids).sort());
    expect(rows.every((r) => r.model === LOCAL_MODEL_ID && r.embedding.length === 384)).toBe(true);
    const comments = await database.db.selectFrom('comment_embedding').selectAll().execute();
    expect(comments.map((c) => c.comment_id)).toEqual([restrictedComment]);
  });

  it('[AI-012] finds the paraphrase first, scores each result and never the ticket itself', async () => {
    const { model, similar: hits } = await similar(exactApp, 'alice', keys.login as string);
    expect(model).toBe(LOCAL_MODEL_ID);
    expect(names(hits)[0]).toBe('signIn');
    expect(names(hits)).not.toContain('login');
    expect(hits[0]?.ticket).toMatchObject({ key: keys.signIn, summary: expect.any(String) });
    expect(hits.every((h, i) => i === 0 || h.score <= (hits[i - 1]?.score ?? 1))).toBe(true);
    const typed = await as(exactApp, 'alice', {
      method: 'POST',
      url: '/api/v1/tickets/similar',
      payload: { text: 'export to csv loses a column', track: 'OPS', limit: 3 },
    });
    expect(typed.statusCode, typed.body).toBe(200);
    expect(names(typed.json().similar)[0]).toBe('export');
    // minScore leaves out the weak matches.
    const strict = await similar(exactApp, 'alice', keys.login as string, '&minScore=0.5');
    expect(strict.similar.every((h) => h.score >= 0.5)).toBe(true);
    expect(strict.similar.length).toBeLessThan(hits.length);
  });

  /** The permission matrix, the same for both ways of searching. */
  const matrix = async (app: FastifyInstance) => {
    // Alice browses OPS only and is not in the level nor in Leads.
    const alice = await similar(app, 'alice', keys.login as string);
    expect(names(alice.similar)).not.toContain('secret');
    expect(names(alice.similar)).not.toContain('levelled');
    const aliceChart = alice.similar.find((h) => h.ticket.id === ids.chart);
    expect(aliceChart?.match ?? 'ticket').toBe('ticket');
    expect(aliceChart?.commentId).toBeUndefined();
    // Bob sees everything, and the chart ticket through its comment for Leads.
    const bob = await similar(app, 'bob', keys.login as string);
    expect(names(bob.similar)).toEqual(expect.arrayContaining(['secret', 'levelled', 'signIn']));
    const bobChart = bob.similar.find((h) => h.ticket.id === ids.chart);
    expect(bobChart).toMatchObject({ match: 'comment', commentId: restrictedComment });
    expect(bobChart?.score).toBeGreaterThan(aliceChart?.score ?? -1);
    expect(JSON.stringify(bob)).not.toContain('reset their password');
    // A text being typed: the same filter; a hidden track is answered as unknown.
    const typed = await as(app, 'alice', {
      method: 'POST',
      url: '/api/v1/tickets/similar',
      payload: { text: 'sign-in broken after a password reset' },
    });
    expect(names(typed.json().similar)).not.toContain('secret');
    expect(names(typed.json().similar)).not.toContain('levelled');
    const hidden = await as(app, 'alice', {
      method: 'POST',
      url: '/api/v1/tickets/similar',
      payload: { text: 'sign-in broken', track: 'SEC' },
    });
    expect(hidden.statusCode).toBe(400);
    expect(hidden.json()).toEqual({ error: 'invalid_fields', fields: { track: 'No such track' } });
    // A ticket one cannot see has no similar tickets, only a 404.
    const res = await as(app, 'alice', {
      method: 'GET',
      url: `/api/v1/tickets/${keys.secret}/similar`,
    });
    expect(res.statusCode).toBe(404);
    return { alice: names(alice.similar), bob: names(bob.similar) };
  };

  let exactOrder: { alice: string[]; bob: string[] } | undefined;

  it('[AI-012] never returns a ticket the person cannot browse, nor counts a comment they cannot read (exact scan)', async () => {
    exactOrder = await matrix(exactApp);
  });

  const hasPgvector = async () => {
    const { rows } = await sql`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`.execute(
      database.db,
    );
    return rows.length > 0;
  };

  it('[AI-012] gives the same answers through pgvector’s HNSW index, where the server has it', async (ctx) => {
    if (!(await hasPgvector())) ctx.skip();
    const status = await ensureVectorIndex(database.db, 384);
    expect(status.search).toBe('pgvector');
    const indexes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_hnsw_384'`.execute(database.db);
    expect(indexes.rows.map((r) => r.indexname).sort()).toEqual([
      indexName('comment_embedding', 384),
      indexName('ticket_embedding', 384),
    ]);
    // Twice is harmless.
    expect((await ensureVectorIndex(database.db, 384)).search).toBe('pgvector');
    const app = await buildApp({ db: database.db, version: 'test', roles: ['api'], embedder });
    try {
      const order = await matrix(app);
      expect(order).toEqual(exactOrder);
      // The planner takes the index for a lookup.
      const plan = await sql<{ 'QUERY PLAN': string }>`
        EXPLAIN SELECT ticket_id FROM ticket_embedding WHERE cardinality(embedding) = 384
         ORDER BY (embedding::vector(384)) <=> (SELECT embedding FROM ticket_embedding LIMIT 1)::vector(384)
         LIMIT 5`.execute(database.db);
      const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(text).toMatch(/ticket_embedding_hnsw_384|Seq Scan/);
    } finally {
      await app.close();
    }
  });

  it('[AI-012] re-embeds a ticket only when its text changes, and drops trashed tickets and deleted comments', async () => {
    const before = await database.db
      .selectFrom('ticket_embedding')
      .select(['embedded_at', 'source_hash'])
      .where('ticket_id', '=', ids.export as number)
      .executeTakeFirstOrThrow();
    const labelled = await as(exactApp, 'admin', {
      method: 'PATCH',
      url: `/api/v1/tickets/${keys.export}`,
      payload: { labels: ['csv'] },
    });
    expect(labelled.statusCode, labelled.body).toBe(200);
    await drain();
    const same = await database.db
      .selectFrom('ticket_embedding')
      .select(['embedded_at', 'source_hash'])
      .where('ticket_id', '=', ids.export as number)
      .executeTakeFirstOrThrow();
    expect(same).toEqual(before);
    const renamed = await as(exactApp, 'admin', {
      method: 'PATCH',
      url: `/api/v1/tickets/${keys.export}`,
      payload: { summary: 'Spreadsheet download loses its final column' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    await drain();
    const changed = await database.db
      .selectFrom('ticket_embedding')
      .select('source_hash')
      .where('ticket_id', '=', ids.export as number)
      .executeTakeFirstOrThrow();
    expect(changed.source_hash).not.toBe(before.source_hash);

    const trashed = await as(exactApp, 'admin', {
      method: 'DELETE',
      url: `/api/v1/tickets/${keys.chart}`,
    });
    expect(trashed.statusCode, trashed.body).toBeLessThan(300);
    await drain();
    const rowsOf = async () => ({
      ticket: await database.db
        .selectFrom('ticket_embedding')
        .select('ticket_id')
        .where('ticket_id', '=', ids.chart as number)
        .execute(),
      comment: await database.db
        .selectFrom('comment_embedding')
        .select('comment_id')
        .where('comment_id', '=', restrictedComment)
        .execute(),
    });
    expect(await rowsOf()).toEqual({ ticket: [], comment: [] });
    const bob = await similar(exactApp, 'bob', keys.login as string);
    expect(names(bob.similar)).not.toContain('chart');
    const restored = await as(exactApp, 'admin', {
      method: 'POST',
      url: `/api/v1/tickets/${keys.chart}/restore`,
    });
    expect(restored.statusCode, restored.body).toBeLessThan(300);
    await drain();
    expect((await rowsOf()).ticket).toHaveLength(1);
    expect((await rowsOf()).comment).toHaveLength(1);
    const deleted = await as(exactApp, 'admin', {
      method: 'DELETE',
      url: `/api/v1/tickets/${keys.chart}/comments/${restrictedComment}`,
    });
    expect(deleted.statusCode, deleted.body).toBeLessThan(300);
    await drain();
    expect((await rowsOf()).comment).toEqual([]);
  });

  it('[AI-012] catches up with rows of another model and imports through the sweep and the CLI backfill', async () => {
    // Rows a former model made are stale.
    await sql`UPDATE ticket_embedding SET model = 'local:older-model'
               WHERE ticket_id = ${ids.signIn}`.execute(database.db);
    // A ticket written without an event, as an import does.
    await sql`INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, rank)
      SELECT workspace_id, track_id, 999, ticket_type_id, 'Imported: sign-in loops after reset', rank || 'z'
        FROM ticket WHERE id = ${ids.login}`.execute(database.db);
    expect(await scheduleBootSweeps(database.db, 'local:test-boot')).toBe(1);
    expect(await scheduleBootSweeps(database.db, 'local:test-boot')).toBe(0);
    await drain();
    const fresh = await database.db
      .selectFrom('ticket_embedding as e')
      .innerJoin('ticket as k', 'k.id', 'e.ticket_id')
      .select(['k.summary', 'e.model'])
      .where((eb) =>
        eb.or([eb('k.number', '=', 999), eb('e.ticket_id', '=', ids.signIn as number)]),
      )
      .execute();
    expect(fresh).toHaveLength(2);
    expect(fresh.every((r) => r.model === LOCAL_MODEL_ID)).toBe(true);
    // The operator's backfill: nothing is left; with --rebuild every vector is made again.
    const [report] = await backfillEmbeddings(database.db, service);
    expect(report).toMatchObject({ tickets: 0, comments: 0, search: 'exact' });
    expect(report?.coverage.ticketVectors).toBe(report?.coverage.tickets);
    const [rebuilt] = await backfillEmbeddings(database.db, service, { rebuild: true });
    expect(rebuilt?.cleared).toBeGreaterThan(0);
    expect(rebuilt?.tickets).toBe(rebuilt?.coverage.tickets);
  });

  // Loading 3,000 rows and building the HNSW index take seconds on a loaded machine.
  it('[AI-012] [AI-016] answers within budget at a few thousand tickets, both ways', async () => {
    // 3,000 tickets with vectors near random directions (made directly: the model is not what
    // is measured here), then lookups as alice, who sees the OPS track.
    const ops = await database.db
      .selectFrom('ticket')
      .select(['track_id', 'ticket_type_id', 'rank'])
      .where('id', '=', ids.login as number)
      .executeTakeFirstOrThrow();
    const count = 3_000;
    await sql`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, rank)
      SELECT 1, ${ops.track_id}, 1000 + n, ${ops.ticket_type_id}, 'Load ' || n, ${ops.rank} || lpad(n::text, 6, '0')
        FROM generate_series(1, ${count}) n`.execute(database.db);
    await sql`
      INSERT INTO ticket_embedding (ticket_id, workspace_id, model, source_hash, embedding)
      SELECT k.id, 1, ${LOCAL_MODEL_ID}, md5(k.summary),
             (SELECT array_agg(random()::real - 0.5) FROM generate_series(1, 384) WHERE k.id > 0)
        FROM ticket k WHERE k.summary LIKE 'Load %'`.execute(database.db);
    const time = async (app: FastifyInstance, what: string) => {
      const runs: number[] = [];
      for (let i = 0; i < 10; i++) {
        const started = performance.now();
        const res = await as(app, 'alice', {
          method: 'POST',
          url: '/api/v1/tickets/similar',
          payload: { text: `sign-in problem number ${i}`, limit: 10 },
        });
        runs.push(performance.now() - started);
        expect(res.statusCode).toBe(200);
        expect(res.json().similar).toHaveLength(10);
      }
      runs.sort((a, b) => a - b);
      const p95 = runs[Math.ceil(runs.length * 0.95) - 1] as number;
      expectWithinBudget(p95, 500, `similar tickets at ${count} tickets, ${what}, p95 ms`);
      return p95;
    };
    await time(exactApp, 'exact scan');
    if (await hasPgvector()) {
      await ensureVectorIndex(database.db, 384);
      const app = await buildApp({ db: database.db, version: 'test', roles: ['api'], embedder });
      try {
        await time(app, 'pgvector');
      } finally {
        await app.close();
      }
    }
  }, 120_000);

  it('[AI-012] reads stored vectors back exactly', async () => {
    const row = await sql<{ bin: Buffer; embedding: number[] }>`
      SELECT array_send(embedding) AS bin, embedding FROM ticket_embedding
       WHERE ticket_id = ${ids.login}`.execute(database.db);
    const first = row.rows[0];
    expect(first).toBeDefined();
    const decoded = decodeRealArray(first?.bin as Buffer, 384);
    expect(Array.from(decoded)).toEqual(Array.from(Float32Array.from(first?.embedding ?? [])));
  });
});
