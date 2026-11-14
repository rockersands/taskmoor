import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';

// Made for this run: no password is written in the repository.
const PASSWORD = `plan-structure-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.92.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Skeleton {
  structure: { id: number | null; name: string | null; spec: unknown; version: number | null };
  broken: boolean;
  problems: { path: string; reason: string }[];
  generation: number;
  total: number;
  more: boolean;
  today: number;
  workingWeek: boolean[];
  fields: { ref: string; type: string }[];
  rows: {
    ticket: number[];
    key: string[];
    parent: number[];
    depth: number[];
    level: number[];
    track: number[];
    inPlan: boolean[];
    via: number[];
    closed: boolean[];
    notShown: number[];
    elsewhere: number[];
  };
  groups: { row: number; field: string; value: string | null; label: string | null }[];
  values: Record<string, (number | string | null)[]>;
}

interface Structure {
  id: number;
  name: string;
  version: number;
  broken: boolean;
  spec: { steps: Record<string, unknown>[]; columns: Record<string, unknown>[] };
}

/** Words, keys and a value only hidden tickets carry; no answer to a reader who may not see them names them. */
const SENTINEL_WORDS = ['Sentinel hidden child', 'Sentinel hidden parent', 'Sentinel hidden link'];
const SENTINEL_POINTS = 4242.5;

/**
 * The Grid of a plan (T-089a; PLN-010; ADR-122 stage 10). A plan over GRA and GRB, owned by the
 * site administrator and shared with everyone. Ana is a member of GRA and GRC (outside the plan),
 * Dee of GRA only, and Cy of none: GRB's sentinel tickets (a hidden child, a hidden parent and a
 * hidden linked ticket) are never theirs to see, and GRC's child of a GRA ticket is Ana's alone.
 *
 * Outcome O1 has A1 and A2; A1 has the hidden child and the outside child; A2 blocks the hidden
 * linked ticket and A3; A4's parent is the hidden parent.
 */
describe('plan structures and the Grid (PLN-010)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let slowApp: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const roles: Record<string, number> = {};
  type Ticket = { id: number; key: string };
  const t = {} as Record<
    | 'o1'
    | 'a1'
    | 'a2'
    | 'a3'
    | 'a4'
    | 'hiddenChild'
    | 'hiddenParent'
    | 'hiddenLink'
    | 'outside'
    | 'linked',
    Ticket
  >;
  let planId = 0;
  let privateId = 0;
  let feature = 0;
  let outcome = 0;
  let blocks = 0;
  let points = 0;
  let spare = 0;
  let multi = 0;

  const as = (who: string, options: InjectOptions, on = app) =>
    on.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const call = async (who: string, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body.slice(0, 600)}`).toBe(
      code,
    );
    return res.statusCode === 204 ? null : res.json();
  };
  const plan = (id = planId) => `/api/v1/plans/${id}`;
  const save = async (who: string, name: string, spec: unknown, id = planId) =>
    (
      await call(
        who,
        { method: 'POST', url: `${plan(id)}/structures`, payload: { name, spec } },
        201,
      )
    ).structure as Structure;
  const rows = async (who: string, sid: number | 'default', query = '', id = planId) =>
    (await call(who, {
      method: 'GET',
      url: `${plan(id)}/structures/${sid}/rows${query}`,
    })) as Skeleton;
  const ticket = async (
    track: string,
    summary: string,
    data: Record<string, unknown> = {},
    type = feature,
  ) =>
    (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tickets',
          payload: { track, summary, ticketTypeId: type, ...data },
        },
        201,
      )
    ).ticket as Ticket;
  const parent = (child: Ticket, of: Ticket) =>
    database.db
      .updateTable('ticket')
      .set({ parent_id: of.id })
      .where('id', '=', child.id)
      .execute();
  const link = (from: Ticket, to: Ticket) =>
    database.db
      .insertInto('ticket_link')
      .values({ workspace_id: 1, link_type_id: blocks, source_id: from.id, target_id: to.id })
      .execute();
  const eventsOf = async (type: string, since = 0) =>
    database.db
      .selectFrom('domain_event')
      .select(['id', 'type', 'subject_id', 'payload'])
      .where('type', '=', type)
      .where('id', '>', String(since) as never)
      .orderBy('id')
      .execute();
  const lastEventId = async () =>
    Number(
      (
        await database.db
          .selectFrom('domain_event')
          .select((eb) => eb.fn.max('id').as('id'))
          .executeTakeFirstOrThrow()
      ).id ?? 0,
    );
  const member = (who: string, track: string) =>
    database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: tracks[track] as number,
        role_id: roles.Members as number,
        user_id: users[who]?.id as number,
      })
      .execute();
  const trackPlan = async (name: string, keys: string[], shared = true) =>
    (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/plans',
          payload: {
            name,
            sources: keys.map((k) => ({ kind: 'track', trackId: tracks[k] })),
            ...(shared ? { shares: [{ scope: 'any_user' }] } : {}),
          },
        },
        201,
      )
    ).plan.id as number;
  /** The rows as `key` in preorder, a group row as `[label]`. */
  const keysOf = (s: Skeleton) =>
    s.rows.ticket.map((id, i) =>
      id === 0 ? `[${s.groups.find((g) => g.row === i)?.label ?? 'No value'}]` : s.rows.key[i],
    );
  const row = (s: Skeleton, x: Ticket) => s.rows.ticket.indexOf(x.id);
  /** Nothing a hidden ticket carries is in the answer: its id, key, words or value. */
  const noSentinels = (body: string, hidden: Ticket[]) => {
    for (const h of hidden) expect(body).not.toContain(`"${h.key}"`);
    const parsed = JSON.parse(body) as Partial<Skeleton> & { tickets?: Ticket[] };
    const ids = [...(parsed.rows?.ticket ?? []), ...(parsed.tickets ?? []).map((x) => x.id)];
    for (const h of hidden) expect(ids).not.toContain(h.id);
    for (const w of SENTINEL_WORDS) expect(body).not.toContain(w);
    expect(body).not.toContain(String(SENTINEL_POINTS));
    expect(body).not.toContain('GRB');
  };
  async function relay(): Promise<void> {
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'plan-structures-test');
    bus.attach(runner);
    for (let i = 0; i < 50; i++) {
      const relayed = await bus.relayOnce();
      const ran = await runner.runOnce();
      if (relayed === 0 && ran === 0) break;
    }
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    slowApp = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      queryTimeoutMs: 1,
    });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['ana', false],
      ['dee', false],
      ['cy', false],
      ['vi', false],
    ] as const) {
      const made = await database.db
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
      users[name] = { id: made.id, cookie: sessionCookie(res.headers['set-cookie']) };
    }
    for (const r of await database.db.selectFrom('role').select(['id', 'name']).execute()) {
      roles[r.name] = r.id;
    }
    const typeId = async (name: string) =>
      (
        await database.db
          .selectFrom('ticket_type')
          .select('id')
          .where('name', '=', name)
          .where('owner_track_id', 'is', null)
          .executeTakeFirstOrThrow()
      ).id;
    feature = await typeId('Feature');
    outcome = await typeId('Outcome');
    blocks = (
      await database.db
        .selectFrom('link_type')
        .select('id')
        .where('name', '=', 'Blocks')
        .executeTakeFirstOrThrow()
    ).id;
    for (const [key, name] of [
      ['GRA', 'Apps'],
      ['GRB', 'Billing'],
      ['GRC', 'Core'],
      ['GRS', 'Slow'],
    ] as const) {
      tracks[key] = (
        await call(
          'admin',
          { method: 'POST', url: '/api/v1/tracks', payload: { key, name, mode: 'shared' } },
          201,
        )
      ).track.id;
    }
    await member('ana', 'GRA');
    await member('ana', 'GRC');
    await member('dee', 'GRA');
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: tracks.GRA as number,
        role_id: roles.Viewers as number,
        user_id: users.vi?.id as number,
      })
      .execute();
    const field = async (payload: Record<string, unknown>) =>
      (await call('admin', { method: 'POST', url: '/api/v1/fields', payload }, 201)).field
        .id as number;
    points = await field({ name: 'Grid points', type: 'number' });
    spare = await field({ name: 'Grid spare', type: 'number' });
    multi = await field({
      name: 'Grid topics',
      type: 'select',
      multiple: true,
      context: { options: [{ value: 'One' }, { value: 'Two' }] },
    });
    const pts = (n: number) => ({ fields: { [points]: n } });
    t.o1 = await ticket('GRA', 'Outcome one', pts(1), outcome);
    t.a1 = await ticket('GRA', 'A one', pts(2));
    t.a2 = await ticket('GRA', 'A two', pts(3));
    t.a3 = await ticket('GRA', 'A three', pts(5));
    t.a4 = await ticket('GRA', 'A four', pts(8));
    t.hiddenChild = await ticket('GRB', SENTINEL_WORDS[0] as string, pts(SENTINEL_POINTS));
    t.hiddenParent = await ticket(
      'GRB',
      SENTINEL_WORDS[1] as string,
      pts(SENTINEL_POINTS),
      outcome,
    );
    t.hiddenLink = await ticket('GRB', SENTINEL_WORDS[2] as string, pts(SENTINEL_POINTS));
    t.outside = await ticket('GRC', 'Outside child', pts(13));
    t.linked = await ticket('GRC', 'Linked outside', pts(21));
    await parent(t.a1, t.o1);
    await parent(t.a2, t.o1);
    await parent(t.hiddenChild, t.a1);
    await parent(t.outside, t.a1);
    await parent(t.a4, t.hiddenParent);
    await link(t.a2, t.hiddenLink);
    await link(t.a2, t.a3);
    await link(t.a3, t.linked);
    planId = await trackPlan('Grid plan', ['GRA', 'GRB']);
    privateId = await trackPlan('Private', ['GRA'], false);
  }, 240_000);
  afterAll(async () => {
    await app.close();
    await slowApp.close();
  });

  it('[PLN-010] shows the default structure: the plan’s tickets and their children, unsaved', async () => {
    const s = await rows('admin', 'default');
    expect(s.structure).toMatchObject({ id: null, name: null, version: null });
    expect(s.structure.spec).toEqual({
      steps: [{ kind: 'insert' }, { kind: 'children' }],
      columns: [
        { kind: 'ticket', field: 'key' },
        { kind: 'ticket', field: 'summary' },
        { kind: 'ticket', field: 'status' },
        { kind: 'ticket', field: 'assignee' },
        { kind: 'total', fn: 'count' },
        { kind: 'total', fn: 'progress' },
      ],
    });
    // The administrator sees everything: the hidden parent is theirs, with A4 under it.
    expect(keysOf(s)).toEqual([
      t.o1.key,
      t.a1.key,
      t.hiddenChild.key,
      t.outside.key,
      t.a2.key,
      t.a3.key,
      t.hiddenParent.key,
      t.a4.key,
      t.hiddenLink.key,
    ]);
    expect(s.rows.parent[row(s, t.a4)]).toBe(row(s, t.hiddenParent));
    expect(s.rows.parent[row(s, t.a1)]).toBe(row(s, t.o1));
    expect(s.rows.inPlan[row(s, t.outside)]).toBe(false);
    expect(s.rows.via[row(s, t.outside)]).toBe(1);
    expect(s.rows.via[row(s, t.a1)]).toBe(0);
    expect(s.rows.notShown.every((n) => n === 0)).toBe(true);
    expect(s.total).toBe(9);
    expect(s.more).toBe(false);
    expect(s.broken).toBe(false);
    expect(s.workingWeek).toHaveLength(7);
    expect(Number.isInteger(s.today)).toBe(true);
    expect(s.fields).toEqual([]);
  });

  it('[PLN-010] [QRY-008] never names, keys, values or totals a hidden ticket; four readers, each counted', async () => {
    const withPoints = await save('admin', 'Sentinels', {
      steps: [
        { kind: 'insert' },
        { kind: 'children' },
        { kind: 'links', linkTypeId: blocks, direction: 'outward', depth: 1 },
      ],
      columns: [
        { kind: 'ticket', field: 'summary' },
        { kind: 'total', fn: 'sum', of: `cf[${points}]` },
        {
          kind: 'formula',
          name: 'Double',
          expression: '{Grid points} * 2',
          output: 'number',
          decimals: 0,
        },
      ],
    });
    const hidden = [t.hiddenChild, t.hiddenParent, t.hiddenLink];
    // Ana: the outside child is hers, not in the plan; the hidden child and link are counted.
    const ana = await as('ana', {
      method: 'GET',
      url: `${plan()}/structures/${withPoints.id}/rows`,
    });
    expect(ana.statusCode, ana.body).toBe(200);
    noSentinels(ana.body, hidden);
    const a = ana.json() as Skeleton;
    expect(keysOf(a)).toEqual([
      t.o1.key,
      t.a1.key,
      t.outside.key,
      t.a2.key,
      t.a3.key,
      t.linked.key,
      t.a4.key,
    ]);
    // A ticket outside the plan that a links step reaches is a row, marked so.
    expect(a.rows.via[row(a, t.linked)]).toBe(2);
    expect(a.rows.inPlan[row(a, t.linked)]).toBe(false);
    expect(a.rows.parent[row(a, t.linked)]).toBe(row(a, t.a3));
    // A hidden parent breaks the path: A4 is a top row.
    expect(a.rows.parent[row(a, t.a4)]).toBe(-1);
    expect(a.rows.inPlan[row(a, t.outside)]).toBe(false);
    expect(a.rows.notShown[row(a, t.a1)]).toBe(1);
    expect(a.rows.notShown[row(a, t.a2)]).toBe(1);
    // A3 is in the plan and placed first; A2's link to it is shown elsewhere.
    expect(a.rows.elsewhere[row(a, t.a2)]).toBe(1);
    expect(a.fields).toEqual([{ ref: `cf[${points}]`, type: 'number' }]);
    expect(a.values[`cf[${points}]`]).toEqual([1, 2, 13, 3, 5, 21, 8]);
    // Dee: the outside child is hidden from her too, so A1 counts two.
    const dee = await as('dee', {
      method: 'GET',
      url: `${plan()}/structures/${withPoints.id}/rows`,
    });
    noSentinels(dee.body, [...hidden, t.outside, t.linked]);
    const d = dee.json() as Skeleton;
    expect(keysOf(d)).toEqual([t.o1.key, t.a1.key, t.a2.key, t.a3.key, t.a4.key]);
    expect(d.rows.notShown[row(d, t.a1)]).toBe(2);
    expect(d.rows.notShown[row(d, t.a3)]).toBe(1);
    expect(dee.body).not.toContain('Outside child');
    // Cy sees the plan and none of its tickets: no rows, nothing named.
    const cy = await as('cy', {
      method: 'GET',
      url: `${plan()}/structures/${withPoints.id}/rows`,
    });
    noSentinels(cy.body, [...hidden, t.outside, t.linked, t.o1, t.a1, t.a2, t.a3, t.a4]);
    expect((cy.json() as Skeleton).total).toBe(0);
    // The administrator sees every one.
    const all = await rows('admin', withPoints.id);
    // GRB is in the plan: its tickets are inserted, so A2's two links are shown elsewhere.
    expect(all.rows.via[row(all, t.hiddenLink)]).toBe(0);
    expect(all.rows.elsewhere[row(all, t.a2)]).toBe(2);
    expect(all.rows.notShown.every((n) => n === 0)).toBe(true);
    // Grouped by track, the labels name only values on rows shown.
    const grouped = await save('admin', 'By track', {
      steps: [{ kind: 'insert' }, { kind: 'group', field: 'track' }, { kind: 'children' }],
      columns: [],
    });
    const g = await as('ana', { method: 'GET', url: `${plan()}/structures/${grouped.id}/rows` });
    noSentinels(g.body, hidden);
    expect((g.json() as Skeleton).groups.map((x) => x.label)).toEqual(['Apps']);
    // The rows in view: a hidden id is left out silently, the same as a missing one.
    const view = await call('ana', {
      method: 'POST',
      url: `${plan()}/grid/tickets`,
      payload: {
        ids: [t.a1.id, t.hiddenChild.id, t.outside.id, t.hiddenLink.id, 2_000_000_000],
        fields: ['summary', `cf[${points}]`],
      },
    });
    expect(view.tickets.map((x: Ticket) => x.key)).toEqual([t.a1.key, t.outside.key]);
    expect(view.tickets[0]).toMatchObject({ summary: 'A one', version: expect.any(Number) });
    noSentinels(JSON.stringify(view), hidden);
    const onlyHidden = await as('ana', {
      method: 'POST',
      url: `${plan()}/grid/tickets`,
      payload: { ids: [t.hiddenChild.id] },
    });
    const onlyMissing = await as('ana', {
      method: 'POST',
      url: `${plan()}/grid/tickets`,
      payload: { ids: [2_000_000_000] },
    });
    expect(onlyHidden.body).toBe(onlyMissing.body);
  });

  it('[PLN-010] saves, changes and deletes a structure with its version, and audits each', async () => {
    const since = await lastEventId();
    const made = await save('admin', '  Delivery  ', {
      // Stored in the order they apply, whatever order they come in.
      steps: [{ kind: 'children' }, { kind: 'insert', query: 'type = Feature' }],
      columns: [{ kind: 'ticket', field: 'summary' }],
    });
    expect(made).toMatchObject({ name: 'Delivery', version: 1, broken: false });
    expect(made.spec.steps).toEqual([
      { kind: 'insert', query: 'type = Feature' },
      { kind: 'children' },
    ]);
    const s = await rows('ana', made.id);
    expect(keysOf(s)).toEqual([t.a1.key, t.outside.key, t.a2.key, t.a3.key, t.a4.key]);
    const url = `${plan()}/structures/${made.id}`;
    const changed = (
      await call('admin', { method: 'PATCH', url, payload: { name: 'Shipping', version: 1 } })
    ).structure as Structure;
    expect(changed).toMatchObject({ name: 'Shipping', version: 2 });
    const stale = await as('admin', { method: 'PATCH', url, payload: { name: 'X', version: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'version_conflict', version: 2 });
    const staleDelete = await as('admin', { method: 'DELETE', url: `${url}?version=1` });
    expect(staleDelete.statusCode).toBe(409);
    const list = await call('ana', { method: 'GET', url: `${plan()}/structures` });
    expect(list).toMatchObject({
      editable: false,
      limits: { structures: 20, rows: 100_000, columns: 30, totals: 10, formulas: 5, ids: 500 },
    });
    expect(list.structures.map((x: Structure) => x.name)).toContain('Shipping');
    await call('admin', { method: 'DELETE', url: `${url}?version=2` }, 204);
    const gone = await as('admin', { method: 'GET', url: `${url}/rows` });
    expect(gone.statusCode).toBe(404);
    const payloads = async (type: string) =>
      (await eventsOf(type, since)).map((e) => [Number(e.subject_id), e.payload]);
    expect(await payloads('plan.structure_created')).toEqual([
      [planId, { structureId: made.id, name: 'Delivery' }],
    ]);
    expect(await payloads('plan.structure_changed')).toEqual([
      [planId, { structureId: made.id, name: 'Shipping' }],
    ]);
    expect(await payloads('plan.structure_deleted')).toEqual([
      [planId, { structureId: made.id, name: 'Shipping' }],
    ]);
    await relay();
    const audited = await database.db
      .selectFrom('audit_event')
      .select('action')
      .where('action', 'like', 'plan.structure_%')
      .execute();
    for (const type of [
      'plan.structure_created',
      'plan.structure_changed',
      'plan.structure_deleted',
    ]) {
      expect(audited.map((r) => r.action)).toContain(type);
    }
  });

  it('[PLN-010] refuses what the record says: limits, names, fields, formulas and queries', async () => {
    const small = await trackPlan('Small', ['GRA']);
    const base = `${plan(small)}/structures`;
    const ok = { steps: [{ kind: 'insert' }], columns: [] };
    const bad = async (spec: unknown, fields: Record<string, string>, name = 'Bad') => {
      const res = await as('admin', { method: 'POST', url: base, payload: { name, spec } });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_fields', fields });
      return res.json();
    };
    await bad(ok, { name: expect.any(String) }, '   ');
    await bad(ok, { name: expect.any(String) }, 'x'.repeat(101));
    await bad({ steps: [{ kind: 'children' }], columns: [] }, { 'spec.steps': 'one_insert' });
    await bad(
      { steps: [{ kind: 'insert' }, { kind: 'insert' }], columns: [] },
      { 'spec.steps': 'too_many_insert' },
    );
    await bad(
      {
        steps: [
          { kind: 'insert' },
          { kind: 'group', field: 'status' },
          { kind: 'group', field: 'track' },
          { kind: 'group', field: 'priority' },
        ],
        columns: [],
      },
      { 'spec.steps': 'too_many_group' },
    );
    await bad(
      {
        steps: [
          { kind: 'insert' },
          { kind: 'links', linkTypeId: blocks, direction: 'outward', depth: 4 },
        ],
        columns: [],
      },
      { 'spec.steps.1.depth': expect.any(String) },
    );
    await bad(
      { steps: [{ kind: 'insert', query: 'x'.repeat(2001) }], columns: [] },
      { 'spec.steps.0.query': expect.any(String) },
    );
    await bad(
      {
        steps: [{ kind: 'insert' }],
        columns: Array.from({ length: 31 }, () => ({ kind: 'total', fn: 'count' })),
      },
      { 'spec.columns': expect.any(String) },
    );
    await bad(
      {
        steps: [{ kind: 'insert' }],
        columns: Array.from({ length: 11 }, () => ({ kind: 'total', fn: 'count' })),
      },
      { 'spec.columns': 'too_many_totals' },
    );
    await bad(
      {
        steps: [{ kind: 'insert' }],
        columns: Array.from({ length: 6 }, (_, i) => ({
          kind: 'formula',
          name: `F${i}`,
          expression: '1',
          output: 'number',
          decimals: 0,
        })),
      },
      { 'spec.columns': 'too_many_formulas' },
    );
    // References checked against the workspace.
    await bad(
      { steps: [{ kind: 'insert' }, { kind: 'group', field: 'labels' }], columns: [] },
      { 'spec.steps.1.field': 'not_groupable' },
    );
    await bad(
      { steps: [{ kind: 'insert' }, { kind: 'group', field: `cf[${multi}]` }], columns: [] },
      { 'spec.steps.1.field': 'not_groupable' },
    );
    await bad(
      {
        steps: [
          { kind: 'insert' },
          { kind: 'links', linkTypeId: 2_000_000_000, direction: 'inward', depth: 1 },
        ],
        columns: [],
      },
      { 'spec.steps.1.linkTypeId': 'not_found' },
    );
    await bad(
      { steps: [{ kind: 'insert' }], columns: [{ kind: 'ticket', field: 'cf[2000000000]' }] },
      { 'spec.columns.0.field': 'unknown_field' },
    );
    await bad(
      { steps: [{ kind: 'insert' }], columns: [{ kind: 'total', fn: 'sum', of: 'due' }] },
      { 'spec.columns.0.of': 'not_summable' },
    );
    await bad(
      { steps: [{ kind: 'insert' }], columns: [{ kind: 'total', fn: 'count', of: 'due' }] },
      { 'spec.columns.0.of': 'not_allowed' },
    );
    // A formula that does not check answers what the formula check does.
    const formula = await bad(
      {
        steps: [{ kind: 'insert' }],
        columns: [
          {
            kind: 'formula',
            name: 'F',
            expression: '{Nowhere} + 1',
            output: 'number',
            decimals: 0,
          },
        ],
      },
      { 'spec.columns.0.expression': 'unknown_field' },
    );
    const check = await call('admin', {
      method: 'GET',
      url: `/api/v1/formulas/check?expression=${encodeURIComponent('{Nowhere} + 1')}&output=number`,
    });
    expect(formula.check).toEqual(check);
    // A query that does not compile.
    const query = await as('admin', {
      method: 'POST',
      url: base,
      payload: {
        name: 'Q',
        spec: { steps: [{ kind: 'insert', query: 'nonsense ===' }], columns: [] },
      },
    });
    expect(query.statusCode).toBe(400);
    expect(query.json()).toMatchObject({ error: 'invalid_query' });
    // Names unique in the plan ignoring case; at most 20 a plan.
    await call('admin', { method: 'POST', url: base, payload: { name: 'Mine', spec: ok } }, 201);
    const taken = await as('admin', {
      method: 'POST',
      url: base,
      payload: { name: 'MINE', spec: ok },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'name_taken' });
    for (let i = 2; i <= 20; i++) {
      await call('admin', { method: 'POST', url: base, payload: { name: `S${i}`, spec: ok } }, 201);
    }
    const full = await as('admin', {
      method: 'POST',
      url: base,
      payload: { name: 'S21', spec: ok },
    });
    expect(full.statusCode).toBe(409);
    expect(full.json()).toEqual({ error: 'too_many_structures', limit: 20 });
    // A formula stored by id: renaming its field never breaks it.
    const other = await trackPlan('Formulas', ['GRA']);
    const stored = await save(
      'admin',
      'By id',
      {
        steps: [{ kind: 'insert' }],
        columns: [
          {
            kind: 'formula',
            name: 'P',
            expression: '{grid points} + 1',
            output: 'number',
            decimals: 1,
          },
        ],
      },
      other,
    );
    expect(stored.spec.columns[0]).toMatchObject({ expression: `{cf[${points}]} + 1` });
  });

  it('[PLN-010] answers 403 edit_plan to readers and 404 word for word for what they may not reach', async () => {
    const mine = await save('admin', 'Editors only', { steps: [{ kind: 'insert' }], columns: [] });
    const url = `${plan()}/structures/${mine.id}`;
    for (const options of [
      {
        method: 'POST' as const,
        url: `${plan()}/structures`,
        payload: { name: 'Ana’s', spec: { steps: [{ kind: 'insert' }], columns: [] } },
      },
      { method: 'PATCH' as const, url, payload: { name: 'Ana’s', version: 1 } },
      { method: 'DELETE' as const, url: `${url}?version=1` },
    ]) {
      const res = await as('ana', options);
      expect(res.statusCode, options.method).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', permission: 'edit_plan' });
    }
    const nowhere = await as('ana', { method: 'GET', url: `${plan(2_000_000_000)}/structures` });
    expect(nowhere.statusCode).toBe(404);
    const privateOne = await save(
      'admin',
      'Private one',
      { steps: [{ kind: 'insert' }], columns: [] },
      privateId,
    );
    for (const path of [
      `${plan(privateId)}/structures`,
      `${plan(privateId)}/structures/default/rows`,
      `${plan(privateId)}/structures/${privateOne.id}/rows`,
    ]) {
      const res = await as('ana', { method: 'GET', url: path });
      expect(res.statusCode, path).toBe(404);
      expect(res.body).toBe(nowhere.body);
    }
    const privateTickets = await as('ana', {
      method: 'POST',
      url: `${plan(privateId)}/grid/tickets`,
      payload: { ids: [t.a1.id] },
    });
    expect(privateTickets.body).toBe(nowhere.body);
    // A structure of another plan, and one missing: the same 404, for writes too.
    for (const options of [
      { method: 'GET' as const, url: `${plan()}/structures/${privateOne.id}/rows` },
      { method: 'GET' as const, url: `${plan()}/structures/2000000000/rows` },
      {
        method: 'PATCH' as const,
        url: `${plan()}/structures/${privateOne.id}`,
        payload: { name: 'X', version: 1 },
      },
      { method: 'DELETE' as const, url: `${plan()}/structures/${privateOne.id}?version=1` },
    ]) {
      const res = await as('admin', options);
      expect(res.statusCode, options.url).toBe(404);
      expect(res.body).toBe(nowhere.body);
    }
    const tooMany = await as('ana', {
      method: 'POST',
      url: `${plan()}/grid/tickets`,
      payload: { ids: Array.from({ length: 501 }, (_, i) => i + 1) },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json()).toMatchObject({
      error: 'invalid_fields',
      fields: { ids: expect.any(String) },
    });
  });

  it('[PLN-010] a deleted field breaks its column and a query a reader cannot run breaks the structure, for them', async () => {
    const s = await save('admin', 'Fragile', {
      steps: [{ kind: 'insert' }, { kind: 'children' }],
      columns: [
        { kind: 'ticket', field: `cf[${spare}]` },
        { kind: 'total', fn: 'sum', of: `cf[${spare}]` },
        {
          kind: 'formula',
          name: 'S',
          expression: '{Grid spare} + 1',
          output: 'number',
          decimals: 0,
        },
        { kind: 'total', fn: 'count' },
      ],
    });
    await call('admin', { method: 'DELETE', url: `/api/v1/fields/${spare}` }, 204);
    const list = await call('admin', { method: 'GET', url: `${plan()}/structures` });
    expect(list.structures.find((x: Structure) => x.id === s.id)?.broken).toBe(true);
    const read = await rows('admin', s.id);
    expect(read.broken).toBe(true);
    expect(read.problems.map((p) => [p.path, p.reason])).toEqual([
      ['columns.0', 'field_deleted'],
      ['columns.1', 'field_deleted'],
      ['columns.2', 'formula'],
    ]);
    // The rest works.
    expect(read.total).toBe(9);
    // GRB's tickets cannot be searched by Ana: her structure is broken, the administrator’s not.
    const narrow = await save('admin', 'Billing only', {
      steps: [{ kind: 'insert', query: 'track = GRB' }],
      columns: [],
    });
    const forAna = await as('ana', {
      method: 'GET',
      url: `${plan()}/structures/${narrow.id}/rows`,
    });
    expect(forAna.statusCode).toBe(200);
    const a = forAna.json() as Skeleton;
    expect(a.broken).toBe(true);
    expect(a.problems).toMatchObject([{ path: 'steps.0.query', reason: 'invalid_query' }]);
    expect(a.total).toBe(0);
    const anaList = await call('ana', { method: 'GET', url: `${plan()}/structures` });
    expect(anaList.structures.find((x: Structure) => x.id === narrow.id)?.broken).toBe(true);
    const forAdmin = await rows('admin', narrow.id);
    expect(forAdmin.broken).toBe(false);
    expect(keysOf(forAdmin)).toEqual([t.hiddenChild.key, t.hiddenParent.key, t.hiddenLink.key]);
  });

  it('[PLN-010] inside a scenario shows live values; a scenario of another plan is refused', async () => {
    const scenario = (
      await call(
        'admin',
        { method: 'POST', url: `${plan()}/scenarios`, payload: { name: 'Later' } },
        201,
      )
    ).scenario.id as number;
    const live = await rows('ana', 'default');
    const inScenario = (await call('ana', {
      method: 'GET',
      url: `${plan()}/structures/default/rows?scenario=${scenario}`,
    })) as Skeleton & { scenario: { id: number }; live: boolean };
    expect(inScenario.scenario).toMatchObject({ id: scenario, name: 'Later' });
    expect(inScenario.live).toBe(true);
    expect(inScenario.rows).toEqual(live.rows);
    expect(inScenario.values).toEqual(live.values);
    const other = (
      await call(
        'admin',
        { method: 'POST', url: `${plan(privateId)}/scenarios`, payload: { name: 'Other' } },
        201,
      )
    ).scenario.id as number;
    const refused = await as('ana', {
      method: 'GET',
      url: `${plan()}/structures/default/rows?scenario=${other}`,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: 'invalid_fields', fields: { scenario: 'not_found' } });
    // The page's filters narrow the Add tickets step.
    const filtered = await rows('ana', 'default', `?type=Outcome`);
    expect(keysOf(filtered)).toEqual([t.o1.key, t.a1.key, t.outside.key, t.a2.key]);
  });

  it('[PLN-010] a copy of a plan copies its structures, as the copier’s', async () => {
    const before = await call('admin', { method: 'GET', url: `${plan()}/structures` });
    const copy = await call(
      'ana',
      { method: 'POST', url: `${plan()}/duplicate`, payload: { name: 'Ana’s copy' } },
      201,
    );
    const copied = await call('ana', { method: 'GET', url: `${plan(copy.plan.id)}/structures` });
    expect(copied.editable).toBe(true);
    expect(copied.structures.map((x: Structure) => [x.name, x.spec])).toEqual(
      before.structures.map((x: Structure) => [x.name, x.spec]),
    );
    const owners = await database.db
      .selectFrom('plan_structure')
      .select(['created_by', 'updated_by'])
      .where('plan_id', '=', copy.plan.id)
      .execute();
    expect(
      owners.every((o) => o.created_by === users.ana?.id && o.updated_by === users.ana?.id),
    ).toBe(true);
    // A deleted plan takes its structures.
    await call('ana', { method: 'DELETE', url: plan(copy.plan.id) }, 204);
    expect(
      await database.db
        .selectFrom('plan_structure')
        .select('id')
        .where('plan_id', '=', copy.plan.id)
        .execute(),
    ).toEqual([]);
  });

  it('[PLN-010] refuses a read that runs too long, never with part of an answer', async () => {
    const slow = await trackPlan('Slow', ['GRS']);
    const template = await ticket('GRS', 'Bulk');
    // 20,000 copies in one statement: every one matches, and the query has no index to use.
    const columns = (
      await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'ticket' AND table_schema = 'public'
           AND column_name NOT IN ('id', 'number', 'rank', 'search_vector')
           AND is_generated = 'NEVER'`.execute(database.db)
    ).rows.map((r) => r.column_name);
    const list = sql.join(columns.map((c) => sql.ref(c)));
    await sql`
      INSERT INTO ticket (number, rank, ${list})
      SELECT 1 + g, rank || lpad(g::text, 8, '0'), ${list}
        FROM ticket, generate_series(1, 20000) g
       WHERE id = ${template.id}`.execute(database.db);
    const s = await save(
      'admin',
      'Slow',
      {
        steps: [{ kind: 'insert', query: 'summary !~ nothingmatches' }, { kind: 'children' }],
        columns: [],
      },
      slow,
    );
    const res = await as(
      'admin',
      { method: 'GET', url: `${plan(slow)}/structures/${s.id}/rows` },
      slowApp,
    );
    expect(res.statusCode, res.body.slice(0, 300)).toBe(503);
    expect(res.json()).toEqual({
      error: 'query_timeout',
      message: expect.any(String),
      timeoutMs: 1,
    });
  }, 600_000);
  it('[PLN-010] moves a row through the ticket’s own change, with every check it makes', async () => {
    const version = async (x: Ticket) =>
      (await call('admin', { method: 'GET', url: `/api/v1/tickets/${x.key}` })).ticket
        .version as number;
    const move = (who: string, x: Ticket, parentRef: string | null, v: number) =>
      as(who, {
        method: 'PATCH',
        url: `/api/v1/tickets/${x.key}`,
        payload: { parent: parentRef, version: v },
      });
    // A Feature under a Feature: not a level up.
    const wrong = await move('admin', t.a3, t.a1.key, await version(t.a3));
    expect(wrong.statusCode, wrong.body).toBe(400);
    expect(wrong.json()).toMatchObject({
      error: 'invalid_fields',
      fields: { parent: 'wrong_level' },
    });
    // A reader of the track who may not edit it.
    const viewer = await move('vi', t.a3, t.o1.key, await version(t.a3));
    expect(viewer.statusCode, viewer.body).toBe(403);
    expect(viewer.json()).toMatchObject({ error: 'forbidden' });
    // A stale version.
    const stale = await move('admin', t.a3, t.o1.key, (await version(t.a3)) - 1 || 999);
    expect(stale.statusCode, stale.body).toBe(409);
    // A subticket lives in its parent's track, and must have one.
    const subType = (
      await database.db
        .selectFrom('ticket_type')
        .select('id')
        .where('name', '=', 'Subticket')
        .where('owner_track_id', 'is', null)
        .executeTakeFirstOrThrow()
    ).id;
    const sub = await ticket('GRA', 'A sub', { parent: t.a1.key }, subType);
    const elsewhere = await move('admin', sub, t.outside.key, await version(sub));
    expect(elsewhere.statusCode, elsewhere.body).toBe(400);
    expect(elsewhere.json()).toMatchObject({ fields: { parent: 'other_track' } });
    const orphan = await move('admin', sub, null, await version(sub));
    expect(orphan.statusCode, orphan.body).toBe(400);
    expect(orphan.json()).toMatchObject({ fields: { parent: 'required' } });
    // Allowed: A3 under the Outcome, and the Grid reads it there.
    const moved = await move('admin', t.a3, t.o1.key, await version(t.a3));
    expect(moved.statusCode, moved.body).toBe(200);
    const s = await rows('ana', 'default');
    expect(s.rows.parent[row(s, t.a3)]).toBe(row(s, t.o1));
  });
});
