import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { expectWithinBudget } from '@taskmoor/testkit/budget';
import { CSV_BOM } from '@taskmoor/webconfig';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { AUDITED_EVENTS } from '../audit/subscriber';
import { SESSION_COOKIE } from '../auth';
import { cellText, records } from '../import/csv';

// Made for this run: no password is written in the repository.
const PASSWORD = `plans-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.88.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Count {
  id: string;
  name: string | null;
  query: string;
  count: number;
}
interface Item {
  id: number;
  key: string;
  summary: string;
  parentId: number | null;
  start: string | null;
  due: string | null;
  dated: string | null;
  rollup: { start: string | null; due: string | null; total: number; closed: number } | null;
  trackId: number;
  assignee: { id: number; name: string } | null;
}

/**
 * Multi-track plans through the API (T-088; PLN-001, PLN-012; ADR-122). Three tracks: Ana is a
 * member of PLA and PLB, Bo a member of PLA and a viewer nowhere else, Cy a member of none; only
 * the administrator sees PLC. A plan gives no access: each viewer gets the tickets of the sources
 * they may see, as they may see them.
 */
describe('Multi-track plans (PLN-001, PLN-012)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const keys: Record<string, string> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const call = async (who: string, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body.slice(0, 400)}`).toBe(
      code,
    );
    return res.statusCode === 204 ? null : res.json();
  };
  const get = (who: string, url: string, code = 200) => call(who, { method: 'GET', url }, code);
  const make = (who: string, payload: Record<string, unknown>, code = 201) =>
    call(who, { method: 'POST', url: '/api/v1/plans', payload }, code);
  const patch = (who: string, id: number, payload: Record<string, unknown>, code = 200) =>
    call(who, { method: 'PATCH', url: `/api/v1/plans/${id}`, payload }, code);
  /** How many tickets a search finds, as that person. */
  const searchCount = async (who: string, q: string): Promise<number> =>
    (await call(who, { method: 'POST', url: '/api/v1/search', payload: { q, count: true } })).total
      .count;
  const ticket = async (track: string, data: Record<string, unknown> = {}) =>
    (
      await call(
        'admin',
        { method: 'POST', url: '/api/v1/tickets', payload: { track, summary: 'Work', ...data } },
        201,
      )
    ).ticket as { id: number; key: string };
  const typeId = async (name: string) =>
    (
      await database.db
        .selectFrom('ticket_type')
        .select('id')
        .where('name', '=', name)
        .where('owner_track_id', 'is', null)
        .executeTakeFirstOrThrow()
    ).id;
  const role = async (name: string) =>
    (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', name)
        .executeTakeFirstOrThrow()
    ).id;
  const join = async (who: string, track: string, roleName = 'Members') => {
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: tracks[track] as number,
        role_id: await role(roleName),
        user_id: users[who]?.id as number,
      })
      .execute();
  };
  const events = async (type: string) =>
    (
      await database.db
        .selectFrom('domain_event')
        .select(['payload', 'subject_id'])
        .where('type', '=', type)
        .orderBy('id')
        .execute()
    ).map((e) => ({ subject: e.subject_id, payload: e.payload }));

  let saved = 0;
  let mixed = 0;
  let outcome: { id: number; key: string };
  let feature: { id: number; key: string };

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['ana', false],
      ['bo', false],
      ['cy', false],
    ] as const) {
      const row = await database.db
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
    for (const [key, name] of [
      ['PLA', 'Apps'],
      ['PLB', 'Billing'],
      ['PLC', 'Core'],
    ] as const) {
      const made = await call(
        'admin',
        { method: 'POST', url: '/api/v1/tracks', payload: { key, name, mode: 'shared' } },
        201,
      );
      tracks[key] = made.track.id;
      keys[key] = key;
    }
    await join('ana', 'PLA');
    await join('ana', 'PLB');
    await join('bo', 'PLA');
    // Bo may see PLB's tickets but not reschedule them.
    await join('bo', 'PLB', 'Viewers');
    const outcomeType = await typeId('Outcome');
    const featureType = await typeId('Feature');
    outcome = await ticket('PLA', { summary: 'Launch', ticketTypeId: outcomeType });
    feature = await ticket('PLA', {
      summary: 'Site',
      ticketTypeId: featureType,
      parent: outcome.key,
      startDate: '2027-03-01',
      dueDate: '2027-03-10',
      assigneeId: users.ana?.id,
    });
    // A child in PLC: it rolls up only for those who may see it.
    await ticket('PLC', {
      summary: 'Core work',
      ticketTypeId: featureType,
      parent: outcome.key,
      startDate: '2027-02-01',
      dueDate: '2027-04-30',
    });
    await ticket('PLA', { summary: 'Overdue', dueDate: '2020-01-01', assigneeId: users.bo?.id });
    await ticket('PLA', { summary: 'Plain' });
    await ticket('PLB', { summary: 'Invoice', dueDate: '2027-03-05', assigneeId: users.ana?.id });
    await ticket('PLB', { summary: 'Refund' });
    await ticket('PLC', { summary: 'Hidden', dueDate: '2027-03-06' });
    // A saved search of Ana's, shared with everyone: PLB's tickets due in March 2027.
    saved = (
      await call(
        'ana',
        {
          method: 'POST',
          url: '/api/v1/saved-searches',
          payload: {
            name: 'Billing due',
            query: 'track = PLB AND due IS NOT EMPTY ORDER BY due',
            shares: [{ scope: 'any_user' }],
          },
        },
        201,
      )
    ).savedSearch.id;
    // The administrator's, over PLB and PLC: it does not read for anyone who cannot see PLC.
    mixed = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/saved-searches',
          payload: {
            name: 'Billing and core',
            query: 'track = PLB OR track = PLC',
            shares: [{ scope: 'any_user' }],
          },
        },
        201,
      )
    ).savedSearch.id;
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('[PLN-001] makes a plan over tracks and saved searches, lists it and records one event per change', async () => {
    const made = (
      await make('ana', {
        name: 'Spring launch',
        description: 'Apps and billing',
        sources: [
          { kind: 'track', trackId: tracks.PLA },
          { kind: 'savedSearch', savedSearchId: saved },
        ],
      })
    ).plan;
    expect(made).toMatchObject({
      name: 'Spring launch',
      description: 'Apps and billing',
      owner: { id: users.ana?.id, name: 'ana' },
      editable: true,
      hiddenSources: 0,
      shares: [],
      sources: [
        { kind: 'track', id: tracks.PLA, key: 'PLA', name: 'Apps', state: 'visible' },
        { kind: 'savedSearch', id: saved, name: 'Billing due', state: 'visible' },
      ],
      query: 'track IN ("PLA") OR (track = PLB AND due IS NOT EMPTY)',
      version: 1,
    });
    const listed = (await get('ana', '/api/v1/plans')).plans;
    expect(
      listed.map((p: { name: string; sourceCount: number }) => [p.name, p.sourceCount]),
    ).toEqual([['Spring launch', 2]]);
    // Private until shared: Bo neither lists nor reads it.
    expect((await get('bo', '/api/v1/plans')).plans).toEqual([]);
    await get('bo', `/api/v1/plans/${made.id}`, 404);
    const renamed = (await patch('ana', made.id, { name: 'Spring', version: 1 })).plan;
    expect(renamed.version).toBe(2);
    await patch('ana', made.id, { name: 'Late', version: 1 }, 409);
    await call('ana', { method: 'DELETE', url: `/api/v1/plans/${made.id}` }, 204);
    await get('ana', `/api/v1/plans/${made.id}`, 404);
    const created = await events('plan.created');
    expect(created.at(-1)?.payload).toEqual({
      name: 'Spring launch',
      sources: [`track:${tracks.PLA}`, `saved_search:${saved}`],
      shares: [],
    });
    expect((await events('plan.updated')).at(-1)?.payload).toEqual({
      changes: { name: { from: 'Spring launch', to: 'Spring' } },
    });
    expect((await events('plan.deleted')).at(-1)?.payload).toEqual({ name: 'Spring' });
  });

  it('[PLN-001] takes tracks and saved searches only, never boards, and only those the person may see', async () => {
    const shape = await make(
      'ana',
      { name: 'Boards', sources: [{ kind: 'board', boardId: 1 }] },
      400,
    );
    expect(shape.error).toBe('invalid_fields');
    const hidden = await make(
      'ana',
      {
        name: 'Core',
        sources: [
          { kind: 'track', trackId: tracks.PLC },
          { kind: 'track', trackId: 2_000_000 },
        ],
      },
      400,
    );
    // A track Ana may not see answers exactly as one that does not exist.
    expect(hidden.fields).toEqual({
      'sources.0.trackId': 'not_found',
      'sources.1.trackId': 'not_found',
    });
    const twice = await make(
      'ana',
      {
        name: 'Twice',
        sources: [
          { kind: 'track', trackId: tracks.PLA },
          { kind: 'track', trackId: tracks.PLA },
        ],
      },
      400,
    );
    expect(twice.fields).toEqual({ sources: 'duplicate' });
    // Plans are for signed-in people: never public.
    const open = await make('ana', { name: 'Open', shares: [{ scope: 'public' }] }, 400);
    expect(open.fields).toEqual({ 'shares.0.scope': 'not_shareable' });
  });

  it('[PLN-001] shows each viewer only what they may see; a hidden source adds nothing and is only counted', async () => {
    const plan = (
      await make('admin', {
        name: 'Everything',
        sources: [
          { kind: 'track', trackId: tracks.PLA },
          { kind: 'track', trackId: tracks.PLC },
          { kind: 'savedSearch', savedSearchId: saved },
        ],
        shares: [{ scope: 'any_user' }],
      })
    ).plan;
    const seenBy = async (who: string) => (await get(who, `/api/v1/plans/${plan.id}`)).plan;
    expect((await seenBy('admin')).hiddenSources).toBe(0);
    const bo = await seenBy('bo');
    expect(bo.hiddenSources).toBe(1);
    expect(bo.sources.map((s: { kind: string; id: number }) => `${s.kind}:${s.id}`)).toEqual([
      `track:${tracks.PLA}`,
      `savedSearch:${saved}`,
    ]);
    expect(bo.query).toBe('track IN ("PLA") OR (track = PLB AND due IS NOT EMPTY)');
    expect(bo.editable).toBe(false);
    const timeline = async (who: string) =>
      ((await get(who, `/api/v1/plans/${plan.id}/timeline`)).items as Item[]).map((i) => i.summary);
    expect((await timeline('admin')).sort()).toEqual(
      ['Core work', 'Hidden', 'Invoice', 'Launch', 'Overdue', 'Plain', 'Site'].sort(),
    );
    // Bo sees PLA's tickets and Invoice through Ana's saved search, never PLC's.
    expect((await timeline('bo')).sort()).toEqual([
      'Invoice',
      'Launch',
      'Overdue',
      'Plain',
      'Site',
    ]);
    const summary = await get('bo', `/api/v1/plans/${plan.id}/summary`);
    expect(summary.total.count).toBe(5);
    expect(summary.tracks.map((t: Count) => t.name)).toEqual(['PLA', 'PLB']);
    // Cy sees none of the tracks: the plan finds nothing for Cy, and runs nothing.
    const cy = await seenBy('cy');
    expect(cy.query).toBeNull();
    expect(cy.hiddenSources).toBe(2);
    expect((await get('cy', `/api/v1/plans/${plan.id}/timeline`)).items).toEqual([]);
    expect((await get('cy', `/api/v1/plans/${plan.id}/summary`)).total.count).toBe(0);
    expect(
      (await get('cy', `/api/v1/plans/${plan.id}/calendar?from=2027-03-01&to=2027-03-31`)).tickets,
    ).toEqual([]);
  });

  it('[PLN-001] leaves out and flags a saved search that does not run for the viewer, and the rest still shows', async () => {
    const plan = (
      await make('admin', {
        name: 'Mixed',
        sources: [
          { kind: 'track', trackId: tracks.PLA },
          { kind: 'savedSearch', savedSearchId: mixed },
        ],
        shares: [{ scope: 'any_user' }],
      })
    ).plan;
    // For the administrator it reads; for Ana, PLC is a key she cannot search.
    expect(plan.sources[1]).toMatchObject({ id: mixed, state: 'visible' });
    const ana = (await get('ana', `/api/v1/plans/${plan.id}`)).plan;
    expect(ana.sources[1]).toMatchObject({ id: mixed, state: 'broken' });
    expect(ana.query).toBe('track IN ("PLA")');
    const items = (await get('ana', `/api/v1/plans/${plan.id}/timeline`)).items as Item[];
    expect(items.map((i) => i.summary).sort()).toEqual(['Launch', 'Overdue', 'Plain', 'Site']);
    // A query an import could not translate is broken for everyone.
    await database.db
      .updateTable('saved_search')
      .set({ import_problem: 'unknown function' })
      .where('id', '=', mixed)
      .execute();
    const admin = (await get('admin', `/api/v1/plans/${plan.id}`)).plan;
    expect(admin.sources[1]).toMatchObject({ state: 'broken' });
    await database.db
      .updateTable('saved_search')
      .set({ import_problem: null })
      .where('id', '=', mixed)
      .execute();
  });

  it('[PLN-001] keeps the sources hidden from an editor when they change the others', async () => {
    const plan = (
      await make('admin', {
        name: 'Kept',
        sources: [
          { kind: 'track', trackId: tracks.PLC },
          { kind: 'track', trackId: tracks.PLA },
        ],
        shares: [{ scope: 'user', userId: users.ana?.id }],
      })
    ).plan;
    // Ana may not edit it; when the owner hands it over by sharing, the owner keeps the right.
    await patch('ana', plan.id, { sources: [] }, 403);
    await database.db
      .updateTable('plan')
      .set({ owner_id: users.ana?.id as number })
      .where('id', '=', plan.id)
      .execute();
    const changed = (
      await patch('ana', plan.id, { sources: [{ kind: 'track', trackId: tracks.PLB }] })
    ).plan;
    expect(changed.sources.map((s: { key: string }) => s.key)).toEqual(['PLB']);
    expect(changed.hiddenSources).toBe(1);
    // PLC is still there, after the sources Ana sees.
    const rows = await database.db
      .selectFrom('plan_source')
      .select(['track_id', 'position'])
      .where('plan_id', '=', plan.id)
      .orderBy('position')
      .execute();
    expect(rows.map((r) => r.track_id)).toEqual([tracks.PLB, tracks.PLC]);
    // Naming the hidden source answers exactly as naming one that does not exist, so a refusal
    // never tells which hidden sources the plan holds.
    const hiddenOne = await patch(
      'ana',
      plan.id,
      { sources: [{ kind: 'track', trackId: tracks.PLC }] },
      400,
    );
    const noSuch = await patch(
      'ana',
      plan.id,
      { sources: [{ kind: 'track', trackId: 2_000_000 }] },
      400,
    );
    expect(hiddenOne).toEqual(noSuch);
    expect(hiddenOne.fields).toEqual({ 'sources.0.trackId': 'not_found' });
  });

  it('[PLN-012] makes every number on the summary equal the count of the search it links to', async () => {
    const plan = (
      await make('ana', {
        name: 'Counted',
        sources: [
          { kind: 'track', trackId: tracks.PLA },
          { kind: 'track', trackId: tracks.PLB },
        ],
      })
    ).plan;
    const summary = await get('ana', `/api/v1/plans/${plan.id}/summary`);
    expect(summary.query).toBe('track IN ("PLA", "PLB")');
    const counts: Count[] = [
      summary.total,
      ...summary.overview,
      ...summary.stages,
      ...summary.tracks,
      ...summary.assignees,
    ];
    expect(counts.length).toBeGreaterThan(10);
    for (const c of counts) expect(await searchCount('ana', c.query), c.query).toBe(c.count);
    const byId = Object.fromEntries(summary.overview.map((c: Count) => [c.id, c.count]));
    expect(byId).toMatchObject({ open: 6, overdue: 1, unscheduled: 3 });
    expect(summary.total.count).toBe(6);
    expect(summary.assignees.map((c: Count) => [c.name, c.count])).toEqual([
      [null, 3],
      ['ana', 2],
      ['bo', 1],
    ]);
  });

  it('[PLN-012] narrows every view with one value per filter, and refuses a filter that does not read', async () => {
    const plan = (
      await make('ana', {
        name: 'Filtered',
        sources: [
          { kind: 'track', trackId: tracks.PLA },
          { kind: 'track', trackId: tracks.PLB },
        ],
      })
    ).plan;
    const base = `/api/v1/plans/${plan.id}`;
    const mine = (await get('ana', `${base}/timeline?assignee=me`)).items as Item[];
    expect(mine.map((i) => i.summary).sort()).toEqual(['Invoice', 'Site']);
    const pla = await get('ana', `${base}/summary?track=PLA&stage=new`);
    expect(pla.query).toBe('(track IN ("PLA", "PLB")) AND track = "PLA" AND stage = new');
    expect(pla.total.count).toBe(await searchCount('ana', pla.query));
    expect((await get('ana', `${base}?type=Feature`)).plan.query).toBe(
      '(track IN ("PLA", "PLB")) AND type = "Feature"',
    );
    const nobody = (await get('ana', `${base}/timeline?assignee=none`)).items as Item[];
    expect(nobody.every((i) => i.assignee === null)).toBe(true);
    const calendar = await get('ana', `${base}/calendar?from=2027-03-01&to=2027-03-31&track=PLB`);
    expect(calendar.tickets.map((t: { summary: string }) => t.summary)).toEqual(['Invoice']);
    // Several values, an unknown stage or a track Ana may not search: refused.
    await get('ana', `${base}/timeline?stage=done`, 400);
    await get('ana', `${base}/timeline?assignee=me&assignee=none`, 400);
    expect((await get('ana', `${base}/timeline?track=PLC`, 400)).error).toBe('invalid_query');
    // A person's id beyond an int4 is a bad filter, not a database error.
    for (const view of ['', '/summary', '/timeline', '/calendar?from=2027-03-01&to=2027-03-31&']) {
      const url = view.endsWith('&')
        ? `${base}${view}assignee=3000000000`
        : `${base}${view}?assignee=3000000000`;
      expect((await get('ana', url, 400)).error, url).toMatch(/^invalid_/);
    }
  });

  it('[PLN-012] draws the timeline across tracks with roll-ups from every child the viewer sees', async () => {
    const plan = (
      await make('admin', {
        name: 'Timeline',
        sources: [
          { kind: 'track', trackId: tracks.PLA },
          { kind: 'track', trackId: tracks.PLB },
        ],
        shares: [{ scope: 'any_user' }],
      })
    ).plan;
    const read = async (who: string) => {
      const answer = await get(who, `/api/v1/plans/${plan.id}/timeline`);
      return {
        ...answer,
        byKey: new Map((answer.items as Item[]).map((i) => [i.key, i])),
      };
    };
    const admin = await read('admin');
    expect(admin.truncated).toBe(false);
    expect(admin.tracks.map((t: { key: string }) => t.key)).toEqual(['PLA', 'PLB']);
    // The administrator's roll-up counts the child in PLC, outside the plan.
    expect(admin.byKey.get(outcome.key)?.rollup).toEqual({
      start: '2027-02-01',
      due: '2027-04-30',
      total: 2,
      closed: 0,
    });
    const ana = await read('ana');
    expect(ana.byKey.get(outcome.key)?.rollup).toEqual({
      start: '2027-03-01',
      due: '2027-03-10',
      total: 1,
      closed: 0,
    });
    expect(ana.byKey.get(feature.key)).toMatchObject({
      parentId: outcome.id,
      start: '2027-03-01',
      due: '2027-03-10',
      dated: 'own',
      trackId: tracks.PLA,
      assignee: { id: users.ana?.id, name: 'ana' },
    });
    // Rescheduling is the ticket's own change: the next read has the new days.
    await call('ana', {
      method: 'PATCH',
      url: `/api/v1/tickets/${feature.key}`,
      payload: { startDate: '2027-03-08', dueDate: '2027-03-17' },
    });
    expect((await read('ana')).byKey.get(outcome.key)?.rollup).toMatchObject({
      start: '2027-03-08',
      due: '2027-03-17',
    });
    // Bo views PLB's tickets, so may not reschedule them: the ticket route refuses.
    const invoice = [...ana.byKey.values()].find((i) => i.summary === 'Invoice') as Item;
    const refused = await as('bo', {
      method: 'PATCH',
      url: `/api/v1/tickets/${invoice.key}`,
      payload: { dueDate: '2027-03-20' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().permission).toBe('schedule_tickets');
  });

  it('[PLN-001] reads a parent the viewer may not see as none, never as its id', async () => {
    const parent = await ticket('PLC', {
      summary: 'Core goal',
      ticketTypeId: await typeId('Outcome'),
    });
    const child = await ticket('PLA', {
      summary: 'Child of core',
      ticketTypeId: await typeId('Feature'),
      parent: parent.key,
    });
    const plan = (
      await make('ana', { name: 'Parents', sources: [{ kind: 'track', trackId: tracks.PLA }] })
    ).plan;
    const items = (await get('ana', `/api/v1/plans/${plan.id}/timeline`)).items as Item[];
    expect(items.find((i) => i.id === child.id)?.parentId).toBeNull();
  });

  it('[PLN-012] lists at most the first 10,000 tickets of a view and says so', async () => {
    const big = await call(
      'admin',
      {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key: 'PLZ', name: 'Big', mode: 'shared' },
      },
      201,
    );
    const first = await ticket('PLZ', { summary: 'Template', dueDate: '2027-05-03' });
    await sql`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, rank, fields, labels, due_date)
      SELECT k.workspace_id, k.track_id, k.number + g, k.ticket_type_id, k.status_id,
             'Bulk ' || g, k.creator_id, k.rank || lpad(g::text, 6, '0'), k.fields, k.labels,
             k.due_date
        FROM ticket k, generate_series(1, 10050) AS g
       WHERE k.id = ${first.id}`.execute(database.db);
    const plan = (
      await make('admin', { name: 'Big', sources: [{ kind: 'track', trackId: big.track.id }] })
    ).plan;
    const timeline = await get('admin', `/api/v1/plans/${plan.id}/timeline`);
    expect(timeline.items).toHaveLength(10_000);
    expect(timeline.truncated).toBe(true);
    const calendar = await get(
      'admin',
      `/api/v1/plans/${plan.id}/calendar?from=2027-05-01&to=2027-05-31`,
    );
    expect(calendar.tickets).toHaveLength(10_000);
    expect(calendar.truncated).toBe(true);
    // The summary counts all of them.
    expect((await get('admin', `/api/v1/plans/${plan.id}/summary`)).total.count).toBe(10_051);
  }, 120_000);

  it('[PLN-012] offers the plan’s tracks, types and assignees as filter choices', async () => {
    const plan = (
      await make('ana', {
        name: 'Choices',
        sources: [
          { kind: 'track', trackId: tracks.PLA },
          { kind: 'savedSearch', savedSearchId: saved },
        ],
      })
    ).plan;
    const choices = await get('ana', `/api/v1/plans/${plan.id}/choices`);
    expect(choices.tracks.map((t: { key: string; count: number }) => [t.key, t.count])).toEqual([
      ['PLA', 5],
      ['PLB', 1],
    ]);
    expect(choices.types.map((t: { name: string }) => t.name)).toContain('Feature');
    expect(choices.assignees.map((a: { name: string }) => a.name).sort()).toEqual(['ana', 'bo']);
    expect(choices.unassigned).toBe(3);
  });

  it('[PLN-001] keeps a track seen only through a ticket-level grant hidden: no name, sprints or releases', async () => {
    // PLD's policy lets requesters see their own tickets (a service desk's): Cy is the requester
    // of one, and browses the track itself no more than before.
    const desk = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'PLD', name: 'Desk', mode: 'shared' },
        },
        201,
      )
    ).track.id as number;
    const policy = await database.db
      .insertInto('access_policy')
      .values({ workspace_id: 1, name: 'Requesters see their own' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('access_grant')
      .values([
        {
          workspace_id: 1,
          policy_id: policy.id,
          permission: 'browse_track',
          grantee: 'role',
          role_id: await role('Members'),
        },
        { workspace_id: 1, policy_id: policy.id, permission: 'browse_track', grantee: 'requester' },
      ])
      .execute();
    await database.db
      .updateTable('track')
      .set({ access_policy_id: policy.id })
      .where('id', '=', desk)
      .execute();
    const asked = await ticket('PLD', { summary: 'Printer jam', dueDate: '2027-03-12' });
    await ticket('PLD', { summary: 'Someone else’s', dueDate: '2027-03-13' });
    await database.db
      .updateTable('ticket')
      .set({ requester_id: users.cy?.id as number })
      .where('id', '=', asked.id)
      .execute();
    await database.db
      .insertInto('release')
      .values({
        workspace_id: 1,
        track_id: desk,
        name: 'Desk 1.0',
        release_date: '2027-03-15',
        sort_order: 1,
      })
      .execute();
    const deskSearch = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/saved-searches',
          payload: { name: 'Desk work', query: 'track = PLD', shares: [{ scope: 'any_user' }] },
        },
        201,
      )
    ).savedSearch.id;
    const plan = (
      await make('admin', {
        name: 'Desk',
        sources: [
          { kind: 'track', trackId: desk },
          { kind: 'savedSearch', savedSearchId: deskSearch },
        ],
        shares: [{ scope: 'any_user' }],
      })
    ).plan;
    const base = `/api/v1/plans/${plan.id}`;
    const cy = (await get('cy', base)).plan;
    expect(cy.sources.map((x: { kind: string }) => x.kind)).toEqual(['savedSearch']);
    expect(cy.hiddenSources).toBe(1);
    expect(cy.query).toBe('(track = PLD)');
    const timeline = await get('cy', `${base}/timeline`);
    expect((timeline.items as Item[]).map((i) => i.summary)).toEqual(['Printer jam']);
    expect(timeline.tracks).toEqual([{ id: desk, key: 'PLD', name: null }]);
    expect(timeline.markers).toEqual({ sprints: [], releases: [] });
    const calendar = await get('cy', `${base}/calendar?from=2027-03-01&to=2027-03-31`);
    expect(calendar.tickets.map((t: { summary: string }) => t.summary)).toEqual(['Printer jam']);
    expect(calendar.tracks).toEqual([{ id: desk, key: 'PLD', name: null }]);
    expect(calendar.releases).toEqual([]);
    expect((await get('cy', `${base}/choices`)).tracks).toEqual([
      { id: desk, key: 'PLD', name: null, count: 1 },
    ]);
    // Those who browse the track see its name and its releases.
    const admin = await get('admin', `${base}/timeline`);
    expect(admin.tracks).toEqual([{ id: desk, key: 'PLD', name: 'Desk' }]);
    expect(admin.markers.releases.map((r: { name: string }) => r.name)).toEqual(['Desk 1.0']);
  });

  it('[PLN-001] shares like a dashboard, and sharing needs its permission', async () => {
    const plan = (
      await make('ana', { name: 'Shared', sources: [{ kind: 'track', trackId: tracks.PLA }] })
    ).plan;
    await patch('ana', plan.id, { shares: [{ scope: 'user', userId: users.bo?.id }] });
    expect((await get('bo', '/api/v1/plans')).plans.map((p: { name: string }) => p.name)).toContain(
      'Shared',
    );
    await database.db
      .deleteFrom('global_grant')
      .where('permission', '=', 'share_saved_searches')
      .execute();
    try {
      const refused = await patch('ana', plan.id, { shares: [{ scope: 'any_user' }] }, 403);
      expect(refused.permission).toBe('share_saved_searches');
      // Taking a share away needs no permission.
      await patch('ana', plan.id, { shares: [] });
    } finally {
      await database.db
        .insertInto('global_grant')
        .values({ workspace_id: 1, permission: 'share_saved_searches', grantee: 'any_user' })
        .execute();
    }
    await get('bo', `/api/v1/plans/${plan.id}`, 404);
  });

  /** A plan of the administrator's over three tracks and a saved search, shared with everyone. */
  async function shared(name: string, extra: Record<string, unknown> = {}) {
    return (
      await make('admin', {
        name,
        description: 'Copied words',
        sources: [
          { kind: 'track', trackId: tracks.PLA },
          { kind: 'track', trackId: tracks.PLC },
          { kind: 'savedSearch', savedSearchId: saved },
        ],
        shares: [{ scope: 'any_user' }],
        ...extra,
      })
    ).plan as { id: number; version: number };
  }
  const duplicate = (who: string, id: number, name: string, code = 201) =>
    call(who, { method: 'POST', url: `/api/v1/plans/${id}/duplicate`, payload: { name } }, code);
  const exported = (who: string, id: number, query: Record<string, string> = {}) =>
    as(who, { method: 'GET', url: `/api/v1/plans/${id}/export?${new URLSearchParams(query)}` });
  /**
   * A simple file's rows, its cells split at commas and quotes taken off, after the byte-order
   * mark every CSV file starts with exactly once (T-252).
   */
  const rowsOf = (body: string) => {
    expect(body.startsWith(CSV_BOM)).toBe(true);
    expect(body.slice(1).startsWith(CSV_BOM)).toBe(false);
    return body
      .slice(1)
      .trimEnd()
      .split('\r\n')
      .map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '')));
  };
  /** The keys a search finds as that person, each once. */
  const searchKeys = async (who: string, q: string) => {
    const found: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { tickets: { key: string }[]; next: string | null } = await call(who, {
        method: 'POST',
        url: '/api/v1/search',
        payload: { q, limit: 100, ...(cursor ? { cursor } : {}) },
      });
      found.push(...page.tickets.map((t) => t.key));
      cursor = page.next ?? null;
    } while (cursor);
    return found;
  };
  /** How many bulk exports count against that person, in every window. */
  const bulkExports = async (who: string) => {
    const rows = await database.db
      .selectFrom('security_counter')
      .select('count')
      .where('rule', '=', 'bulk_exports')
      .where('key', '=', `user:${users[who]?.id}`)
      .execute();
    return rows.reduce((sum, r) => sum + r.count, 0);
  };

  it('[PLN-014] a copy holds what its maker sees, with the settings and teams, and is private to them', async () => {
    const team = (
      await call(
        'admin',
        { method: 'POST', url: '/api/v1/teams', payload: { name: 'Copied team' } },
        201,
      )
    ).team.id as number;
    const original = await shared('Spring original');
    await patch('admin', original.id, {
      teams: [team],
      capacityUnit: 'hours',
      period: { kind: 'weeks', weeks: 3, anchor: '2027-01-04' },
    });
    await call('admin', {
      method: 'PUT',
      url: `/api/v1/plans/${original.id}/capacity`,
      payload: { entries: [{ teamId: team, period: null, amount: 40, note: 'Parental leave' }] },
    });
    const before = await get('admin', `/api/v1/plans/${original.id}`);

    const res = await duplicate('bo', original.id, 'Bo copy');
    expect(res.left).toEqual({ hiddenSources: 1 });
    expect(res.plan).toMatchObject({
      name: 'Bo copy',
      description: 'Copied words',
      owner: { id: users.bo?.id, name: 'bo' },
      editable: true,
      shares: [],
      hiddenSources: 0,
      version: 1,
      capacityUnit: 'hours',
      period: { kind: 'weeks', weeks: 3, anchor: '2027-01-04' },
      teams: [{ id: team, name: 'Copied team' }],
      sources: [
        { kind: 'track', id: tracks.PLA, key: 'PLA', name: 'Apps', state: 'visible' },
        { kind: 'savedSearch', id: saved, name: 'Billing due', state: 'visible' },
      ],
    });
    expect(res.plan.id).not.toBe(original.id);
    // Hidden sources are only counted: no name, key or id of the track Bo may not see.
    const said = JSON.stringify(res);
    expect(said).not.toContain('PLC');
    expect(said).not.toContain('Core');

    // Capacity stays behind: its amounts and notes do not reach a second plan.
    const capacity = await database.db
      .selectFrom('plan_capacity')
      .select('id')
      .where('plan_id', '=', res.plan.id)
      .execute();
    expect(capacity).toEqual([]);

    // Private to its maker, and the event says what it took and how many it left, a number.
    await get('ana', `/api/v1/plans/${res.plan.id}`, 404);
    const event = (await events('plan.duplicated')).at(-1);
    expect(event).toEqual({
      subject: String(res.plan.id),
      payload: {
        name: 'Bo copy',
        from: original.id,
        sources: [`track:${tracks.PLA}`, `saved_search:${saved}`],
        teams: [team],
        hiddenSources: 1,
      },
    });
    expect(AUDITED_EVENTS).toContain('plan.duplicated');

    // The original is as it was, for its owner and for its viewers.
    expect(await get('admin', `/api/v1/plans/${original.id}`)).toEqual(before);
    expect((await get('bo', '/api/v1/plans?filter=mine')).plans).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: res.plan.id })]),
    );
    expect(
      (await get('admin', '/api/v1/plans?filter=mine')).plans.map((p: { id: number }) => p.id),
    ).not.toContain(res.plan.id);

    // A later change of the original does not reach the copy.
    await patch('admin', original.id, { description: 'Changed afterwards' });
    const copy = await get('bo', `/api/v1/plans/${res.plan.id}`);
    expect(copy.plan.description).toBe('Copied words');

    // Someone who sees neither hidden track gets less again; the administrator gets it all.
    const cy = await duplicate('cy', original.id, 'Cy copy');
    expect(cy.left).toEqual({ hiddenSources: 2 });
    // Its saved search names a track Cy may not search: it comes, flagged as on the original.
    expect(cy.plan.sources).toEqual([
      { kind: 'savedSearch', id: saved, name: 'Billing due', state: 'broken' },
    ]);
    const all = await duplicate('admin', original.id, 'Everything');
    expect(all.left).toEqual({ hiddenSources: 0 });
    expect(all.plan.sources).toHaveLength(3);
    expect(all.plan.shares).toEqual([]);
  });

  it('[PLN-003] [PLN-014] a copy takes no scenarios or drafts, and a deleted plan takes its own', async () => {
    const original = await shared('Scenario original');
    const dated = await ticket('PLA', { summary: 'Drafted in a scenario', dueDate: '2027-04-01' });
    const made = await call(
      'admin',
      {
        method: 'POST',
        url: `/api/v1/plans/${original.id}/scenarios`,
        payload: { name: 'Faster' },
      },
      201,
    );
    await call('admin', {
      method: 'PUT',
      url: `/api/v1/plans/${original.id}/scenarios/${made.scenario.id}/drafts`,
      payload: { changes: [{ ticketId: dated.id, dueDate: '2027-04-08' }] },
    });
    const copy = await duplicate('admin', original.id, 'Copy without scenarios');
    expect((await get('admin', `/api/v1/plans/${copy.plan.id}/scenarios`)).scenarios).toEqual([]);
    const count = async (table: 'plan_scenario' | 'plan_draft', planId: number) =>
      (
        await database.db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('plan_id', '=', planId)
          .executeTakeFirstOrThrow()
      ).n;
    expect(await count('plan_draft', copy.plan.id)).toBe('0');
    expect(await count('plan_draft', original.id)).toBe('1');
    await call('admin', { method: 'DELETE', url: `/api/v1/plans/${original.id}` }, 204);
    expect(await count('plan_scenario', original.id)).toBe('0');
    expect(await count('plan_draft', original.id)).toBe('0');
  });

  it('[PLN-014] [PLN-012] copies a plan of 500 sources and 50 teams within a second', async () => {
    const ana = users.ana?.id as number;
    const plan = (await make('ana', { name: 'At its limits' })).plan as { id: number };
    const searches = await database.db
      .insertInto('saved_search')
      .values(
        Array.from({ length: 500 }, (_, i) => ({
          workspace_id: 1,
          owner_id: ana,
          name: `At limits ${i}`,
          query: 'track = PLA',
        })),
      )
      .returning('id')
      .execute();
    await database.db
      .insertInto('plan_source')
      .values(
        searches.map((s, position) => ({
          workspace_id: 1,
          plan_id: plan.id,
          kind: 'saved_search' as const,
          saved_search_id: s.id,
          track_id: null,
          position,
        })),
      )
      .execute();
    const teams = await database.db
      .insertInto('team')
      .values(
        Array.from({ length: 50 }, (_, i) => ({
          workspace_id: 1,
          name: `Limit ${i}`,
          lead_id: null,
        })),
      )
      .returning('id')
      .execute();
    await database.db
      .insertInto('plan_team')
      .values(
        teams.map((x, position) => ({
          workspace_id: 1,
          plan_id: plan.id,
          team_id: x.id,
          position,
        })),
      )
      .execute();
    const started = performance.now();
    const copy = await duplicate('ana', plan.id, 'Limits, copied');
    const ms = performance.now() - started;
    expect(copy.plan.sources).toHaveLength(500);
    expect(copy.plan.teams).toHaveLength(50);
    expect(copy.left).toEqual({ hiddenSources: 0 });
    process.stdout.write(`PLN-014 duplicate of 500 sources and 50 teams: ${Math.round(ms)} ms\n`);
    expectWithinBudget(ms, 1000, 'plan duplicate, 500 sources and 50 teams (ms)');
  });

  it('[PLN-014] a plan the person may not see answers as a missing one, and a name is required', async () => {
    const mine = (
      await make('ana', { name: 'Private', sources: [{ kind: 'track', trackId: tracks.PLA }] })
    ).plan as { id: number };
    const hidden = await as('bo', {
      method: 'POST',
      url: `/api/v1/plans/${mine.id}/duplicate`,
      payload: { name: 'Mine now' },
    });
    const missing = await as('bo', {
      method: 'POST',
      url: '/api/v1/plans/99999999/duplicate',
      payload: { name: 'Mine now' },
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe(missing.body);
    const file = await exported('bo', mine.id);
    expect(file.statusCode).toBe(404);
    expect(file.body).toBe((await exported('bo', 99999999)).body);
    const blank = await duplicate('ana', mine.id, '   ', 400);
    expect(blank.error).toBe('invalid_fields');
    await call(
      'ana',
      {
        method: 'POST',
        url: `/api/v1/plans/${mine.id}/duplicate`,
        payload: { name: 'Mine', include: ['capacity'] },
      },
      400,
    );
    const signedOut = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${mine.id}/duplicate`,
      payload: { name: 'Nobody' },
      remoteAddress: nextAddress(),
    });
    expect(signedOut.statusCode).toBe(401);
  });

  it("[PLN-014] [PLN-012] the List's file holds exactly what each viewer finds, whatever the filters", async () => {
    const plan = await shared('Exported "plan": año/2027');
    for (const who of ['admin', 'ana', 'bo', 'cy']) {
      const { plan: seen } = await get(who, `/api/v1/plans/${plan.id}`);
      const res = await exported(who, plan.id, { columns: 'summary,status', sort: 'updated' });
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      const rows = rowsOf(res.body);
      expect(rows[0]).toEqual(['key', 'summary', 'status']);
      const keysInFile = rows.slice(1).map((r) => r[0]);
      // The bytes start EF BB BF, and the CSV importer reads the file back without the mark.
      expect([...res.rawPayload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const back = [...records(res.rawPayload, ',')].map((r) => r.fields.map(cellText));
      expect(back[0]).toEqual(['key', 'summary', 'status']);
      expect(back.slice(1).map((r) => r[0])).toEqual(keysInFile);
      if (seen.query === null) {
        expect(keysInFile).toEqual([]);
        continue;
      }
      // The same tickets, in the order asked for, as a search of the plan's query finds them.
      expect(keysInFile).toEqual(await searchKeys(who, `${seen.query} ORDER BY updated DESC`));
    }
    const admin = await exported('admin', plan.id);
    expect(admin.headers['content-disposition']).toMatch(
      /^attachment; filename="Exported-plan-a-o-2027-list-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(rowsOf(admin.body)[0]).toEqual([
      'key',
      'summary',
      'status',
      'assignee',
      'priority',
      'updatedAt',
    ]);
    // PLC's tickets are in the administrator's file and nobody else's.
    expect(admin.body).toContain('PLC-');
    for (const who of ['ana', 'bo', 'cy']) {
      expect((await exported(who, plan.id)).body).not.toContain('PLC-');
    }
    // The views' filters narrow it.
    const narrowed = await exported('ana', plan.id, { track: 'PLA', assignee: 'me' });
    const expected = await searchKeys('ana', 'track = PLA AND assignee = currentUser()');
    expect(
      rowsOf(narrowed.body)
        .slice(1)
        .map((r) => r[0])
        .sort(),
    ).toEqual(expected.sort());
    // A filter that does not read answers as it does on the views; bad input is refused.
    expect((await exported('ana', plan.id, { track: 'PLC' })).statusCode).toBe(400);
    expect((await exported('ana', plan.id, { format: 'xml' })).statusCode).toBe(400);
    expect((await exported('ana', plan.id, { sort: 'summary' })).statusCode).toBe(400);
    expect((await exported('ana', plan.id, { other: '1' })).statusCode).toBe(400);
    const signedOut = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/${plan.id}/export`,
      remoteAddress: nextAddress(),
    });
    expect(signedOut.statusCode).toBe(401);
  });

  it('[PLN-014] no file holds a hidden column, a formula that would run, or anything from nothing', async () => {
    const local = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'PLL', name: 'Hush', mode: 'local' },
        },
        201,
      )
    ).track.id as number;
    const field = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/fields',
          payload: { name: 'Hidden note', type: 'text', trackId: local },
        },
        201,
      )
    ).field.id as number;
    const risky = await ticket('PLA', { summary: '=HYPERLINK("http://example.test")' });
    const plan = (
      await make('ana', {
        name: 'Guarded',
        sources: [{ kind: 'track', trackId: tracks.PLA }],
        shares: [{ scope: 'any_user' }],
      })
    ).plan as { id: number };
    const column = `cf[${field}]`;
    const refused = await exported('ana', plan.id, { columns: column });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toBe(
      (await exported('ana', plan.id, { columns: 'cf[99999999]' })).body.replace(
        '99999999',
        String(field),
      ),
    );
    expect(refused.body).not.toContain('Hidden note');
    expect((await exported('ana', plan.id, { columns: 'nosuch' })).statusCode).toBe(400);

    const guarded = await exported('ana', plan.id, { columns: 'summary' });
    expect(guarded.body).toContain(`${risky.key},"'=HYPERLINK(""http://example.test"")"`);

    // Cy sees none of the plan's sources: a header row alone, in the columns asked for.
    const nothing = await exported('cy', plan.id, { columns: 'summary' });
    expect(nothing.statusCode).toBe(200);
    expect(nothing.body).toBe(`${CSV_BOM}key,summary\r\n`);
    // An empty plan too.
    const empty = (await make('ana', { name: 'Empty', sources: [] })).plan as { id: number };
    expect((await exported('ana', empty.id, { columns: 'summary' })).body).toBe(
      `${CSV_BOM}key,summary\r\n`,
    );
  });

  it('[QRY-015] [PLN-014] a file counts as a bulk export; export=true answers the same and counts once', async () => {
    const plan = await shared('Counted');
    const url = `/api/v1/plans/${plan.id}`;
    const calendar = 'from=2027-03-01&to=2027-03-31';
    const start = await bulkExports('ana');

    // Reading the views counts nothing.
    const timeline = await get('ana', `${url}/timeline`);
    const month = await get('ana', `${url}/calendar?${calendar}`);
    expect(await bulkExports('ana')).toBe(start);

    expect(await get('ana', `${url}/timeline?export=true`)).toEqual(timeline);
    expect(await bulkExports('ana')).toBe(start + 1);
    expect(await get('ana', `${url}/calendar?${calendar}&export=true`)).toEqual(month);
    expect(await bulkExports('ana')).toBe(start + 2);
    expect((await exported('ana', plan.id)).statusCode).toBe(200);
    expect(await bulkExports('ana')).toBe(start + 3);

    // The filters apply to a file's read as to the view's.
    expect(await get('ana', `${url}/timeline?track=PLA&export=true`)).toEqual(
      await get('ana', `${url}/timeline?track=PLA`),
    );
    expect((await get('cy', `${url}/timeline?export=true`)).items.map((i: Item) => i.key)).toEqual(
      (await get('cy', `${url}/timeline`)).items.map((i: Item) => i.key),
    );

    // Only `true` means it, and a plan nobody may read counts nothing.
    await get('ana', `${url}/timeline?export=false`, 400);
    const mine = (await make('admin', { name: 'Not for Ana' })).plan as { id: number };
    const counted = await bulkExports('ana');
    await get('ana', `/api/v1/plans/${mine.id}/timeline?export=true`, 404);
    expect((await exported('ana', mine.id)).statusCode).toBe(404);
    expect(await bulkExports('ana')).toBe(counted);

    // The rule raises its alert from these as from the search export (ADR-109).
    await call('admin', {
      method: 'PUT',
      url: '/api/v1/security/alerts',
      payload: { rules: { bulk_exports: { enabled: true, threshold: 1, windowMinutes: 60 } } },
    });
    await exported('bo', plan.id);
    const raised = await database.db
      .selectFrom('security_alert')
      .select('key')
      .where('rule', '=', 'bulk_exports')
      .where('key', '=', `user:${users.bo?.id}`)
      .execute();
    expect(raised).toHaveLength(1);
  });
});
