import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { blockingLinks } from './dependencies';

// Made for this run: no password is written in the repository.
const PASSWORD = `blocking-${randomBytes(18).toString('base64url')}`;

/**
 * `blockingLinks`, the first statement of a plan's dependencies (ADR-122 stages 2, 5 and 7): the
 * Timeline draws and counts from it, and the auto-scheduler orders work by it. A dependency's
 * source finishes first; one per pair, a blocking link before another chosen type; never a
 * blocker in the trash.
 */
describe('blocking links (PLN-006, PLN-004)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  const t: Record<string, number> = {};
  const types: Record<string, number> = {};

  const linkType = async (outward: string) =>
    (
      await database.db
        .selectFrom('link_type')
        .select('id')
        .where('workspace_id', '=', 1)
        .where('outward', '=', outward)
        .executeTakeFirstOrThrow()
    ).id;
  const link = (from: string, to: string, type: string) =>
    database.db
      .insertInto('ticket_link')
      .values({
        workspace_id: 1,
        link_type_id: types[type] as number,
        source_id: t[from] as number,
        target_id: t[to] as number,
        created_by: null,
      })
      .execute();
  const ids = (...names: string[]) => names.map((n) => t[n] as number);
  const named = (links: { from: number; to: number; linkTypeId: number }[]) => {
    const name = new Map(Object.entries(t).map(([k, v]) => [v, k]));
    const typeName = new Map(Object.entries(types).map(([k, v]) => [v, k]));
    return links.map((l) => `${name.get(l.from)}>${name.get(l.to)}:${typeName.get(l.linkTypeId)}`);
  };

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
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
    });
    const header = session.headers['set-cookie'];
    cookie =
      (Array.isArray(header) ? header : [header ?? '']).find(
        (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
      ) ?? '';
    cookie = cookie.split(';')[0] ?? '';
    const track = await app.inject({
      method: 'POST',
      url: '/api/v1/tracks',
      headers: { cookie },
      payload: { key: 'BLK', name: 'Blocking', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    for (const name of ['design', 'review', 'build', 'ship', 'binned', 'other']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tickets',
        headers: { cookie },
        payload: { track: 'BLK', summary: name },
      });
      expect(res.statusCode, res.body).toBe(201);
      t[name] = res.json().ticket.id;
    }
    types.blocks = await linkType('blocks');
    types.relates = await linkType('relates to');
    // A type of the workspace's own whose phrase is written in capitals still blocks.
    types.hard = (
      await database.db
        .insertInto('link_type')
        .values({ workspace_id: 1, name: 'Hard stop', outward: 'Blocks', inward: 'Is held by' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await link('design', 'build', 'blocks');
    await link('review', 'build', 'hard');
    await link('design', 'ship', 'relates');
    await link('design', 'ship', 'blocks');
    await link('build', 'ship', 'relates');
    await link('binned', 'ship', 'blocks');
    await link('ship', 'other', 'blocks');
    await database.db
      .updateTable('ticket')
      .set({ deleted_at: new Date() })
      .where('id', '=', t.binned as number)
      .execute();
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('[PLN-006] [PLN-004] lists the blockers of the targets, blocking links only, never one in the trash', async () => {
    const links = await blockingLinks(database.db, 1, ids('build', 'ship'), { linkTypeIds: [] });
    // Design blocks Ship through both a blocking and a related link: one dependency, the blocking
    // one. Build only relates to Ship, and the Binned blocker is in the trash.
    expect(named(links).sort()).toEqual(
      ['design>build:blocks', 'design>ship:blocks', 'review>build:hard'].sort(),
    );
    // Ordered by blocker, then by the ticket it holds up.
    expect(links.map((l) => [l.from, l.to])).toEqual(
      [...links.map((l) => [l.from, l.to])].sort((a, b) =>
        a[0] === b[0] ? (a[1] ?? 0) - (b[1] ?? 0) : (a[0] ?? 0) - (b[0] ?? 0),
      ),
    );
  });

  it('[PLN-006] [PLN-004] counts a type the plan chose, after a blocking link between the same pair', async () => {
    const links = await blockingLinks(database.db, 1, ids('ship'), {
      linkTypeIds: [types.relates as number],
    });
    expect(named(links).sort()).toEqual(['build>ship:relates', 'design>ship:blocks']);
  });

  it('[PLN-004] reads only links into the targets, and nothing for none', async () => {
    // Ship blocks Other: it is Other's blocker, not Ship's.
    expect(named(await blockingLinks(database.db, 1, ids('other'), { linkTypeIds: [] }))).toEqual([
      'ship>other:blocks',
    ]);
    expect(await blockingLinks(database.db, 1, ids('design'), { linkTypeIds: [] })).toEqual([]);
    expect(await blockingLinks(database.db, 1, [], { linkTypeIds: [] })).toEqual([]);
    // Another workspace's id reads nothing.
    expect(await blockingLinks(database.db, 2, ids('build', 'ship'), { linkTypeIds: [] })).toEqual(
      [],
    );
  });
});
