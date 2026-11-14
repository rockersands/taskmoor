import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `plan-deps-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.87.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Timeline {
  items: { id: number; key: string; summary: string }[];
  links: { from: number; to: number; linkTypeId: number; sameSprint?: true }[];
  linkTypes: { id: number; name: string; outward: string }[];
  sameSprint: boolean;
  blockersElsewhere: { id: number; outside: number; unlisted: number }[];
  truncated: boolean;
}

/**
 * The dependencies of a Multi-track plan's Timeline (T-089; PLN-006; ADR-122). A plan over DPA,
 * where Ana is a member; she also sees DPB, which is not a source, and never DPC. In DPA, Design
 * blocks Build (which starts before Design ends) and Ship; Ship is also blocked by a DPB ticket,
 * a DPC ticket and a ticket in the trash, and related to another. A blocker the timeline lists is
 * a line; any other is only counted on the ticket it blocks: outside the plan or hidden as one
 * number, never named, and the plan's own that a filter leaves out as another.
 */
describe('a plan’s dependencies (PLN-006)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const t: Record<string, { id: number; key: string }> = {};
  let planId = 0;
  let blocks = 0;

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
    return res.json();
  };
  const timeline = async (who: string, query = '') => {
    const res = await as(who, { method: 'GET', url: `/api/v1/plans/${planId}/timeline${query}` });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    return { body: res.body, answer: res.json() as Timeline };
  };
  const ticket = async (track: string, summary: string, data: Record<string, unknown> = {}) =>
    (
      await call(
        'admin',
        { method: 'POST', url: '/api/v1/tickets', payload: { track, summary, ...data } },
        201,
      )
    ).ticket as { id: number; key: string };
  const linkType = async (outward: string) =>
    (
      await database.db
        .selectFrom('link_type')
        .select('id')
        .where('outward', '=', outward)
        .executeTakeFirstOrThrow()
    ).id;
  /** `blocker` blocks `blocked`, or another link type's outward phrase. */
  const link = async (
    blocker: { key: string },
    blocked: { key: string },
    outward = 'blocks',
  ): Promise<void> => {
    await call(
      'admin',
      {
        method: 'POST',
        url: `/api/v1/tickets/${blocker.key}/links`,
        payload: { linkTypeId: await linkType(outward), ticket: blocked.key },
      },
      201,
    );
  };

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['ana', false],
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
      ['DPA', 'Apps'],
      ['DPB', 'Billing'],
      ['DPC', 'Core'],
    ] as const) {
      const made = await call(
        'admin',
        { method: 'POST', url: '/api/v1/tracks', payload: { key, name, mode: 'shared' } },
        201,
      );
      tracks[key] = made.track.id;
    }
    const members = (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', 'Members')
        .executeTakeFirstOrThrow()
    ).id;
    for (const key of ['DPA', 'DPB']) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: tracks[key] as number,
          role_id: members,
          user_id: users.ana?.id as number,
        })
        .execute();
    }
    const ana = users.ana?.id;
    blocks = await linkType('blocks');
    t.design = await ticket('DPA', 'Design', { startDate: '2027-03-01', dueDate: '2027-03-10' });
    t.build = await ticket('DPA', 'Build', {
      startDate: '2027-03-08',
      dueDate: '2027-03-20',
      assigneeId: ana,
    });
    t.ship = await ticket('DPA', 'Ship', {
      startDate: '2027-03-22',
      dueDate: '2027-03-25',
      assigneeId: ana,
    });
    t.invoice = await ticket('DPB', 'Invoice run', { dueDate: '2027-03-30' });
    t.secret = await ticket('DPC', 'Secret core work', { dueDate: '2027-04-30' });
    t.binned = await ticket('DPA', 'Binned', { dueDate: '2027-03-05' });
    t.related = await ticket('DPB', 'Related only');
    await link(t.design, t.build);
    await link(t.design, t.ship);
    await link(t.invoice, t.ship);
    await link(t.secret, t.ship);
    await link(t.binned, t.ship);
    await link(t.related, t.ship, 'relates to');
    // In the trash: no longer a blocker anyone counts.
    await database.db
      .updateTable('ticket')
      .set({ deleted_at: new Date() })
      .where('id', '=', t.binned.id)
      .execute();
    planId = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/plans',
          payload: {
            name: 'Delivery',
            sources: [{ kind: 'track', trackId: tracks.DPA }],
            shares: [{ scope: 'any_user' }],
          },
        },
        201,
      )
    ).plan.id;
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('[PLN-006] draws listed blockers as lines and counts the others, without the trash or other link types', async () => {
    const { answer } = await timeline('admin');
    expect(answer.items.map((i) => i.summary).sort()).toEqual(['Build', 'Design', 'Ship']);
    expect(answer.links).toEqual([
      { from: t.design?.id, to: t.build?.id, linkTypeId: blocks },
      { from: t.design?.id, to: t.ship?.id, linkTypeId: blocks },
    ]);
    expect(answer.linkTypes.map((l) => l.outward)).toEqual(['blocks']);
    expect(answer.sameSprint).toBe(false);
    // Invoice run (outside the plan) and Secret core work: two, whoever may see them.
    expect(answer.blockersElsewhere).toEqual([{ id: t.ship?.id, outside: 2, unlisted: 0 }]);
  });

  it('[PLN-006] counts a blocker hidden from the viewer as outside the plan, and never names it', async () => {
    const { answer, body } = await timeline('ana');
    expect(answer.blockersElsewhere).toEqual([{ id: t.ship?.id, outside: 2, unlisted: 0 }]);
    const listed = new Set(answer.items.map((i) => i.id));
    for (const l of answer.links) {
      expect(listed.has(l.from) && listed.has(l.to)).toBe(true);
    }
    // Neither its key nor its summary is anywhere in the answer.
    expect(body).not.toContain(t.secret?.key);
    expect(body).not.toContain('Secret core work');
    expect(body).not.toContain('DPC');
    // The ticket's own page lists only the links she may see: the plan adds no name to them.
    const links = await call('ana', { method: 'GET', url: `/api/v1/tickets/${t.ship?.key}/links` });
    expect(links.links.map((l: { ticket: { key: string } }) => l.ticket.key).sort()).toEqual(
      [t.design?.key, t.invoice?.key, t.related?.key].sort(),
    );
  });

  it('[PLN-006] counts the plan’s own blockers that a filter leaves out apart from those outside it', async () => {
    const { answer } = await timeline('ana', '?assignee=me');
    expect(answer.items.map((i) => i.summary).sort()).toEqual(['Build', 'Ship']);
    expect(answer.links).toEqual([]);
    expect(answer.blockersElsewhere).toEqual(
      [
        { id: t.build?.id, outside: 0, unlisted: 1 },
        { id: t.ship?.id, outside: 2, unlisted: 1 },
      ].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
    );
  });

  it('[PLN-006] counts nothing for someone who sees none of the plan', async () => {
    const { answer, body } = await timeline('cy');
    expect(answer.items).toEqual([]);
    expect(answer.links).toEqual([]);
    expect(answer.blockersElsewhere).toEqual([]);
    expect(body).not.toContain('Secret core work');
  });

  it('[PLN-006] makes a blocker that joins the plan a line instead of a count', async () => {
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/plans/${planId}`,
      payload: {
        sources: [
          { kind: 'track', trackId: tracks.DPA },
          { kind: 'track', trackId: tracks.DPB },
        ],
      },
    });
    try {
      const { answer } = await timeline('ana');
      expect(answer.links).toContainEqual({
        from: t.invoice?.id,
        to: t.ship?.id,
        linkTypeId: blocks,
      });
      // Secret core work stays outside for her, and only counted.
      expect(answer.blockersElsewhere).toEqual([{ id: t.ship?.id, outside: 1, unlisted: 0 }]);
    } finally {
      await call('admin', {
        method: 'PATCH',
        url: `/api/v1/plans/${planId}`,
        payload: { sources: [{ kind: 'track', trackId: tracks.DPA }] },
      });
    }
  });
  describe('dependency options (PLN-013)', () => {
    const options = (linkTypeIds: number[], sameSprint: boolean) =>
      as('admin', {
        method: 'PATCH',
        url: `/api/v1/plans/${planId}`,
        payload: { dependencies: { linkTypeIds, sameSprint } },
      });
    afterAll(async () => {
      await options([], false);
    });

    it('[PLN-013] counts a chosen link type as a dependency, the source first, and none when not chosen', async () => {
      const relates = await linkType('relates to');
      const docs = await ticket('DPA', 'Docs', { startDate: '2027-03-01', dueDate: '2027-03-12' });
      await link(docs, t.build as { key: string }, 'relates to');
      // Not chosen: only blocking links, as before.
      let { answer } = await timeline('admin');
      expect(answer.links.some((l) => l.from === docs.id)).toBe(false);
      expect(answer.blockersElsewhere).toEqual([{ id: t.ship?.id, outside: 2, unlisted: 0 }]);

      expect((await options([relates], false)).statusCode).toBe(200);
      ({ answer } = await timeline('admin'));
      // Docs relates to Build: Build waits for Docs, late as PLN-006 judges it.
      expect(answer.links).toContainEqual({ from: docs.id, to: t.build?.id, linkTypeId: relates });
      // Related only (DPB, outside the plan) relates to Ship: now counted, never named.
      expect(answer.blockersElsewhere).toEqual([{ id: t.ship?.id, outside: 3, unlisted: 0 }]);
      expect(answer.linkTypes.map((l) => l.outward).sort()).toEqual(['blocks', 'relates to']);
      const plan = await call('admin', { method: 'GET', url: `/api/v1/plans/${planId}` });
      expect(plan.plan.dependencies).toEqual({
        linkTypes: [expect.objectContaining({ id: relates, outward: 'relates to' })],
        sameSprint: false,
      });

      // Ana sees the same lines; Secret core work stays a count.
      const seen = await timeline('ana');
      expect(seen.answer.links).toContainEqual({
        from: docs.id,
        to: t.build?.id,
        linkTypeId: relates,
      });
      expect(seen.body).not.toContain('Secret core work');

      // Taken away again: the line and the count go.
      await options([], false);
      ({ answer } = await timeline('admin'));
      expect(answer.links.some((l) => l.from === docs.id)).toBe(false);
      expect(answer.blockersElsewhere).toEqual([{ id: t.ship?.id, outside: 2, unlisted: 0 }]);
    });

    it('[PLN-013] [PLN-014] copies a plan’s dependency options with it', async () => {
      const relates = await linkType('relates to');
      expect((await options([relates], true)).statusCode).toBe(200);
      const copy = await call(
        'ana',
        {
          method: 'POST',
          url: `/api/v1/plans/${planId}/duplicate`,
          payload: { name: 'Delivery, copied' },
        },
        201,
      );
      expect(copy.plan.dependencies).toEqual({
        linkTypes: [expect.objectContaining({ id: relates })],
        sameSprint: true,
      });
      await options([], false);
    });

    it('[PLN-013] refuses blocking types, which are always counted, and types that do not exist', async () => {
      const refused = await options([blocks, 999_999], false);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().fields).toEqual({
        'dependencies.linkTypeIds.0': 'always_counted',
        'dependencies.linkTypeIds.1': 'not_found',
      });
      expect(
        (
          await as('ana', {
            method: 'PATCH',
            url: `/api/v1/plans/${planId}`,
            payload: { dependencies: { linkTypeIds: [], sameSprint: true } },
          })
        ).statusCode,
      ).toBe(403);
    });

    it('[PLN-013] marks a dependency within one open sprint only when the plan asks', async () => {
      const board = await database.db
        .insertInto('board')
        .values({
          workspace_id: 1,
          name: 'DPA board',
          kind: 'scrum',
          location_track_id: tracks.DPA as number,
          location_user_id: null,
          filter_query: 'track = DPA',
          sub_filter_query: null,
          columns: JSON.stringify([]),
          swimlanes: JSON.stringify({ kind: 'none' }),
          card_rules: JSON.stringify([]),
          created_by: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const sprint = await database.db
        .insertInto('sprint')
        .values({
          workspace_id: 1,
          board_id: board.id,
          name: 'DPA 1',
          sequence: 1,
          state: 'active',
          started_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await database.db
        .insertInto('sprint_ticket')
        .values([
          { workspace_id: 1, sprint_id: sprint.id, ticket_id: t.design?.id as number },
          { workspace_id: 1, sprint_id: sprint.id, ticket_id: t.build?.id as number },
        ])
        .execute();
      try {
        let { answer } = await timeline('admin');
        expect(answer.links.filter((l) => l.sameSprint)).toEqual([]);

        expect((await options([], true)).statusCode).toBe(200);
        ({ answer } = await timeline('admin'));
        expect(answer.sameSprint).toBe(true);
        expect(answer.links).toEqual([
          { from: t.design?.id, to: t.build?.id, linkTypeId: blocks, sameSprint: true },
          { from: t.design?.id, to: t.ship?.id, linkTypeId: blocks },
        ]);

        // A completed sprint marks nothing.
        await database.db
          .updateTable('sprint')
          .set({ state: 'closed', completed_at: new Date() })
          .where('id', '=', sprint.id)
          .execute();
        ({ answer } = await timeline('admin'));
        expect(answer.links.filter((l) => l.sameSprint)).toEqual([]);
      } finally {
        await options([], false);
        await database.db.deleteFrom('sprint_ticket').where('sprint_id', '=', sprint.id).execute();
        await database.db.deleteFrom('sprint').where('id', '=', sprint.id).execute();
        await database.db.deleteFrom('board').where('id', '=', board.id).execute();
      }
    });
  });

  /**
   * The critical path (PLN-011; ADR-122 stage 9). A plan over DPD: First -> Middle -> Last ends
   * the plan on 30 Apr; Side blocks Last; Wide runs beside them; Sprinted has no days and is
   * dated by its sprint's; Early only relates to First. A closed ticket of DPD blocks First, and
   * Secret core work (DPC, which Ana may not see) blocks Middle.
   */
  describe('the critical path (PLN-011)', () => {
    let pathPlan = 0;
    const p: Record<string, { id: number; key: string }> = {};
    interface PathAnswer {
      planEnd: string | null;
      chains: {
        tickets: {
          id: number;
          key: string;
          summary: string;
          start: string;
          end: string;
          slack: number;
        }[];
      }[];
      more: number;
      counts: { critical: number; cycles: number; undated: number; waitsElsewhere: number };
      listed: { id: number; slack: number }[];
      scenario?: { id: number };
    }
    const path = async (who: string, query = '') => {
      const res = await as(who, {
        method: 'GET',
        url: `/api/v1/plans/${pathPlan}/critical-path${query}`,
      });
      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
      return { body: res.body, answer: res.json() as PathAnswer };
    };
    const slackOf = (answer: PathAnswer) =>
      Object.fromEntries(answer.listed.map((l) => [l.id, l.slack]));
    const chainKeys = (answer: PathAnswer) =>
      answer.chains.map((c) => c.tickets.map((x) => x.summary));

    beforeAll(async () => {
      const made = await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'DPD', name: 'Delivery', mode: 'shared' },
        },
        201,
      );
      const members = (
        await database.db
          .selectFrom('role')
          .select('id')
          .where('name', '=', 'Members')
          .executeTakeFirstOrThrow()
      ).id;
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: made.track.id,
          role_id: members,
          user_id: users.ana?.id as number,
        })
        .execute();
      p.first = await ticket('DPD', 'First', { startDate: '2027-04-01', dueDate: '2027-04-05' });
      p.middle = await ticket('DPD', 'Middle', {
        startDate: '2027-04-06',
        dueDate: '2027-04-10',
        assigneeId: users.ana?.id,
      });
      p.last = await ticket('DPD', 'Last', { startDate: '2027-04-11', dueDate: '2027-04-30' });
      p.side = await ticket('DPD', 'Side', { startDate: '2027-04-01', dueDate: '2027-04-03' });
      p.wide = await ticket('DPD', 'Wide', { startDate: '2027-04-01', dueDate: '2027-04-20' });
      p.early = await ticket('DPD', 'Early', { startDate: '2027-03-20', dueDate: '2027-03-25' });
      p.sprinted = await ticket('DPD', 'Sprinted');
      p.undated = await ticket('DPD', 'Undated');
      p.closed = await ticket('DPD', 'Closed blocker', { dueDate: '2027-04-29' });
      await link(p.first, p.middle);
      await link(p.middle, p.last);
      await link(p.side, p.last);
      await link(p.early, p.first, 'relates to');
      await link(p.closed, p.first);
      await link(t.secret as { key: string }, p.middle);
      const closed = await database.db
        .selectFrom('status')
        .select('id')
        .where('stage', '=', 'closed')
        .limit(1)
        .executeTakeFirstOrThrow();
      await database.db
        .updateTable('ticket')
        .set({ status_id: closed.id, closed_at: new Date() })
        .where('id', '=', p.closed.id)
        .execute();
      const board = await database.db
        .insertInto('board')
        .values({
          workspace_id: 1,
          name: 'DPD board',
          kind: 'scrum',
          location_track_id: made.track.id,
          location_user_id: null,
          filter_query: 'track = DPD',
          sub_filter_query: null,
          columns: JSON.stringify([]),
          swimlanes: JSON.stringify({ kind: 'none' }),
          card_rules: JSON.stringify([]),
          created_by: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const sprint = await database.db
        .insertInto('sprint')
        .values({
          workspace_id: 1,
          board_id: board.id,
          name: 'DPD 1',
          sequence: 1,
          state: 'future',
          start_at: new Date('2027-04-12T09:00:00Z'),
          end_at: new Date('2027-04-30T17:00:00Z'),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await database.db
        .insertInto('sprint_ticket')
        .values({ workspace_id: 1, sprint_id: sprint.id, ticket_id: p.sprinted.id })
        .execute();
      pathPlan = (
        await call(
          'admin',
          {
            method: 'POST',
            url: '/api/v1/plans',
            payload: {
              name: 'Path',
              sources: [{ kind: 'track', trackId: made.track.id }],
              shares: [{ scope: 'any_user' }],
            },
          },
          201,
        )
      ).plan.id;
    }, 120_000);

    it('[PLN-011] gives a chain that ends the plan slack 0, and the tickets beside it their slack', async () => {
      // Acceptance 4.
      const { answer } = await path('admin');
      expect(answer.planEnd).toBe('2027-04-30');
      expect(chainKeys(answer)).toEqual([['First', 'Middle', 'Last'], ['Sprinted']]);
      expect(answer.chains[0]?.tickets[0]).toEqual({
        id: p.first?.id,
        key: p.first?.key,
        summary: 'First',
        start: '2027-04-01',
        end: '2027-04-05',
        slack: 0,
      });
      // Sprinted is read by its sprint's days.
      expect(answer.chains[1]?.tickets[0]).toMatchObject({
        start: '2027-04-12',
        end: '2027-04-30',
      });
      expect(slackOf(answer)).toEqual({
        [p.first?.id as number]: 0,
        [p.middle?.id as number]: 0,
        [p.last?.id as number]: 0,
        [p.sprinted?.id as number]: 0,
        // Last may start no later than 11 Apr.
        [p.side?.id as number]: 7,
        [p.wide?.id as number]: 10,
        // Relates to First, which is not a dependency until the plan chooses it.
        [p.early?.id as number]: 36,
      });
      // The closed blocker holds nothing; Secret core work waits elsewhere, only counted.
      expect(answer.counts).toEqual({ critical: 4, cycles: 0, undated: 1, waitsElsewhere: 1 });
      expect(answer.more).toBe(0);
    });

    it('[PLN-011] [QRY-008] never names a blocker the viewer may not see', async () => {
      const { answer, body } = await path('ana');
      expect(answer.counts.waitsElsewhere).toBe(1);
      expect(body).not.toContain(t.secret?.key);
      expect(body).not.toContain('Secret core work');
      expect(body).not.toContain('DPC');
      // Someone shown none of the plan gets no path at all.
      const none = await path('cy');
      expect(none.answer).toMatchObject({ planEnd: null, chains: [], listed: [] });
      expect(none.body).not.toContain('First');
    });

    it('[PLN-011] lets the filters change only which tickets are listed, never the path', async () => {
      const all = await path('ana');
      const mine = await path('ana', '?assignee=me');
      expect(mine.answer.listed).toEqual([{ id: p.middle?.id, slack: 0 }]);
      expect(mine.answer.chains).toEqual(all.answer.chains);
      expect(mine.answer.planEnd).toBe(all.answer.planEnd);
      expect(mine.answer.counts).toEqual(all.answer.counts);
    });

    it('[PLN-011] [PLN-013] counts a link type the plan chose', async () => {
      const relates = await linkType('relates to');
      const set = (linkTypeIds: number[]) =>
        call('admin', {
          method: 'PATCH',
          url: `/api/v1/plans/${pathPlan}`,
          payload: { dependencies: { linkTypeIds, sameSprint: false } },
        });
      await set([relates]);
      try {
        const { answer } = await path('admin');
        // Early relates to First, which may start no later than 1 Apr.
        expect(slackOf(answer)[p.early?.id as number]).toBe(6);
      } finally {
        await set([]);
      }
    });

    it('[PLN-011] reads a scenario’s days', async () => {
      const scenario = (
        await call(
          'admin',
          {
            method: 'POST',
            url: `/api/v1/plans/${pathPlan}/scenarios`,
            payload: { name: 'Later' },
          },
          201,
        )
      ).scenario as { id: number };
      await call('admin', {
        method: 'PUT',
        url: `/api/v1/plans/${pathPlan}/scenarios/${scenario.id}/drafts`,
        payload: { changes: [{ ticketId: p.wide?.id, dueDate: '2027-05-10' }] },
      });
      const { answer } = await path('admin', `?scenario=${scenario.id}`);
      expect(answer.scenario?.id).toBe(scenario.id);
      expect(answer.planEnd).toBe('2027-05-10');
      expect(chainKeys(answer)).toEqual([['Wide']]);
      expect(slackOf(answer)[p.last?.id as number]).toBe(10);
      // Live is unchanged.
      expect((await path('admin')).answer.planEnd).toBe('2027-04-30');
    });

    it('[PLN-011] answers 404 for a plan the viewer may not see and 400 for another plan’s scenario', async () => {
      const missing = await as('admin', {
        method: 'GET',
        url: '/api/v1/plans/999999/critical-path',
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'not_found' });
      const other = await as('admin', {
        method: 'GET',
        url: `/api/v1/plans/${pathPlan}/critical-path?scenario=999999`,
      });
      expect(other.statusCode).toBe(400);
      expect(other.json()).toEqual({ error: 'invalid_fields', fields: { scenario: 'not_found' } });
      const bad = await as('admin', {
        method: 'GET',
        url: `/api/v1/plans/${pathPlan}/critical-path?stage=later`,
      });
      expect(bad.statusCode).toBe(400);
    });

    it('[PLN-011] [QRY-008] answers a member 404 for a private plan of someone else, word for word as a missing id', async () => {
      const hidden = (
        await call(
          'admin',
          {
            method: 'POST',
            url: '/api/v1/plans',
            payload: { name: 'Private path', sources: [{ kind: 'track', trackId: tracks.DPA }] },
          },
          201,
        )
      ).plan.id as number;
      // Its owner reads its path; Ana, who sees its tickets, may not see the plan.
      expect(
        (await as('admin', { method: 'GET', url: `/api/v1/plans/${hidden}/critical-path` }))
          .statusCode,
      ).toBe(200);
      const refused = await as('ana', {
        method: 'GET',
        url: `/api/v1/plans/${hidden}/critical-path`,
      });
      const missing = await as('ana', { method: 'GET', url: '/api/v1/plans/999999/critical-path' });
      expect(refused.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(refused.body).toBe(missing.body);
      expect(refused.body).not.toContain('Design');
    });

    /** `n` copies of `template` in its track, in one statement. */
    async function copies(template: { id: number }, n: number, tag: string): Promise<void> {
      const columns = (
        await sql<{ column_name: string }>`
          SELECT column_name FROM information_schema.columns
           WHERE table_name = 'ticket' AND table_schema = 'public'
             AND column_name NOT IN ('id', 'number', 'rank', 'search_vector')
             AND is_generated = 'NEVER'`.execute(database.db)
      ).rows.map((r) => r.column_name);
      const list = sql.join(columns.map((c) => sql.ref(c)));
      const row = await database.db
        .selectFrom('ticket')
        .select('track_id')
        .where('id', '=', template.id)
        .executeTakeFirstOrThrow();
      const top = await sql<{ n: number }>`
        SELECT max(number)::int AS n FROM ticket WHERE track_id = ${row.track_id}`.execute(
        database.db,
      );
      await sql`
        INSERT INTO ticket (number, rank, ${list})
        SELECT ${top.rows[0]?.n ?? 0} + g, rank || ${tag}::text || lpad(g::text, 6, '0'), ${list}
          FROM ticket, generate_series(1, ${n}::int) g
         WHERE id = ${template.id}`.execute(database.db);
    }

    it('[PLN-011] names 500 tickets of the chains at most and counts the rest, and refuses a plan of more than 50,000 open tickets', async () => {
      const track = await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'DPL', name: 'Large', mode: 'shared' },
        },
        201,
      );
      const large = (
        await call(
          'admin',
          {
            method: 'POST',
            url: '/api/v1/plans',
            payload: {
              name: 'Large path',
              sources: [{ kind: 'track', trackId: track.track.id }],
              shares: [{ scope: 'any_user' }],
            },
          },
          201,
        )
      ).plan.id as number;
      const read = (who: string) =>
        as(who, { method: 'GET', url: `/api/v1/plans/${large}/critical-path` });
      // 600 tickets that all end on the plan's last day: each is critical, a chain of its own.
      const template = await ticket('DPL', 'Even', {
        startDate: '2027-05-01',
        dueDate: '2027-05-10',
      });
      await copies(template, 599, 'c');
      const cut = await read('admin');
      expect(cut.statusCode, cut.body.slice(0, 400)).toBe(200);
      const answer = cut.json() as PathAnswer;
      expect(answer.counts.critical).toBe(600);
      expect(answer.chains.reduce((n, c) => n + c.tickets.length, 0)).toBe(500);
      expect(answer.more).toBe(100);
      expect(answer.chains.every((c) => c.tickets.every((x) => x.key.startsWith('DPL-')))).toBe(
        true,
      );
      // Past 50,000 open tickets nothing is computed: they are counted first.
      for (const [tag, n] of [
        ['a', 10_000],
        ['b', 10_000],
        ['d', 10_000],
        ['e', 10_000],
        ['f', 9_401],
      ] as const)
        await copies(template, n, tag);
      const refused = await read('admin');
      expect(refused.statusCode, refused.body.slice(0, 400)).toBe(409);
      expect(refused.json()).toEqual({ error: 'plan_too_large', limit: 50_000 });
    }, 240_000);
  });
});
