import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { addDays, todayIn } from '../templates/model';

// Made for this run: no password is written in the repository.
const PASSWORD = `tt-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.113.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

type Who = 'admin' | 'alice' | 'carol' | 'dave';

/**
 * Ticket templates (CORE-029, CORE-030; ADR-113). Alice is a member of the tracks without
 * "Assign tickets" and "Schedule tickets"; Carol administers them; Dave is in none.
 */
describe('ticket templates (CORE-029, CORE-030)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<Who, { id: number; cookie: string }> = {} as never;
  const types: Record<string, number> = {};
  const tracks: Record<string, number> = {};
  let trackCount = 0;

  const call = (who: Who, method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      remoteAddress: nextAddress(),
      headers: { cookie: users[who].cookie },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const ok = (res: LightMyRequestResponse, code = 200) => {
    expect(res.statusCode, res.body).toBe(code);
    return res.json();
  };

  async function track(): Promise<string> {
    const key = `TT${++trackCount}`;
    const made = ok(
      await call('admin', 'POST', '/api/v1/tracks', { key, name: key, mode: 'shared' }),
      201,
    );
    tracks[key] = made.track.id;
    const roles = await database.db.selectFrom('role').select(['id', 'name']).execute();
    for (const [who, role] of [
      ['alice', 'Members'],
      ['carol', 'Administrators'],
    ] as const) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: made.track.id,
          role_id: roles.find((r) => r.name === role)?.id as number,
          user_id: users[who].id,
        })
        .execute();
    }
    return key;
  }

  const template = async (who: Who, body: Record<string, unknown>, code = 201) =>
    ok(await call(who, 'POST', '/api/v1/ticket-templates', body), code);
  const apply = (who: Who, id: number, body: Record<string, unknown> = {}) =>
    call(who, 'POST', `/api/v1/ticket-templates/${id}/tickets`, body);
  const ticket = async (key: string) =>
    ok(await call('admin', 'GET', `/api/v1/tickets/${key}`)).ticket;
  const lastEvent = () =>
    database.db
      .selectFrom('domain_event')
      .select(['type', 'payload', 'subject_id', 'actor_id'])
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    // Members here may create but not assign or schedule.
    const members = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    await database.db
      .deleteFrom('access_grant')
      .where('role_id', '=', members.id)
      .where('permission', 'in', ['assign_tickets', 'schedule_tickets'])
      .execute();
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['carol', false],
      ['dave', false],
    ] as const) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name: name[0]?.toUpperCase() + name.slice(1),
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
    for (const t of await database.db.selectFrom('ticket_type').select(['id', 'name']).execute()) {
      types[t.name] = t.id;
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-029] (1) track administrators keep templates for their track; members read them', async () => {
    const key = await track();
    const made = (
      await template('carol', {
        track: key,
        name: 'Bug report',
        purpose: 'For defects found in testing',
        summary: 'Bug: ',
        defaults: { labels: ['bug'], dueInDays: 7 },
      })
    ).template;
    expect(made).toMatchObject({
      name: 'Bug report',
      track: { key },
      ticketTypeIds: [],
      defaults: { labels: ['bug'], dueInDays: 7 },
      mayEdit: true,
      version: 1,
    });
    expect(made.description).toBeNull();
    // The outline in Markdown, kept as a document.
    const withOutline = ok(
      await call('carol', 'PATCH', `/api/v1/ticket-templates/${made.id}?format=markdown`, {
        description: '## Steps\n\n1. First',
      }),
    ).template;
    expect(withOutline.description).toMatch(/Steps/);
    expect(withOutline.version).toBe(2);
    const updated = await lastEvent();
    expect(updated.type).toBe('ticket_template.updated');
    expect(Object.keys((updated.payload as { changes: object }).changes)).toEqual(['description']);

    // Alice reads it and may not change it; Dave, outside the track, does not see it.
    const list = ok(await call('alice', 'GET', `/api/v1/ticket-templates?track=${key}`));
    expect(list.templates.map((t: { name: string }) => t.name)).toContain('Bug report');
    expect(list.mayCreate).toBe(false);
    expect(list.templates.find((t: { id: number }) => t.id === made.id).mayEdit).toBe(false);
    expect(
      (await call('alice', 'PATCH', `/api/v1/ticket-templates/${made.id}`, { name: 'X' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('alice', 'POST', '/api/v1/ticket-templates', { track: key, name: 'Mine' }))
        .statusCode,
    ).toBe(403);
    expect((await call('dave', 'GET', `/api/v1/ticket-templates/${made.id}`)).statusCode).toBe(404);
    expect((await call('dave', 'GET', `/api/v1/ticket-templates?track=${key}`)).statusCode).toBe(
      404,
    );

    // Names are unique in a track, ignoring case; a stale version is refused.
    expect(
      ok(
        await call('carol', 'POST', '/api/v1/ticket-templates', { track: key, name: 'bug REPORT' }),
        400,
      ).fields,
    ).toEqual({ name: 'taken' });
    expect(
      (
        await call('carol', 'PATCH', `/api/v1/ticket-templates/${made.id}`, {
          name: 'Y',
          version: 1,
        })
      ).statusCode,
    ).toBe(409);

    expect((await call('carol', 'DELETE', `/api/v1/ticket-templates/${made.id}`)).statusCode).toBe(
      204,
    );
    const deleted = await lastEvent();
    expect(deleted).toMatchObject({
      type: 'ticket_template.deleted',
      payload: { name: 'Bug report', trackId: tracks[key] },
      actor_id: users.carol.id,
    });
    expect((await call('carol', 'GET', `/api/v1/ticket-templates/${made.id}`)).statusCode).toBe(
      404,
    );
  });

  it('[CORE-029] (2) templates for every track are kept by configuration administrators and offered in every track', async () => {
    const key = await track();
    expect(
      (await call('carol', 'POST', '/api/v1/ticket-templates', { name: 'Everywhere' })).statusCode,
    ).toBe(403);
    const global = (await template('admin', { name: 'Everywhere', summary: 'Note from {user}' }))
      .template;
    expect(global.track).toBeNull();
    // Areas and releases belong to a track: a template for every track cannot name them.
    const area = ok(
      await call('admin', 'POST', `/api/v1/tracks/${tracks[key]}/areas`, { name: 'Web' }),
      201,
    ).area;
    expect(
      ok(
        await call('admin', 'POST', '/api/v1/ticket-templates', {
          name: 'With area',
          defaults: { areaIds: [area.id] },
        }),
        400,
      ).fields,
    ).toEqual({ 'defaults.areaIds': 'track_only' });
    // Another track's area is not this one's.
    const other = await track();
    expect(
      ok(
        await call('admin', 'POST', '/api/v1/ticket-templates', {
          track: other,
          name: 'Wrong area',
          defaults: { areaIds: [area.id] },
        }),
        400,
      ).fields,
    ).toEqual({ 'defaults.areaIds.0': 'not_found' });

    const offered = ok(
      await call('alice', 'GET', `/api/v1/ticket-templates?track=${key}`),
    ).templates;
    expect(offered.map((t: { name: string }) => t.name)).toContain('Everywhere');
    const read = ok(
      await call('alice', 'GET', `/api/v1/ticket-templates/${global.id}?track=${key}`),
    );
    expect(read.start).toEqual({ summary: 'Note from Alice' });
    const made = ok(await apply('alice', global.id, { track: key }), 201);
    expect(made.ticket.summary).toBe('Note from Alice');
    // A template for every track needs one named.
    expect(ok(await apply('alice', global.id), 400).fields).toEqual({ track: 'required' });
  });

  it('[CORE-029] (3) a template limited to ticket types is offered for those only', async () => {
    const key = await track();
    const bugs = (
      await template('carol', { track: key, name: 'Bugs only', ticketTypeIds: [types.Bug] })
    ).template;
    const forChore = ok(
      await call(
        'alice',
        'GET',
        `/api/v1/ticket-templates?track=${key}&ticketTypeId=${types.Chore}`,
      ),
    ).templates;
    expect(forChore.map((t: { id: number }) => t.id)).not.toContain(bugs.id);
    const forBug = ok(
      await call('alice', 'GET', `/api/v1/ticket-templates?track=${key}&ticketTypeId=${types.Bug}`),
    ).templates;
    expect(forBug.map((t: { id: number }) => t.id)).toContain(bugs.id);
    expect(
      ok(await apply('alice', bugs.id, { summary: 'S', ticketTypeId: types.Chore }), 400).fields,
    ).toEqual({ ticketTypeId: 'not_in_template' });
    // Without a type, the template's own.
    const made = ok(await apply('alice', bugs.id, { summary: 'A bug' }), 201);
    expect(made.ticket.ticketType.id).toBe(types.Bug);
  });

  it('[CORE-029][CORE-015][CORE-016] refuses to save a template naming an archived release or area, custom or not, with the create route’s code (T-287)', async () => {
    const key = await track();
    const other = await track();
    const made = async (path: string, name: string, at = key) =>
      ok(await call('admin', 'POST', `/api/v1/tracks/${tracks[at]}/${path}`, { name }), 201);
    const old = (await made('releases', 'R0')).release;
    const live = (await made('releases', 'R1')).release;
    const legacy = (await made('areas', 'Legacy')).area;
    const elsewhere = (await made('areas', 'Elsewhere', other)).area;
    ok(await call('admin', 'POST', `/api/v1/releases/${old.id}/archive`, {}));
    ok(await call('admin', 'POST', `/api/v1/areas/${legacy.id}/archive`, {}));
    const field = async (name: string, type: string, multiple = false) =>
      ok(
        await call('admin', 'POST', '/api/v1/fields', {
          name: `${name} ${key}`,
          type,
          ...(multiple ? { multiple } : {}),
        }),
        201,
      ).field.id as number;
    const shippedIn = await field('Shipped in', 'release');
    const owners = await field('Owning areas', 'area', true);

    const refused = ok(
      await call('carol', 'POST', '/api/v1/ticket-templates', {
        track: key,
        name: 'Archived values',
        defaults: {
          targetReleaseIds: [live.id, old.id],
          areaIds: [legacy.id],
          fields: { [shippedIn]: old.id, [owners]: [legacy.id] },
        },
      }),
      400,
    );
    expect(refused.fields).toEqual({
      'defaults.targetReleaseIds.1': 'archived',
      'defaults.areaIds.0': 'archived',
      [`defaults.fields.${shippedIn}`]: 'archived',
      [`defaults.fields.${owners}`]: 'archived',
    });
    // Another track's value is not this one's, with the create route's code for a custom field.
    expect(
      ok(
        await call('carol', 'POST', '/api/v1/ticket-templates', {
          track: key,
          name: 'Elsewhere',
          defaults: { fields: { [owners]: [elsewhere.id] } },
        }),
        400,
      ).fields,
    ).toEqual({ [`defaults.fields.${owners}`]: 'not_in_track' });

    // Live values save; an edit that names an archived one is refused the same way.
    const saved = (
      await template('carol', {
        track: key,
        name: 'Live values',
        defaults: { fields: { [shippedIn]: live.id } },
      })
    ).template;
    expect(
      ok(
        await call('carol', 'PATCH', `/api/v1/ticket-templates/${saved.id}`, {
          defaults: { fields: { [shippedIn]: old.id } },
        }),
        400,
      ).fields,
    ).toEqual({ [`defaults.fields.${shippedIn}`]: 'archived' });
  });

  it('[CORE-029][CORE-015][CORE-016] keeps an archived release or area a template already holds when it is saved again, refusing only one named anew (T-287)', async () => {
    const key = await track();
    const made = async (path: string, name: string) =>
      ok(await call('admin', 'POST', `/api/v1/tracks/${tracks[key]}/${path}`, { name }), 201);
    const shipped = (await made('releases', 'R1')).release;
    const later = (await made('releases', 'R2')).release;
    const legacy = (await made('areas', 'Legacy')).area;
    const field = async (name: string, type: string, multiple = false) =>
      ok(
        await call('admin', 'POST', '/api/v1/fields', {
          name: `${name} ${key}`,
          type,
          ...(multiple ? { multiple } : {}),
        }),
        201,
      ).field.id as number;
    const shippedIn = await field('Shipped in', 'release');
    const owners = await field('Owning areas', 'area', true);
    const defaults = {
      targetReleaseIds: [shipped.id],
      areaIds: [legacy.id],
      fields: { [shippedIn]: shipped.id, [owners]: [legacy.id] },
    };
    const saved = (await template('carol', { track: key, name: 'Release checklist', defaults }))
      .template;
    // R1 ships and is archived, and so is the area, after the template was saved.
    ok(await call('admin', 'POST', `/api/v1/releases/${shipped.id}/archive`, {}));
    ok(await call('admin', 'POST', `/api/v1/releases/${later.id}/archive`, {}));
    ok(await call('admin', 'POST', `/api/v1/areas/${legacy.id}/archive`, {}));

    // The form sends back every value it holds with a new name: the save goes through.
    const renamed = ok(
      await call('carol', 'PATCH', `/api/v1/ticket-templates/${saved.id}`, {
        name: 'Release checklist (old)',
        defaults,
      }),
    ).template;
    expect(renamed.name).toBe('Release checklist (old)');
    expect(renamed.defaults).toEqual(defaults);
    // A ticket made from it leaves the archived values out and names them.
    const fromIt = ok(await apply('alice', saved.id, { summary: 'After the release' }), 201);
    expect([...fromIt.left].sort()).toEqual(
      ['areaIds', 'targetReleaseIds', `fields.${shippedIn}`, `fields.${owners}`].sort(),
    );
    // An archived value the template did not hold is still refused, in its own field or a custom one.
    expect(
      ok(
        await call('carol', 'PATCH', `/api/v1/ticket-templates/${saved.id}`, {
          defaults: {
            ...defaults,
            targetReleaseIds: [shipped.id, later.id],
            fields: { [shippedIn]: later.id, [owners]: [legacy.id] },
          },
        }),
        400,
      ).fields,
    ).toEqual({
      'defaults.targetReleaseIds.1': 'archived',
      [`defaults.fields.${shippedIn}`]: 'archived',
    });
  });

  it('[CORE-030] (1) creates a ticket with the template’s values, the person’s edits winning, and its subtickets', async () => {
    const key = await track();
    const field = ok(
      await call('admin', 'POST', '/api/v1/fields', { name: `Customer ${key}`, type: 'text' }),
      201,
    ).field;
    const priorities = ok(await call('admin', 'GET', '/api/v1/priorities')).priorities;
    const high = priorities[0].id as number;
    const tpl = (
      await template('carol', {
        track: key,
        name: 'Release',
        summary: 'Release {track} {date}',
        description: {
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: { level: 2 },
              content: [{ type: 'text', text: 'Checklist' }],
            },
          ],
        },
        defaults: {
          priorityId: high,
          labels: ['release'],
          assigneeId: users.carol.id,
          dueInDays: 7,
          fields: { [field.id]: 'Acme' },
        },
        subtickets: [{ summary: 'Notes for {track}' }, { summary: 'Announce' }],
      })
    ).template;
    const made = ok(await apply('carol', tpl.id, { labels: ['release', 'q4'] }), 201);
    const today = todayIn(null);
    expect(made.ticket).toMatchObject({
      summary: `Release ${key} ${today}`,
      priority: { id: high },
      labels: ['release', 'q4'],
      dueDate: addDays(today, 7),
      assignee: { id: users.carol.id },
    });
    expect(made.ticket.fields[field.id]).toBe('Acme');
    expect(made.ticket.description.content[0].content[0].text).toBe('Checklist');
    expect(made.left).toEqual([]);
    expect(
      made.subtickets.map((s: { summary: string; error: null }) => [s.summary, s.error]),
    ).toEqual([
      [`Notes for ${key}`, null],
      ['Announce', null],
    ]);
    const sub = await ticket(made.subtickets[0].key);
    expect(sub.parent.key).toBe(made.ticket.key);
    // One ticket.created for each ticket made, the template named; nothing else.
    const events = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload'])
      .where('type', '=', 'ticket.created')
      .execute();
    expect(
      events.filter((e) => (e.payload as { templateId?: number }).templateId === tpl.id),
    ).toHaveLength(3);
    // Subtickets are optional, and a template value can be left out by name.
    const plain = ok(
      await apply('carol', tpl.id, {
        subtickets: false,
        omit: ['assigneeId', `fields.${field.id}`],
      }),
      201,
    );
    expect(plain.subtickets).toEqual([]);
    expect(plain.ticket.assignee).toBeNull();
    expect(plain.ticket.fields[field.id] ?? null).toBeNull();
  });

  it('[CORE-030] (2) never sets a value the person may not set: the template’s is left out, theirs is refused', async () => {
    const key = await track();
    const tpl = (
      await template('carol', {
        track: key,
        name: 'Planned',
        summary: 'Planned work',
        defaults: { assigneeId: users.carol.id, dueInDays: 3, labels: ['planned'] },
      })
    ).template;
    // Alice may neither assign nor schedule here.
    const made = ok(await apply('alice', tpl.id), 201);
    expect(made.left.sort()).toEqual(['assigneeId', 'dueDate']);
    expect(made.ticket).toMatchObject({ assignee: null, dueDate: null, labels: ['planned'] });
    // Her own assignee is hers: refused, not left out.
    const own = await apply('alice', tpl.id, { assigneeId: users.alice.id });
    expect(own.statusCode).toBe(403);
    // Starting values the form shows unchanged still count as the template's.
    const read = ok(await call('alice', 'GET', `/api/v1/ticket-templates/${tpl.id}?track=${key}`));
    const again = ok(await apply('alice', tpl.id, read.start), 201);
    expect(again.left.sort()).toEqual(['assigneeId', 'dueDate']);
    // Without "Create tickets" nothing is made.
    expect((await apply('dave', tpl.id)).statusCode).toBe(404);
  });

  it('[CORE-030] (3) never sets a field a field rule hides', async () => {
    const key = await track();
    const rules = ok(
      await call('admin', 'POST', '/api/v1/field-rule-sets', {
        name: `Hide labels ${key}`,
        rules: [{ field: 'labels', hidden: true }],
      }),
      201,
    ).fieldRuleSet;
    ok(await call('admin', 'PATCH', `/api/v1/tracks/${tracks[key]}`, { fieldRuleSetId: rules.id }));
    const tpl = (
      await template('carol', {
        track: key,
        name: 'Labelled',
        summary: 'Labelled',
        defaults: { labels: ['hidden-here'] },
      })
    ).template;
    const made = ok(await apply('carol', tpl.id), 201);
    expect(made.left).toEqual(['labels']);
    expect(made.ticket.labels).toEqual([]);
    const theirs = await apply('carol', tpl.id, { labels: ['mine'] });
    expect(theirs.statusCode).toBe(400);
    expect(theirs.json().fields).toEqual({ labels: 'hidden' });
  });

  it('[CORE-030] (3) never sets a custom field a field rule hides, and names who a template assigns', async () => {
    const key = await track();
    const field = ok(
      await call('admin', 'POST', '/api/v1/fields', { name: `Secret ${key}`, type: 'text' }),
      201,
    ).field;
    const rules = ok(
      await call('admin', 'POST', '/api/v1/field-rule-sets', {
        name: `Hide secret ${key}`,
        rules: [{ field: `cf[${field.id}]`, hidden: true }],
      }),
      201,
    ).fieldRuleSet;
    ok(await call('admin', 'PATCH', `/api/v1/tracks/${tracks[key]}`, { fieldRuleSetId: rules.id }));
    const tpl = (
      await template('carol', {
        track: key,
        name: 'Secretive',
        summary: 'Secretive',
        defaults: { assigneeId: users.carol.id, fields: { [field.id]: 'hush' } },
      })
    ).template;
    expect(tpl.assignee).toEqual({ id: users.carol.id, name: 'Carol' });
    const made = ok(await apply('carol', tpl.id), 201);
    expect(made.left).toEqual([`fields.${field.id}`]);
    expect(made.ticket.fields[field.id] ?? null).toBeNull();
    expect(made.ticket.assignee).toMatchObject({ id: users.carol.id });
  });

  it('[CORE-030] names the people, groups and teams a template starts with, only to those who may see them (T-276)', async () => {
    const key = await track();
    const field = async (name: string, type: string, multiple = false) =>
      ok(
        await call('admin', 'POST', '/api/v1/fields', {
          name: `${name} ${key}`,
          type,
          ...(multiple ? { multiple } : {}),
        }),
        201,
      ).field as { id: number };
    const reviewer = await field('Reviewer', 'user');
    const watchers = await field('Watchers', 'user', true);
    const owners = await field('Owners', 'group');
    const team = await field('Team', 'team');
    const [group] = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: `Owners of ${key}` })
      .returning('id')
      .execute();
    const [squad] = await database.db
      .insertInto('team')
      .values({ workspace_id: 1, name: `Squad ${key}` })
      .returning('id')
      .execute();
    const gone = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: `gone-${key.toLowerCase()}@example.com`,
        name: 'Gone',
        deactivated_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const tpl = (
      await template('carol', {
        track: key,
        name: 'Named',
        summary: 'Named',
        defaults: {
          fields: {
            [reviewer.id]: users.carol.id,
            [watchers.id]: [users.alice.id, gone.id],
            [owners.id]: group?.id,
            [team.id]: squad?.id,
          },
        },
      })
    ).template;
    const read = ok(await call('alice', 'GET', `/api/v1/ticket-templates/${tpl.id}?track=${key}`));
    expect(read.names).toEqual({
      [`fields.${reviewer.id}`]: [{ id: users.carol.id, name: 'Carol' }],
      // A deactivated person is no one a picker offers: unnamed, the value stays in the list.
      [`fields.${watchers.id}`]: [{ id: users.alice.id, name: 'Alice' }],
      [`fields.${owners.id}`]: [{ id: group?.id, name: `Owners of ${key}` }],
      [`fields.${team.id}`]: [{ id: squad?.id, name: `Squad ${key}` }],
    });
    // Without "Browse users and groups" no person or group is named; teams still are.
    await database.db.deleteFrom('global_grant').where('permission', '=', 'browse_users').execute();
    try {
      const blind = ok(
        await call('alice', 'GET', `/api/v1/ticket-templates/${tpl.id}?track=${key}`),
      );
      expect(blind.names).toEqual({
        [`fields.${team.id}`]: [{ id: squad?.id, name: `Squad ${key}` }],
      });
      expect(blind.start.fields[reviewer.id]).toBe(users.carol.id);
    } finally {
      await database.db
        .insertInto('global_grant')
        .values({ workspace_id: 1, permission: 'browse_users', grantee: 'any_user' })
        .execute();
    }
    // Read without a track, to edit it (T-299): no start, and the names of its own values.
    const plain = ok(await call('alice', 'GET', `/api/v1/ticket-templates/${tpl.id}`));
    expect(plain.start).toBeUndefined();
    expect(plain.names).toEqual(read.names);
  });

  it('[CORE-029] names the people, groups and teams a template for every track holds, to edit it (T-299)', async () => {
    const reviewer = ok(
      await call('admin', 'POST', '/api/v1/fields', { name: 'Reviewer T-299', type: 'user' }),
      201,
    ).field as { id: number };
    const tpl = (
      await template('admin', {
        track: null,
        name: 'Every track, named',
        summary: 'Named',
        defaults: { fields: { [reviewer.id]: users.carol.id } },
      })
    ).template;
    const read = ok(await call('dave', 'GET', `/api/v1/ticket-templates/${tpl.id}`));
    expect(read.names).toEqual({
      [`fields.${reviewer.id}`]: [{ id: users.carol.id, name: 'Carol' }],
    });
    // A template with no such values names none.
    const plain = (await template('admin', { track: null, name: 'Plain', summary: 'Plain' }))
      .template;
    expect(ok(await call('dave', 'GET', `/api/v1/ticket-templates/${plain.id}`)).names).toEqual({});
  });

  it('[CORE-030] (2) leaves out an assignee who cannot be assigned here', async () => {
    const key = await track();
    const tpl = (
      await template('carol', {
        track: key,
        name: 'For Dave',
        summary: 'For Dave',
        defaults: { assigneeId: users.dave.id },
      })
    ).template;
    const made = ok(await apply('carol', tpl.id), 201);
    expect(made.left).toEqual(['assigneeId']);
    expect(made.ticket.assignee).toBeNull();
    // The person's own choice of Dave is refused, not left out.
    const own = await apply('carol', tpl.id, { assigneeId: users.dave.id, omit: ['assigneeId'] });
    expect(own.statusCode).toBe(400);
    expect(own.json().fields).toEqual({ assigneeId: 'not_assignable' });
  });

  it('[CORE-030] (4) a template of one track does not make tickets in another', async () => {
    const key = await track();
    const other = await track();
    const tpl = (await template('carol', { track: key, name: 'Here', summary: 'Here' })).template;
    expect(ok(await apply('carol', tpl.id, { track: other }), 400).fields).toEqual({
      track: 'not_template_track',
    });
  });
});
