import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { AdapterRequest, AdapterResponse } from '@taskmoor/ai';
import { FakeAdapter } from '@taskmoor/ai/testing';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { expectWithinBudget } from '@taskmoor/testkit/budget';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUERY_SYSTEM } from '../ai/features/query';
import { SUMMARY_SYSTEM } from '../ai/features/summary';
import type { AiConfigured } from '../ai/service';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { backfillEmbeddings } from '../embeddings/backfill';
import { EmbeddingService, sharedLocalEmbedder } from '../embeddings/service';

/**
 * The AI features of v1 against the server (M1-079; AI-013 to AI-016, NFR-011; ADR-108), with a
 * scripted provider (`FakeAdapter`) and the bundled embedding model: what reaches the prompt is
 * only what the person may read, summaries stream and cite comments, queries are checked and
 * never run, drafts and breakdowns create nothing, and duplicate suggestions keep to 2 seconds.
 */
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.81.${Math.floor(++address / 250)}.${(address % 250) + 1}`;
const PEOPLE = ['admin', 'alice', 'bob'] as const;
type Person = (typeof PEOPLE)[number];

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    list
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
      ?.split(';')[0] ?? ''
  );
}

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Server-sent events of a body, in order. */
function events(body: string): { event: string; data: Record<string, unknown> }[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

const json = (value: unknown): Partial<AdapterResponse> => ({ text: JSON.stringify(value) });
const sentText = (adapter: FakeAdapter) => JSON.stringify(adapter.requests);

/** Answers after a pause, to stand for a slow provider. */
class SlowAdapter extends FakeAdapter {
  constructor(
    private readonly delayMs: number,
    script: ConstructorParameters<typeof FakeAdapter>[0],
  ) {
    super(script);
  }
  override async generate(request: AdapterRequest, options?: { signal?: AbortSignal }) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      options?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });
    return super.generate(request);
  }
}

/** Streams many pieces and remembers whether its call was cancelled. */
class LongStream extends FakeAdapter {
  aborted = false;
  override async stream(request: AdapterRequest, options: Parameters<FakeAdapter['stream']>[1]) {
    try {
      return await super.stream(request, options);
    } catch (error) {
      this.aborted = options.signal?.aborted ?? false;
      throw error;
    }
  }
}

describe('AI features (M1-079)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let configured: AiConfigured | null = null;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const secret = `payroll-${randomBytes(5).toString('hex')}`;
  const hiddenSecret = `merger-${randomBytes(5).toString('hex')}`;
  let ticketKey = '';
  let ticketId = 0;
  const comments: number[] = [];
  let outcomeKey = '';
  let subticketKey = '';
  const typeIds: Record<string, number> = {};
  const priorityIds: Record<string, number> = {};

  const as = (who: Person, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who].cookie },
    });
  const post = (who: Person, url: string, payload: unknown) =>
    as(who, { method: 'POST', url, payload: payload as Record<string, unknown> });
  const ticketCount = async () =>
    Number(
      (
        await database.db
          .selectFrom('ticket')
          .select((eb) => eb.fn.countAll().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );

  beforeAll(async () => {
    const embedder = sharedLocalEmbedder();
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      embedder,
      vectorSearch: 'exact',
      ai: { source: async () => configured, gateway: { retry: { maxRetries: 0 } } },
    });
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name: `${name[0]?.toUpperCase()}${name.slice(1)} Tester`,
          password_hash: hash,
          is_site_admin: name === 'admin',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      users[name] = { id: row.id, cookie: sessionCookie(res.headers['set-cookie']) };
    }
    const roles = await database.db.selectFrom('role').select(['id', 'name']).execute();
    const roleId = (name: string) => roles.find((r) => r.name === name)?.id as number;
    // AIF: Alice and Bob are members. HID: only the administrator.
    for (const key of ['AIF', 'HID']) {
      const track = await post('admin', '/api/v1/tracks', {
        key,
        name: `${key} track`,
        mode: 'shared',
      });
      expect(track.statusCode, track.body).toBe(201);
      if (key === 'AIF') {
        await database.db
          .insertInto('track_role_actor')
          .values(
            (['alice', 'bob'] as const).map((who) => ({
              workspace_id: 1,
              track_id: track.json().track.id,
              role_id: roleId('Members'),
              user_id: users[who].id,
            })),
          )
          .execute();
      }
    }
    const types = (
      await as('admin', { method: 'GET', url: '/api/v1/tracks/AIF/ticket-types' })
    ).json().ticketTypes as { id: number; name: string }[];
    for (const t of types) typeIds[t.name] = t.id;
    const priorities = (await as('admin', { method: 'GET', url: '/api/v1/priorities' })).json()
      .priorities as { id: number; name: string }[];
    for (const p of priorities) priorityIds[p.name] = p.id;
    // A group only Alice is in, for a restricted comment.
    const group = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'inner-circle' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('group_member')
      .values({ workspace_id: 1, group_id: group.id, user_id: users.alice.id })
      .execute();

    const created = await post('alice', '/api/v1/tickets?format=markdown', {
      track: 'AIF',
      summary: 'Checkout fails with an expired card',
      description: 'Paying with an expired card shows a blank page instead of an error.',
    });
    expect(created.statusCode, created.body).toBe(201);
    ticketKey = created.json().ticket.key;
    ticketId = created.json().ticket.id;
    const say = async (who: Person, text: string, visibility?: { groupId: number }) => {
      const res = await post(who, `/api/v1/tickets/${ticketKey}/comments`, {
        body: doc(text),
        ...(visibility ? { visibility } : {}),
      });
      expect(res.statusCode, res.body).toBe(201);
      comments.push(res.json().comment.id);
    };
    await say('alice', 'I can reproduce it with any card that expired last month.');
    await say('alice', `Internal: this blocks the ${secret} release.`, { groupId: group.id });
    await say('bob', 'The fix belongs in the payment form validation; I will take it.');
    await post('alice', '/api/v1/tickets', { track: 'AIF', summary: 'Assign me' });
    const hidden = await post('admin', '/api/v1/tickets?format=markdown', {
      track: 'HID',
      summary: 'Checkout fails with an expired card during the merger',
      description: hiddenSecret,
    });
    expect(hidden.statusCode, hidden.body).toBe(201);
    const outcome = await post('alice', '/api/v1/tickets?format=markdown', {
      track: 'AIF',
      ticketTypeId: typeIds.Outcome,
      summary: 'Customers can pay with saved cards',
      description: 'Store cards securely, let customers pick one at checkout, and remove them.',
    });
    expect(outcome.statusCode, outcome.body).toBe(201);
    outcomeKey = outcome.json().ticket.key;
    const sub = await post('alice', '/api/v1/tickets', {
      track: 'AIF',
      ticketTypeId: typeIds.Subticket,
      parent: ticketKey,
      summary: 'Write the validation message',
    });
    expect(sub.statusCode, sub.body).toBe(201);
    subticketKey = sub.json().ticket.key;
    const similar = await post('alice', '/api/v1/tickets?format=markdown', {
      track: 'AIF',
      summary: 'Expired card leaves checkout blank',
      description: 'A blank checkout page appears when the card on file has expired.',
    });
    expect(similar.statusCode).toBe(201);
    await post('alice', '/api/v1/tickets?format=markdown', {
      track: 'AIF',
      summary: 'Dark mode for the settings page',
      description: 'The settings page ignores the dark theme.',
    });
    await backfillEmbeddings(database.db, new EmbeddingService(database.db, embedder));
  }, 120_000);

  afterAll(async () => {
    // The cancelled request's keep-alive connection would hold the close.
    app?.server.closeAllConnections();
    await app?.close();
  });

  // ---------------------------------------------------------------------------------------

  it('[AI-013] streams a ticket summary citing only comments the reader may read', async () => {
    const [open, restricted, bobs] = comments as [number, number, number];
    const text = `Checkout shows a blank page for expired cards [c${open}]. It blocks a release [c${restricted}]. Bob takes the fix in the form validation [c${bobs}] [c999999].`;
    const adapter = new FakeAdapter([{ text }], { deltas: text.match(/\S+\s*/g) ?? [] });
    configured = { adapter };
    const res = await post('bob', `/api/v1/tickets/${ticketKey}/ai/summary`, {});
    configured = null;
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const list = events(res.body);
    expect(list.filter((e) => e.event === 'text').length).toBeGreaterThan(3);
    const done = list.at(-1);
    expect(done?.event).toBe('done');
    // Bob may not read the restricted comment: it is not in the prompt, nor cited.
    const sent = sentText(adapter);
    expect(sent).not.toContain(secret);
    expect(sent).not.toContain(`c${restricted}`);
    expect(sent).toContain(`c${open}`);
    expect(sent).toContain(`c${bobs}`);
    expect(adapter.requests[0]?.system).toBe(SUMMARY_SYSTEM.ticket);
    expect(done?.data.citations).toEqual([
      { commentId: open, author: 'Alice Tester' },
      { commentId: bobs, author: 'Bob Tester' },
    ]);
    expect(done?.data.text).not.toContain(`[c${restricted}]`);
    expect(done?.data.text).not.toContain('[c999999]');
    // Every comment fenced as data, ticket too.
    expect(sent.match(/<comment id=/g)?.length).toBe(2);
    expect(sent).toContain('<ticket key=');
  });

  it('[AI-013] the reader who may read the restricted comment gets it in the prompt; a thread summary has its own instructions', async () => {
    const adapter = new FakeAdapter([{ text: 'They agreed on a fix.' }]);
    configured = { adapter };
    const res = await post('alice', `/api/v1/tickets/${ticketKey}/ai/summary`, {
      scope: 'thread',
    });
    configured = null;
    expect(res.statusCode, res.body).toBe(200);
    expect(adapter.requests[0]?.system).toBe(SUMMARY_SYSTEM.thread);
    expect(sentText(adapter)).toContain(secret);
  });

  it('[AI-013] a ticket with 200 comments is summarised with references to specific comments', async () => {
    const rows = await database.db
      .insertInto('ticket_comment')
      .values(
        Array.from({ length: 200 }, (_, i) => ({
          workspace_id: 1,
          ticket_id: ticketId,
          author_id: users.bob.id,
          body: JSON.stringify(doc(`Status note ${i + 1}: still investigating the card check.`)),
        })),
      )
      .returning('id')
      .execute();
    const last = rows.at(-1)?.id as number;
    const first = rows[0]?.id as number;
    const adapter = new FakeAdapter([
      { text: `Investigation started [c${first}] and is still going on [c${last}].` },
    ]);
    configured = { adapter };
    const res = await post('bob', `/api/v1/tickets/${ticketKey}/ai/summary`, {});
    configured = null;
    const done = events(res.body).at(-1);
    expect(done?.event).toBe('done');
    expect(done?.data.comments).toBe(202);
    expect(
      ((done?.data.citations ?? []) as { commentId: number }[]).map((c) => c.commentId),
    ).toEqual([first, last]);
    await database.db
      .deleteFrom('ticket_comment')
      .where(
        'id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();
  });

  it('[AI-007] cancelling the request stops the provider’s stream', async () => {
    const pieces = Array.from({ length: 3000 }, (_, i) => `word${i} `);
    const adapter = new LongStream([{ text: pieces.join('') }], { deltas: pieces });
    configured = { adapter };
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const port = (app.server.address() as AddressInfo).port;
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/tickets/${ticketKey}/ai/summary`, {
        method: 'POST',
        headers: { cookie: users.bob.cookie, 'content-type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
      const reader = res.body?.getReader();
      const first = await reader?.read();
      expect(new TextDecoder().decode(first?.value)).toContain('event: text');
      controller.abort();
      await expect.poll(() => adapter.aborted, { timeout: 10_000 }).toBe(true);
    } finally {
      configured = null;
    }
  });

  it('[NFR-011] with no provider the summary is refused before anything streams', async () => {
    const res = await post('bob', `/api/v1/tickets/${ticketKey}/ai/summary`, {});
    expect(res.statusCode).toBe(403);
    // A fresh workspace has AI switched off (no provider set up either).
    expect(res.json()).toEqual({ error: 'ai_unavailable', reason: 'disabled' });
  });

  it('[AI-013] a ticket the person cannot see is not found, and nothing is sent', async () => {
    const adapter = new FakeAdapter([{ text: 'x' }]);
    configured = { adapter };
    const hidden = await database.db
      .selectFrom('ticket')
      .select('id')
      .where('description', 'is not', null)
      .where('summary', 'like', '%merger%')
      .executeTakeFirstOrThrow();
    const res = await post('alice', `/api/v1/tickets/${hidden.id}/ai/summary`, {});
    configured = null;
    expect(res.statusCode).toBe(404);
    expect(adapter.requests).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------

  it('[AI-014] turns a question into a checked query with an explanation, with the person’s context', async () => {
    const adapter = new FakeAdapter([
      json({
        query:
          'assignee = currentUser() AND type = Bug AND stage != closed AND updated >= startOfWeek()',
        explanation: 'Your open bugs changed since Sunday.',
      }),
    ]);
    configured = { adapter, features: {} };
    const res = await post('alice', '/api/v1/ai/query', { text: 'my open bugs updated this week' });
    configured = null;
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      query:
        'assignee = currentUser() AND type = Bug AND stage != closed AND updated >= startOfWeek()',
      explanation: 'Your open bugs changed since Sunday.',
      valid: true,
      repaired: false,
    });
    const request = adapter.requests[0];
    expect(request?.system).toBe(QUERY_SYSTEM);
    expect(request?.jsonSchema).toBeDefined();
    const prompt = JSON.stringify(request?.messages);
    expect(prompt).toContain('AIF: AIF track');
    // Alice does not see HID: its key is not offered.
    expect(prompt).not.toContain('HID');
    expect(prompt).toContain('Alice Tester');
    expect(prompt).toContain('time zone UTC');
    expect(prompt).toContain('<question>\\nmy open bugs updated this week\\n</question>');
  });

  it('[AI-014] a query that does not parse gets one repair; one that still fails is returned with the problem, never run', async () => {
    const broken = new FakeAdapter([
      json({ query: 'assignee = = me', explanation: 'x' }),
      json({ query: 'status IN (', explanation: 'y' }),
    ]);
    configured = { adapter: broken };
    const res = await post('alice', '/api/v1/ai/query', { text: 'Meine offenen Fehler' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ valid: false, query: 'assignee = = me' });
    expect(res.json().problem.stage).toBe('parse');
    expect(broken.requests).toHaveLength(2);
    expect(JSON.stringify(broken.requests[1]?.messages)).toContain('That query is refused');

    const repaired = new FakeAdapter([
      json({ query: 'track = NOPE', explanation: 'x' }),
      json({ query: 'track = AIF AND stage != closed', explanation: 'AIFの未完了のチケット' }),
    ]);
    configured = { adapter: repaired };
    const ja = await post('alice', '/api/v1/ai/query', { text: 'AIFの未完了のチケット' });
    configured = null;
    expect(ja.json()).toEqual({
      query: 'track = AIF AND stage != closed',
      explanation: 'AIFの未完了のチケット',
      valid: true,
      repaired: true,
    });
    expect(JSON.stringify(repaired.requests[0]?.messages)).toContain('AIFの未完了のチケット');
  });

  // ---------------------------------------------------------------------------------------

  it('[AI-015] drafts tickets from pasted text as proposals: names mapped, unknown ones dropped, nothing created', async () => {
    const before = await ticketCount();
    const adapter = new FakeAdapter([
      json({
        drafts: [
          {
            summary: 'Refund button does nothing on Safari',
            description:
              'Clicking Refund on Safari 18 does nothing. ![x](https://evil.example/c?d=1)',
            type: 'bug',
            priority: 'High',
            labels: ['made-up-label'],
          },
          {
            summary: 'Add refund reasons',
            description: 'Ask why.',
            type: 'Nonsense',
            priority: '',
            labels: [],
          },
        ],
      }),
    ]);
    configured = { adapter };
    const res = await post('alice', '/api/v1/ai/drafts', {
      track: 'AIF',
      text: 'From support: refunds broken on Safari. Also we should ask for a reason.',
    });
    configured = null;
    expect(res.statusCode, res.body).toBe(200);
    const drafts = res.json().drafts;
    expect(drafts).toHaveLength(2);
    expect(drafts[0].ticketType).toEqual({ id: typeIds.Bug, name: 'Bug' });
    expect(drafts[0].priority).toEqual({ id: priorityIds.High, name: 'High' });
    expect(drafts[0].labels).toEqual([]);
    expect(drafts[0].description).not.toContain('evil.example');
    expect(drafts[1].ticketType).toBeNull();
    expect(sentText(adapter)).toContain('<pasted>');
    expect(await ticketCount()).toBe(before);
  });

  it('[AI-015] breaks an Outcome into children of the level below; nothing is created', async () => {
    const before = await ticketCount();
    const adapter = new FakeAdapter([
      json({
        children: [
          { summary: 'Store cards securely', description: 'Use the vault.', type: 'Feature' },
          { summary: 'Pick a saved card', description: 'At checkout.', type: 'Subticket' },
        ],
      }),
    ]);
    configured = { adapter };
    const res = await post('alice', `/api/v1/tickets/${outcomeKey}/ai/breakdown`, {});
    configured = null;
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.childTypes.map((t: { name: string }) => t.name).sort()).toEqual([
      'Bug',
      'Chore',
      'Feature',
    ]);
    expect(body.children.map((c: { ticketType: { name: string } }) => c.ticketType.name)).toEqual([
      'Feature',
      // A type that may not sit under an Outcome becomes the first one that may.
      body.childTypes[0].name,
    ]);
    expect(await ticketCount()).toBe(before);

    const none = await post('alice', `/api/v1/tickets/${subticketKey}/ai/breakdown`, {});
    expect(none.statusCode).toBe(409);
    expect(none.json()).toEqual({ error: 'no_child_types' });
  });

  // ---------------------------------------------------------------------------------------

  it('[AI-016] with no AI key, duplicate candidates come from embeddings alone', async () => {
    const res = await post('alice', '/api/v1/tickets/similar', {
      text: 'Checkout page is blank when the card expired',
      track: 'AIF',
      reasons: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().reranked).toBe(false);
    const keys = res.json().similar.map((h: { ticket: { key: string } }) => h.ticket.key);
    expect(keys).toContain(ticketKey);
    // The hidden track's near twin never shows.
    expect(JSON.stringify(res.json())).not.toContain('merger');
  });

  it('[AI-016] with a model, the candidates are re-ranked with reasons', async () => {
    const plain = await post('alice', '/api/v1/tickets/similar', {
      text: 'Checkout page is blank when the card expired',
      track: 'AIF',
    });
    const order = plain.json().similar.map((h: { ticket: { key: string } }) => h.ticket.key);
    const reversed = [...order].reverse();
    const adapter = new FakeAdapter([
      json({
        ranked: reversed.map((key: string, i: number) => ({
          key,
          likely: i === 0,
          reason: i === 0 ? 'Same blank page with an expired card.' : 'Different problem.',
        })),
      }),
    ]);
    configured = { adapter };
    const res = await post('alice', '/api/v1/tickets/similar', {
      text: 'Checkout page is blank when the card expired',
      track: 'AIF',
      reasons: true,
    });
    configured = null;
    expect(res.json().reranked).toBe(true);
    const hits = res.json().similar as {
      ticket: { key: string };
      reason?: string;
      likely?: boolean;
    }[];
    expect(hits.slice(0, reversed.length).map((h) => h.ticket.key)).toEqual(reversed.slice(0, 8));
    expect(hits[0]?.reason).toBe('Same blank page with an expired card.');
    expect(hits[0]?.likely).toBe(true);
    expect(sentText(adapter)).not.toContain('merger');
  });

  it('[AI-016] a slow model does not hold suggestions past 2 seconds: embeddings alone', async () => {
    configured = { adapter: new SlowAdapter(5_000, [json({ ranked: [] })]) };
    const started = performance.now();
    const res = await post('alice', '/api/v1/tickets/similar', {
      text: 'Checkout page is blank when the card expired',
      track: 'AIF',
      reasons: true,
    });
    const took = performance.now() - started;
    configured = null;
    expect(res.statusCode).toBe(200);
    expect(res.json().reranked).toBe(false);
    expect(res.json().similar.length).toBeGreaterThan(0);
    expectWithinBudget(took, 2_000, 'duplicate suggestions with a slow model');
  });
});
