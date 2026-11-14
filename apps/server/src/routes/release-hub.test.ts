import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { localDate } from '@taskmoor/query';
import { stableJson } from '@taskmoor/testkit';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `hub-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.89.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Counted {
  query: string;
  count: number;
  exact: boolean;
}

/**
 * The releases hub's reads (M1-050; CORE-016): a release's progress by stage and its warnings,
 * each number equal to the search it names, and release notes generated from its closed
 * tickets (golden), as data and as a Markdown file; only for those who may browse the track.
 */
describe('releases hub (M1-050)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  let trackId = 0;
  let gated = 0;
  let shipped = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const call = async (who: string, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body}`).toBe(code);
    return res.json();
  };
  const get = (who: string, url: string, code = 200) => call(who, { method: 'GET', url }, code);
  const searchCount = async (who: string, q: string) =>
    (await get(who, `/api/v1/search?q=${encodeURIComponent(q)}&count=true&limit=1`)).total.count;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['dave', false],
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
    trackId = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'RH', name: 'Checkout', mode: 'shared' },
        },
        201,
      )
    ).track.id;
    const members = (await database.db.selectFrom('role').select(['id', 'name']).execute()).find(
      (r) => r.name === 'Members',
    )?.id as number;
    for (const who of ['alice', 'dave']) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: trackId,
          role_id: members,
          user_id: users[who]?.id as number,
        })
        .execute();
    }
    const release = (payload: Record<string, unknown>) =>
      call('admin', { method: 'POST', url: `/api/v1/tracks/${trackId}/releases`, payload }, 201);
    gated = (await release({ name: '2.0', releaseDate: '2026-01-15', requireApprovals: true }))
      .release.id;
    await call('admin', {
      method: 'PUT',
      url: `/api/v1/releases/${gated}/approvers`,
      payload: { userIds: [users.dave?.id] },
    });
    shipped = (
      await release({
        name: '1.9',
        description: 'Card payments, at last.',
        releaseDate: '2026-10-01',
      })
    ).release.id;
    const types = Object.fromEntries(
      (
        await database.db
          .selectFrom('ticket_type')
          .select(['id', 'name'])
          .where('owner_track_id', 'is', null)
          .execute()
      ).map((y) => [y.name, y.id]),
    );
    const status = (stage: 'active' | 'closed') =>
      database.db
        .selectFrom('status')
        .select('id')
        .where('stage', '=', stage)
        .orderBy('id')
        .executeTakeFirstOrThrow();
    const closedStatus = await status('closed');
    const activeStatus = await status('active');
    const reasons = Object.fromEntries(
      (await database.db.selectFrom('close_reason').select(['id', 'name']).execute()).map((r) => [
        r.name,
        r.id,
      ]),
    );
    const ticket = async (
      summary: string,
      type: string,
      payload: Record<string, unknown>,
      state?: 'active' | { reason: string },
    ) => {
      const made = (
        await call(
          'alice',
          {
            method: 'POST',
            url: '/api/v1/tickets',
            payload: { track: 'RH', summary, ticketTypeId: types[type], ...payload },
          },
          201,
        )
      ).ticket;
      // Straight to the stage wanted: these tests read releases, not workflows.
      if (state === 'active') {
        await database.db
          .updateTable('ticket')
          .set({ status_id: activeStatus.id })
          .where('id', '=', made.id)
          .execute();
      } else if (state) {
        await database.db
          .updateTable('ticket')
          .set({
            status_id: closedStatus.id,
            closed_at: new Date('2026-09-30T12:00:00Z'),
            close_reason_id: reasons[state.reason] as number,
          })
          .where('id', '=', made.id)
          .execute();
      }
      return made;
    };
    const onGated = { targetReleaseIds: [gated] };
    await ticket('Pay by card', 'Feature', onGated, { reason: 'Completed' });
    await ticket('Save a card', 'Feature', { ...onGated, assigneeId: users.alice?.id }, 'active');
    await ticket('Refunds', 'Feature', onGated);
    await ticket('Gift cards', 'Chore', { ...onGated, assigneeId: users.alice?.id });
    await ticket('Old checkout crashes', 'Bug', { foundInReleaseIds: [gated] });
    const onShipped = { targetReleaseIds: [shipped] };
    await ticket('Wallet *payments* [beta]', 'Feature', onShipped, { reason: 'Completed' });
    await ticket('Totals off by a cent', 'Bug', onShipped, { reason: 'Completed' });
    await ticket('A card form', 'Feature', onShipped, { reason: 'Completed' });
    await ticket('Pay later', 'Feature', onShipped, { reason: 'Not planned' });
    await ticket('Same as RH-6', 'Bug', onShipped, { reason: 'Duplicate' });
    await ticket('Receipts by email', 'Chore', onShipped);
    await call('admin', {
      method: 'POST',
      url: `/api/v1/releases/${shipped}/ship`,
      // Shipped on a fixed day, so the notes stay the same from one day to the next.
      payload: { moveOpenTo: null, releaseDate: '2026-10-01' },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-016] counts a release’s tickets by stage, each number equal to its search', async () => {
    const overview = await get('alice', `/api/v1/releases/${gated}/overview`);
    const counts = (s: Record<string, Counted>) =>
      Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.count]));
    expect(counts(overview.stages)).toEqual({ new: 2, active: 1, closed: 1 });
    expect(overview.open.count).toBe(3);
    for (const counted of [...Object.values(overview.stages), overview.open] as Counted[]) {
      expect(await searchCount('alice', counted.query)).toBe(counted.count);
    }
    expect(overview.tickets.map((k: { key: string }) => k.key)).toEqual([
      'RH-1',
      'RH-2',
      'RH-3',
      'RH-4',
    ]);
    expect(overview.tickets[1]).toMatchObject({
      summary: 'Save a card',
      stage: 'active',
      assignee: 'alice',
    });
    expect(overview.viewer).toEqual({ mayManage: false, approver: null });
    expect((await get('admin', `/api/v1/releases/${gated}/overview`)).viewer.mayManage).toBe(true);
    expect((await get('dave', `/api/v1/releases/${gated}/overview`)).viewer.approver).toEqual({
      decision: null,
    });
  });

  it('[CORE-016] warns of a passed date, unassigned and found-in tickets, and waiting approvals', async () => {
    const { warnings } = await get('alice', `/api/v1/releases/${gated}/overview`);
    expect(warnings.map((w: { code: string; count: number }) => [w.code, w.count])).toEqual([
      ['overdue', 3],
      ['unassigned', 1],
      ['open_found', 1],
      ['approvals_waiting', 1],
    ]);
    for (const w of warnings.filter((x: { query?: string }) => x.query)) {
      expect(await searchCount('alice', w.query)).toBe(w.count);
    }
    await call('dave', {
      method: 'POST',
      url: `/api/v1/releases/${gated}/approval`,
      payload: { decision: 'declined', comment: 'Refunds first' },
    });
    const after = await get('alice', `/api/v1/releases/${gated}/overview`);
    expect(after.warnings.at(-1)).toEqual({ code: 'approval_declined', count: 1 });
    expect(after.approvers[0]).toMatchObject({ decision: 'declined', comment: 'Refunds first' });
    // Shipped with an open ticket left in it.
    const done = await get('alice', `/api/v1/releases/${shipped}/overview`);
    expect(done.warnings).toEqual([
      {
        code: 'open_after_ship',
        count: 1,
        query: `targetRelease = ${shipped} AND stage != closed`,
      },
    ]);
  });

  it('[CORE-016] generates release notes from the closed tickets, grouped by type (golden)', async () => {
    const notes = await get('alice', `/api/v1/releases/${shipped}/notes`);
    expect(notes.sections.map((s: { type: string }) => s.type)).toEqual(['Feature', 'Bug']);
    expect(notes.leftOut).toEqual([
      { reason: 'Not planned', count: 1 },
      { reason: 'Duplicate', count: 1 },
    ]);
    await expect(stableJson(notes)).toMatchFileSnapshot('./__golden__/release-notes.json');
    const file = await as('alice', {
      method: 'GET',
      url: `/api/v1/releases/${shipped}/notes?format=markdown`,
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(file.headers['content-disposition']).toBe('attachment; filename="RH-1.9-notes.md"');
    expect(file.body).toBe(notes.markdown);
    expect(file.body).toContain('- RH-6 Wallet \\*payments\\* \\[beta\\]');
  });

  it('[CORE-016] writes the notes’ days in plain English, the shipped day in the reader’s zone (T-277)', async () => {
    const release = async (payload: Record<string, unknown>) =>
      (
        await call(
          'admin',
          { method: 'POST', url: `/api/v1/tracks/${trackId}/releases`, payload },
          201,
        )
      ).release.id as number;
    const planned = await release({ name: '2.1', releaseDate: '2026-12-01' });
    const plannedNotes = await get('alice', `/api/v1/releases/${planned}/notes`);
    expect(plannedNotes.markdown).toContain('Planned for December 1, 2026.');
    expect(plannedNotes.markdown).not.toContain('2026-12-01');
    // Shipped with no release date, as an import can leave one: 03:00 in UTC on October 2 is
    // still October 1 in Chicago, the day the release's page shows a reader there.
    const undated = await release({ name: '1.8' });
    await database.db
      .updateTable('release')
      .set({ shipped_at: new Date('2026-10-02T03:00:00Z'), release_date: null })
      .where('id', '=', undated)
      .execute();
    const url = `/api/v1/releases/${undated}/notes`;
    const inChicago = await call('alice', {
      method: 'GET',
      url,
      headers: { 'taskmoor-time-zone': 'America/Chicago' },
    });
    expect(inChicago.release.shippedOn).toBe('2026-10-01');
    expect(inChicago.markdown).toContain('Released on October 1, 2026.');
    // A download sends no header, so its link names the zone.
    const file = await as('alice', {
      method: 'GET',
      url: `${url}?format=markdown&timeZone=${encodeURIComponent('America/Chicago')}`,
    });
    expect(file.statusCode, file.body).toBe(200);
    expect(file.body).toContain('Released on October 1, 2026.');
    // With no zone sent and none on the profile, the day is UTC's.
    const anywhere = await get('alice', url);
    expect(anywhere.release.shippedOn).toBe('2026-10-02');
    expect(anywhere.markdown).toContain('Released on October 2, 2026.');
    await get('alice', `${url}?timeZone=${encodeURIComponent('Mars/Olympus')}`, 400);
  });

  it('[CORE-016] judges overdue and ships an undated release on the viewer’s own day (T-282)', async () => {
    // Kiritimati (UTC+14) is always a day or two ahead of Pago Pago (UTC-11), whatever the hour.
    const ahead = 'Pacific/Kiritimati';
    const behind = 'Pacific/Pago_Pago';
    const zone = (timeZone: string) => ({ 'taskmoor-time-zone': timeZone });
    const behindToday = localDate(new Date(), behind);
    const due = (
      await call(
        'admin',
        {
          method: 'POST',
          url: `/api/v1/tracks/${trackId}/releases`,
          payload: { name: '2.2', releaseDate: behindToday },
        },
        201,
      )
    ).release.id as number;
    await call(
      'alice',
      {
        method: 'POST',
        url: '/api/v1/tickets',
        payload: { track: 'RH', summary: 'Tip jar', targetReleaseIds: [due] },
      },
      201,
    );
    // Its day is today in Pago Pago and gone by in Kiritimati.
    const read = (timeZone: string, url: string) =>
      call('alice', { method: 'GET', url, headers: zone(timeZone) });
    const codes = async (timeZone: string) =>
      (await read(timeZone, `/api/v1/releases/${due}/overview`)).warnings.map(
        (w: { code: string }) => w.code,
      );
    expect(await codes(ahead)).toContain('overdue');
    expect(await codes(behind)).not.toContain('overdue');
    const listed = async (timeZone: string) =>
      (await read(timeZone, `/api/v1/tracks/${trackId}/releases`)).releases.find(
        (r: { id: number }) => r.id === due,
      );
    expect(await listed(ahead)).toMatchObject({ overdue: true });
    expect(await listed(behind)).toMatchObject({ overdue: false });
    expect((await read(ahead, `/api/v1/releases/${due}`)).release.overdue).toBe(true);
    expect((await read(behind, `/api/v1/releases/${due}`)).release.overdue).toBe(false);
    // Shipped with no day given, each ships on the shipper's own day, never UTC's for both.
    const shippedOn: Record<string, string> = {};
    for (const [name, timeZone] of [
      ['2.3', ahead],
      ['2.4', behind],
    ] as const) {
      const made = (
        await call(
          'admin',
          { method: 'POST', url: `/api/v1/tracks/${trackId}/releases`, payload: { name } },
          201,
        )
      ).release.id as number;
      const done = await call('admin', {
        method: 'POST',
        url: `/api/v1/releases/${made}/ship`,
        headers: zone(timeZone),
        payload: {},
      });
      shippedOn[timeZone] = done.release.releaseDate;
    }
    expect(shippedOn[ahead]).toBe(localDate(new Date(), ahead));
    expect(shippedOn[behind]).toBe(localDate(new Date(), behind));
    expect(shippedOn[ahead]).not.toBe(shippedOn[behind]);
  });

  it('[CORE-016] shows nothing to those who may not browse the track', async () => {
    await get('carol', `/api/v1/releases/${gated}/overview`, 404);
    await get('carol', `/api/v1/releases/${shipped}/notes`, 404);
    await get('alice', '/api/v1/releases/999999/overview', 404);
    const list = await get('alice', `/api/v1/tracks/${trackId}/releases`);
    expect(list.mayManage).toBe(false);
    expect((await get('admin', `/api/v1/tracks/${trackId}/releases`)).mayManage).toBe(true);
  });
});
