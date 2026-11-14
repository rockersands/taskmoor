import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.71.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface OptionJson {
  id: number;
  value: string;
  disabled: boolean;
  children: OptionJson[];
}
interface ContextJson {
  id: number;
  name: string;
  trackIds: number[] | null;
  ticketTypeIds: number[] | null;
  defaultValue: unknown;
  options: OptionJson[];
}
interface FieldJson {
  id: number;
  name: string;
  type: string;
  multiple: boolean;
  trackId: number | null;
  contexts: ContextJson[];
}
interface TicketJson {
  id: number;
  key: string;
  version: number;
  fields: Record<string, unknown>;
}

/**
 * Custom fields, contexts and options through the API (M1-010; CORE-003, CORE-009, CORE-010).
 * The per-type rules are in `fields/types.test.ts`.
 */
describe('custom fields (M1-010)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const types: Record<string, number> = {};
  let token = '';

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });
  const post = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'POST', url, payload });
  const patch = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'PATCH', url, payload });
  const put = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'PUT', url, payload });
  const del = (who: string, url: string) => as(who, { method: 'DELETE', url });

  async function field(body: Record<string, unknown>, who = 'admin'): Promise<FieldJson> {
    const res = await post(who, '/api/v1/fields', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().field as FieldJson;
  }
  async function create(track: string, body: Record<string, unknown> = {}, who = 'alice') {
    return post(who, '/api/v1/tickets', { track, summary: 'Work', ...body });
  }
  async function ticket(track: string, body: Record<string, unknown> = {}): Promise<TicketJson> {
    const res = await create(track, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as TicketJson;
  }
  const view = async (t: { id: number }) =>
    (await get('alice', `/api/v1/tickets/${t.id}`)).json().ticket as TicketJson;
  const history = async (t: { id: number }) =>
    (await get('alice', `/api/v1/tickets/${t.id}/history?order=asc`)).json().changes as {
      field: string;
      fieldName?: string | null;
      valueType?: string | null;
      from: { value: string | null; display: string | null };
      to: { value: string | null; display: string | null };
    }[];
  const errorsOf = (res: LightMyRequestResponse) => res.json().fields as Record<string, string>;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
      ['carol', false],
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
    const roles: Record<string, number> = {};
    for (const role of await database.db.selectFrom('role').select(['id', 'name']).execute()) {
      roles[role.name] = role.id;
    }
    for (const [key, mode] of [
      ['XT', 'shared'],
      ['YT', 'shared'],
      ['LOC', 'local'],
      ['LOB', 'local'],
    ] as const) {
      const res = await post('admin', '/api/v1/tracks', { key, name: key, mode });
      expect(res.statusCode, res.body).toBe(201);
      tracks[key] = res.json().track.id;
      for (const who of ['alice', 'bob', 'carol']) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            // Alice administers the local tracks; everyone else is a member.
            role_id: roles[
              who === 'alice' && key === 'LOC' ? 'Administrators' : 'Members'
            ] as number,
            user_id: users[who]?.id as number,
          })
          .execute();
      }
    }
    for (const t of await database.db.selectFrom('ticket_type').select(['id', 'name']).execute()) {
      types[t.name] = t.id;
    }
    const res = await post('alice', '/api/v1/account/tokens', {
      name: 'Script',
      scopes: ['read', 'write'],
      expiresInDays: 30,
    });
    expect(res.statusCode, res.body).toBe(201);
    token = res.json().secret ?? res.json().token;
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-010] round-trips a value of every type through REST, with history by name', async () => {
    const release = (
      await post('admin', `/api/v1/tracks/${tracks.XT}/releases`, { name: '1.0' })
    ).json().release;
    const area = (await post('admin', `/api/v1/tracks/${tracks.XT}/areas`, { name: 'API' })).json()
      .area;
    const group = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'Reviewers' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const f = {
      text: await field({ name: 'Customer', type: 'text' }),
      paragraph: await field({ name: 'Notes', type: 'paragraph' }),
      number: await field({ name: 'Pts', type: 'number', config: { decimals: 1 } }),
      date: await field({ name: 'Go-live', type: 'date' }),
      datetime: await field({ name: 'Incident start', type: 'datetime' }),
      select: await field({
        name: 'Severity',
        type: 'select',
        context: { options: [{ value: 'Major' }, { value: 'Minor' }] },
      }),
      checks: await field({
        name: 'Platforms',
        type: 'select',
        multiple: true,
        config: { display: 'checkboxes' },
        context: { options: [{ value: 'iOS' }, { value: 'Android' }, { value: 'Web' }] },
      }),
      cascade: await field({
        name: 'Component',
        type: 'cascading-select',
        context: {
          options: [{ value: 'Backend', children: [{ value: 'Queue' }, { value: 'Search' }] }],
        },
      }),
      user: await field({ name: 'Reviewer', type: 'user' }),
      users: await field({ name: 'Watchers', type: 'user', multiple: true }),
      group: await field({ name: 'Team', type: 'group' }),
      labels: await field({ name: 'Topics', type: 'labels' }),
      url: await field({ name: 'Design', type: 'url' }),
      release: await field({ name: 'Shipped in', type: 'release' }),
      area: await field({ name: 'Owning area', type: 'area', multiple: true }),
    };
    const opt = (fj: FieldJson, i: number) => fj.contexts[0]?.options[i] as OptionJson;
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Call first' }] }],
    };
    const given = {
      [f.text.id]: 'ACME',
      [f.paragraph.id]: doc,
      [f.number.id]: '1.23456',
      [f.date.id]: '2026-12-01',
      [f.datetime.id]: '2026-10-28T09:30:00+01:00',
      [f.select.id]: opt(f.select, 1).id,
      [f.checks.id]: [opt(f.checks, 2).id, { id: opt(f.checks, 0).id }],
      [f.cascade.id]: { parent: opt(f.cascade, 0).id, child: opt(f.cascade, 0).children[1]?.id },
      [f.user.id]: users.bob?.id,
      [f.users.id]: [users.carol?.id, String(users.bob?.id)],
      [f.group.id]: group.id,
      [f.labels.id]: ['billing', 'ux'],
      [f.url.id]: 'https://example.com/design',
      [f.release.id]: release.id,
      [f.area.id]: [area.id],
    };
    const made = await ticket('XT', { fields: given });
    const shown = (await view(made)).fields;
    expect(shown[f.text.id]).toBe('ACME');
    expect(shown[f.number.id]).toBe(1.235);
    expect(shown[f.datetime.id]).toBe('2026-10-28T08:30:00.000Z');
    expect(shown[f.select.id]).toEqual({ id: opt(f.select, 1).id, value: 'Minor' });
    // Multiple values in id order, whatever order they came in.
    expect(shown[f.checks.id]).toEqual([
      { id: opt(f.checks, 0).id, value: 'iOS' },
      { id: opt(f.checks, 2).id, value: 'Web' },
    ]);
    expect(shown[f.cascade.id]).toEqual({
      id: opt(f.cascade, 0).id,
      value: 'Backend',
      child: { id: opt(f.cascade, 0).children[1]?.id, value: 'Search' },
    });
    expect(shown[f.users.id]).toEqual(
      [
        { id: users.bob?.id, name: 'bob' },
        { id: users.carol?.id, name: 'carol' },
      ].sort((a, b) => (a.id as number) - (b.id as number)),
    );
    expect(shown[f.group.id]).toEqual({ id: group.id, name: 'Reviewers' });
    expect(shown[f.release.id]).toEqual({ id: release.id, name: '1.0' });
    // Writing back what was read changes nothing (CORE-010 (3)).
    const again = await patch('alice', `/api/v1/tickets/${made.id}`, { fields: shown });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().ticket.version).toBe(made.version);
    expect(again.json().ticket.fields).toEqual(shown);
    // Starting values are history under the query language's names, references by name.
    const rows = await history(made);
    const select = rows.find((r) => r.field === `cf[${f.select.id}]`);
    expect(select?.to).toEqual({ value: String(opt(f.select, 1).id), display: 'Minor' });
    const cascade = rows.find((r) => r.field === `cf[${f.cascade.id}]`);
    expect(cascade?.to.display).toBe('Backend / Search');
    expect(rows.find((r) => r.field === `cf[${f.number.id}]`)?.to.value).toBe('1.235');
    // Clearing a value removes it and is history too.
    const cleared = await patch('alice', `/api/v1/tickets/${made.id}`, {
      fields: { [f.text.id]: '', [f.checks.id]: [] },
    });
    expect(cleared.json().ticket.fields[f.text.id]).toBeUndefined();
    expect(cleared.json().ticket.fields[f.checks.id]).toBeUndefined();
    const last = (await history(made)).filter((r) => r.field === `cf[${f.checks.id}]`).pop();
    expect(last?.to.value).toBeNull();
    expect(last?.from.display).toBe('iOS, Web');
    // Labels fields keep their own vocabulary.
    const suggested = await get('alice', `/api/v1/fields/${f.labels.id}/labels?q=BI`);
    expect(suggested.json().labels).toEqual(['billing']);
  });

  it('[CORE-022] names a custom field in history and says whether its values are days or instants (T-277)', async () => {
    const day = await field({ name: 'Go-live day', type: 'date' });
    const moment = await field({ name: 'Cut-over', type: 'datetime' });
    const note = await field({ name: 'Rollout note', type: 'text' });
    const gone = await field({ name: 'Audit day', type: 'date' });
    const made = await ticket('XT', {
      fields: {
        [day.id]: '2026-10-13',
        [moment.id]: '2026-10-13T09:00:00Z',
        [note.id]: 'Soon',
        [gone.id]: '2026-11-01',
      },
    });
    // Audit day stops applying to the ticket's track: its rows keep how they read, not the name.
    const narrowed = await patch(
      'admin',
      `/api/v1/fields/${gone.id}/contexts/${gone.contexts[0]?.id}`,
      { trackIds: [tracks.YT] },
    );
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    const rows = await history(made);
    const row = (f: FieldJson) => rows.find((r) => r.field === `cf[${f.id}]`);
    expect(row(day)).toMatchObject({
      fieldName: 'Go-live day',
      valueType: 'date',
      to: { value: '2026-10-13', display: null },
    });
    expect(row(moment)).toMatchObject({
      fieldName: 'Cut-over',
      valueType: 'datetime',
      to: { value: '2026-10-13T09:00:00.000Z', display: null },
    });
    expect(row(note)).toMatchObject({ fieldName: 'Rollout note', valueType: null });
    expect(row(gone)).toMatchObject({ fieldName: null, valueType: 'date' });
    // A system field's row carries neither.
    const summary = rows.find((r) => r.field === 'summary');
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('fieldName');
    expect(summary).not.toHaveProperty('valueType');
  });

  it('[CORE-010] checks values on write: numbers, text length, references and read-only text', async () => {
    const points = await field({ name: 'Estimate points', type: 'number' });
    const title = await field({ name: 'Short title', type: 'text' });
    const shipped = await field({ name: 'Target release', type: 'release' });
    const external = await field({ name: 'External id', type: 'read-only-text' });
    const other = (
      await post('admin', `/api/v1/tracks/${tracks.YT}/releases`, { name: 'Y1' })
    ).json().release;
    const res = await create('XT', {
      fields: {
        [points.id]: 2e12,
        [title.id]: 'x'.repeat(256),
        [shipped.id]: other.id,
        999999: 'x',
        nonsense: 1,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(errorsOf(res)).toEqual({
      [`fields.${points.id}`]: 'out_of_range',
      [`fields.${title.id}`]: 'too_long',
      [`fields.${shipped.id}`]: 'not_in_track',
      'fields.999999': 'unknown_field',
      'fields.nonsense': 'unknown_field',
    });
    const own = (await post('admin', `/api/v1/tracks/${tracks.XT}/releases`, { name: 'X9' })).json()
      .release;
    expect((await ticket('XT', { fields: { [shipped.id]: own.id } })).fields[shipped.id]).toEqual({
      id: own.id,
      name: 'X9',
    });
    expect((await ticket('XT', { fields: { [points.id]: '5e3' } })).fields[points.id]).toBe(5000);
    // Read-only text is written by integrations (a token), never from the UI.
    const ui = await create('XT', { fields: { [external.id]: 'EXT-1' } });
    expect(errorsOf(ui)).toEqual({ [`fields.${external.id}`]: 'read_only' });
    const api = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      remoteAddress: nextAddress(),
      headers: { authorization: `Bearer ${token}` },
      payload: { track: 'XT', summary: 'From a script', fields: { [external.id]: 'EXT-1' } },
    });
    expect(api.statusCode, api.body).toBe(201);
    expect(api.json().ticket.fields[external.id]).toBe('EXT-1');
  });

  it('[CORE-009] offers options {A, B} in track X and {C} in track Y; contexts never overlap', async () => {
    const f = await field({
      name: 'Region',
      type: 'select',
      context: { name: 'X', trackIds: [tracks.XT], options: [{ value: 'A' }, { value: 'B' }] },
    });
    const added = await post('admin', `/api/v1/fields/${f.id}/contexts`, {
      name: 'Y',
      trackIds: [tracks.YT],
      options: [{ value: 'C', default: true }],
    });
    expect(added.statusCode, added.body).toBe(201);
    const [x, y] = added.json().field.contexts as ContextJson[];
    const offered = async (track: string, typeId = types.Feature) =>
      (await get('alice', `/api/v1/tracks/${track}/fields?ticketTypeId=${typeId}`))
        .json()
        .fields.find((g: { id: number }) => g.id === f.id);
    expect((await offered('XT')).options.map((o: { value: string }) => o.value)).toEqual([
      'A',
      'B',
    ]);
    expect((await offered('YT')).options.map((o: { value: string }) => o.value)).toEqual(['C']);
    expect(await offered('LOC')).toBeUndefined();
    const a = x?.options[0]?.id as number;
    const c = y?.options[0]?.id as number;
    expect((await ticket('XT', { fields: { [f.id]: a } })).fields[f.id]).toEqual({
      id: a,
      value: 'A',
    });
    expect(errorsOf(await create('XT', { fields: { [f.id]: c } }))).toEqual({
      [`fields.${f.id}`]: 'not_found',
    });
    // Track Y's context gives its default to new tickets there.
    expect((await ticket('YT')).fields[f.id]).toEqual({ id: c, value: 'C' });
    // A field where no context covers the track does not apply.
    expect(errorsOf(await create('LOC', { fields: { [f.id]: a } }))).toEqual({
      [`fields.${f.id}`]: 'not_applicable',
    });
    // A second context for track X clashes with the first.
    const clash = await post('admin', `/api/v1/fields/${f.id}/contexts`, {
      name: 'X again',
      trackIds: [tracks.XT],
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toEqual({ error: 'context_overlap', contextId: x?.id });
    // The most specific context wins: Bugs in track X get their own options.
    const bugs = await post('admin', `/api/v1/fields/${f.id}/contexts`, {
      name: 'X bugs',
      trackIds: [tracks.XT],
      ticketTypeIds: [types.Bug],
      options: [{ value: 'Z' }],
    });
    expect(bugs.statusCode, bugs.body).toBe(201);
    expect((await offered('XT', types.Bug)).options.map((o: { value: string }) => o.value)).toEqual(
      ['Z'],
    );
    expect(
      (await offered('XT', types.Feature)).options.map((o: { value: string }) => o.value),
    ).toEqual(['A', 'B']);
    // Only administrators change shared fields.
    expect((await patch('alice', `/api/v1/fields/${f.id}`, { name: 'Mine' })).statusCode).toBe(403);
  });

  it('[CORE-009] a user picker restricted to group G offers and accepts only members of G', async () => {
    const g = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'G' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const child = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'G child' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('group_nesting')
      .values({ workspace_id: 1, parent_id: g.id, child_id: child.id })
      .execute();
    await database.db
      .insertInto('group_member')
      .values([
        { workspace_id: 1, group_id: g.id, user_id: users.bob?.id as number },
        { workspace_id: 1, group_id: child.id, user_id: users.carol?.id as number },
      ])
      .execute();
    const f = await field({
      name: 'Approver',
      type: 'user',
      context: { config: { userGroupId: g.id } },
    });
    const people = await get(
      'alice',
      `/api/v1/fields/${f.id}/people?track=XT&ticketTypeId=${types.Feature}`,
    );
    expect(people.json().people.map((p: { name: string }) => p.name)).toEqual(['bob', 'carol']);
    const narrowed = await get(
      'alice',
      `/api/v1/fields/${f.id}/people?track=XT&ticketTypeId=${types.Feature}&q=car`,
    );
    expect(narrowed.json().people).toEqual([{ id: users.carol?.id, name: 'carol' }]);
    expect((await ticket('XT', { fields: { [f.id]: users.carol?.id } })).fields[f.id]).toEqual({
      id: users.carol?.id,
      name: 'carol',
    });
    expect(errorsOf(await create('XT', { fields: { [f.id]: users.alice?.id } }))).toEqual({
      [`fields.${f.id}`]: 'not_allowed',
    });
    // Lifting the restriction offers everyone again.
    const lifted = await patch('admin', `/api/v1/fields/${f.id}/contexts/${f.contexts[0]?.id}`, {
      config: { userGroupId: null },
    });
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect((await ticket('XT', { fields: { [f.id]: users.alice?.id } })).fields[f.id]).toEqual({
      id: users.alice?.id,
      name: 'alice',
    });
  });

  it('[CORE-010] a group picker offers the site groups by name to those who may browse them (T-265)', async () => {
    const [ops, design] = await database.db
      .insertInto('user_group')
      .values([
        { workspace_id: 1, name: 'Picker ops' },
        { workspace_id: 1, name: 'Picker design' },
      ])
      .returning(['id', 'name'])
      .execute();
    const f = await field({ name: 'Owning group', type: 'group' });
    const all = await get('alice', `/api/v1/fields/${f.id}/groups?q=picker`);
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json().groups).toEqual([
      { id: design?.id, name: 'Picker design' },
      { id: ops?.id, name: 'Picker ops' },
    ]);
    const narrowed = await get('alice', `/api/v1/fields/${f.id}/groups?q=OPS&limit=5`);
    expect(narrowed.json().groups).toEqual([{ id: ops?.id, name: 'Picker ops' }]);
    // What the picker offers, the create route takes.
    expect((await ticket('XT', { fields: { [f.id]: ops?.id } })).fields[f.id]).toEqual({
      id: ops?.id,
      name: 'Picker ops',
    });
    // Only for a group field.
    const text = await field({ name: 'Not groups', type: 'text' });
    expect((await get('alice', `/api/v1/fields/${text.id}/groups`)).statusCode).toBe(404);
    // Not to people without "Browse users and groups".
    await database.db.deleteFrom('global_grant').where('permission', '=', 'browse_users').execute();
    try {
      expect((await get('alice', `/api/v1/fields/${f.id}/groups`)).statusCode).toBe(403);
    } finally {
      await database.db
        .insertInto('global_grant')
        .values({ workspace_id: 1, permission: 'browse_users', grantee: 'any_user' })
        .execute();
    }
  });

  it('[CORE-009] renames, reorders and disables options without changing stored ids', async () => {
    const f = await field({
      name: 'Browser',
      type: 'select',
      context: { options: [{ value: 'Firefox' }, { value: 'Chrome' }, { value: 'Safari' }] },
    });
    const context = f.contexts[0] as ContextJson;
    const [firefox, chrome, safari] = context.options.map((o) => o.id) as [number, number, number];
    const base = `/api/v1/fields/${f.id}/contexts/${context.id}/options`;
    const t = await ticket('XT', { fields: { [f.id]: chrome } });
    const renamed = await patch('admin', `${base}/${chrome}`, { value: 'Chromium' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await view(t)).fields[f.id]).toEqual({ id: chrome, value: 'Chromium' });
    const ordered = await put('admin', `${base}/order`, { optionIds: [safari, chrome, firefox] });
    expect(ordered.statusCode, ordered.body).toBe(200);
    expect((ordered.json().field as FieldJson).contexts[0]?.options.map((o) => o.value)).toEqual([
      'Safari',
      'Chromium',
      'Firefox',
    ]);
    // A partial order is refused.
    expect((await put('admin', `${base}/order`, { optionIds: [safari] })).statusCode).toBe(400);
    expect((await patch('admin', `${base}/${chrome}`, { disabled: true })).statusCode).toBe(200);
    // Kept on the ticket that has it, hidden for new values.
    expect((await view(t)).fields[f.id]).toEqual({ id: chrome, value: 'Chromium' });
    const keep = await patch('alice', `/api/v1/tickets/${t.id}`, {
      fields: { [f.id]: chrome },
      summary: 'Still Chromium',
    });
    expect(keep.statusCode, keep.body).toBe(200);
    expect(errorsOf(await create('XT', { fields: { [f.id]: chrome } }))).toEqual({
      [`fields.${f.id}`]: 'disabled_option',
    });
    const offered = (await get('alice', `/api/v1/tracks/XT/fields?ticketTypeId=${types.Feature}`))
      .json()
      .fields.find((g: { id: number }) => g.id === f.id);
    expect(offered.options.map((o: { value: string }) => o.value)).toEqual(['Safari', 'Firefox']);
    // An option in use is not deleted; an unused one is.
    const inUse = await del('admin', `${base}/${chrome}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json()).toEqual({ error: 'in_use', ticketCount: 1 });
    expect((await del('admin', `${base}/${firefox}`)).statusCode).toBe(204);
    // So are the field and its contexts while tickets hold values.
    expect((await del('admin', `/api/v1/fields/${f.id}/contexts/${context.id}`)).json()).toEqual({
      error: 'options_in_use',
      ticketCount: 1,
    });
    expect((await del('admin', `/api/v1/fields/${f.id}`)).json()).toEqual({
      error: 'in_use',
      ticketCount: 1,
    });
    // The value must be gone before the field can go: a failed change shows here, not below.
    const cleared = await patch('alice', `/api/v1/tickets/${t.id}`, { fields: { [f.id]: null } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await del('admin', `/api/v1/fields/${f.id}`)).statusCode).toBe(204);
    expect((await get('admin', `/api/v1/fields/${f.id}`)).statusCode).toBe(404);
  });

  it('[CORE-003] a local field stays in its track; local tracks take 51 fields and selects with 56 options', async () => {
    // Alice administers LOC; she makes its fields, which no other track sees.
    const local = await field(
      {
        name: 'Local only',
        type: 'select',
        trackId: tracks.LOC,
        context: { options: Array.from({ length: 56 }, (_, i) => ({ value: `Option ${i + 1}` })) },
      },
      'alice',
    );
    expect(local.trackId).toBe(tracks.LOC);
    expect(local.contexts[0]?.trackIds).toEqual([tracks.LOC]);
    expect(local.contexts[0]?.options).toHaveLength(56);
    const fifty = [local];
    for (let i = 2; i <= 51; i++) {
      fifty.push(await field({ name: `Local ${i}`, type: 'text', trackId: tracks.LOC }, 'alice'));
    }
    const offered = (await get('alice', `/api/v1/tracks/LOC/fields?ticketTypeId=${types.Feature}`))
      .json()
      .fields.map((g: { id: number }) => g.id);
    for (const g of fifty) expect(offered).toContain(g.id);
    const option = local.contexts[0]?.options[55]?.id as number;
    expect((await ticket('LOC', { fields: { [local.id]: option } })).fields[local.id]).toEqual({
      id: option,
      value: 'Option 56',
    });
    // Editing it in track LOC has no effect on track LOB (CORE-003 (1)).
    expect(errorsOf(await create('LOB', { fields: { [local.id]: option } }))).toEqual({
      [`fields.${local.id}`]: 'not_applicable',
    });
    const reach = await post('alice', `/api/v1/fields/${local.id}/contexts`, {
      name: 'Elsewhere',
      trackIds: [tracks.LOB],
    });
    expect(reach.statusCode).toBe(400);
    expect(
      (await get('bob', `/api/v1/fields?trackId=${tracks.LOB}`))
        .json()
        .fields.some((g: { id: number }) => g.id === local.id),
    ).toBe(false);
    // Bob is a member of LOC, not an administrator: he reads its fields but does not change them.
    expect((await get('bob', `/api/v1/fields/${local.id}`)).statusCode).toBe(200);
    expect((await patch('bob', `/api/v1/fields/${local.id}`, { name: 'Bob' })).statusCode).toBe(
      403,
    );
    // Local fields belong to local-mode tracks only.
    const shared = await post('admin', '/api/v1/fields', {
      name: 'Not local',
      type: 'text',
      trackId: tracks.XT,
    });
    expect(shared.statusCode).toBe(409);
    expect(shared.json()).toEqual({ error: 'track_not_local' });
  });

  it('[CORE-010] fixes type and multiplicity at creation and checks type settings', async () => {
    expect(
      (await post('admin', '/api/v1/fields', { name: 'Bad', type: 'number', multiple: true }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post('admin', '/api/v1/fields', {
          name: 'Bad',
          type: 'text',
          config: { decimals: 2 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post('admin', '/api/v1/fields', {
          name: 'Bad',
          type: 'select',
          config: { display: 'checkboxes' },
        })
      ).statusCode,
    ).toBe(400);
    const f = await field({
      name: 'Cost',
      type: 'number',
      config: { format: 'currency', currency: 'EUR' },
    });
    expect((await patch('admin', `/api/v1/fields/${f.id}`, { type: 'text' })).statusCode).toBe(400);
    expect((await post('admin', '/api/v1/fields', { name: 'cost', type: 'text' })).json()).toEqual({
      error: 'name_taken',
    });
    const paragraph = await field({
      name: 'Long notes',
      type: 'paragraph',
      config: { maxChars: 10 },
    });
    const tooLong = await create('XT', {
      fields: {
        [paragraph.id]: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'eleven char' }] }],
        },
      },
    });
    expect(errorsOf(tooLong)).toEqual({ [`fields.${paragraph.id}`]: 'too_long' });
  });
});
