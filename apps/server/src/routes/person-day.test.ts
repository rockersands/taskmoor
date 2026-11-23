import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { dayOfIso } from '@taskmoor/formula';
import { hashPassword } from '@taskmoor/iam';
import { localDate } from '@taskmoor/query';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `day-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.91.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

// Kiritimati (UTC+14) is always a day or two ahead of Pago Pago (UTC−11), whatever the hour, so
// a day counted on the wrong one of them is always a different day.
const AHEAD = 'Pacific/Kiritimati';
const BEHIND = 'Pacific/Pago_Pago';
const today = (zone: string) => localDate(new Date(), zone);
const daysBefore = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/**
 * One clock per person (T-280; ADR-010): every "today" and day boundary the server counts for a
 * person uses the zone saved on their account, else the device's zone the app sends in the
 * `taskmoor-time-zone` header (an account on Automatic), else UTC. The search's dates, a plan's
 * overdue count, the first day of a plan's periods, a template's `{date}`, a new subscription's
 * zone and a download's file name all agree with the person's own screens.
 */
describe('the person’s day on the server (T-280)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  let userId = 0;
  let planId = 0;

  const send = (options: InjectOptions & { zone?: string }) => {
    const { zone, ...rest } = options;
    return app.inject({
      ...rest,
      remoteAddress: nextAddress(),
      headers: {
        ...(rest.headers ?? {}),
        cookie,
        ...(zone ? { 'taskmoor-time-zone': zone } : {}),
      },
    });
  };
  const call = async (options: InjectOptions & { zone?: string }, code = 200) => {
    const res = await send(options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body}`).toBe(code);
    return res.json();
  };
  const get = (url: string, zone?: string) =>
    call({ method: 'GET', url, ...(zone ? { zone } : {}) });
  const saveZone = (zone: string | null) =>
    database.db.updateTable('app_user').set({ time_zone: zone }).where('id', '=', userId).execute();

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    userId = (
      await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: 'pat@example.com',
          name: 'pat',
          password_hash: await hashPassword(PASSWORD),
          is_site_admin: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'pat@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    cookie = sessionCookie(res.headers['set-cookie']);
    const trackId = (
      await call(
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'PD', name: 'Days', mode: 'shared' },
        },
        201,
      )
    ).track.id;
    // Due today in Pago Pago: already past in Kiritimati, not yet in Pago Pago.
    await call(
      {
        method: 'POST',
        url: '/api/v1/tickets',
        payload: { track: 'PD', summary: 'Due behind', dueDate: today(BEHIND) },
      },
      201,
    );
    planId = (
      await call(
        {
          method: 'POST',
          url: '/api/v1/plans',
          payload: { name: 'Days', sources: [{ kind: 'track', trackId }] },
        },
        201,
      )
    ).plan.id;
    // Weekly periods that start on Kiritimati's today: Pago Pago's today is in the week before.
    await call({
      method: 'PATCH',
      url: `/api/v1/plans/${planId}`,
      payload: { period: { kind: 'weeks', weeks: 1, anchor: today(AHEAD) } },
    });
    await call(
      { method: 'POST', url: '/api/v1/fields', payload: { name: 'Team', type: 'team' } },
      201,
    );
  });
  afterEach(async () => {
    await saveZone(null);
  });
  afterAll(async () => {
    await app.close();
  });

  it('[QRY-006] reads startOfDay() on the account’s zone, else the device’s the app sends', async () => {
    const q = encodeURIComponent('track = PD AND due < startOfDay()');
    const count = async (zone: string) =>
      (await get(`/api/v1/search?q=${q}&count=true&limit=1`, zone)).total.count as number;
    // Automatic: the device's zone.
    expect(await count(AHEAD)).toBe(1);
    expect(await count(BEHIND)).toBe(0);
    // A zone saved on the account wins over the device's.
    await saveZone(BEHIND);
    expect(await count(AHEAD)).toBe(0);
    await saveZone(AHEAD);
    expect(await count(BEHIND)).toBe(1);
    // The query editor's check reads the same clock.
    const checked = await get(`/api/v1/search/check?q=${q}`, BEHIND);
    expect(checked).not.toHaveProperty('error');
  });

  it('[PLN-012] counts a plan’s overdue tickets on the person’s day: due today is not overdue in the evening west of UTC', async () => {
    const overdue = async (zone: string) =>
      (
        (await get(`/api/v1/plans/${planId}/summary`, zone)).overview as {
          id: string;
          count: number;
        }[]
      ).find((c) => c.id === 'overdue')?.count;
    expect(await overdue(BEHIND)).toBe(0);
    expect(await overdue(AHEAD)).toBe(1);
    await saveZone(BEHIND);
    expect(await overdue(AHEAD)).toBe(0);
  });

  it('[PLN-004] [PLN-005] starts a plan’s periods from the person’s today when no first day is given', async () => {
    const first = async (path: string, zone: string) =>
      ((await get(`/api/v1/plans/${planId}/${path}`, zone)).periods as { start: string }[])[0]
        ?.start;
    const ahead = today(AHEAD);
    const weekBefore = daysBefore(ahead, 7);
    expect(await first('schedule', AHEAD)).toBe(ahead);
    expect(await first('schedule', BEHIND)).toBe(weekBefore);
    expect(await first('capacity', AHEAD)).toBe(ahead);
    expect(await first('capacity', BEHIND)).toBe(weekBefore);
    await saveZone(BEHIND);
    expect(await first('schedule', AHEAD)).toBe(weekBefore);
    expect(await first('capacity', AHEAD)).toBe(weekBefore);
  });

  it('[PLN-008] starts a new program board on the person’s today', async () => {
    const made = async (name: string, zone: string) =>
      (
        await call(
          {
            method: 'POST',
            url: `/api/v1/plans/${planId}/program-boards`,
            payload: { name },
            zone,
          },
          201,
        )
      ).board.from as string;
    expect(await made('Ahead', AHEAD)).toBe(today(AHEAD));
    expect(await made('Behind', BEHIND)).toBe(today(BEHIND));
    await saveZone(BEHIND);
    expect(await made('Saved', AHEAD)).toBe(today(BEHIND));
  });

  it('[PLN-010] gives a plan grid’s formulas the person’s today', async () => {
    const day = async (zone: string) =>
      (await get(`/api/v1/plans/${planId}/structures/default/rows`, zone)).today as number;
    expect(await day(AHEAD)).toBe(dayOfIso(today(AHEAD)));
    expect(await day(BEHIND)).toBe(dayOfIso(today(BEHIND)));
    await saveZone(BEHIND);
    expect(await day(AHEAD)).toBe(dayOfIso(today(BEHIND)));
  });

  it('[CORE-029] [CORE-030] fills a template’s {date} and counts its days from the person’s today', async () => {
    const template = (
      await call(
        {
          method: 'POST',
          url: '/api/v1/ticket-templates',
          payload: {
            track: 'PD',
            name: 'Standup',
            summary: 'Standup {date}',
            defaults: { dueInDays: 1 },
          },
        },
        201,
      )
    ).template.id as number;
    const start = async (zone: string) =>
      (await get(`/api/v1/ticket-templates/${template}?track=PD`, zone)).start as {
        summary: string;
        dueDate: string;
      };
    expect(await start(AHEAD)).toMatchObject({ summary: `Standup ${today(AHEAD)}` });
    expect(await start(BEHIND)).toMatchObject({ summary: `Standup ${today(BEHIND)}` });
    await saveZone(BEHIND);
    const saved = await start(AHEAD);
    expect(saved.summary).toBe(`Standup ${today(BEHIND)}`);
    expect(saved.dueDate).toBe(daysBefore(today(BEHIND), -1));
    // The ticket it makes says the same.
    const made = await call(
      {
        method: 'POST',
        url: `/api/v1/ticket-templates/${template}/tickets`,
        payload: {},
        zone: AHEAD,
      },
      201,
    );
    expect(made.ticket.summary).toBe(`Standup ${today(BEHIND)}`);
  });

  it('[QRY-012] gives a new subscription the person’s zone when none is named', async () => {
    const saved = (
      await call(
        {
          method: 'POST',
          url: '/api/v1/saved-searches',
          payload: { name: 'Due', query: 'track = PD' },
        },
        201,
      )
    ).savedSearch.id as number;
    const subscribe = async (payload: Record<string, unknown>, zone?: string) =>
      (
        await call(
          {
            method: 'POST',
            url: `/api/v1/saved-searches/${saved}/subscriptions`,
            payload: { schedule: 'daily', ...payload },
            ...(zone ? { zone } : {}),
          },
          201,
        )
      ).subscription.timeZone as string;
    // Automatic: the device's zone, not UTC.
    expect(await subscribe({}, BEHIND)).toBe(BEHIND);
    // Saved on the account: that one.
    await saveZone('Europe/Madrid');
    expect(await subscribe({}, BEHIND)).toBe('Europe/Madrid');
    // Named: as named. Nothing at all: UTC.
    expect(await subscribe({ timeZone: 'Asia/Tokyo' }, BEHIND)).toBe('Asia/Tokyo');
    await saveZone(null);
    expect(await subscribe({})).toBe('UTC');
  });

  it('[QRY-015] names a downloaded file after the person’s today', async () => {
    const file = async (zone: string) =>
      (
        await send({
          method: 'GET',
          url: `/api/v1/search/export?q=${encodeURIComponent('track = PD')}&format=csv`,
          zone,
        })
      ).headers['content-disposition'];
    expect(await file(AHEAD)).toContain(`-${today(AHEAD)}.csv`);
    expect(await file(BEHIND)).toContain(`-${today(BEHIND)}.csv`);
    await saveZone(BEHIND);
    expect(await file(AHEAD)).toContain(`-${today(BEHIND)}.csv`);
  });
});
