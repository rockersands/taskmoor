import { randomBytes } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { makeCatalogue, parseQuery, resolveQuery } from '@taskmoor/query';
import { stableJson } from '@taskmoor/testkit';
import { fc } from '@taskmoor/testkit/property';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { FieldCatalogs } from '../fields/catalog';
import { pushNot } from './bind';
import { queryCatalogue } from './catalogue';
import { compileCond, findAnchor } from './compile';
import { prepareSearch } from './run';

const NOW = new Date('2026-10-28T12:00:00Z');
/** A viewer who browses tracks 1 to 3: the filter stands in for `ticketFilter().sql`. */
const FILTER = { sql: sql<boolean>`k.track_id = ANY(${[1, 2, 3]}::int[])`, tracks: [1, 2, 3] };

/** The SQL contract (ADR-010): these queries compile to the reviewed statements. */
export const GOLDEN_QUERIES = [
  '',
  'track = ABC ORDER BY created DESC',
  'track = ABC AND status = New ORDER BY updated DESC',
  'assignee = currentUser() AND stage != closed ORDER BY priority DESC, created DESC',
  'status IN (New, Active) AND priority IN (High, Urgent) ORDER BY created DESC',
  'labels IN (security, regression)',
  'summary ~ "login form" ORDER BY created DESC',
  'text ~ cookies',
  'description ~ freeze AND environment IS EMPTY',
  'created >= -30d AND type = Bug',
  'closed IS EMPTY AND updated < -90d ORDER BY updated ASC',
  'Points > 3 AND track = ABC ORDER BY Points DESC',
  'Team = Red AND stage = new ORDER BY created DESC',
  '"Review day" <= 2026-10-31 AND "Review day" >= 2026-10-01 ORDER BY "Review day" ASC',
  'due <= 2026-10-31 ORDER BY due ASC',
  'Reviewer = currentUser() ORDER BY updated DESC',
  'Tags IN (A, B) AND status != Closed ORDER BY created DESC',
  'Points IS EMPTY AND type IN (Bug, Feature) AND track = ABC ORDER BY created DESC',
  '(assignee = currentUser() OR reporter = currentUser()) AND stage != closed ORDER BY updated DESC',
  'NOT (labels IN (infra) OR type = Subticket) AND track IN (ABC, DEF) ORDER BY created DESC',
  'Tags != A AND Notes !~ draft',
  'Topics = alpha AND Squad = Support',
  'Deadline > "2026-10-01 09:30"',
  'parent IS EMPTY ORDER BY key ASC',
  'watcher = currentUser() AND votes > 2',
  'fixVersion > "1.0" OR affectedVersion IS EMPTY ORDER BY fixVersion DESC',
  'component = Backend ORDER BY Team ASC, Reviewer DESC',
  'ticketLinkType = Blocks AND attachments IS NOT EMPTY',
  'worklogComment ~ deploy OR timeEntryDate = 2026-10-01',
  'workRatio > 100 AND originalEstimate IS NOT EMPTY ORDER BY workRatio DESC',
  'hierarchyLevel = -1 AND trackType = software',
  'comment ~ "deploy notes" OR comment IS EMPTY',
  'priority > Normal AND track = ABC ORDER BY priority DESC, updated DESC',
  'track = ABC ORDER BY key ASC',
  'ORDER BY type ASC, summary DESC',
  // Functions (M1-038): ticket sets as semi-joins, the rest as ids.
  'key IN followedTickets() OR key IN votedTickets() ORDER BY updated DESC',
  'issue IN issueHistory() AND parent NOT IN watchedIssues()',
  'key IN linkedTickets(ABC-1, "is blocked by") ORDER BY key ASC',
  'key IN updatedBy(currentUser(), -1w, now())',
  'key IN (ABC-1, ticketsWithWebLinksByGlobalId("ci-1", "ci-2"))',
  'assignee IN membersOf(Support) AND track IN tracksOwnedByUser()',
  'type IN subticketTypes() AND created >= startOfWeek(-1w)',
  // History (M1-039): one EXISTS over ticket_change per clause.
  'status WAS "In Review" ORDER BY updated DESC',
  'status WAS NOT IN (New, Gone) BY currentUser() DURING ("2026-01-01", "2026-02-01")',
  'assignee WAS EMPTY AFTER -1w',
  'Points CHANGED FROM 3 TO 5 BY currentUser() ON 2026-01-15',
  'labels CHANGED TO security AND Tags WAS IN (A, B)',
  'ticketLink WAS ABC-1 OR ticketLinkType CHANGED FROM Blocks',
  'summary WAS login AND description CHANGED BEFORE 2026-10-01',
  'stage WAS closed AND creator WAS currentUser()',
  // Text search (M1-040): stored words, patterns on short text, the master field as one set,
  // relevance.
  'summary ~ "Exception*" AND text ~ "\\"login failed\\" log* -password"',
  'text ~ deploy AND Notes ~ "draft*" ORDER BY relevance',
  'comment ~ "release notes" ORDER BY priority DESC, relevance ASC',
] as const;

describe('query compiler (M1-037)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let db: Kysely<Database>;
  let catalogs: FieldCatalogs;
  let adminId = 0;

  const prepare = async (q: string, anchor = true, branches = true) => {
    const catalog = await catalogs.get(1);
    const catalogue = await queryCatalogue(db, 1, catalog, 'all');
    return prepareSearch({
      db,
      workspaceId: 1,
      catalog,
      catalogue,
      filter: FILTER,
      q,
      currentUserId: adminId,
      now: NOW,
      anchor,
      branches,
    });
  };

  beforeAll(async () => {
    db = database.db;
    app = await buildApp({ db, version: 'test', roles: ['api'] });
    catalogs = new FieldCatalogs(db);
    const password = randomBytes(18).toString('base64url');
    adminId = (
      await db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: 'admin@example.com',
          name: 'Admin',
          password_hash: await hashPassword(password),
          is_site_admin: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password },
      remoteAddress: '100.77.0.1',
    });
    const header = session.headers['set-cookie'];
    const cookie =
      [header]
        .flat()
        .find((c) => c?.startsWith(`${SESSION_COOKIE}=`))
        ?.split(';')[0] ?? '';
    const post = async (url: string, payload: Record<string, unknown>) => {
      const res = await app.inject({
        method: 'POST',
        url,
        payload,
        headers: { cookie },
        remoteAddress: '100.77.0.2',
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json();
    };
    for (const key of ['ABC', 'DEF']) {
      await post('/api/v1/tracks', { key, name: key, mode: 'shared' });
    }
    const opts = (values: string[]) => values.map((value) => ({ value }));
    await post('/api/v1/fields', { name: 'Review day', type: 'date' });
    await post('/api/v1/fields', { name: 'Deadline', type: 'datetime' });
    await post('/api/v1/fields', {
      name: 'Team',
      type: 'select',
      context: { options: opts(['Red', 'Green']) },
    });
    await post('/api/v1/fields', {
      name: 'Tags',
      type: 'select',
      multiple: true,
      context: { options: opts(['A', 'B', 'C']) },
    });
    await post('/api/v1/fields', { name: 'Reviewer', type: 'user' });
    await post('/api/v1/fields', { name: 'Notes', type: 'text' });
    await post('/api/v1/fields', { name: 'Topics', type: 'labels' });
    await post('/api/v1/fields', { name: 'Squad', type: 'group' });
    const abc = await db
      .selectFrom('track')
      .select('id')
      .where('key', '=', 'ABC')
      .executeTakeFirstOrThrow();
    await post(`/api/v1/tracks/${abc.id}/releases`, { name: '1.0' });
    await post(`/api/v1/tracks/${abc.id}/areas`, { name: 'Backend' });
    const support = await db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'Support' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('group_member')
      .values({ workspace_id: 1, group_id: support.id, user_id: adminId })
      .execute();
    await post('/api/v1/tickets', { track: 'ABC', summary: 'The first ticket' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('[QRY-010] compiles the golden set to the reviewed parameterised SQL', async () => {
    const out: Record<string, unknown> = {};
    for (const q of GOLDEN_QUERIES) {
      const { compiled } = await prepare(q);
      const page = compiled.page(51).compile(db);
      out[q === '' ? '(empty)' : q] = {
        anchored: compiled.anchored,
        sql: page.sql,
        parameters: page.parameters,
      };
    }
    await expect(stableJson(out)).toMatchFileSnapshot('./__golden__/compile.json');
  });

  it('[QRY-009] cuts the next page by keyset: a row comparison when it can, else expanded', async () => {
    const plain = await prepare('');
    const first = plain.compiled.page(51, { values: ['2026-10-01 10:00:00.123456+00'], id: 7 });
    expect(first.compile(db).sql).toContain('(k.created_at, k.id) < ($');
    const mixed = await prepare('ORDER BY priority DESC, created ASC', true, false);
    const next = mixed.compiled.page(51, { values: [-2, '2026-10-01 10:00:00+00'], id: 7 });
    const text = next.compile(db).sql;
    expect(text).toContain('IS NULL');
    expect(text).toContain('k.id > $');
    // Value branches: each priority continues by its own row comparison.
    const branched = await prepare('ORDER BY priority DESC, created ASC');
    expect(branched.compiled.branched).toBe(true);
    const merged = branched.compiled
      .page(51, { values: [-2, '2026-10-01 10:00:00+00'], id: 7 })
      .compile(db).sql;
    expect(merged).toContain('(k.created_at, k.id) > ($');
    expect(merged).toContain(' UNION ALL ');
    expect(merged).toContain('k.priority_id IS NULL');
    const anchored = await prepare('Team = Red');
    expect(anchored.compiled.anchored).toBe(true);
    expect(
      anchored.compiled.page(51, { values: ['2026-10-01 10:00:00+00'], id: 7 }).compile(db).sql,
    ).toContain('(a.created_at, a.ticket_id) < ($');
  });

  it('[QRY-008] puts the viewer filter in every statement, the anchored ones included', async () => {
    for (const q of GOLDEN_QUERIES) {
      const { compiled } = await prepare(q);
      expect(compiled.page(51).compile(db).sql, q).toContain('k.track_id = ANY($');
      expect(compiled.count(10_001).compile(db).sql, q).toContain('k.track_id = ANY($');
    }
    // An anchored walk also limits the side rows to the viewer's tracks, so the index does it.
    const { compiled } = await prepare('Team = Red');
    expect(compiled.page(51).compile(db).sql).toContain('a.track_id = ANY($');
  });

  it('[QRY-010] keeps every value out of the SQL text (10,000 fuzzed queries)', async () => {
    const catalog = await catalogs.get(1);
    const catalogue = await queryCatalogue(db, 1, catalog, 'all');
    const quote = (v: string) => `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`;
    const templates = [
      (v: string) => `summary ~ ${quote(v)}`,
      (v: string) => `labels = ${quote(v)} OR labels IN (${quote(v)}, x)`,
      (v: string) => `Notes ~ ${quote(v)} AND description !~ ${quote(v)}`,
      (v: string) => `Topics != ${quote(v)} ORDER BY Points DESC`,
      (v: string) => `text ~ ${quote(v)} AND worklogComment ~ ${quote(v)}`,
      (v: string) => `comment ~ ${quote(v)} OR comment !~ ${quote(v)}`,
      // Value branches repeat the conditions in every branch.
      (v: string) => `labels = ${quote(v)} ORDER BY priority DESC, key ASC`,
      // History values (M1-039): words, list items and items that moved.
      (v: string) => `summary WAS ${quote(v)} OR Notes CHANGED TO ${quote(v)}`,
      (v: string) => `labels WAS ${quote(v)} AND Topics CHANGED FROM ${quote(v)} BY currentUser()`,
    ];
    // Text searches (M1-040) read the value's syntax: `?` and fuzzy words probe the index word
    // by word, so the statement depends on its shape. Same shape, same statement: each letter or digit as `a`,
    // every other character but the syntax's own (space, quote, `*`, `?`, `~`, `-`, `\`) as `+`.
    const searches = new Set([0, 2, 4, 5, 7]);
    const shape = (v: string) =>
      [...v]
        .map((c) => (/[\p{L}\p{N}]/u.test(c) ? 'a' : /[\s"*?~\-\\]/u.test(c) ? c : '+'))
        .join('');
    const sqlOf = async (q: string) => {
      const { compiled } = await prepareSearch({
        db,
        workspaceId: 1,
        catalog,
        catalogue,
        filter: FILTER,
        q,
        currentUserId: adminId,
        now: NOW,
      });
      return compiled.page(51).compile(db);
    };
    const reference = new Map<number, string>();
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: templates.length - 1 }),
        fc.string({ unit: 'binary', minLength: 1, maxLength: 40 }),
        async (i, value) => {
          if (value.includes('\u0000')) return;
          const template = templates[i] as (v: string) => string;
          let out: Awaited<ReturnType<typeof sqlOf>>;
          try {
            resolveQuery(parseQuery(template(value)), catalogue, {
              currentUserId: adminId,
              now: NOW,
            });
            out = await sqlOf(template(value));
          } catch (error) {
            // A search with nothing to look for, or a * inside a word, is refused.
            if (!searches.has(i)) throw error;
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).name).toMatch(/QueryError|SearchError/);
            return;
          }
          if (searches.has(i)) {
            // The value never enters the statement's text: a value of the same shape and other
            // characters compiles to the same statement.
            expect(out.sql).toBe((await sqlOf(template(shape(value)))).sql);
            return;
          }
          // The statement's text does not depend on the value at all; the value is a parameter.
          const known = reference.get(i);
          if (known === undefined) reference.set(i, out.sql);
          else expect(out.sql).toBe(known);
          expect(out.parameters.flat()).toContain(value);
        },
      ),
      { numRuns: Number(process.env.SEARCH_FUZZ_RUNS ?? 10_000) },
    );
  });

  it('[QRY-007] keeps text searches a test of the row for a few known tickets (webhooks)', async () => {
    const q = 'text ~ cookies AND summary ~ "cokies~" AND Notes ~ "dr?ft" AND comment ~ "deplyo~"';
    const { bound, compiled } = await prepare(q);
    const ctx = { comments: sql<boolean>`true`, filter: FILTER.sql, workspaceId: 1 };
    const text = (rows: boolean) =>
      sql`SELECT 1 FROM ticket k WHERE ${compileCond(bound.where, { ...ctx, rows })}`.compile(db)
        .sql;
    // A search over the workspace reads sets of matches...
    expect(compiled.page(51).compile(db).sql).toMatch(/UNION ALL[\s\S]*ARRAY\(/);
    // ...a test of one ticket never does.
    expect(text(true)).not.toMatch(/UNION ALL|ARRAY\(|unnest\(/);
    expect(text(true)).toContain('k.summary_words @@');
  });

  it('[QRY-002] pushes NOT down to the clauses by turning their operators around', () => {
    const catalogue = makeCatalogue([], { ABC: 1 });
    const plan = resolveQuery(
      parseQuery('NOT (assignee = 1 OR (labels IN (a) AND NOT priority > High))'),
      catalogue,
      { currentUserId: 1, now: NOW },
    );
    const pushed = pushNot(plan.where as NonNullable<typeof plan.where>);
    expect(JSON.stringify(pushed)).not.toContain('"kind":"not"');
    expect(pushed).toMatchObject({
      kind: 'and',
      items: [
        { kind: 'compare', op: '!=' },
        {
          kind: 'or',
          items: [
            { kind: 'in', negated: true },
            { kind: 'compare', op: '>' },
          ],
        },
      ],
    });
  });

  it('[QRY-009] merges value branches only for a first key with few values, pruned by the query', async () => {
    const shape = async (q: string) => {
      const { compiled } = await prepare(q);
      const text = compiled.page(51).compile(db).sql;
      return { branched: compiled.branched, branches: text.split(' UNION ALL ').length };
    };
    const priorities = (await db.selectFrom('priority').select('id').execute()).length;
    // Every priority and the empty one; only those the query allows; one track.
    expect(await shape('ORDER BY priority DESC, updated DESC')).toEqual({
      branched: true,
      branches: priorities + 1,
    });
    expect(await shape('priority IN (High, Urgent) ORDER BY priority DESC, created ASC')).toEqual({
      branched: true,
      branches: 2,
    });
    expect(await shape('priority IS EMPTY ORDER BY priority DESC')).toEqual({
      branched: true,
      branches: 1,
    });
    expect(await shape('track = ABC ORDER BY key ASC')).toEqual({ branched: true, branches: 1 });
    // The viewer's tracks only: ABC and DEF (the filter names ids 1 to 3).
    expect(await shape('ORDER BY key ASC')).toEqual({ branched: true, branches: 2 });
    expect(await shape('ORDER BY status ASC, created DESC')).toMatchObject({ branched: true });
    // Not for other first keys, nor when a side table drives the page.
    expect(await shape('ORDER BY updated DESC, priority DESC')).toEqual({
      branched: false,
      branches: 1,
    });
    expect((await shape('Team = Red')).branched).toBe(false);
  });

  it('drives from a side table only when the order allows it', async () => {
    const anchored = async (q: string) => {
      const { bound } = await prepare(q);
      return findAnchor(bound) !== undefined;
    };
    expect(await anchored('Team = Red')).toBe(true);
    expect(await anchored('Points > 3 ORDER BY Points DESC')).toBe(true);
    expect(await anchored('Tags IN (A, B)')).toBe(true);
    // Not on a negation, a second order key, an order by another field, or an OR.
    expect(await anchored('Team != Red')).toBe(false);
    expect(await anchored('Team = Red ORDER BY created DESC, key ASC')).toBe(false);
    expect(await anchored('Team = Red ORDER BY updated DESC')).toBe(false);
    expect(await anchored('Points > 3 ORDER BY "Review day" DESC')).toBe(false);
    expect(await anchored('Team = Red OR Points > 3')).toBe(false);
  });
});
