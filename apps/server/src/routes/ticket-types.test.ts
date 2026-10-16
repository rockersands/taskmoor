import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { ladderProblem } from '../tickets/hierarchy';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.66.0.${++address}`;

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

interface LevelJson {
  id: number;
  kind: 'subticket' | 'standard' | 'outcome' | 'custom';
  rank: number;
  name: string;
  description: string;
}
interface TypeJson {
  id: number;
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
  level: { id: number; rank: number; name: string };
  trackId: number | null;
}
interface TypeSetJson {
  id: number;
  name: string;
  trackId: number | null;
  defaultTypeId: number | null;
  ticketTypes: TypeJson[];
  defaultFor: string[];
  tracks: { id: number; key: string; name: string }[];
}

describe('hierarchy levels, ticket types and type sets (M1-007)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};

  const as = (who: string | null, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: (who && users[who]?.cookie) || '' },
    });
  const post = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'POST', url, payload });
  const patch = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'PATCH', url, payload });
  const del = (who: string, url: string) => as(who, { method: 'DELETE', url });

  const levels = async () =>
    (await as('alice', { method: 'GET', url: '/api/v1/hierarchy-levels' })).json()
      .levels as LevelJson[];
  const levelNamed = async (name: string) =>
    (await levels()).find((l) => l.name === name) as LevelJson;
  const builtin = async (kind: LevelJson['kind']) =>
    (await levels()).find((l) => l.kind === kind) as LevelJson;
  const types = async (query = '') =>
    (await as('alice', { method: 'GET', url: `/api/v1/ticket-types${query}` })).json()
      .ticketTypes as TypeJson[];
  const typeId = async (name: string) =>
    ((await types()).find((t) => t.name === name) as TypeJson).id;
  const typeSets = async () =>
    (await as('config', { method: 'GET', url: '/api/v1/type-sets' })).json()
      .typeSets as TypeSetJson[];
  const typeSet = async (name: string) =>
    (await typeSets()).find((s) => s.name === name) as TypeSetJson;
  const trackTypes = async (who: string, ref: string | number) =>
    as(who, { method: 'GET', url: `/api/v1/tracks/${ref}/ticket-types` });
  const lastEvent = async (type: string) =>
    database.db
      .selectFrom('domain_event')
      .select(['subject_id', 'payload'])
      .where('type', '=', type)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
  /** Ranks top first, as the API lists them. */
  const ranks = (list: readonly LevelJson[]) => list.map((l) => [l.name, l.rank]);

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['config', false],
      ['alice', false],
      ['bob', false],
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
    await database.db
      .insertInto('global_grant')
      .values({
        workspace_id: 1,
        permission: 'configuration_admin',
        grantee: 'user',
        user_id: users.config?.id as number,
      })
      .execute();
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-006] starts every workspace with the Subticket, standard and Outcome levels and the default types and sets', async () => {
    expect((await as(null, { method: 'GET', url: '/api/v1/hierarchy-levels' })).statusCode).toBe(
      401,
    );
    const ladder = await levels();
    expect(ladder.map((l) => [l.kind, l.rank, l.name])).toEqual([
      ['outcome', 1, 'Outcome'],
      ['standard', 0, 'Standard'],
      ['subticket', -1, 'Subticket'],
    ]);
    expect((await types()).map((t) => [t.name, t.level.rank])).toEqual([
      ['Outcome', 1],
      ['Bug', 0],
      ['Chore', 0],
      ['Feature', 0],
      ['Idea', 0],
      ['To-do', 0],
      ['Subticket', -1],
    ]);
    const sets = await typeSets();
    expect(
      sets.map((s) => ({
        name: s.name,
        types: s.ticketTypes.map((t) => t.name),
        preselected: s.ticketTypes.find((t) => t.id === s.defaultTypeId)?.name,
        defaultFor: s.defaultFor,
      })),
    ).toEqual([
      {
        name: 'Business type set',
        types: ['Outcome', 'To-do', 'Subticket'],
        preselected: 'To-do',
        defaultFor: ['business', 'service'],
      },
      {
        name: 'Discovery type set',
        types: ['Idea'],
        preselected: 'Idea',
        defaultFor: ['discovery'],
      },
      {
        name: 'Software type set',
        types: ['Outcome', 'Feature', 'Bug', 'Chore', 'Subticket'],
        preselected: 'Feature',
        defaultFor: ['software'],
      },
    ]);
    // Type sets are configuration: administrators list them.
    expect((await as('alice', { method: 'GET', url: '/api/v1/type-sets' })).statusCode).toBe(403);
  });

  it('[CORE-006] (1) lets administrators add levels 2 and 3 above Outcome, with several ticket types at one level', async () => {
    expect((await post('alice', '/api/v1/hierarchy-levels', { name: 'Strategy' })).statusCode).toBe(
      403,
    );
    const strategy = await post('config', '/api/v1/hierarchy-levels', { name: 'Strategy' });
    expect(strategy.statusCode, strategy.body).toBe(201);
    expect(strategy.json().level).toMatchObject({ kind: 'custom', rank: 2, name: 'Strategy' });
    // A level inserted at 2 pushes the one there up.
    const objective = await post('config', '/api/v1/hierarchy-levels', {
      name: 'Objective',
      rank: 2,
      description: 'What a year of work aims at',
    });
    expect(objective.statusCode, objective.body).toBe(201);
    expect(ranks(objective.json().levels)).toEqual([
      ['Strategy', 3],
      ['Objective', 2],
      ['Outcome', 1],
      ['Standard', 0],
      ['Subticket', -1],
    ]);
    expect((await lastEvent('hierarchy_level.created')).payload).toEqual({
      name: 'Objective',
      rank: 2,
      shifted: [{ levelId: strategy.json().level.id, from: 2, to: 3 }],
    });
    // Custom levels sit above Outcome and below one past the top; names are unique.
    for (const rank of [1, 0, -1, 5]) {
      const res = await post('config', '/api/v1/hierarchy-levels', { name: 'Nope', rank });
      expect(res.statusCode, String(rank)).toBe(400);
      expect(res.json()).toEqual({ error: 'rank_out_of_range', detail: { min: 2, max: 4 } });
    }
    expect(
      (await post('config', '/api/v1/hierarchy-levels', { name: 'objective' })).statusCode,
    ).toBe(409);
    // Several ticket types share level 2.
    for (const name of ['Objective', 'Key result']) {
      const res = await post('config', '/api/v1/ticket-types', {
        name,
        levelId: objective.json().level.id,
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().ticketType.level).toEqual({
        id: objective.json().level.id,
        rank: 2,
        name: 'Objective',
      });
    }
    // Built-in levels are renamed, never moved.
    const outcome = await builtin('outcome');
    const renamed = await patch('config', `/api/v1/hierarchy-levels/${outcome.id}`, {
      name: 'Result',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().level).toMatchObject({ kind: 'outcome', rank: 1, name: 'Result' });
    expect(
      (await patch('config', `/api/v1/hierarchy-levels/${outcome.id}`, { rank: 2 })).json(),
    ).toEqual({ error: 'builtin_level' });
    await patch('config', `/api/v1/hierarchy-levels/${outcome.id}`, { name: 'Outcome' });
    expect(ladderProblem(await levels())).toBeNull();
  });

  it('[CORE-006] moves and removes custom levels; the types of a removed level fall to level 0', async () => {
    const strategy = await levelNamed('Strategy');
    const objective = await levelNamed('Objective');
    const moved = await patch('config', `/api/v1/hierarchy-levels/${strategy.id}`, { rank: 2 });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(ranks(moved.json().levels).slice(0, 2)).toEqual([
      ['Objective', 3],
      ['Strategy', 2],
    ]);
    expect((await lastEvent('hierarchy_level.updated')).payload).toEqual({
      changes: { rank: { from: 3, to: 2 } },
      shifted: [{ levelId: objective.id, from: 2, to: 3 }],
    });
    const theme = await post('config', '/api/v1/ticket-types', {
      name: 'Theme',
      levelId: strategy.id,
    });
    expect(theme.statusCode).toBe(201);

    expect((await del('alice', `/api/v1/hierarchy-levels/${strategy.id}`)).statusCode).toBe(403);
    expect((await del('config', `/api/v1/hierarchy-levels/${strategy.id}`)).statusCode).toBe(204);
    expect(ranks(await levels()).slice(0, 2)).toEqual([
      ['Objective', 2],
      ['Outcome', 1],
    ]);
    const fallen = (await types()).find((t) => t.name === 'Theme') as TypeJson;
    expect(fallen.level).toMatchObject({ rank: 0, name: 'Standard' });
    expect((await lastEvent('hierarchy_level.deleted')).payload).toEqual({
      name: 'Strategy',
      rank: 2,
      shifted: [{ levelId: objective.id, from: 3, to: 2 }],
      typesToStandard: [theme.json().ticketType.id],
    });
    for (const kind of ['subticket', 'standard', 'outcome'] as const) {
      const res = await del('config', `/api/v1/hierarchy-levels/${(await builtin(kind)).id}`);
      expect(res.json(), kind).toEqual({ error: 'builtin_level' });
    }
    expect((await del('config', '/api/v1/hierarchy-levels/999999')).statusCode).toBe(404);
    expect(ladderProblem(await levels())).toBeNull();
  });

  it('[CORE-007] (1) previews the parent links a change breaks and the types that fall to level 0', async () => {
    const before = await levels();
    const initiative = await post('config', '/api/v1/hierarchy-levels', { name: 'Initiative' });
    const level = initiative.json().level as LevelJson;
    const type = await post('config', '/api/v1/ticket-types', {
      name: 'Initiative',
      levelId: level.id,
    });
    const impact = async (query: string) =>
      as('config', { method: 'GET', url: `/api/v1/hierarchy-levels/impact?${query}` });

    const removal = await impact(`change=remove&levelId=${level.id}`);
    expect(removal.statusCode, removal.body).toBe(200);
    expect(removal.json().impact).toEqual({
      levels: [{ levelId: level.id, from: level.rank, to: null }],
      typesToStandard: [type.json().ticketType.id],
      types: [{ typeId: type.json().ticketType.id, from: level.rank, to: 0 }],
      ticketsChangingLevel: 0,
      brokenLinks: [],
      brokenLinkCount: 0,
      ticketsNeedingParent: [],
      breaksTickets: false,
    });
    const objective = await levelNamed('Objective');
    expect((await impact('change=insert&rank=2')).json().impact.levels).toEqual([
      { levelId: objective.id, from: 2, to: 3 },
      { levelId: level.id, from: 3, to: 4 },
    ]);
    expect((await impact(`change=move&levelId=${level.id}&rank=2`)).json().impact.levels).toEqual([
      { levelId: objective.id, from: 2, to: 3 },
      { levelId: level.id, from: 3, to: 2 },
    ]);
    const feature = await typeId('Feature');
    const subticket = await builtin('subticket');
    expect(
      (await impact(`change=retype&typeId=${feature}&levelId=${subticket.id}`)).json().impact.types,
    ).toEqual([{ typeId: feature, from: 0, to: -1 }]);
    const outcome = await builtin('outcome');
    expect((await impact(`change=remove&levelId=${outcome.id}`)).statusCode).toBe(409);
    expect((await impact(`change=move&levelId=${level.id}&rank=9`)).statusCode).toBe(400);
    expect((await impact('change=explode')).statusCode).toBe(400);
    // It names tickets across tracks, so it is for administrators.
    expect(
      (await as('alice', { method: 'GET', url: `/api/v1/hierarchy-levels/impact?change=insert` }))
        .statusCode,
    ).toBe(403);
    // A preview writes nothing.
    expect((await levels()).length).toBe(before.length + 1);
    expect((await del('config', `/api/v1/hierarchy-levels/${level.id}`)).statusCode).toBe(204);
    expect(ranks(await levels())).toEqual(ranks(before));
  });

  it('[CORE-006] keeps the ladder gapless while administrators change it at the same time', async () => {
    const before = await levels();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post('config', '/api/v1/hierarchy-levels', {
          name: `Parallel ${i}`,
          ...(i % 2 === 0 ? { rank: 2 } : {}),
        }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(201));
    const after = await levels();
    expect(after).toHaveLength(before.length + 8);
    expect(ladderProblem(after)).toBeNull();
    await Promise.all(
      after
        .filter((l) => l.name.startsWith('Parallel'))
        .map((l) => del('config', `/api/v1/hierarchy-levels/${l.id}`)),
    );
    expect(ranks(await levels())).toEqual(ranks(before));
  });

  it('[CORE-005] lets configuration administrators define ticket types with a name, icon, description and level', async () => {
    const standard = await builtin('standard');
    expect(
      (await post('alice', '/api/v1/ticket-types', { name: 'Spike', levelId: standard.id }))
        .statusCode,
    ).toBe(403);
    const spike = await post('config', '/api/v1/ticket-types', {
      name: 'Spike',
      description: 'A time-boxed investigation',
      icon: 'flask',
      color: '#AABBCC',
      levelId: standard.id,
    });
    expect(spike.statusCode, spike.body).toBe(201);
    const created = spike.json().ticketType as TypeJson;
    expect(created).toMatchObject({
      name: 'Spike',
      description: 'A time-boxed investigation',
      icon: 'flask',
      color: '#aabbcc',
      level: { id: standard.id, rank: 0, name: 'Standard' },
      trackId: null,
    });
    expect(
      (await post('config', '/api/v1/ticket-types', { name: 'spike', levelId: standard.id }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await post('config', '/api/v1/ticket-types', {
          name: 'Bad',
          icon: 'Not An Icon',
          levelId: standard.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post('config', '/api/v1/ticket-types', { name: 'Lost', levelId: 999999 })).json(),
    ).toEqual({ error: 'invalid_request', detail: 'levelId' });

    const outcome = await builtin('outcome');
    const raised = await patch('config', `/api/v1/ticket-types/${created.id}`, {
      name: 'Research',
      levelId: outcome.id,
    });
    expect(raised.statusCode, raised.body).toBe(200);
    expect(raised.json().ticketType).toMatchObject({ name: 'Research', level: { rank: 1 } });
    expect((await lastEvent('ticket_type.updated')).payload).toEqual({
      changes: {
        name: { from: 'Spike', to: 'Research' },
        levelId: { from: standard.id, to: outcome.id },
      },
    });
    expect(
      (await patch('alice', `/api/v1/ticket-types/${created.id}`, { icon: 'x' })).statusCode,
    ).toBe(403);
    expect(
      (await as('alice', { method: 'GET', url: `/api/v1/ticket-types/${created.id}` })).json()
        .ticketType.name,
    ).toBe('Research');

    // A type in a set stays until it leaves every set.
    const feature = await typeId('Feature');
    expect((await del('config', `/api/v1/ticket-types/${feature}`)).json()).toEqual({
      error: 'in_type_sets',
      typeSets: [{ id: (await typeSet('Software type set')).id, name: 'Software type set' }],
    });
    expect((await del('alice', `/api/v1/ticket-types/${created.id}`)).statusCode).toBe(403);
    expect((await del('config', `/api/v1/ticket-types/${created.id}`)).statusCode).toBe(204);
    expect(
      (await as('alice', { method: 'GET', url: `/api/v1/ticket-types/${created.id}` })).statusCode,
    ).toBe(404);
    expect((await lastEvent('ticket_type.deleted')).payload).toEqual({
      name: 'Research',
      trackId: null,
    });
  });

  it('[CORE-005] (1) offers each track the types of its set in set order, with the default preselected', async () => {
    const make = async (key: string, type: string, extra: Record<string, unknown> = {}) => {
      const res = await post('config', '/api/v1/tracks', {
        key,
        name: key,
        mode: 'shared',
        type,
        ownerId: users.alice?.id,
        ...extra,
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().track as { id: number; typeSetId: number };
    };
    const offered = async (ref: string | number) => {
      const body = (await trackTypes('alice', ref)).json() as {
        typeSetId: number;
        defaultTypeId: number;
        ticketTypes: TypeJson[];
      };
      return {
        names: body.ticketTypes.map((t) => t.name),
        preselected: body.ticketTypes.find((t) => t.id === body.defaultTypeId)?.name,
      };
    };
    const software = await make('SW', 'software');
    expect(software.typeSetId).toBe((await typeSet('Software type set')).id);
    expect(await offered('SW')).toEqual({
      names: ['Outcome', 'Feature', 'Bug', 'Chore', 'Subticket'],
      preselected: 'Feature',
    });
    await make('BIZ', 'business');
    expect(await offered('biz')).toEqual({
      names: ['Outcome', 'To-do', 'Subticket'],
      preselected: 'To-do',
    });
    await make('DSC', 'discovery');
    expect(await offered('DSC')).toEqual({ names: ['Idea'], preselected: 'Idea' });
    await make('SRV', 'service');
    expect(await offered('SRV')).toEqual({
      names: ['Outcome', 'To-do', 'Subticket'],
      preselected: 'To-do',
    });
    // Only people who see the track see its types.
    expect((await trackTypes('bob', 'SW')).statusCode).toBe(404);

    // The set's order and default reach every track that uses it.
    const set = await typeSet('Software type set');
    const ids = Object.fromEntries(set.ticketTypes.map((t) => [t.name, t.id]));
    const reordered = await patch('config', `/api/v1/type-sets/${set.id}`, {
      ticketTypeIds: [ids.Bug, ids.Feature, ids.Chore, ids.Outcome, ids.Subticket],
      defaultTypeId: ids.Bug,
    });
    expect(reordered.statusCode, reordered.body).toBe(200);
    expect(await offered(software.id)).toEqual({
      names: ['Bug', 'Feature', 'Chore', 'Outcome', 'Subticket'],
      preselected: 'Bug',
    });
    expect((await lastEvent('type_set.updated')).payload).toEqual({
      changes: {
        ticketTypeIds: {
          from: set.ticketTypes.map((t) => t.id),
          to: [ids.Bug, ids.Feature, ids.Chore, ids.Outcome, ids.Subticket],
        },
        defaultTypeId: { from: ids.Feature, to: ids.Bug },
      },
    });
    await patch('config', `/api/v1/type-sets/${set.id}`, {
      ticketTypeIds: set.ticketTypes.map((t) => t.id),
      defaultTypeId: ids.Feature,
    });

    // A shared track may name a shared set, and administrators may switch it.
    const discovery = await typeSet('Discovery type set');
    const named = await make('IDEAS', 'software', { typeSetId: discovery.id });
    expect(await offered(named.id)).toEqual({ names: ['Idea'], preselected: 'Idea' });
    expect(
      (await patch('alice', `/api/v1/tracks/${software.id}`, { typeSetId: discovery.id }))
        .statusCode,
    ).toBe(403);
    const switched = await patch('config', `/api/v1/tracks/${software.id}`, {
      typeSetId: discovery.id,
    });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json().track.typeSetId).toBe(discovery.id);
    expect((await lastEvent('track.updated')).payload).toEqual({
      changes: { typeSetId: { from: set.id, to: discovery.id } },
    });
    expect(await offered(software.id)).toEqual({ names: ['Idea'], preselected: 'Idea' });
    expect(
      (await patch('config', `/api/v1/tracks/${software.id}`, { typeSetId: 999999 })).statusCode,
    ).toBe(400);
  });

  it('[CORE-005] keeps type sets consistent: shared types, a default among them and a default set per track type', async () => {
    const [bug, chore, feature] = await Promise.all(['Bug', 'Chore', 'Feature'].map(typeId));
    const create = (who: string, payload: Record<string, unknown>) =>
      post(who, '/api/v1/type-sets', payload);
    expect((await create('alice', { name: 'Ops', ticketTypeIds: [bug] })).statusCode).toBe(403);
    for (const payload of [
      { name: 'Ops', ticketTypeIds: [] },
      { name: 'Ops', ticketTypeIds: [bug, bug] },
      { name: 'Ops', ticketTypeIds: [bug], defaultTypeId: chore },
      { name: 'Ops', ticketTypeIds: [bug, 999999] },
      { name: 'Ops', ticketTypeIds: [bug], defaultFor: ['software', 'software'] },
    ]) {
      expect((await create('config', payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const ops = await create('config', {
      name: 'Ops type set',
      ticketTypeIds: [chore, bug],
      defaultTypeId: chore,
      defaultFor: ['service'],
    });
    expect(ops.statusCode, ops.body).toBe(201);
    const opsSet = ops.json().typeSet as TypeSetJson;
    expect(opsSet).toMatchObject({ defaultFor: ['service'], trackId: null, tracks: [] });
    // The service default moved from the business set.
    expect((await typeSet('Business type set')).defaultFor).toEqual(['business']);
    const srv = await post('config', '/api/v1/tracks', {
      key: 'OPS',
      name: 'Ops',
      mode: 'shared',
      type: 'service',
    });
    expect(srv.json().track.typeSetId).toBe(opsSet.id);
    expect((await typeSet('Ops type set')).tracks).toEqual([
      { id: srv.json().track.id, key: 'OPS', name: 'Ops' },
    ]);

    // A track type keeps a default set; another set takes it over instead.
    expect(
      (await patch('config', `/api/v1/type-sets/${opsSet.id}`, { defaultFor: [] })).json(),
    ).toEqual({ error: 'default_required' });
    // The default stays one of the set's types.
    expect(
      (await patch('config', `/api/v1/type-sets/${opsSet.id}`, { ticketTypeIds: [bug] })).json(),
    ).toEqual({ error: 'invalid_request', detail: 'defaultTypeId' });
    const narrowed = await patch('config', `/api/v1/type-sets/${opsSet.id}`, {
      ticketTypeIds: [bug, feature],
      defaultTypeId: null,
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json().typeSet).toMatchObject({ defaultTypeId: null });
    expect(
      (await patch('config', `/api/v1/type-sets/${opsSet.id}`, { name: 'software type set' }))
        .statusCode,
    ).toBe(409);

    // In use, a default, or owned by a track: it stays.
    expect((await del('config', `/api/v1/type-sets/${opsSet.id}`)).json()).toEqual({
      error: 'in_use',
      trackCount: 1,
    });
    const business = await typeSet('Business type set');
    // With no track left on the business set, it still stays as the business default.
    await database.db
      .updateTable('track')
      .set({ type_set_id: opsSet.id })
      .where('type_set_id', '=', business.id)
      .execute();
    expect((await del('config', `/api/v1/type-sets/${business.id}`)).json()).toEqual({
      error: 'default_type_set',
      defaultFor: ['business'],
    });
    const spare = await create('config', { name: 'Spare type set', ticketTypeIds: [bug] });
    expect((await del('alice', `/api/v1/type-sets/${spare.json().typeSet.id}`)).statusCode).toBe(
      403,
    );
    expect((await del('config', `/api/v1/type-sets/${spare.json().typeSet.id}`)).statusCode).toBe(
      204,
    );
    expect((await lastEvent('type_set.deleted')).payload).toEqual({ name: 'Spare type set' });
  });

  it('[CORE-003] gives a local-mode track its own type set and lets its administrators own ticket types', async () => {
    const res = await post('alice', '/api/v1/tracks', {
      key: 'LOCT',
      name: 'Local',
      mode: 'local',
    });
    expect(res.statusCode, res.body).toBe(201);
    const local = res.json().track as { id: number; typeSetId: number };
    const software = await typeSet('Software type set');
    expect(local.typeSetId).not.toBe(software.id);
    expect((await lastEvent('track.created')).payload).toMatchObject({
      key: 'LOCT',
      typeSetId: local.typeSetId,
    });
    const own = (
      await as('alice', { method: 'GET', url: `/api/v1/type-sets/${local.typeSetId}` })
    ).json().typeSet as TypeSetJson;
    expect(own).toMatchObject({
      name: 'LOCT local type set',
      trackId: local.id,
      defaultTypeId: software.defaultTypeId,
      defaultFor: [],
    });
    expect(own.ticketTypes.map((t) => t.id)).toEqual(software.ticketTypes.map((t) => t.id));
    expect(
      (await as('bob', { method: 'GET', url: `/api/v1/type-sets/${local.typeSetId}` })).statusCode,
    ).toBe(404);
    expect(
      (
        await post('alice', '/api/v1/tracks', {
          key: 'LOCX',
          name: 'x',
          mode: 'local',
          typeSetId: software.id,
        })
      ).statusCode,
    ).toBe(400);

    // Its administrators add their own ticket types and put them in its set.
    const standard = await builtin('standard');
    const experiment = await post('alice', '/api/v1/ticket-types', {
      name: 'Experiment',
      levelId: standard.id,
      trackId: local.id,
    });
    expect(experiment.statusCode, experiment.body).toBe(201);
    const expId = experiment.json().ticketType.id as number;
    expect(experiment.json().ticketType.trackId).toBe(local.id);
    expect(
      (
        await post('bob', '/api/v1/ticket-types', {
          name: 'Mine',
          levelId: standard.id,
          trackId: local.id,
        })
      ).statusCode,
    ).toBe(404);
    // A track's own types are shown only with the track, to people who see it.
    expect((await types()).map((t) => t.name)).not.toContain('Experiment');
    expect((await types(`?trackId=${local.id}`)).map((t) => t.name)).toContain('Experiment');
    expect(
      (await as('bob', { method: 'GET', url: `/api/v1/ticket-types?trackId=${local.id}` }))
        .statusCode,
    ).toBe(404);
    const added = await patch('alice', `/api/v1/type-sets/${local.typeSetId}`, {
      ticketTypeIds: [...own.ticketTypes.map((t) => t.id), expId],
      defaultTypeId: expId,
    });
    expect(added.statusCode, added.body).toBe(200);
    const offered = (await trackTypes('alice', local.id)).json();
    expect(offered.defaultTypeId).toBe(expId);
    expect(offered.ticketTypes.at(-1).name).toBe('Experiment');
    // Nothing leaks: the shared set is unchanged, and no shared set takes a local type.
    expect((await typeSet('Software type set')).ticketTypes.map((t) => t.name)).not.toContain(
      'Experiment',
    );
    expect(
      (
        await patch('config', `/api/v1/type-sets/${software.id}`, {
          ticketTypeIds: [...software.ticketTypes.map((t) => t.id), expId],
        })
      ).json(),
    ).toEqual({ error: 'invalid_request', detail: 'ticketTypeIds' });
    expect(
      (await patch('alice', `/api/v1/type-sets/${software.id}`, { name: 'Mine' })).statusCode,
    ).toBe(403);
    expect(
      (await patch('alice', `/api/v1/type-sets/${local.typeSetId}`, { defaultFor: ['software'] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post('alice', '/api/v1/ticket-types', { name: 'Shared', levelId: standard.id }))
        .statusCode,
    ).toBe(403);
    // The track keeps its own set; administrators cannot delete it from under it.
    expect(
      (await patch('config', `/api/v1/tracks/${local.id}`, { typeSetId: software.id })).statusCode,
    ).toBe(400);
    expect((await del('config', `/api/v1/type-sets/${local.typeSetId}`)).json()).toEqual({
      error: 'owned_by_track',
    });

    // An archived track's configuration is read-only.
    await post('config', `/api/v1/tracks/${local.id}/archive`, {});
    expect(
      (await patch('alice', `/api/v1/ticket-types/${expId}`, { description: 'x' })).json(),
    ).toEqual({ error: 'track_archived' });
    await post('config', `/api/v1/tracks/${local.id}/restore`, {});

    expect((await del('alice', `/api/v1/ticket-types/${expId}`)).json()).toMatchObject({
      error: 'in_type_sets',
    });
    await patch('alice', `/api/v1/type-sets/${local.typeSetId}`, {
      ticketTypeIds: own.ticketTypes.map((t) => t.id),
      defaultTypeId: own.defaultTypeId,
    });
    expect((await del('alice', `/api/v1/ticket-types/${expId}`)).statusCode).toBe(204);
    expect((await lastEvent('ticket_type.deleted')).payload).toEqual({
      name: 'Experiment',
      trackId: local.id,
    });
  });
});
