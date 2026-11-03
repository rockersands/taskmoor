import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `tpl-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.90.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Card {
  key: string;
}

/**
 * Track templates and copied configuration (M1-054; CORE-002 (1)): Scrum, Kanban, Bug tracking
 * and Business templates each make a track with a board that shows its tickets, Blank makes
 * none; a track made from another takes its configuration sets and toggles.
 */
describe('track templates (M1-054)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  const types: Record<string, number> = {};

  const call = async (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    code = 200,
  ) => {
    const res = await app.inject({
      method,
      url,
      remoteAddress: nextAddress(),
      headers: { cookie },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(code);
    return res.json();
  };
  const make = (payload: Record<string, unknown>, code = 201) =>
    call('POST', '/api/v1/tracks', { mode: 'shared', ...payload }, code);
  const ticket = async (track: string, summary: string, type?: string) =>
    (
      await call(
        'POST',
        '/api/v1/tickets',
        { track, summary, ...(type ? { ticketTypeId: types[type] } : {}) },
        201,
      )
    ).ticket.key as string;
  const cards = async (board: number) =>
    ((await call('GET', `/api/v1/boards/${board}/data`)).cards as Card[]).map((c) => c.key);

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'admin',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    cookie = sessionCookie(res.headers['set-cookie']);
    for (const y of await database.db
      .selectFrom('ticket_type')
      .select(['id', 'name'])
      .where('owner_track_id', 'is', null)
      .execute()) {
      types[y.name] = y.id;
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-002] Scrum and Kanban templates each make a track with a working board', async () => {
    const scrum = await make({ key: 'SCR', name: 'Payments', template: 'scrum' });
    expect(scrum.track).toMatchObject({
      type: 'software',
      features: { sprints: true, backlog: true },
    });
    expect(scrum.board).toMatchObject({
      name: 'Payments',
      kind: 'scrum',
      location: { type: 'track', track: { key: 'SCR' } },
    });
    const first = await ticket('SCR', 'Accept cards');
    // A Scrum board shows its active sprints: the ticket waits in the backlog.
    const backlog = await call('GET', `/api/v1/boards/${scrum.board.id}/backlog`);
    expect(backlog.backlog.tickets.map((x: Card) => x.key)).toEqual([first]);
    const kanban = await make({ key: 'KAN', name: 'Support', template: 'kanban' });
    expect(kanban.track.features).toMatchObject({ board: true, sprints: false, backlog: false });
    expect(kanban.board.kind).toBe('kanban');
    const second = await ticket('KAN', 'Answer the phone');
    expect(await cards(kanban.board.id)).toEqual([second]);
  });

  it('[CORE-002] Bug tracking shows the bugs; Business is a business track; Blank has no board', async () => {
    const bugs = await make({ key: 'BUG', name: 'Defects', template: 'bug-tracking' });
    expect(bugs.board.kind).toBe('kanban');
    const bug = await ticket('BUG', 'Totals off by a cent', 'Bug');
    await ticket('BUG', 'A new report', 'Feature');
    expect(await cards(bugs.board.id)).toEqual([bug]);
    const business = await make({ key: 'BIZ', name: 'Hiring', template: 'business' });
    expect(business.track).toMatchObject({ type: 'business', features: { sprints: false } });
    const offered = await call('GET', `/api/v1/tracks/${business.track.id}/ticket-types`);
    expect(offered.ticketTypes.map((y: { name: string }) => y.name)).toContain('To-do');
    const todo = await ticket('BIZ', 'Post the job');
    expect(await cards(business.board.id)).toEqual([todo]);
    const blank = await make({ key: 'BLK', name: 'Empty', template: 'blank' });
    expect(blank.board).toBeUndefined();
    expect((await call('GET', `/api/v1/boards?trackId=${blank.track.id}`)).boards).toEqual([]);
    // The template's event names it; the board has its own.
    const events = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload'])
      .where('type', 'in', ['track.created', 'board.created'])
      .orderBy('id')
      .execute();
    expect(
      events
        .filter((e) => e.type === 'track.created')
        .map((e) => (e.payload as { template?: string }).template),
    ).toEqual(['scrum', 'kanban', 'bug-tracking', 'business', 'blank']);
    expect(events.filter((e) => e.type === 'board.created')).toHaveLength(4);
  });

  describe('the Points field (migration 0095)', () => {
    const fieldsNamed = async (name: string) =>
      ((await call('GET', '/api/v1/fields')).fields as { id: number; name: string }[]).filter(
        (f) => f.name === name,
      );
    const estimation = async (board: number) =>
      (await call('GET', `/api/v1/boards/${board}`)).board.sprintSettings.estimation;

    it("[AGL-007] new tracks' boards estimate with it, and it is on the forms to set", async () => {
      const [points] = await fieldsNamed('Points');
      const fieldId = points?.id as number;
      for (const template of ['scrum', 'kanban', 'business']) {
        const key = `P${template.slice(0, 2).toUpperCase()}`;
        const { board } = await make({ key, name: template, template });
        expect(await estimation(board.id), template).toEqual({ statistic: 'field', fieldId });
      }
      const tracked = await ticket('PSC', 'Sized');
      const form = await call('GET', `/api/v1/tickets/${tracked}/layout?operation=edit`);
      expect(
        form.layout.tabs.flatMap((t: { sections: { fields: { key: string }[] }[] }) =>
          t.sections.flatMap((s) => s.fields.map((f) => f.key)),
        ),
      ).toContain(`cf[${fieldId}]`);
      expect(form.customFields.map((f: { id: number }) => f.id)).toContain(fieldId);
      const set = await call('PATCH', `/api/v1/tickets/${tracked}`, {
        fields: { [fieldId]: 5 },
      });
      expect(set.ticket.fields[String(fieldId)]).toBe(5);
      const hits = await call('POST', '/api/v1/search', { q: 'track = PSC AND Points = 5' });
      expect(hits.tickets.map((x: { key: string }) => x.key)).toEqual([tracked]);
    });

    it('[AGL-007] a rename keeps it, and removing it leaves boards on the default', async () => {
      const { board: before } = await make({ key: 'RNA', name: 'Before', template: 'kanban' });
      const [points] = await fieldsNamed('Points');
      const fieldId = points?.id as number;
      await call('PATCH', `/api/v1/fields/${fieldId}`, { name: 'Effort' });
      const { board: renamed } = await make({ key: 'RNB', name: 'Renamed', template: 'scrum' });
      expect(await estimation(renamed.id)).toEqual({ statistic: 'field', fieldId });
      // Removed once no ticket holds a value (as for any field), and not brought back.
      const holders = await database.db
        .selectFrom('ticket')
        .select('id')
        .where(sql<boolean>`fields ? ${String(fieldId)}`)
        .execute();
      for (const { id } of holders) {
        await call('PATCH', `/api/v1/tickets/${id}`, { fields: { [fieldId]: null } });
      }
      const gone = await app.inject({
        method: 'DELETE',
        url: `/api/v1/fields/${fieldId}`,
        remoteAddress: nextAddress(),
        headers: { cookie },
      });
      expect(gone.statusCode, gone.body).toBe(204);
      expect(await estimation(before.id)).toEqual({ statistic: 'originalEstimate' });
      const saved = await call('PATCH', `/api/v1/boards/${renamed.id}`, {
        sprintSettings: (await call('GET', `/api/v1/boards/${renamed.id}`)).board.sprintSettings,
      });
      expect(saved.board.sprintSettings.estimation).toEqual({ statistic: 'originalEstimate' });
      const { board: after } = await make({ key: 'RNC', name: 'After', template: 'kanban' });
      expect(await estimation(after.id)).toEqual({ statistic: 'originalEstimate' });
      expect(await fieldsNamed('Points')).toEqual([]);
      // The tests after this one still start from the seeded field.
      const again = await call('POST', '/api/v1/fields', { name: 'Points', type: 'number' }, 201);
      expect(again.field.name).toBe('Points');
    });
  });

  it('[CORE-002] refuses a template with another type, or with a track to copy', async () => {
    await make({ key: 'BAD', name: 'Bad', template: 'business', type: 'software' }, 400);
    await make({ key: 'BAD', name: 'Bad', template: 'scrum', copyFrom: 1 }, 400);
    await make({ key: 'BAD', name: 'Bad', mode: 'local', copyFrom: 1 }, 400);
  });

  it('[CORE-002] a track made from another takes its configuration sets and toggles', async () => {
    const original = (await make({ key: 'ORG', name: 'Original' })).track;
    const priorities = (
      await database.db.selectFrom('priority').select('id').orderBy('sort_order').execute()
    ).map((p) => p.id);
    const prioritySet = (
      await call(
        'POST',
        '/api/v1/priority-sets',
        { name: 'Two levels', priorityIds: priorities.slice(0, 2) },
        201,
      )
    ).prioritySet.id;
    const businessSet = (
      await database.db
        .selectFrom('type_set')
        .select('id')
        .where('name', '=', 'Business type set')
        .executeTakeFirstOrThrow()
    ).id;
    await call('PATCH', `/api/v1/tracks/${original.id}`, {
      prioritySetId: prioritySet,
      typeSetId: businessSet,
      features: { timeline: false, forms: false },
    });
    const copy = (await make({ key: 'CPY', name: 'Copy', copyFrom: original.id })).track;
    expect(copy).toMatchObject({
      type: 'software',
      typeSetId: businessSet,
      prioritySetId: prioritySet,
      accessPolicyId: original.accessPolicyId,
      workflowMapId: original.workflowMapId,
      features: { timeline: false, forms: false, sprints: true },
    });
    // A local-mode source owns its sets: nothing to share.
    const local = (await make({ key: 'LOC', name: 'Local', mode: 'local' })).track;
    expect((await make({ key: 'CP2', name: 'Copy 2', copyFrom: local.id }, 409)).error).toBe(
      'source_not_shared',
    );
    await make({ key: 'CP3', name: 'Copy 3', copyFrom: 999_999 }, 400);
  });

  describe("a board's kind and its track's backlog (ADR-116)", () => {
    const sections = async (key: string) =>
      (await call('GET', `/api/v1/tracks/${key}`)).track as {
        features: { backlog: boolean; sprints: boolean };
        sections: { backlog: boolean; sprints: boolean };
      };
    const kind = (board: number, to: 'scrum' | 'kanban') =>
      call('PATCH', `/api/v1/boards/${board}`, { kind: to });

    it('[CORE-002] a template says which sections a track has', async () => {
      await make({ key: 'SSC', name: 'Scrum one', template: 'scrum' });
      expect((await sections('SSC')).sections).toEqual({ backlog: true, sprints: true });
      await make({ key: 'SKA', name: 'Kanban one', template: 'kanban' });
      expect((await sections('SKA')).sections).toEqual({ backlog: false, sprints: false });
    });

    it('[CORE-002] a Blank track has no backlog before or after its Kanban board is made', async () => {
      await make({ key: 'SBL', name: 'Blank one', template: 'blank' });
      const before = await sections('SBL');
      expect(before.features).toMatchObject({ backlog: true, sprints: true });
      expect(before.sections).toEqual({ backlog: false, sprints: false });
      expect((await call('GET', '/api/v1/tracks/SBL/board')).board.kind).toBe('kanban');
      const after = await sections('SBL');
      expect(after.features).toMatchObject({ backlog: false, sprints: false });
      expect(after.sections).toEqual({ backlog: false, sprints: false });
    });

    it("[CORE-002] changing the board's kind moves the toggles both ways, as a change of the track", async () => {
      const { board, track } = await make({ key: 'SCH', name: 'Changing', template: 'kanban' });
      await kind(board.id, 'scrum');
      expect(await sections('SCH')).toMatchObject({
        features: { backlog: true, sprints: true },
        sections: { backlog: true, sprints: true },
      });
      await kind(board.id, 'kanban');
      expect(await sections('SCH')).toMatchObject({
        features: { backlog: false, sprints: false },
        sections: { backlog: false, sprints: false },
      });
      const events = await database.db
        .selectFrom('domain_event')
        .select('payload')
        .where('type', '=', 'track.updated')
        .where('subject_id', '=', String(track.id))
        .execute();
      expect(events).toHaveLength(2);
    });

    it('[CORE-002] a toggle turned on by hand does not give a Kanban track a backlog', async () => {
      const { track } = await make({ key: 'SHA', name: 'By hand', template: 'kanban' });
      await call('PATCH', `/api/v1/tracks/${track.id}`, { features: { backlog: true } });
      const read = await sections('SHA');
      expect(read.features.backlog).toBe(true);
      expect(read.sections.backlog).toBe(false);
    });

    it('[AGL-002] tickets of a Scrum backlog and of its sprints stay on the board as Kanban', async () => {
      const { board } = await make({ key: 'SMV', name: 'Moving', template: 'scrum' });
      const inBacklog = await ticket('SMV', 'Waiting in the backlog');
      const inFuture = await ticket('SMV', 'In a planned sprint');
      const running = await ticket('SMV', 'In the running sprint');
      const planned = (
        await call('POST', `/api/v1/boards/${board.id}/sprints`, { name: 'Later' }, 201)
      ).sprint.id;
      const active = (
        await call('POST', `/api/v1/boards/${board.id}/sprints`, { name: 'Now' }, 201)
      ).sprint.id;
      await call('POST', `/api/v1/sprints/${planned}/tickets`, { tickets: [inFuture] });
      await call('POST', `/api/v1/sprints/${active}/tickets`, { tickets: [running] });
      await call('POST', `/api/v1/sprints/${active}/start`, {
        startAt: '2026-11-01T00:00:00.000Z',
        endAt: '2026-11-15T00:00:00.000Z',
      });
      const shownAsScrum = (await call('GET', `/api/v1/boards/${board.id}/data?sprints=active`))
        .cards as Card[];
      expect(shownAsScrum.map((c) => c.key)).toEqual([running]);

      const timeline = () => call('GET', '/api/v1/tracks/SMV/timeline');
      const calendar = () =>
        call('GET', '/api/v1/tracks/SMV/calendar?from=2026-11-01&to=2026-11-30');
      expect((await timeline()).markers.sprints).toHaveLength(1);
      expect((await calendar()).sprints).toHaveLength(1);

      // A running sprint has to end first (`sprints.test.ts` covers the refusal).
      await call('POST', `/api/v1/sprints/${active}/complete`, { moveTo: { type: 'backlog' } });
      await kind(board.id, 'kanban');
      expect((await cards(board.id)).sort()).toEqual([inBacklog, inFuture, running].sort());
      // Its sprints do not show elsewhere on the track either.
      expect((await timeline()).markers.sprints).toEqual([]);
      expect((await calendar()).sprints).toEqual([]);
      // Nothing about the sprints was lost: back on Scrum they are where they were.
      await kind(board.id, 'scrum');
      const back = await call('GET', `/api/v1/boards/${board.id}/backlog`);
      expect(back.backlog.tickets.map((x: Card) => x.key).sort()).toEqual(
        [inBacklog, running].sort(),
      );
    });
  });
});
