import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { localDate } from '@taskmoor/query';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { crossTrackState, moveOutcome } from '../plans/cross-track';

// Made for this run: no password is written in the repository.
const PASSWORD = `cross-track-${randomBytes(18).toString('base64url')}`;
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

/** Must never reach anyone who may not see the hidden track. */
const HIDDEN_TRACK = 'Sentinel hidden track';
const HIDDEN_RELEASE = 'Sentinel hidden release';
const HIDDEN_DAY = '2031-03-17';
const HIDDEN_TICKET = 'Sentinel hidden ticket';

interface Member {
  id: number;
  name: string;
  track: { id: number; key: string; name: string };
  releaseDate: string | null;
  archived: boolean;
  trackArchived: boolean;
  overdue: boolean;
  outOfStep: boolean;
  progress: { tickets: number; closed: number; open: number };
  mayRemove: boolean;
}
interface Counted {
  query: string;
  count: number;
  exact: boolean;
}
interface Answer {
  id: number;
  name: string;
  state: string;
  version: number;
  endRule: string;
  date: string | null;
  stages: { new: Counted; active: Counted; closed: Counted };
  open: Counted;
  warnings: { code: string; count: number; query?: string }[];
  members: Member[];
  hidden: { releases: number; open: number };
  tickets: { key: string; summary: string }[];
  truncated: boolean;
  viewer: { mayManage: boolean; mayLink: boolean };
}
interface Line {
  id: number;
  name: string;
  from: string | null;
  to: string;
  outcome: 'moves' | 'same' | 'stays';
  reason?: string;
}

/**
 * Releases across tracks (T-089c; PLN-007; ADR-122 stage 4). Three tracks: Ana administers XTA and
 * XTB, Bo browses XTA only, Cy may see a single ticket of XTC by being its requester and browses no
 * track, and only the site administrator sees XTC, the hidden track, whose names and day are
 * sentinels that must appear in nobody else's answers.
 */
describe('releases across tracks (PLN-007)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const releases: Record<string, number> = {};
  let crossId = 0;
  let granted = '';

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
  const post = (who: string, url: string, payload: Record<string, unknown>, code = 200) =>
    call(who, { method: 'POST', url, payload }, code);
  const base = (id = crossId) => `/api/v1/cross-track-releases/${id}`;
  const read = (who: string, id = crossId) => get(who, base(id)) as Promise<Answer>;
  const searchCount = async (who: string, q: string): Promise<number> =>
    (await post(who, '/api/v1/search', { q, count: true })).total.count;
  const role = async (name: string) =>
    (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', name)
        .executeTakeFirstOrThrow()
    ).id;
  /** Gives someone a role on a track; what it answers takes it away again. */
  const join = async (who: string, track: string, roleName: string) => {
    const roleId = await role(roleName);
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: tracks[track] as number,
        role_id: roleId,
        user_id: users[who]?.id as number,
      })
      .execute();
    return async () => {
      await database.db
        .deleteFrom('track_role_actor')
        .where('track_id', '=', tracks[track] as number)
        .where('role_id', '=', roleId)
        .where('user_id', '=', users[who]?.id as number)
        .execute();
    };
  };
  const ticket = async (track: string, summary: string, release: string, data = {}) =>
    (
      await post(
        'admin',
        '/api/v1/tickets',
        { track, summary, targetReleaseIds: [releases[release]], ...data },
        201,
      )
    ).ticket as { id: number; key: string };
  const addRelease = async (track: string, name: string, data: Record<string, unknown> = {}) => {
    const made = await post(
      'admin',
      `/api/v1/tracks/${tracks[track]}/releases`,
      { name, ...data },
      201,
    );
    releases[name] = made.release.id;
    return made.release.id as number;
  };
  /** Closes a ticket by putting it in a closed status, as a search reads it. */
  const closeTicket = async (id: number) => {
    const closed = await database.db
      .selectFrom('status')
      .select('id')
      .where('stage', '=', 'closed')
      .limit(1)
      .executeTakeFirstOrThrow();
    await database.db
      .updateTable('ticket')
      .set({ status_id: closed.id, closed_at: new Date() })
      .where('id', '=', id)
      .execute();
  };
  const eventCount = async (type: string) =>
    Number(
      (
        await database.db
          .selectFrom('domain_event')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('type', '=', type)
          .executeTakeFirstOrThrow()
      ).n,
    );
  const eventsOf = async (type: string) =>
    (
      await database.db
        .selectFrom('domain_event')
        .select(['payload', 'subject_id'])
        .where('type', '=', type)
        .orderBy('id')
        .execute()
    ).map((e) => ({ subject: e.subject_id, payload: e.payload as Record<string, unknown> }));

  /** One release across XTA, XTB and the hidden XTC, as the administrator makes it. */
  const makeWhole = async (name = 'Spring launch', date = '2027-05-10') =>
    (await post(
      'admin',
      '/api/v1/cross-track-releases',
      {
        name,
        endRule: 'fixed_date',
        date,
        releaseIds: [releases['A 1.0'], releases['B 1.0'], releases[HIDDEN_RELEASE]],
      },
      201,
    )) as Answer;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['ana', false],
      ['bo', false],
      ['cy', false],
      ['di', false],
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
      ['XTA', 'Apps'],
      ['XTB', 'Billing'],
      ['XTC', HIDDEN_TRACK],
      ['XTD', 'Docs'],
    ] as const) {
      const made = await call(
        'admin',
        { method: 'POST', url: '/api/v1/tracks', payload: { key, name, mode: 'shared' } },
        201,
      );
      tracks[key] = made.track.id;
    }
    await join('ana', 'XTA', 'Administrators');
    await join('ana', 'XTB', 'Administrators');
    await join('bo', 'XTA', 'Members');
    await join('di', 'XTD', 'Administrators');
    // XTC's policy lets requesters see their own tickets: a ticket-level grant, never the track.
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
      .where('id', '=', tracks.XTC as number)
      .execute();
    await addRelease('XTA', 'A 1.0', { releaseDate: '2027-05-10' });
    await addRelease('XTB', 'B 1.0', { releaseDate: '2027-05-10' });
    await addRelease('XTC', HIDDEN_RELEASE, { releaseDate: HIDDEN_DAY });
    await addRelease('XTD', 'D 1.0', { releaseDate: '2027-05-10' });
    await ticket('XTA', 'Shop page', 'A 1.0', { assigneeId: users.bo?.id });
    await ticket('XTA', 'Cart', 'A 1.0');
    await ticket('XTB', 'Invoice run', 'B 1.0', { assigneeId: users.ana?.id });
    await ticket('XTC', HIDDEN_TICKET, HIDDEN_RELEASE);
    await ticket('XTC', `${HIDDEN_TICKET} two`, HIDDEN_RELEASE);
    const asked = await ticket('XTC', 'Printer jam', HIDDEN_RELEASE);
    granted = asked.key;
    await database.db
      .updateTable('ticket')
      .set({ requester_id: users.cy?.id as number })
      .where('id', '=', asked.id)
      .execute();
    crossId = (await makeWhole()).id;
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  const restore = async () => {
    // Each test leaves the shared release across tracks as it found it.
    await database.db
      .updateTable('cross_track_release')
      .set({ end_rule: 'fixed_date', release_date: '2027-05-10' })
      .where('id', '=', crossId)
      .execute();
    for (const name of ['A 1.0', 'B 1.0']) {
      await database.db
        .updateTable('release')
        .set({ release_date: '2027-05-10', shipped_at: null, archived_at: null, start_date: null })
        .where('id', '=', releases[name] as number)
        .execute();
    }
    await database.db
      .updateTable('release')
      .set({ release_date: HIDDEN_DAY, shipped_at: null, archived_at: null, start_date: null })
      .where('id', '=', releases[HIDDEN_RELEASE] as number)
      .execute();
    await database.db
      .updateTable('track')
      .set({ archived_at: null, deleted_at: null })
      .where('id', 'in', [tracks.XTA as number, tracks.XTB as number, tracks.XTC as number])
      .execute();
  };
  beforeEach(restore);

  describe('[PLN-007] making and linking', () => {
    it('[PLN-007] makes one from releases of tracks the person administers, and records one event', async () => {
      const before = await eventCount('cross_track_release.created');
      const made = (await post(
        'ana',
        '/api/v1/cross-track-releases',
        {
          name: 'Ana’s launch',
          description: 'Two tracks, one day',
          endRule: 'fixed_date',
          date: '2027-06-01',
          releaseIds: [await addRelease('XTA', 'A 2.0'), await addRelease('XTB', 'B 2.0')],
        },
        201,
      )) as Answer;
      expect(made).toMatchObject({
        name: 'Ana’s launch',
        endRule: 'fixed_date',
        date: '2027-06-01',
        state: 'upcoming',
        version: 1,
        viewer: { mayManage: true },
        hidden: { releases: 0, open: 0 },
      });
      expect(made.members.map((m) => m.name)).toEqual(['A 2.0', 'B 2.0']);
      expect(await eventCount('cross_track_release.created')).toBe(before + 1);
      // Linking never moves a date: neither release had one, and they read out of step.
      expect(made.members.every((m) => m.releaseDate === null && m.outOfStep)).toBe(true);
    });

    it('[PLN-007] refuses a date with the wrong end, and a release twice', async () => {
      const path = '/api/v1/cross-track-releases';
      const a = releases['A 1.0'];
      const fields = async (payload: Record<string, unknown>) =>
        (await post('admin', path, payload, 400)).fields;
      expect(await fields({ name: 'x', endRule: 'fixed_date', releaseIds: [a] })).toEqual({
        date: 'required',
      });
      expect(
        await fields({ name: 'x', endRule: 'work_complete', date: '2027-01-01', releaseIds: [a] }),
      ).toEqual({ date: 'not_with_work_complete' });
      expect(await fields({ name: 'x', endRule: 'work_complete', releaseIds: [a, a] })).toEqual({
        releaseIds: 'duplicate',
      });
      expect(await fields({ name: 'x', endRule: 'work_complete', releaseIds: [] })).toHaveProperty(
        'releaseIds',
      );
    });

    it('[PLN-007] refuses each kind of release that may not be linked', async () => {
      const path = '/api/v1/cross-track-releases';
      const body = (id: number) => ({ name: 'x', endRule: 'work_complete', releaseIds: [id] });
      // Hidden answers as absent; seen but not administered is forbidden.
      expect(
        (await post('ana', path, body(releases[HIDDEN_RELEASE] as number), 400)).fields,
      ).toEqual({ 'releaseIds.0': 'not_found' });
      expect((await post('ana', path, body(99_999_999), 400)).fields).toEqual({
        'releaseIds.0': 'not_found',
      });
      await post('bo', path, body(releases['A 1.0'] as number), 403);
      // Already linked.
      expect((await post('ana', path, body(releases['A 1.0'] as number), 409)).error).toBe(
        'release_taken',
      );
      // Shipped, archived, or two of one track.
      const shipped = await addRelease('XTA', 'A shipped');
      await post('admin', `/api/v1/releases/${shipped}/ship`, {});
      expect((await post('ana', path, body(shipped), 409)).error).toBe('release_shipped');
      const archived = await addRelease('XTA', 'A archived');
      await post('admin', `/api/v1/releases/${archived}/archive`, {});
      expect((await post('ana', path, body(archived), 409)).error).toBe('release_archived');
      const one = await addRelease('XTB', 'B 3.0');
      const two = await addRelease('XTB', 'B 3.1');
      expect(
        (
          await post(
            'ana',
            path,
            { name: 'x', endRule: 'work_complete', releaseIds: [one, two] },
            409,
          )
        ).error,
      ).toBe('track_taken');
    });

    it('[PLN-007] links and unlinks one by one, with the version moving, and frees what it held', async () => {
      const a = await addRelease('XTA', 'A 4.0');
      const b = await addRelease('XTB', 'B 4.0');
      const b2 = await addRelease('XTB', 'B 4.1');
      const made = (await post(
        'ana',
        '/api/v1/cross-track-releases',
        { name: 'One by one', endRule: 'work_complete', releaseIds: [a] },
        201,
      )) as Answer;
      const members = `${base(made.id)}/members`;
      const linked = (await post('ana', members, { releaseId: b }, 201)) as Answer;
      expect(linked.version).toBe(made.version + 1);
      expect(linked.members.map((m) => m.name)).toEqual(['A 4.0', 'B 4.0']);
      expect((await post('ana', members, { releaseId: b2 }, 409)).error).toBe('track_taken');
      // Bo sees it (he browses XTA) and administers neither: a release of XTA is his to see and not
      // to link, and one of XTB reads as one that does not exist.
      const other = await addRelease('XTA', 'A 4.1');
      expect((await post('bo', members, { releaseId: other }, 403)).permission).toBe(
        'administer_track',
      );
      expect((await post('bo', members, { releaseId: b2 }, 400)).fields).toEqual({
        releaseId: 'not_found',
      });
      await call('bo', { method: 'DELETE', url: `${members}/${b}` }, 404);
      await call('bo', { method: 'DELETE', url: `${members}/${a}` }, 403);
      await call('ana', { method: 'DELETE', url: `${members}/${b}` }, 204);
      expect((await read('ana', made.id)).members.map((m) => m.name)).toEqual(['A 4.0']);
      // Someone who sees nothing of it cannot learn it exists.
      await post('di', members, { releaseId: releases['D 1.0'] as number }, 404);
      const events = await eventsOf('cross_track_release.member_removed');
      expect(events.at(-1)?.payload).toEqual({
        releaseId: b,
        trackId: tracks.XTB,
        reason: 'removed',
      });
      await call('ana', { method: 'DELETE', url: base(made.id) }, 204);
      await get('ana', base(made.id), 404);
      // Its releases stay, and may join another.
      expect((await get('ana', `/api/v1/releases/${a}`)).release.crossTrack).toBeNull();
    });

    it('[PLN-007] offers upcoming unlinked releases of tracks the person administers', async () => {
      const listed = async (who: string) =>
        ((await get(who, `${'/api/v1/cross-track-releases'}/candidates`)).releases as Member[]).map(
          (r) => r.name,
        );
      const ana = await listed('ana');
      expect(ana).not.toContain('A 1.0');
      expect(ana).not.toContain(HIDDEN_RELEASE);
      expect(await listed('bo')).toEqual([]);
      expect(await listed('di')).toEqual(['D 1.0']);
    });
  });

  describe('[PLN-007] who sees what', () => {
    it('[PLN-007] answers those who see no linked track exactly as for an id that does not exist', async () => {
      const paths = [
        (id: number) => ({ method: 'GET' as const, url: base(id) }),
        (id: number) => ({ method: 'GET' as const, url: `${base(id)}/move?date=2027-06-01` }),
        (id: number) => ({
          method: 'PATCH' as const,
          url: base(id),
          payload: { name: 'x', version: 1 },
        }),
        (id: number) => ({ method: 'DELETE' as const, url: base(id) }),
        (id: number) => ({
          method: 'POST' as const,
          url: `${base(id)}/move`,
          payload: { date: '2027-06-01', version: 1 },
        }),
        (id: number) => ({
          method: 'POST' as const,
          url: `${base(id)}/members`,
          payload: { releaseId: releases['D 1.0'] as number },
        }),
        (id: number) => ({
          method: 'DELETE' as const,
          url: `${base(id)}/members/${releases['A 1.0']}`,
        }),
      ];
      for (const options of paths) {
        const hidden = await as('cy', options(crossId));
        const absent = await as('cy', options(99_999_999));
        expect(hidden.statusCode, options(crossId).url).toBe(404);
        expect(hidden.body).toBe(absent.body);
        const outsider = await as('di', options(crossId));
        expect(outsider.statusCode, options(crossId).url).toBe(404);
        expect(outsider.body).toBe(absent.body);
      }
    });

    it('[PLN-007] tells a viewer of the tracks they see and only counts the rest, as one number each', async () => {
      const bo = await read('bo');
      expect(bo.members.map((m) => m.track.key)).toEqual(['XTA']);
      expect(bo.viewer.mayManage).toBe(false);
      expect(bo.hidden).toEqual({ releases: 2, open: 4 });
      expect(bo.tickets.map((t) => t.summary).sort()).toEqual(['Cart', 'Shop page']);
      const ana = await read('ana');
      expect(ana.members.map((m) => m.track.key)).toEqual(['XTA', 'XTB']);
      expect(ana.hidden).toEqual({ releases: 1, open: 3 });
      const admin = await read('admin');
      expect(admin.members.map((m) => m.track.key)).toEqual(['XTA', 'XTB', 'XTC']);
      expect(admin.hidden).toEqual({ releases: 0, open: 0 });
    });

    it('[PLN-007] never names the hidden track, release, day or tickets in any answer', async () => {
      const q = encodeURIComponent(`crossTrackRelease = ${crossId}`);
      const answers = await Promise.all(
        ['bo', 'ana'].flatMap((who) =>
          [
            base(),
            `${base()}/move?date=2027-06-01`,
            '/api/v1/cross-track-releases',
            '/api/v1/cross-track-releases/candidates',
            `/api/v1/releases/${releases['A 1.0']}`,
            `/api/v1/search?q=${q}`,
          ].map((url) => as(who, { method: 'GET', url })),
        ),
      );
      for (const res of answers) {
        for (const sentinel of [HIDDEN_TRACK, HIDDEN_RELEASE, HIDDEN_DAY, HIDDEN_TICKET, 'XTC']) {
          expect(res.body, sentinel).not.toContain(sentinel);
        }
      }
    });

    it('[PLN-007] gives a ticket-level grant nothing: no release across tracks, on a page or a label', async () => {
      // Cy sees one ticket of XTC, and browses no track.
      expect(await searchCount('cy', `key = ${granted}`)).toBe(1);
      await get('cy', base(), 404);
      expect((await get('cy', '/api/v1/cross-track-releases')).releases).toEqual([]);
      await get('cy', `/api/v1/releases/${releases[HIDDEN_RELEASE]}`, 404);
    });

    it('[PLN-007] never ties a ticket seen through a grant to it, for a viewer who also sees another linked track', async () => {
      // Cy browses XTA, and sees one ticket of the hidden XTC by being its requester.
      const leave = await join('cy', 'XTA', 'Members');
      try {
        const q = `crossTrackRelease = ${crossId}`;
        const answer = await read('cy');
        expect(answer.members.map((m) => m.track.key)).toEqual(['XTA']);
        expect(answer.tickets.map((t) => t.summary).sort()).toEqual(['Cart', 'Shop page']);
        // The count is what Bo, who holds no grant, is told: the grant changes no number.
        expect(answer.hidden).toEqual((await read('bo')).hidden);
        expect(answer.open.count).toBe(2);
        expect(await searchCount('cy', q)).toBe(2);
        // The ticket answers as any ticket that is not linked would, under every operator.
        expect(await searchCount('cy', `key = ${granted}`)).toBe(1);
        expect(await searchCount('cy', `key = ${granted} AND ${q}`)).toBe(0);
        expect(
          await searchCount('cy', `key = ${granted} AND crossTrackRelease != ${crossId}`),
        ).toBe(await searchCount('cy', `key = ${granted}`));
        expect(
          await searchCount('cy', `key = ${granted} AND crossTrackRelease IN (${crossId})`),
        ).toBe(0);
        const row = (await get('cy', '/api/v1/cross-track-releases')).releases.find(
          (r: { id: number }) => r.id === crossId,
        );
        expect(row.progress).toEqual({ tickets: 2, closed: 0, open: 2 });
        expect(row.hidden).toEqual(answer.hidden);
        const body = JSON.stringify(answer);
        for (const sentinel of [HIDDEN_RELEASE, HIDDEN_TRACK, 'Printer jam', granted]) {
          expect(body, sentinel).not.toContain(sentinel);
        }
      } finally {
        await leave();
      }
    });

    it('[PLN-007] [QRY-002] finds nothing for one whose linked releases are all hidden, or that has none', async () => {
      const a = await addRelease('XTA', 'A 12.0', { releaseDate: '2027-07-01' });
      const made = (await post(
        'ana',
        '/api/v1/cross-track-releases',
        { name: 'Left empty', endRule: 'work_complete', releaseIds: [a] },
        201,
      )) as Answer;
      await ticket('XTA', 'Left behind', 'A 12.0');
      await call('ana', { method: 'DELETE', url: `${base(made.id)}/members/${a}` }, 204);
      expect(await searchCount('ana', `crossTrackRelease = ${made.id}`)).toBe(0);
      await call('ana', { method: 'DELETE', url: base(made.id) }, 204);
    });

    it('[PLN-007] [QRY-002] keeps a page to its own id, whatever another is named, and a quoted name still finds that one', async () => {
      const before = await read('ana');
      const a = await addRelease('XTA', 'A 13.0', { releaseDate: '2027-07-01' });
      await ticket('XTA', 'Shadow ticket', 'A 13.0');
      const shadow = (await post(
        'ana',
        '/api/v1/cross-track-releases',
        { name: String(crossId), endRule: 'work_complete', releaseIds: [a] },
        201,
      )) as Answer;
      const after = await read('ana');
      expect(after.tickets).toEqual(before.tickets);
      expect(after.stages.new.count).toBe(before.stages.new.count);
      expect(after.open.count).toBe(before.open.count);
      expect(after.warnings).toEqual(before.warnings);
      expect(await searchCount('ana', `crossTrackRelease = ${crossId}`)).toBe(before.open.count);
      const quoted = await post('ana', '/api/v1/search', {
        q: `crossTrackRelease = "${crossId}"`,
        limit: 10,
      });
      expect((quoted.tickets as { summary: string }[]).map((t) => t.summary)).toEqual([
        'Shadow ticket',
      ]);
      // A bare number nobody has as an id is still read as a name, as before.
      const sevens = '900000007';
      await call(
        'ana',
        {
          method: 'PATCH',
          url: base(shadow.id),
          payload: { name: sevens, version: shadow.version },
        },
        200,
      );
      expect(await searchCount('ana', `crossTrackRelease = ${sevens}`)).toBe(1);
      await call('ana', { method: 'DELETE', url: base(shadow.id) }, 204);
    });

    it('[PLN-007] answers a cursor that is not one with a refusal, never the database’s', async () => {
      for (const cursor of [
        '2026-13-45_1',
        '2026-02-30_1',
        '0000-01-01_1',
        '2026-01-01_9999999999',
      ]) {
        const res = await as('bo', {
          method: 'GET',
          url: `/api/v1/cross-track-releases?cursor=${cursor}`,
        });
        expect(res.statusCode, `${cursor}: ${res.body}`).toBe(400);
        expect(res.json().error).toBe('invalid_fields');
      }
      // The end of a list with no date is a real cursor, and the largest id too.
      await get('bo', '/api/v1/cross-track-releases?cursor=9999-12-31_2147483647');
    });

    it('[PLN-007] finds any release that may be linked by a word, past where the list stops', async () => {
      const q = (word: string) =>
        get('ana', `/api/v1/cross-track-releases/candidates?q=${encodeURIComponent(word)}`);
      const a = await addRelease('XTB', 'Far along 100%');
      expect((await q('billing')).releases.map((r: { id: number }) => r.id)).toContain(a);
      expect((await q('FAR ALONG')).releases.map((r: { id: number }) => r.id)).toEqual([a]);
      expect((await q('100%')).releases.map((r: { id: number }) => r.id)).toEqual([a]);
      // Its wildcards are plain text, and a word finds only what the person may link.
      expect((await q('%')).releases.map((r: { id: number }) => r.id)).toEqual([a]);
      expect((await q('D 1.0')).releases).toEqual([]);
      expect((await q('no such thing')).releases).toEqual([]);
      const all = await get('ana', '/api/v1/cross-track-releases/candidates');
      expect(all.releases.map((r: { id: number }) => r.id)).toContain(a);
    });

    it('[PLN-007] offers linking only to someone with a track to link from', async () => {
      expect((await read('bo')).viewer).toEqual({ mayManage: false, mayLink: false });
      expect((await read('ana')).viewer.mayLink).toBe(true);
      expect((await read('admin')).viewer).toEqual({ mayManage: true, mayLink: true });
    });

    it('[PLN-007] lists what the person sees, upcoming or shipped, with counts on all its work', async () => {
      const list = async (who: string, state = 'upcoming') =>
        (await get(who, `/api/v1/cross-track-releases?state=${state}`)).releases as {
          id: number;
          name: string;
          state: string;
          tracks: { key: string }[];
          hidden: { releases: number; open: number };
          progress: { tickets: number; closed: number; open: number };
        }[];
      const mine = (await list('bo')).find((r) => r.id === crossId);
      expect(mine?.tracks.map((t) => t.key)).toEqual(['XTA']);
      expect(mine?.hidden).toEqual({ releases: 2, open: 4 });
      expect(mine?.progress).toEqual({ tickets: 2, closed: 0, open: 2 });
      expect((await list('di')).map((r) => r.id)).not.toContain(crossId);
      expect((await list('bo', 'shipped')).map((r) => r.id)).not.toContain(crossId);
      await database.db
        .updateTable('release')
        .set({ shipped_at: new Date() })
        .where('id', 'in', [
          releases['A 1.0'] as number,
          releases['B 1.0'] as number,
          releases[HIDDEN_RELEASE] as number,
        ])
        .execute();
      expect((await list('bo', 'shipped')).map((r) => r.id)).toContain(crossId);
      expect((await list('bo')).map((r) => r.id)).not.toContain(crossId);
    });

    it('[PLN-007] pages the list with a cursor that holds its place', async () => {
      await post(
        'admin',
        '/api/v1/cross-track-releases',
        {
          name: 'Paged',
          endRule: 'work_complete',
          releaseIds: [await addRelease('XTD', 'D paged')],
        },
        201,
      );
      const first = await get('admin', '/api/v1/cross-track-releases');
      expect(first.next).toBeNull();
      const dates = (first.releases as { date: string | null }[]).map((r) => r.date);
      expect(dates.at(-1)).toBeNull();
      await get('admin', '/api/v1/cross-track-releases?cursor=not-a-cursor', 400);
      const after = await get('admin', '/api/v1/cross-track-releases?cursor=2027-05-10_1');
      expect((after.releases as { name: string }[]).map((r) => r.name)).toContain('Paged');
    });

    it('[PLN-007] [QRY-008] makes every number equal its search, for each viewer, and visible plus hidden equals all', async () => {
      const everything = await searchCount('admin', `crossTrackRelease = ${crossId}`);
      for (const who of ['bo', 'ana', 'admin']) {
        const answer = await read(who);
        for (const counted of [
          answer.stages.new,
          answer.stages.active,
          answer.stages.closed,
          answer.open,
        ]) {
          expect(counted.count, `${who}: ${counted.query}`).toBe(
            await searchCount(who, counted.query),
          );
        }
        expect(answer.open.count + answer.hidden.open, who).toBe(everything);
        for (const w of answer.warnings) {
          if (w.query) expect(w.count, `${who}: ${w.code}`).toBe(await searchCount(who, w.query));
        }
      }
    });
  });

  describe('[PLN-007] the state', () => {
    it('[PLN-007] follows the table: empty, shipped, overdue, ready, upcoming', () => {
      const day = '2027-01-10';
      const state = (input: Partial<Parameters<typeof crossTrackState>[0]>) =>
        crossTrackState({
          endRule: 'fixed_date',
          date: '2027-02-01',
          today: day,
          releases: 2,
          shipped: 0,
          tickets: 3,
          open: 1,
          ...input,
        });
      expect(state({ releases: 0, shipped: 0 })).toBe('empty');
      expect(state({ shipped: 2 })).toBe('shipped');
      expect(state({ date: '2027-01-09' })).toBe('overdue');
      expect(state({ date: '2027-01-10' })).toBe('upcoming');
      expect(state({ open: 0 })).toBe('ready');
      expect(state({ tickets: 0, open: 0 })).toBe('upcoming');
      expect(state({ endRule: 'work_complete', date: null, open: 0 })).toBe('ready');
      expect(state({ endRule: 'work_complete', date: null })).toBe('upcoming');
    });

    it('[PLN-007] judges on all its work: a hidden open ticket keeps it from ready, and nothing ships by itself', async () => {
      const a = await addRelease('XTA', 'A 5.0');
      const c = await addRelease('XTC', 'C 5.0');
      const done = await ticket('XTA', 'Done work', 'A 5.0');
      const hidden = await ticket('XTC', 'Hidden work', 'C 5.0');
      const made = (await post(
        'admin',
        '/api/v1/cross-track-releases',
        { name: 'Judged', endRule: 'work_complete', releaseIds: [a, c] },
        201,
      )) as Answer;
      await closeTicket(done.id);
      const bo = await read('bo', made.id);
      expect(bo.open.count).toBe(0);
      expect(bo.hidden).toEqual({ releases: 1, open: 1 });
      expect(bo.state).toBe('upcoming');
      await closeTicket(hidden.id);
      const ready = await read('bo', made.id);
      expect(ready.state).toBe('ready');
      expect((await get('admin', `/api/v1/releases/${a}`)).release.shipped).toBe(false);
      expect((await get('admin', `/api/v1/releases/${c}`)).release.shipped).toBe(false);
    });

    it('[PLN-007] reads a release of an archived track as archived, on its row as in the state', async () => {
      await database.db
        .updateTable('release')
        .set({ release_date: '2020-01-01' })
        .where('id', '=', releases['B 1.0'] as number)
        .execute();
      const overdue = (await read('admin')).members.find((m) => m.track.key === 'XTB');
      expect(overdue).toMatchObject({ archived: false, overdue: true, trackArchived: false });
      await database.db
        .updateTable('track')
        .set({ archived_at: new Date() })
        .where('id', '=', tracks.XTB as number)
        .execute();
      const answer = await read('admin');
      expect(answer.members.find((m) => m.track.key === 'XTB')).toMatchObject({
        archived: true,
        overdue: false,
        trackArchived: true,
        outOfStep: false,
      });
      // A plan's Releases tab, and so its file, reads the same row.
      const plan = (
        await post(
          'admin',
          '/api/v1/plans',
          { name: 'Over XTA', sources: [{ kind: 'track', trackId: tracks.XTA }] },
          201,
        )
      ).plan.id as number;
      const tab = await get('admin', `/api/v1/plans/${plan}/releases`);
      const group = tab.crossTrack.find((c: { id: number }) => c.id === crossId);
      expect(
        group.releases.find((r: { track: { key: string } }) => r.track.key === 'XTB'),
      ).toMatchObject({ archived: true, overdue: false });
    });

    it('[PLN-007] [PLN-001] judges overdue on the viewer’s own day: the list, its page, its releases and a plan’s (T-287)', async () => {
      // Kiritimati (UTC+14) is always a day or two ahead of Pago Pago (UTC-11), whatever the hour,
      // so a day that is today in Pago Pago has gone by in Kiritimati; UTC's day agrees with one.
      const ahead = 'Pacific/Kiritimati';
      const behind = 'Pacific/Pago_Pago';
      const day = localDate(new Date(), behind);
      await database.db
        .updateTable('cross_track_release')
        .set({ release_date: day })
        .where('id', '=', crossId)
        .execute();
      await database.db
        .updateTable('release')
        .set({ release_date: day })
        .where('id', 'in', [releases['A 1.0'] as number, releases['B 1.0'] as number])
        .execute();
      // One of XTD's own, linked to no release across tracks, for the plan's rows by track.
      const own = await addRelease('XTD', 'D 7.0', { releaseDate: day });
      const plan = (
        await post(
          'admin',
          '/api/v1/plans',
          {
            name: 'Zones',
            sources: ['XTA', 'XTD'].map((k) => ({ kind: 'track', trackId: tracks[k] })),
          },
          201,
        )
      ).plan.id as number;
      const seen = async (timeZone: string) => {
        const headers = { 'taskmoor-time-zone': timeZone };
        const read = (url: string) => call('admin', { method: 'GET', url, headers });
        const list = await read('/api/v1/cross-track-releases');
        const page = (await read(base())) as Answer;
        const tab = await read(`/api/v1/plans/${plan}/releases`);
        const group = tab.crossTrack.find((c: { id: number }) => c.id === crossId);
        const rows = tab.tracks.flatMap((t: { releases: { id: number }[] }) => t.releases);
        return {
          listed: list.releases.find((r: { id: number }) => r.id === crossId)?.state,
          state: page.state,
          warned: page.warnings.some((w) => w.code === 'overdue'),
          members: page.members
            .filter((m) => m.track.key !== 'XTC')
            .map((m) => [m.name, m.overdue]),
          group: group.state,
          grouped: group.releases
            .filter((r: Member) => r.track.key !== 'XTC')
            .map((r: Member) => [r.name, r.overdue]),
          own: rows.find((r: { id: number }) => r.id === own)?.overdue,
        };
      };
      expect(await seen(ahead)).toEqual({
        listed: 'overdue',
        state: 'overdue',
        warned: true,
        members: [
          ['A 1.0', true],
          ['B 1.0', true],
        ],
        group: 'overdue',
        grouped: [
          ['A 1.0', true],
          ['B 1.0', true],
        ],
        own: true,
      });
      expect(await seen(behind)).toEqual({
        listed: 'upcoming',
        state: 'upcoming',
        warned: false,
        members: [
          ['A 1.0', false],
          ['B 1.0', false],
        ],
        group: 'upcoming',
        grouped: [
          ['A 1.0', false],
          ['B 1.0', false],
        ],
        own: false,
      });
      await post('admin', `/api/v1/releases/${own}/archive`, {});
    });

    it('[PLN-007] drops an archived release from the state, and a track in the trash for everyone until restored', async () => {
      const before = await read('bo');
      expect(before.hidden.releases).toBe(2);
      await database.db
        .updateTable('track')
        .set({ deleted_at: new Date() })
        .where('id', '=', tracks.XTC as number)
        .execute();
      expect((await read('bo')).hidden).toEqual({ releases: 1, open: 1 });
      expect((await read('admin')).members.map((m) => m.track.key)).toEqual(['XTA', 'XTB']);
      await database.db
        .updateTable('track')
        .set({ deleted_at: null })
        .where('id', '=', tracks.XTC as number)
        .execute();
      expect((await read('bo')).hidden.releases).toBe(2);
      await post('admin', `/api/v1/releases/${releases['A 1.0']}/archive`, {});
      for (const name of ['B 1.0', HIDDEN_RELEASE]) {
        await database.db
          .updateTable('release')
          .set({ shipped_at: new Date() })
          .where('id', '=', releases[name] as number)
          .execute();
      }
      expect((await read('admin')).state).toBe('shipped');
    });
  });

  describe('[PLN-007] moving the date', () => {
    const moveList = (who: string, date: string, code = 200, id = crossId) =>
      get(who, `${base(id)}/move?date=${date}`, code);
    const move = (who: string, date: string, version: number, code = 200, id = crossId) =>
      post(who, `${base(id)}/move`, { date, version }, code);

    it('[PLN-007] follows the rule of PATCH in its outcome for one release', () => {
      const release = {
        releaseDate: '2027-01-01',
        startDate: null as string | null,
        shipped: false,
        archived: false,
        trackArchived: false,
        mayChange: true,
      };
      const of = (extra: Partial<typeof release>, date = '2027-02-01') =>
        moveOutcome({ ...release, ...extra }, date);
      expect(of({})).toEqual({ outcome: 'moves' });
      expect(of({}, '2027-01-01')).toEqual({ outcome: 'same' });
      expect(of({ mayChange: false })).toEqual({ outcome: 'stays', reason: 'no_permission' });
      expect(of({ shipped: true })).toEqual({ outcome: 'stays', reason: 'shipped' });
      expect(of({ archived: true })).toEqual({ outcome: 'stays', reason: 'archived' });
      expect(of({ trackArchived: true })).toEqual({ outcome: 'stays', reason: 'track_archived' });
      expect(of({ startDate: '2027-03-01' })).toEqual({
        outcome: 'stays',
        reason: 'start_after_date',
      });
    });

    it('[PLN-007] is only the owner’s and administrators’', async () => {
      await moveList('bo', '2027-06-01', 403);
      const { version } = await read('bo');
      await move('bo', '2027-06-01', version, 403);
      await call(
        'bo',
        { method: 'PATCH', url: base(), payload: { name: 'Taken over', version } },
        403,
      );
      await call('bo', { method: 'DELETE', url: base() }, 403);
    });

    it('[PLN-007] changes nothing in the list, then moves each release the mover may change and says why of the others', async () => {
      const a = releases['A 1.0'] as number;
      const b = releases['B 1.0'] as number;
      const c = (await post(
        'ana',
        '/api/v1/cross-track-releases',
        {
          name: 'Move case',
          endRule: 'fixed_date',
          date: '2027-07-01',
          releaseIds: [await addRelease('XTA', 'A 6.0'), await addRelease('XTB', 'B 6.0')],
        },
        201,
      )) as Answer;
      // Ana sees only the releases of her tracks; the administrator links a hidden one for her.
      await post(
        'admin',
        `${base(c.id)}/members`,
        {
          releaseId: await addRelease('XTC', 'Second hidden', { releaseDate: '2031-04-01' }),
        },
        201,
      );
      const version = (await read('ana', c.id)).version;
      const listed = await moveList('ana', '2027-08-01', 200, c.id);
      expect(listed.changed).toBe(false);
      expect((listed.lines as Line[]).map((l) => [l.name, l.outcome])).toEqual([
        ['A 6.0', 'moves'],
        ['B 6.0', 'moves'],
      ]);
      expect(listed.hidden).toEqual({ releases: 1 });
      expect(JSON.stringify(listed)).not.toContain('Second hidden');
      // Nothing moved yet.
      expect((await read('ana', c.id)).date).toBe('2027-07-01');
      const before = await eventCount('release.updated');
      const moved = await move('ana', '2027-08-01', version, 200, c.id);
      expect(moved.changed).toBe(true);
      expect(moved.version).toBe(version + 1);
      expect(await eventCount('release.updated')).toBe(before + 2);
      const after = await read('ana', c.id);
      expect(after.date).toBe('2027-08-01');
      expect(after.members.every((m) => m.releaseDate === '2027-08-01')).toBe(true);
      const event = (await eventsOf('cross_track_release.moved')).at(-1);
      expect(event?.payload).toMatchObject({
        from: '2027-07-01',
        to: '2027-08-01',
        refused: [],
        hidden: 1,
      });
      // The hidden release stayed on its day.
      const stayed = await database.db
        .selectFrom('release')
        .select('release_date')
        .where('name', '=', 'Second hidden')
        .executeTakeFirstOrThrow();
      expect(stayed.release_date).toBe('2031-04-01');
      // Neither of the shared ones was touched.
      expect((await get('admin', `/api/v1/releases/${a}`)).release.releaseDate).toBe('2027-05-10');
      expect((await get('admin', `/api/v1/releases/${b}`)).release.releaseDate).toBe('2027-05-10');
    });

    it('[PLN-007] leaves shipped, archived and too-late-to-start releases where they are, with a reason each', async () => {
      const make = await post(
        'admin',
        '/api/v1/cross-track-releases',
        {
          name: 'Refusals',
          endRule: 'fixed_date',
          date: '2027-07-01',
          releaseIds: [
            await addRelease('XTA', 'A shipped too'),
            await addRelease('XTB', 'B archived'),
            await addRelease('XTD', 'D starts late', { startDate: '2027-09-01' }),
          ],
        },
        201,
      );
      await post('admin', `/api/v1/releases/${releases['A shipped too']}/ship`, {});
      await post('admin', `/api/v1/releases/${releases['B archived']}/archive`, {});
      const list = await moveList('admin', '2027-08-01', 200, make.id);
      expect((list.lines as Line[]).map((l) => [l.name, l.outcome, l.reason ?? null])).toEqual([
        ['A shipped too', 'stays', 'shipped'],
        ['B archived', 'stays', 'archived'],
        ['D starts late', 'stays', 'start_after_date'],
      ]);
      // A date nothing can follow still moves the release across tracks, and the list says so.
      const version = (await read('admin', make.id)).version;
      const moved = await move('admin', '2027-08-01', version, 200, make.id);
      expect(moved.changed).toBe(true);
      const event = (await eventsOf('cross_track_release.moved')).at(-1);
      expect(event?.payload.moved).toEqual([]);
      expect(event?.payload.refused).toEqual([
        { releaseId: releases['A shipped too'], reason: 'shipped' },
        { releaseId: releases['B archived'], reason: 'archived' },
        { releaseId: releases['D starts late'], reason: 'start_after_date' },
      ]);
      expect((await read('admin', make.id)).date).toBe('2027-08-01');
    });

    it('[PLN-007] says no_permission of a release the mover sees but may not change, and it reads out of step', async () => {
      // Bo owns one he made nothing of: the owner of a release across tracks gets no track right.
      const a = await addRelease('XTA', 'A 7.0', { releaseDate: '2027-07-01' });
      const made = (await post(
        'ana',
        '/api/v1/cross-track-releases',
        { name: 'Handed over', endRule: 'fixed_date', date: '2027-07-01', releaseIds: [a] },
        201,
      )) as Answer;
      await database.db
        .updateTable('cross_track_release')
        .set({ owner_id: users.bo?.id as number })
        .where('id', '=', made.id)
        .execute();
      const version = (await read('bo', made.id)).version;
      const moved = await move('bo', '2027-08-01', version, 200, made.id);
      expect((moved.lines as Line[]).map((l) => [l.outcome, l.reason])).toEqual([
        ['stays', 'no_permission'],
      ]);
      const after = await read('bo', made.id);
      expect(after.date).toBe('2027-08-01');
      expect(after.members[0]?.outOfStep).toBe(true);
      expect(after.warnings).toContainEqual({ code: 'out_of_step', count: 1 });
    });

    it('[PLN-007] refuses a stale version and a release all shipped, and records nothing for the same day', async () => {
      const a = await addRelease('XTA', 'A 8.0', { releaseDate: '2027-07-01' });
      const made = (await post(
        'ana',
        '/api/v1/cross-track-releases',
        { name: 'Guards', endRule: 'fixed_date', date: '2027-07-01', releaseIds: [a] },
        201,
      )) as Answer;
      const stale = await move('ana', '2027-08-01', made.version + 7, 409, made.id);
      expect(stale).toEqual({ error: 'version_conflict', version: made.version });
      const events = await eventCount('cross_track_release.moved');
      const same = await move('ana', '2027-07-01', made.version, 200, made.id);
      expect(same.changed).toBe(false);
      expect(await eventCount('cross_track_release.moved')).toBe(events);
      expect((await read('ana', made.id)).version).toBe(made.version);
      await post('ana', `/api/v1/releases/${a}/ship`, {});
      expect((await move('ana', '2027-08-01', made.version, 409, made.id)).error).toBe(
        'already_shipped',
      );
      expect((await moveList('ana', '2027-08-01', 409, made.id)).error).toBe('already_shipped');
    });

    it('[PLN-007] brings back what is out of step on a move to the day it already has', async () => {
      const a = await addRelease('XTA', 'A 14.0', { releaseDate: '2027-02-02' });
      const b = await addRelease('XTB', 'B 14.0', { releaseDate: '2027-03-03' });
      const made = (await post(
        'ana',
        '/api/v1/cross-track-releases',
        { name: 'Straggler', endRule: 'fixed_date', date: '2027-03-03', releaseIds: [a, b] },
        201,
      )) as Answer;
      expect(made.members.find((m) => m.id === a)?.outOfStep).toBe(true);
      const listed = await moveList('ana', '2027-03-03', 200, made.id);
      expect(listed.from).toBe('2027-03-03');
      expect(listed.lines.map((l: Line) => [l.id, l.outcome])).toEqual([
        [a, 'moves'],
        [b, 'same'],
      ]);
      const moved = await move('ana', '2027-03-03', made.version, 200, made.id);
      expect(moved.changed).toBe(true);
      expect(moved.version).toBe(made.version + 1);
      const after = await read('ana', made.id);
      expect(after.date).toBe('2027-03-03');
      expect(after.members.map((m) => [m.releaseDate, m.outOfStep])).toEqual([
        ['2027-03-03', false],
        ['2027-03-03', false],
      ]);
      expect((await get('ana', `/api/v1/releases/${a}`)).release.releaseDate).toBe('2027-03-03');
      // With nothing left to bring back, the same day changes nothing and records nothing.
      const events = await eventCount('cross_track_release.moved');
      const again = await move('ana', '2027-03-03', after.version, 200, made.id);
      expect(again.changed).toBe(false);
      expect(await eventCount('cross_track_release.moved')).toBe(events);
    });

    it('[PLN-007] makes the end a fixed date when moved, and clears it for work_complete without moving anything', async () => {
      const a = await addRelease('XTA', 'A 9.0', { releaseDate: '2027-07-01' });
      const made = (await post(
        'ana',
        '/api/v1/cross-track-releases',
        { name: 'Rule', endRule: 'work_complete', releaseIds: [a] },
        201,
      )) as Answer;
      expect(made.members[0]?.outOfStep).toBe(false);
      const moved = await move('ana', '2027-09-01', made.version, 200, made.id);
      const after = await read('ana', made.id);
      expect(after).toMatchObject({ endRule: 'fixed_date', date: '2027-09-01' });
      const cleared = (await call(
        'ana',
        {
          method: 'PATCH',
          url: base(made.id),
          payload: { endRule: 'work_complete', version: moved.version },
        },
        200,
      )) as Answer;
      expect(cleared).toMatchObject({ endRule: 'work_complete', date: null });
      expect((await get('ana', `/api/v1/releases/${a}`)).release.releaseDate).toBe('2027-09-01');
      await call(
        'ana',
        {
          method: 'PATCH',
          url: base(made.id),
          payload: { name: 'Stale', version: moved.version },
        },
        409,
      );
    });

    it('[PLN-007] [CORE-016] leaves shipping’s rules alone, and Align is the release’s own change', async () => {
      const a = await addRelease('XTA', 'A 10.0', {
        releaseDate: '2027-07-01',
        requireApprovals: true,
      });
      await ticket('XTA', 'Unfinished', 'A 10.0');
      await call(
        'ana',
        {
          method: 'PUT',
          url: `/api/v1/releases/${a}/approvers`,
          payload: { userIds: [users.bo?.id] },
        },
        200,
      );
      const made = (await post(
        'ana',
        '/api/v1/cross-track-releases',
        { name: 'Ship rules', endRule: 'fixed_date', date: '2027-08-01', releaseIds: [a] },
        201,
      )) as Answer;
      expect(made.members[0]?.outOfStep).toBe(true);
      const page = await get('ana', `/api/v1/releases/${a}/overview`);
      expect(page.warnings).toContainEqual({ code: 'cross_track_out_of_step', count: 1 });
      // A move does not ship, and shipping still needs its approvers and a word on open tickets.
      await move('ana', '2027-09-01', made.version, 200, made.id);
      const release = (await get('ana', `/api/v1/releases/${a}`)).release;
      expect(release.shipped).toBe(false);
      expect((await post('ana', `/api/v1/releases/${a}/ship`, {}, 409)).error).toBe(
        'approvals_pending',
      );
      // Nobody loses the right to move their own release: it just reads out of step, then Align.
      await call(
        'ana',
        { method: 'PATCH', url: `/api/v1/releases/${a}`, payload: { releaseDate: '2027-10-01' } },
        200,
      );
      expect((await read('ana', made.id)).members[0]?.outOfStep).toBe(true);
      await call(
        'ana',
        { method: 'PATCH', url: `/api/v1/releases/${a}`, payload: { releaseDate: '2027-09-01' } },
        200,
      );
      expect((await read('ana', made.id)).members[0]?.outOfStep).toBe(false);
      const clear = await get('ana', `/api/v1/releases/${a}/overview`);
      expect(clear.warnings.map((w: { code: string }) => w.code)).not.toContain(
        'cross_track_out_of_step',
      );
    });
  });

  describe('[PLN-007] on release pages and in queries', () => {
    it('[PLN-007] names it on a release, in the track’s list and on anything that answers a release', async () => {
      const expected = {
        id: crossId,
        name: 'Spring launch',
        endRule: 'fixed_date',
        date: '2027-05-10',
      };
      const release = (await get('bo', `/api/v1/releases/${releases['A 1.0']}`)).release;
      expect(release.crossTrack).toEqual(expected);
      const list = await get('bo', `/api/v1/tracks/${tracks.XTA}/releases`);
      expect(
        list.releases.find((r: { id: number }) => r.id === releases['A 1.0']).crossTrack,
      ).toEqual(expected);
      expect(
        list.releases.find((r: { name: string }) => r.name === 'A 2.0')?.crossTrack?.name,
      ).not.toBe('Spring launch');
    });

    it('[PLN-007] takes a merged or deleted release out with one event and a new version', async () => {
      const keep = await addRelease('XTA', 'A 11.1');
      const gone = await addRelease('XTB', 'B 11.0');
      const merged = await addRelease('XTA', 'A 11.0');
      const made = (await post(
        'ana',
        '/api/v1/cross-track-releases',
        { name: 'Going', endRule: 'work_complete', releaseIds: [merged, gone] },
        201,
      )) as Answer;
      await post('ana', `/api/v1/releases/${merged}/merge`, { into: keep });
      const once = await read('ana', made.id);
      expect(once.members.map((m) => m.name)).toEqual(['B 11.0']);
      expect(once.version).toBe(made.version + 1);
      expect((await eventsOf('cross_track_release.member_removed')).at(-1)?.payload).toEqual({
        releaseId: merged,
        trackId: tracks.XTA,
        reason: 'release_merged',
      });
      await call('ana', { method: 'DELETE', url: `/api/v1/releases/${gone}` }, 204);
      const twice = await read('ana', made.id);
      expect(twice.members).toEqual([]);
      expect(twice.state).toBe('empty');
      expect((await eventsOf('cross_track_release.member_removed')).at(-1)?.payload).toEqual({
        releaseId: gone,
        trackId: tracks.XTB,
        reason: 'release_deleted',
      });
    });

    it('[PLN-007] [QRY-002] finds its work by id or name with =, !=, IN and NOT IN, target releases only', async () => {
      const seen = async (who: string, q: string) => {
        const found = await post(who, '/api/v1/search', { q, count: true, limit: 200 });
        return (found.tickets as { summary: string }[]).map((t) => t.summary).sort();
      };
      expect(await seen('bo', `crossTrackRelease = ${crossId}`)).toEqual(['Cart', 'Shop page']);
      expect(await seen('bo', 'crossTrackRelease = "spring launch"')).toEqual([
        'Cart',
        'Shop page',
      ]);
      expect(await seen('bo', `crossTrackRelease IN (${crossId})`)).toEqual(['Cart', 'Shop page']);
      expect(await seen('bo', `track = XTA AND crossTrackRelease != ${crossId}`)).not.toContain(
        'Cart',
      );
      expect(
        await seen('bo', `track = XTA AND crossTrackRelease NOT IN (${crossId})`),
      ).not.toContain('Cart');
      // A found-in release of a linked release is left out.
      const found = await post(
        'admin',
        '/api/v1/tickets',
        { track: 'XTA', summary: 'Found only', foundInReleaseIds: [releases['A 1.0']] },
        201,
      );
      expect(await seen('bo', `crossTrackRelease = ${crossId}`)).not.toContain('Found only');
      await call('admin', { method: 'DELETE', url: `/api/v1/tickets/${found.ticket.key}` }, 204);
    });

    it('[PLN-007] [QRY-002] refuses a hidden id or name word for word as an absent one, and takes no other operator', async () => {
      const search = (who: string, q: string) =>
        as(who, { method: 'POST', url: '/api/v1/search', payload: { q } });
      const refused = async (who: string, value: string, absent: string) => {
        const res = await search(who, `crossTrackRelease = ${value}`);
        const none = await search(who, `crossTrackRelease = ${absent}`);
        expect(res.statusCode).toBe(none.statusCode);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.json().code ?? res.json().error).toBe(none.json().code ?? none.json().error);
        const strip = (text: string) => text.replaceAll(value.replaceAll('"', ''), '#');
        expect(strip(res.body)).toBe(none.body.replaceAll(absent.replaceAll('"', ''), '#'));
      };
      await refused('di', String(crossId), '99999999');
      await refused('cy', '"Spring launch"', '"No such launch"');
      for (const q of [
        'crossTrackRelease IS EMPTY',
        'crossTrackRelease IS NOT EMPTY',
        'crossTrackRelease > 1',
        'crossTrackRelease WAS 1',
        'ORDER BY crossTrackRelease',
      ]) {
        expect((await search('admin', q)).statusCode, q).toBe(400);
      }
    });

    it('[PLN-007] [QRY-008] a viewer’s search of it keeps to what they may see', async () => {
      const q = `crossTrackRelease = ${crossId}`;
      expect(await searchCount('admin', q)).toBe(6);
      expect(await searchCount('ana', q)).toBe(3);
      expect(await searchCount('bo', q)).toBe(2);
      // A saved search naming it reads as whoever runs it: for Cy it is an unknown name, not a hit.
      const res = await as('cy', { method: 'POST', url: '/api/v1/search', payload: { q } });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('[PLN-007] [PLN-001] a plan', () => {
    const planOver = async (who: string, keys: string[], shares = true) =>
      (
        await post(
          who,
          '/api/v1/plans',
          {
            name: `Plan ${keys.join(' ')}`,
            sources: keys.map((k) => ({ kind: 'track', trackId: tracks[k] })),
            ...(shares ? { shares: [{ scope: 'any_user' }] } : {}),
          },
          201,
        )
      ).plan.id as number;

    it('[PLN-007] [PLN-001] gathers linked releases under theirs, then the rest by track, upcoming first', async () => {
      const plan = await planOver('admin', ['XTA', 'XTD']);
      const tab = await get('ana', `/api/v1/plans/${plan}/releases`);
      const group = tab.crossTrack.find((c: { id: number }) => c.id === crossId);
      expect(group.name).toBe('Spring launch');
      // Whole numbers, not the plan's share: both of Ana's tracks, though the plan holds only one.
      expect(group.releases.map((r: { name: string }) => r.name)).toEqual(['A 1.0', 'B 1.0']);
      expect(group.hidden).toEqual({ releases: 1, open: 3 });
      expect(JSON.stringify(tab)).not.toContain(HIDDEN_RELEASE);
      expect(tab.truncated).toBe(false);
      const only = await get('admin', `/api/v1/plans/${plan}/releases?track=XTD`);
      expect(only.crossTrack.map((c: { id: number }) => c.id)).not.toContain(crossId);
      expect(only.tracks[0].releases.some((r: { name: string }) => r.name === 'D 1.0')).toBe(true);
      await get('admin', `/api/v1/plans/${plan}/releases?stage=new`, 400);
    });

    it('[PLN-007] [PLN-001] adds no row for a track seen only through a ticket-level grant', async () => {
      const search = (
        await post(
          'admin',
          '/api/v1/saved-searches',
          { name: 'Hidden work', query: 'track = XTC', shares: [{ scope: 'any_user' }] },
          201,
        )
      ).savedSearch.id;
      const plan = (
        await post(
          'admin',
          '/api/v1/plans',
          {
            name: 'Grant plan',
            sources: [{ kind: 'savedSearch', savedSearchId: search }],
            shares: [{ scope: 'any_user' }],
          },
          201,
        )
      ).plan.id;
      const tab = await get('cy', `/api/v1/plans/${plan}/releases`);
      expect(tab).toEqual({ crossTrack: [], tracks: [], truncated: false });
      await get('admin', `/api/v1/plans/${plan}/releases`);
      const other = await as('cy', { method: 'GET', url: '/api/v1/plans/99999999/releases' });
      expect(other.statusCode).toBe(404);
    });

    it('[PLN-007] [PLN-001] carries it on the Timeline’s and Calendar’s release markers', async () => {
      const plan = await planOver('admin', ['XTA']);
      const named = {
        id: crossId,
        name: 'Spring launch',
        date: '2027-05-10',
      };
      const timeline = await get('bo', `/api/v1/plans/${plan}/timeline`);
      const marker = timeline.markers.releases.find((r: { name: string }) => r.name === 'A 1.0');
      expect(marker.crossTrack).toEqual(named);
      const calendar = await get(
        'bo',
        `/api/v1/plans/${plan}/calendar?from=2027-05-01&to=2027-05-31`,
      );
      expect(
        calendar.releases.find((r: { name: string }) => r.name === 'A 1.0').crossTrack,
      ).toEqual(named);
    });
  });
});
