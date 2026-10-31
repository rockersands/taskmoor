import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { parseTextSearch, QUERY_CASES, QueryError } from '@taskmoor/query';
import { fc } from '@taskmoor/testkit/property';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { FieldCatalogs } from '../fields/catalog';
import { rankedWarning } from '../routes/search';
import { SearchError } from './bind';
import { queryCatalogue } from './catalogue';
import { RANKED_CAP } from './compile';
import { prepareSearch } from './run';
import { textQuery } from './text';

// Made for this run: no password is written in the repository.
const PASSWORD = `text-${randomBytes(18).toString('base64url')}`;
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

type Inline = string | { text: string; bold: true };
/** A rich-text document of paragraphs; a paragraph of several pieces splits text by marks. */
const doc = (...paragraphs: (Inline | Inline[])[]) => ({
  type: 'doc',
  content: paragraphs.map((p) => ({
    type: 'paragraph',
    content: (Array.isArray(p) ? p : [p]).map((x) =>
      typeof x === 'string'
        ? { type: 'text', text: x }
        : { type: 'text', text: x.text, marks: [{ type: 'bold' }] },
    ),
  })),
});

/**
 * Full-text search through `/api/v1/search` (M1-040; QRY-007, QRY-009): every form of the
 * search syntax (spec 01b section 1.8) on every text a ticket has, written by the API's own
 * mutations; the three acceptance criteria of QRY-007; comments only where the viewer reads
 * them; relevance; and every text case of the conformance suite run on the server.
 */
describe('full-text search through the search API (M1-040)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const fields: Record<string, number> = {};
  const tickets: Record<string, { id: number; key: string }> = {};
  let developers = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const T = (name: string) => tickets[name] as { id: number; key: string };
  const K = (...names: string[]) => names.map((n) => T(n).key).sort();

  async function ticket(name: string, summary: string, extra: Record<string, unknown> = {}) {
    const res = await as('alice', {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'TXT', summary, ...extra },
    });
    expect(res.statusCode, res.body).toBe(201);
    tickets[name] = res.json().ticket as { id: number; key: string };
  }
  async function edit(name: string, payload: Record<string, unknown>) {
    const res = await as('alice', {
      method: 'PATCH',
      url: `/api/v1/tickets/${T(name).id}`,
      payload,
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  async function comment(name: string, body: unknown, visibility?: { groupId: number }) {
    const res = await as('alice', {
      method: 'POST',
      url: `/api/v1/tickets/${T(name).id}/comments`,
      payload: { body, ...(visibility ? { visibility } : {}) },
    });
    expect(res.statusCode, res.body).toBe(201);
  }
  const search = async (q: string, who = 'alice', extra = '') => {
    const res = await as(who, {
      method: 'GET',
      url: `/api/v1/search?q=${encodeURIComponent(q)}&limit=200${extra}`,
    });
    return { status: res.statusCode, body: res.json() };
  };
  /** The keys a query finds among this file's tickets, sorted. */
  const found = async (q: string, who = 'alice') => {
    const { status, body } = await search(`track = TXT AND (${q})`, who);
    expect(status, `${q}: ${JSON.stringify(body)}`).toBe(200);
    return (body.tickets as { key: string }[]).map((t) => t.key).sort();
  };
  /** The keys in the order a query returns them. */
  const ordered = async (q: string) => {
    const { status, body } = await search(q);
    expect(status, `${q}: ${JSON.stringify(body)}`).toBe(200);
    return (body.tickets as { key: string }[]).map((t) => t.key);
  };
  const refused = async (q: string) => {
    const { status, body } = await search(q);
    expect(status, q).toBe(400);
    return JSON.stringify(body);
  };

  beforeAll(async () => {
    const db = database.db;
    app = await buildApp({ db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
    ] as const) {
      const row = await db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: admin,
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
    developers = (
      await db
        .insertInto('user_group')
        .values({ workspace_id: 1, name: 'developers' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('group_member')
      .values({ workspace_id: 1, group_id: developers, user_id: users.alice?.id as number })
      .execute();
    const members = (
      await db
        .selectFrom('role')
        .select('id')
        .where('name', '=', 'Members')
        .executeTakeFirstOrThrow()
    ).id;
    const res = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'TXT', name: 'Track TXT', mode: 'shared' },
    });
    expect(res.statusCode, res.body).toBe(201);
    for (const who of ['alice', 'bob']) {
      await db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: res.json().track.id as number,
          role_id: members,
          user_id: users[who]?.id as number,
        })
        .execute();
    }
    // The conformance suite's custom fields, under its ids (cf[10016] and on).
    const field = async (id: number, payload: Record<string, unknown>) => {
      await sql`SELECT setval('field_id_seq', ${id - 1})`.execute(db);
      const created = await as('admin', { method: 'POST', url: '/api/v1/fields', payload });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().field.id).toBe(id);
      fields[payload.name as string] = id;
    };
    await field(10024, { name: 'Notes', type: 'text' });
    await field(10025, { name: 'Tags', type: 'labels' });

    await ticket('comment', 'Quarterly numbers', {
      description: doc('Nothing about signing in here.'),
    });
    await comment('comment', doc('The login page timed out for me.'));
    await ticket('phrase', 'Login failed after upgrade');
    await ticket('apart', 'Failed upgrade, then login worked');
    await ticket('stems', 'Logging in breaks', { description: doc('The logs show nothing') });
    await ticket('split', 'Split by marks', {
      description: doc(['Fre', { text: 'ezes', bold: true }, ' on save'], 'Second paragraph'),
    });
    await ticket('code', 'NullPointerException in the C++ parser');
    await ticket('notes', 'Has notes');
    await edit('notes', { fields: { [String(fields.Notes)]: 'deployment draftboard ready' } });
    await ticket('env', 'Runs only on staging', { environment: doc('Firefox on Linux') });
    await ticket('hidden', 'Quiet ticket');
    await comment('hidden', doc('Secret rollback plan'), { groupId: developers });
    await ticket('typo', 'Pasword reset loop');
    await ticket('accents', 'Café menu crashes');
  });
  afterAll(async () => {
    await app.close();
  });

  it('[QRY-007] text ~ "login" finds a ticket whose only match is in a comment', async () => {
    expect(await found('text ~ "login"')).toEqual(K('comment', 'phrase', 'apart'));
    expect(await found('comment ~ login')).toEqual(K('comment'));
    // The summary and description of that ticket do not hold the word.
    expect(await found('summary ~ login OR description ~ login')).not.toContain(T('comment').key);
  });

  it('[QRY-007] a phrase matches only adjacent words, in order', async () => {
    expect(await found('summary ~ "\\"login failed\\""')).toEqual(K('phrase'));
    // The same words apart, or in another order, match as words but not as the phrase.
    expect(await found('summary ~ "login failed"')).toEqual(K('phrase', 'apart'));
    expect(await found('summary ~ "\\"failed login\\""')).toEqual([]);
    expect(await found('text ~ "\\"login failed\\""')).toEqual(K('phrase'));
  });

  it('[QRY-007] finds a ticket by text within 1 s of its being saved', async () => {
    const started = performance.now();
    await ticket('fresh', 'Brandnewword appears', { description: doc('Zygomorphic petals') });
    expect(await found('summary ~ brandnewword')).toEqual(K('fresh'));
    expect(await found('description ~ zygomorphic')).toEqual(K('fresh'));
    await edit('fresh', { description: doc('Quixotic plan') });
    expect(await found('text ~ quixotic')).toEqual(K('fresh'));
    expect(await found('text ~ zygomorphic')).toEqual([]);
    await comment('fresh', doc('Xylophone attached'));
    expect(await found('text ~ xylophone')).toEqual(K('fresh'));
    // Each write and the search after it, together.
    expect(performance.now() - started).toBeLessThan(1_000 * 3);
    const one = performance.now();
    await edit('fresh', { summary: 'Brandnewword reworded vividly' });
    expect(await found('summary ~ vividly')).toEqual(K('fresh'));
    expect(performance.now() - one).toBeLessThan(1_000);
  });

  it('[QRY-007] matches words in any order and case, by their stems, and documents split by marks', async () => {
    expect(await found('summary ~ "upgrade LOGIN"')).toEqual(K('phrase', 'apart'));
    // English stemming: "logging" and "logs" are forms of "log".
    expect(await found('summary ~ logged')).toEqual(K('stems'));
    expect(await found('description ~ log')).toEqual(K('stems'));
    // A word split by a bold mark is one word; paragraphs do not run into each other.
    expect(await found('description ~ freezes')).toEqual(K('split'));
    expect(await found('description ~ "\\"save second\\""')).toEqual(K('split'));
    expect(await found('description ~ savesecond')).toEqual([]);
    expect(await found('environment ~ linux')).toEqual(K('env'));
    expect(await found('Notes ~ deployment')).toEqual(K('notes'));
    expect(await found('text ~ deployment')).toEqual(K('notes'));
  });

  it('[QRY-007] takes prefixes, ? wildcards, fuzzy words, exclusions and escapes', async () => {
    expect(await found('summary ~ "upgr*"')).toEqual(K('phrase', 'apart'));
    expect(await found('summary ~ "lo?in"')).toEqual(K('phrase', 'apart'));
    expect(await found('summary ~ "l?g?n"')).toEqual(K('phrase', 'apart'));
    expect(await found('summary ~ "caf?"')).toEqual(K('accents'));
    // One edit away: a missing letter, a swapped pair.
    expect(await found('summary ~ "password~"')).toEqual(K('typo'));
    expect(await found('summary ~ "lgoin~"')).toEqual(K('phrase', 'apart'));
    expect(await found('summary ~ "password"')).toEqual([]);
    expect(await found('summary ~ "login -upgrade"')).toEqual([]);
    expect(await found('summary ~ "login -\\"login failed\\""')).toEqual(K('apart'));
    // Reserved characters escaped are text: C++ reads as the word "c".
    expect(await found('summary ~ "C\\\\+\\\\+ parser"')).toEqual(K('code'));
  });

  it('[QRY-007] refuses a * inside or in front of a word on every text: searches match words', async () => {
    for (const q of [
      'summary ~ "*PointerExc*"',
      'summary ~ "Null*Exception"',
      'Notes ~ "*draft*"',
      'description ~ "*eeze"',
      'comment ~ "*ogin"',
      'text ~ "*ointerExc"',
      'summary WAS "*ogin"',
    ]) {
      expect(await refused(q), q).toContain('A * can only end a word');
    }
    // A trailing * still finds words that start with the term.
    expect(await found('summary ~ "NullPointer*"')).toEqual(K('code'));
  });

  it('[QRY-007] refuses searches the syntax cannot run, naming the field', async () => {
    expect(await refused('summary ~ "-login"')).toContain('cannot only exclude words');
    expect(await refused('summary ~ "+++"')).toContain('no words to look for');
    expect(await refused('summary ~ "a?b?c?d"')).toContain('at most 2 ? wildcards');
  });

  it('[QRY-007] !~ never matches an empty text, and NOT pushes down', async () => {
    const without = await found('description !~ login');
    expect(without).toContain(T('split').key);
    expect(without).not.toContain(T('phrase').key);
    expect(await found('NOT summary ~ login AND summary ~ upgrade')).toEqual([]);
    expect(await found('summary !~ login AND summary ~ "upgrade"')).toEqual([]);
  });

  it('[QRY-008] [QRY-007] searches comments only where the viewer reads them', async () => {
    expect(await found('comment ~ rollback', 'alice')).toEqual(K('hidden'));
    expect(await found('text ~ rollback', 'alice')).toEqual(K('hidden'));
    expect(await found('comment ~ rollback', 'bob')).toEqual([]);
    expect(await found('text ~ rollback', 'bob')).toEqual([]);
    expect(await found('text !~ rollback', 'bob')).toContain(T('hidden').key);
  });

  it('[QRY-007] [QRY-009] orders by relevance, best first, and pages through every match once', async () => {
    await ticket('r1', 'Relevance relevance relevance');
    await ticket('r2', 'Something else', {
      description: doc('Mentions relevance once in passing'),
    });
    await ticket('r3', 'Relevance in short');
    await comment('r2', doc('relevance again'));
    const best = await ordered('track = TXT AND text ~ relevance ORDER BY relevance');
    expect(best).toEqual([T('r1').key, T('r3').key, T('r2').key]);
    expect(await ordered('track = TXT AND text ~ relevance ORDER BY relevance DESC')).toEqual(
      [...best].reverse(),
    );
    // A comment search ranks by the best comment the viewer reads.
    expect(await ordered('track = TXT AND comment ~ relevance ORDER BY relevance')).toEqual([
      T('r2').key,
    ]);
    // Pages of one, cut by cursor, give each ticket once and in the same order.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await as('alice', {
        method: 'GET',
        url: `/api/v1/search?q=${encodeURIComponent('track = TXT AND text ~ relevance ORDER BY relevance, created DESC')}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      seen.push(...(res.json().tickets as { key: string }[]).map((t) => t.key));
      cursor = res.json().next;
    } while (cursor);
    expect(seen).toEqual(best);
    expect(await refused('track = TXT ORDER BY relevance')).toContain('needs a text search');
  });

  it('[QRY-007] ranks only the most recently updated matches by relevance, and says so', async () => {
    await ticket('c1', 'Capped capped capped');
    await ticket('c2', 'Capped twice capped');
    await ticket('c3', 'Capped once');
    // c1 ranks best but was updated first: with room for two, only c2 and c3 are ranked.
    await edit('c2', { fields: { [String(fields.Notes)]: 'touched' } });
    await edit('c3', { fields: { [String(fields.Notes)]: 'touched' } });
    const db = database.db;
    const catalog = await new FieldCatalogs(db).get(1);
    const catalogue = await queryCatalogue(db, 1, catalog, 'all');
    const page = async (rankedCap?: number) => {
      const { compiled } = await prepareSearch({
        db,
        workspaceId: 1,
        catalog,
        catalogue,
        filter: { sql: sql<boolean>`true`, tracks: 'all' },
        q: 'track = TXT AND summary ~ capped ORDER BY relevance',
        currentUserId: users.alice?.id as number,
        ...(rankedCap === undefined ? {} : { rankedCap }),
      });
      const rows = await compiled.page(51).execute(db);
      return { ids: rows.rows.map((r) => r.id), cap: compiled.rankedAmong };
    };
    const every = await page();
    expect(every.cap).toBe(RANKED_CAP);
    expect(every.ids[0]).toBe(T('c1').id);
    expect([...every.ids].sort()).toEqual([T('c1').id, T('c2').id, T('c3').id].sort());
    const two = await page(2);
    expect(two.cap).toBe(2);
    expect([...two.ids].sort()).toEqual([T('c2').id, T('c3').id].sort());
    // The route warns only when some matches were left unranked.
    expect(rankedWarning(RANKED_CAP, { count: 3, exact: true })).toEqual([]);
    expect(rankedWarning(2, { count: 3, exact: true })).toEqual([
      'Ordered by relevance among the 2 most recently updated matches',
    ]);
    expect(rankedWarning(RANKED_CAP, { count: 12_000, exact: false, approximate: true })).toEqual([
      'Ordered by relevance among the 10,000 most recently updated matches',
    ]);
    expect(rankedWarning(undefined, { count: 12_000, exact: false })).toEqual([]);
    const { body } = await search('track = TXT AND summary ~ capped ORDER BY relevance');
    expect(body.warnings).toBeUndefined();
  });

  it('[QRY-007] runs every text search the syntax reads without a database error', async () => {
    const db = database.db;
    const word = fc.stringMatching(/^[a-zA-Z0-9éß'.+\-*?~"\\:&|!()<> ]{1,14}$/u);
    await fc.assert(
      fc.asyncProperty(fc.array(word, { minLength: 1, maxLength: 4 }), async (words) => {
        let search: ReturnType<typeof parseTextSearch>;
        try {
          search = parseTextSearch(words.join(' '));
        } catch {
          return;
        }
        const q = textQuery(search);
        await sql`SELECT to_tsvector('taskmoor_search', 'probe') @@ to_tsquery('taskmoor_search', ${q.tsquery})`.execute(
          db,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('[QRY-007] runs every text case of the conformance suite on the server', async () => {
    const db = database.db;
    const catalog = await new FieldCatalogs(db).get(1);
    const catalogue = await queryCatalogue(db, 1, catalog, 'all');
    const text = QUERY_CASES.filter(
      (c) => c.kind === 'resolve' && c.expect.ok && c.section === 'text',
    );
    expect(text.length).toBeGreaterThan(70);
    const refusedCases: string[] = [];
    for (const c of text) {
      if (c.kind !== 'resolve') continue;
      try {
        const { compiled } = await prepareSearch({
          db,
          workspaceId: 1,
          catalog,
          catalogue,
          filter: { sql: sql<boolean>`true`, tracks: 'all' },
          q: c.text,
          currentUserId: users.alice?.id as number,
        });
        await compiled.page(51).execute(db);
        await compiled.count(1_001).execute(db);
      } catch (error) {
        if (!(error instanceof SearchError || error instanceof QueryError)) throw error;
        refusedCases.push(`${c.text}: ${error.message}`);
      }
    }
    expect(refusedCases).toEqual([]);
  });
});
