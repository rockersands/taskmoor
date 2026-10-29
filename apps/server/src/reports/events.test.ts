import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { fold, type ReportState, readReportEvents, replayCheck, stateAt } from './events';

// Made for this run: no password is written in the repository.
const PASSWORD = `reports-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.80.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

const HOUR = 3600;

/**
 * The report event store (M1-059; RPT-003): after a scripted run of ticket and sprint changes
 * through the API, folding the events reproduces every ticket and its sprints; a report for a
 * past moment is the same before and after later edits; a write that skipped the history shows
 * up in the replay check.
 */
describe('report event store (M1-059)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const status: Record<string, number> = {};
  const t: Record<string, { id: number; key: string }> = {};
  let points = 0;
  let boardId = 0;
  const sprints: Record<string, number> = {};
  /** A moment between the setup and the later edits. */
  let mark: Date;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const ok = async (options: InjectOptions, code = 200) => {
    const res = await as('admin', options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body}`).toBe(code);
    return res.json();
  };
  const post = (url: string, payload: unknown = {}, code = 200) =>
    ok({ method: 'POST', url, payload: payload as Record<string, unknown> }, code);
  const patch = (url: string, payload: unknown) =>
    ok({ method: 'PATCH', url, payload: payload as Record<string, unknown> });
  const ids = () => Object.values(t).map((x) => x.id);
  const dbNow = async () =>
    (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(database.db)).rows[0]
      ?.now as Date;

  async function ticket(name: string, extra: Record<string, unknown> = {}) {
    const res = await post(
      '/api/v1/tickets',
      { track: 'RP', summary: `rpt ${name}`, ...extra },
      201,
    );
    t[name] = res.ticket;
  }
  async function transition(name: string) {
    const listed = await ok({ method: 'GET', url: `/api/v1/tickets/${t[name]?.id}/transitions` });
    const first = (listed.transitions as { id: number }[])[0];
    expect(first, `a transition for ${name}`).toBeDefined();
    await post(`/api/v1/tickets/${t[name]?.id}/transitions`, { transitionId: first?.id });
  }
  /** What a simple report shows: tickets per status, open estimate and points, sprint scope. */
  function summary(states: Map<number, ReportState>) {
    const byStatus: Record<string, number> = {};
    let remaining = 0;
    let pts = 0;
    const scope: Record<string, number> = {};
    for (const s of states.values()) {
      if (s.inTrash) continue;
      byStatus[String(s.statusId)] = (byStatus[String(s.statusId)] ?? 0) + 1;
      remaining += s.remainingEstimate ?? 0;
      pts += s.numbers[points] ?? 0;
      for (const sp of s.sprints) scope[String(sp)] = (scope[String(sp)] ?? 0) + 1;
    }
    return { tickets: states.size, byStatus, remaining, points: pts, scope };
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
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
    const members = (await database.db.selectFrom('role').select(['id', 'name']).execute()).find(
      (r) => r.name === 'Members',
    )?.id as number;
    for (const key of ['RP', 'RQ']) {
      const res = await ok(
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key, name: `Reports ${key}`, mode: 'shared' },
        },
        201,
      );
      tracks[key] = res.track.id;
      for (const who of ['admin', 'alice']) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: members,
            user_id: users[who]?.id as number,
          })
          .execute();
      }
    }
    for (const s of await database.db.selectFrom('status').select(['id', 'name']).execute()) {
      status[s.name] = s.id;
    }
    points = (await post('/api/v1/fields', { name: 'Points', type: 'number' }, 201)).field.id;

    // The starting point: three tickets with estimates and points, two in a started sprint.
    await ticket('a', {
      originalEstimate: 2 * HOUR,
      remainingEstimate: 2 * HOUR,
      fields: { [points]: 3 },
    });
    await ticket('b', {
      originalEstimate: 5 * HOUR,
      remainingEstimate: 5 * HOUR,
      fields: { [points]: 8 },
    });
    await ticket('c');
    boardId = (
      await post(
        '/api/v1/boards',
        {
          name: 'Reports board',
          kind: 'scrum',
          trackId: tracks.RP,
          source: { query: 'track IN (RP, RQ) AND summary ~ rpt' },
          columns: [
            { id: 'todo', name: 'To do', statusIds: [status.New] },
            { id: 'doing', name: 'Doing', statusIds: [status.Active, status['In Review']] },
            { id: 'done', name: 'Done', statusIds: [status.Closed] },
          ],
        },
        201,
      )
    ).board.id;
    sprints.one = (await post(`/api/v1/boards/${boardId}/sprints`, { name: 'One' }, 201)).sprint.id;
    await post(`/api/v1/sprints/${sprints.one}/tickets`, { tickets: [t.a?.key, t.b?.key] });
    await post(`/api/v1/sprints/${sprints.one}/start`, { endAt: '2030-01-15T09:00:00Z' });
    mark = await dbNow();

    // Later: time logged, estimates and points edited, transitions, an assignee, scope change,
    // a completion carrying work over, the trash and back, a move to another track.
    await post(`/api/v1/tickets/${t.a?.id}/time-entries`, { duration: '1h' }, 201);
    await patch(`/api/v1/tickets/${t.b?.id}`, {
      originalEstimate: 8 * HOUR,
      fields: { [points]: 13 },
    });
    await transition('a');
    await transition('a');
    await patch(`/api/v1/tickets/${t.c?.id}`, { assigneeId: users.alice?.id });
    await post(`/api/v1/sprints/${sprints.one}/tickets`, { tickets: [t.c?.key] });
    await post(`/api/v1/sprints/${sprints.one}/tickets/remove`, { tickets: [t.b?.key] });
    await ticket('d', { fields: { [points]: 2 } });
    sprints.two = (await post(`/api/v1/boards/${boardId}/sprints`, { name: 'Two' }, 201)).sprint.id;
    await post(`/api/v1/sprints/${sprints.two}/tickets`, { tickets: [t.d?.key] });
    await post(`/api/v1/sprints/${sprints.one}/complete`, {
      moveTo: { type: 'sprint', sprintId: sprints.two },
    });
    await ok({ method: 'DELETE', url: `/api/v1/tickets/${t.c?.id}` }, 200).catch(async () => {
      // A delete may answer 204 without a body.
    });
    await post(`/api/v1/tickets/${t.c?.id}/restore`);
    await post(`/api/v1/tickets/${t.b?.id}/move`, { track: 'RQ' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('[RPT-003] folding the events reproduces every ticket and the sprints it is in', async () => {
    expect(await replayCheck(database.db, 1, { numberFields: [points] })).toEqual([]);
    // And not by accident: the fold sees the changes made after the mark.
    const now = fold(await readReportEvents(database.db, 1, ids(), { numberFields: [points] }));
    const a = now.get(t.a?.id as number);
    expect(a?.timeSpent).toBe(HOUR);
    expect(a?.remainingEstimate).toBe(HOUR);
    expect(a?.statusId).not.toBe(status.New);
    expect(now.get(t.b?.id as number)).toMatchObject({
      trackId: tracks.RQ,
      originalEstimate: 8 * HOUR,
    });
    expect(now.get(t.b?.id as number)?.numbers[points]).toBe(13);
    expect(now.get(t.c?.id as number)).toMatchObject({
      assigneeId: users.alice?.id,
      inTrash: false,
    });
    // a and c were carried from One into Two; d was planned into Two; b was removed.
    expect([...(now.get(t.a?.id as number)?.sprints ?? [])]).toEqual([sprints.two]);
    expect([...(now.get(t.c?.id as number)?.sprints ?? [])]).toEqual([sprints.two]);
    expect([...(now.get(t.d?.id as number)?.sprints ?? [])]).toEqual([sprints.two]);
    expect([...(now.get(t.b?.id as number)?.sprints ?? [])]).toEqual([]);
  });

  it('[RPT-003] a report for a past moment gives the same numbers before and after later edits', async () => {
    const before = summary(await stateAt(database.db, 1, ids(), mark, { numberFields: [points] }));
    expect(before).toEqual({
      tickets: 3,
      byStatus: { [String(status.New)]: 3 },
      remaining: 7 * HOUR,
      points: 11,
      scope: { [String(sprints.one)]: 2 },
    });
    // More edits after the first look.
    await patch(`/api/v1/tickets/${t.d?.id}`, {
      remainingEstimate: 4 * HOUR,
      fields: { [points]: 5 },
    });
    await transition('d');
    await post(`/api/v1/tickets/${t.a?.id}/time-entries`, { duration: '30m' }, 201);
    const after = summary(await stateAt(database.db, 1, ids(), mark, { numberFields: [points] }));
    expect(after).toEqual(before);
    // The present is different, and still reproduces the tickets.
    const now = summary(
      fold(await readReportEvents(database.db, 1, ids(), { numberFields: [points] })),
    );
    expect(now).not.toEqual(before);
    expect(await replayCheck(database.db, 1, { numberFields: [points] })).toEqual([]);
  });

  it('[RPT-003] the replay check names a write that skipped the history', async () => {
    const a = t.a?.id as number;
    const before = await database.db
      .selectFrom('ticket')
      .select(['status_id', 'remaining_estimate'])
      .where('id', '=', a)
      .executeTakeFirstOrThrow();
    await database.db
      .updateTable('ticket')
      .set({ status_id: status.Closed as number, remaining_estimate: 99 })
      .where('id', '=', a)
      .execute();
    await database.db
      .updateTable('sprint_ticket')
      .set({ open: false })
      .where('ticket_id', '=', t.d?.id as number)
      .execute();
    const found = await replayCheck(database.db, 1, { numberFields: [points] });
    expect(found.map((m) => [m.ticketId, m.field]).sort()).toEqual(
      [
        [a, 'remainingEstimate'],
        [a, 'status'],
        [t.d?.id as number, 'sprints'],
      ].sort(),
    );
    expect(found.find((m) => m.field === 'status')).toMatchObject({
      replayed: before.status_id,
      live: status.Closed,
    });
    // Put back as it was.
    await database.db.updateTable('ticket').set(before).where('id', '=', a).execute();
    await database.db
      .updateTable('sprint_ticket')
      .set({ open: true })
      .where('ticket_id', '=', t.d?.id as number)
      .where('sprint_id', '=', sprints.two as number)
      .execute();
    expect(await replayCheck(database.db, 1, { numberFields: [points] })).toEqual([]);
  });

  it('[RPT-001] the sprint report is recomputed from the sprint events alone', async () => {
    const events = await readReportEvents(database.db, 1, ids());
    const of = (kind: string) =>
      events
        .filter((e) => e.kind === 'sprint' && e.sprintId === sprints.one && e.change === kind)
        .map((e) => e.ticketId)
        .sort((x, y) => x - y);
    const report = await ok({ method: 'GET', url: `/api/v1/sprints/${sprints.one}/report` });
    const keysOf = (list: { key: string }[]) => list.map((x) => x.key).sort();
    // Keys as they are now: b moved to another track since.
    const current = await database.db
      .selectFrom('ticket as k')
      .innerJoin('track as tr', 'tr.id', 'k.track_id')
      .select(['k.id', sql<string>`tr.key || '-' || k.number`.as('key')])
      .execute();
    const keyOf = (id: number) => current.find((x) => x.id === id)?.key as string;
    // Completed: finished there; not completed: carried over; removed: taken out after start.
    expect(keysOf(report.completed)).toEqual(of('completed').map(keyOf).sort());
    expect(keysOf(report.notCompleted)).toEqual(of('carried_over').map(keyOf).sort());
    expect(keysOf(report.removed)).toEqual(of('removed').map(keyOf).sort());
    expect(of('committed')).toEqual([t.a?.id, t.b?.id].sort((x, y) => (x ?? 0) - (y ?? 0)));
  });
});
