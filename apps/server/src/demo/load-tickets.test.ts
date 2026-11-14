import { useMigratedDatabase } from '@taskmoor/db/testing';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { type DemoRequest, loadDemoTickets } from './load-tickets';
import { parseTicketsFile } from './tickets-file';

let address = 0;
const nextAddress = () => `100.97.${Math.floor(++address / 250) % 250}.${(address % 250) + 1}`;

const file = (rows: string[]) =>
  [
    '## Setup and repository',
    '',
    '| ID | Ticket | State | Where and notes |',
    '|---|---|---|---|',
    ...rows.filter((r) => r.startsWith('BE ')).map((r) => r.slice(3)),
    '',
    '## Tickets',
    '',
    '| ID | Ticket | State | Where and notes |',
    '|---|---|---|---|',
    ...rows.filter((r) => r.startsWith('FE ')).map((r) => r.slice(3)),
    '',
    '## Flutter app (stopped)',
    '',
    '| ID | Ticket | State | Where and notes |',
    '|---|---|---|---|',
    ...rows.filter((r) => r.startsWith('FL ')).map((r) => r.slice(3)),
    '',
  ].join('\n');

const FIRST = [
  'BE | T-010 | Commit identity | Done | In **bold**, with `CLAUDE.md` |',
  'BE | T-011 | Release key | You | Waiting on the user |',
  'FE | T-020 | The create form | In progress | apps/web |',
  'FE | T-021 | Board columns | To do | |',
  'FL | T-030 | Flutter sign-in | Later | stopped |',
];

/**
 * `pnpm demo --tickets` (T-239) against the real API in process: the three tracks, a ticket per
 * row at its state's stage, the sample tracks in the trash, and a rerun that adds only new rows
 * and moves the old ones to their new state. Its token is gone when it ends.
 */
describe('loading tickets.md into the demo', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const seen = new Set<string>();

  const request: DemoRequest = async (method, path, body, token) => {
    seen.add(token);
    const res = await app.inject({
      method,
      url: `/api/v1${path}`,
      remoteAddress: nextAddress(),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    return { status: res.statusCode, json: res.body ? res.json() : null };
  };

  /** The demo's tickets as the database holds them, by T id. */
  async function tickets() {
    const { rows } = await sql<{
      summary: string;
      track: string;
      stage: string;
      labels: string[];
      description: unknown;
    }>`
      SELECT k.summary, t.key AS track, s.stage, k.labels, k.description
        FROM ticket k JOIN track t ON t.id = k.track_id JOIN status s ON s.id = k.status_id
       WHERE k.deleted_at IS NULL AND t.key IN ('BE', 'FE', 'FL')
       ORDER BY k.summary`.execute(database.db);
    const byId: Record<string, (typeof rows)[number]> = {};
    for (const r of rows) byId[r.summary.split(' · ')[0] as string] = r;
    return byId;
  }
  const trashed = async (key: string) =>
    (
      await database.db
        .selectFrom('track')
        .select('deleted_at')
        .where('key', '=', key)
        .executeTakeFirstOrThrow()
    ).deleted_at !== null;
  const tokenRows = async () =>
    Number(
      (
        await database.db
          .selectFrom('api_token')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    for (const [name, admin] of [
      ['someone', false],
      ['admin', true],
    ] as const) {
      await database.db
        .insertInto('app_user')
        .values({ workspace_id: 1, email: `${name}@example.org`, name, is_site_admin: admin })
        .execute();
    }
    // A sample track, as the demo's seed leaves.
    await sql`
      INSERT INTO track (workspace_id, key, name, mode, access_policy_id)
      SELECT 1, 'SMPL', 'Sample', 'shared', min(id) FROM access_policy`.execute(database.db);
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-001] makes the three tracks, a ticket per row at its stage, and trashes the samples', async () => {
    const done = await loadDemoTickets(database.db, parseTicketsFile(file(FIRST)), request);
    expect(done).toEqual({
      tracksCreated: 3,
      tracksRestored: 0,
      ticketsCreated: 5,
      moved: 2,
      updated: 0,
      unchanged: 0,
      tracksTrashed: 1,
      problems: [],
    });
    const now = await tickets();
    expect(
      Object.fromEntries(
        Object.entries(now).map(([id, t]) => [id, [t.track, t.stage, ...t.labels]]),
      ),
    ).toEqual({
      'T-010': ['BE', 'closed', 'setup-and-repository'],
      'T-011': ['BE', 'new', 'setup-and-repository', 'needs-you'],
      'T-020': ['FE', 'active', 'tickets'],
      'T-021': ['FE', 'new', 'tickets'],
      'T-030': ['FL', 'new', 'flutter-app-stopped', 'later'],
    });
    expect(now['T-010']?.summary).toBe('T-010 · Commit identity');
    // The notes went in as Markdown: bold and code, not their asterisks.
    expect(JSON.stringify(now['T-010']?.description)).toContain('"type":"code"');
    expect(JSON.stringify(now['T-010']?.description)).toContain('"type":"bold"');
    expect(JSON.stringify(now['T-010']?.description)).not.toContain('**');
    expect(await trashed('SMPL')).toBe(true);
    expect(await trashed('BE')).toBe(false);
  });

  it('[IMP-009] on a rerun adds only new rows and moves loaded tickets to their new state', async () => {
    const again = await loadDemoTickets(database.db, parseTicketsFile(file(FIRST)), request);
    expect(again).toMatchObject({ tracksCreated: 0, ticketsCreated: 0, updated: 0, unchanged: 5 });
    expect(again.problems).toEqual([]);

    // Someone trashed a demo track, and tickets.md moved on.
    await sql`
      INSERT INTO track (workspace_id, key, name, mode, access_policy_id)
      SELECT 1, 'MORE', 'Another sample', 'shared', min(id) FROM access_policy`.execute(
      database.db,
    );
    const be = await database.db
      .selectFrom('track')
      .select('id')
      .where('key', '=', 'BE')
      .executeTakeFirstOrThrow();
    await database.db
      .updateTable('track')
      .set({ deleted_at: new Date() })
      .where('id', '=', be.id)
      .execute();
    const changed = [
      'BE | T-010 | Commit identity | In progress | reopened |',
      'BE | T-011 | Release key | Done | answered |',
      'FE | T-020 | The create form | To do | put back |',
      'FE | T-021 | Board columns | You | a question |',
      'FL | T-030 | Flutter sign-in | Later | stopped |',
      'FE | T-022 | A new row | Done | |',
    ];
    const done = await loadDemoTickets(database.db, parseTicketsFile(file(changed)), request);
    expect(done).toEqual({
      tracksCreated: 0,
      tracksRestored: 1,
      ticketsCreated: 1,
      moved: 1,
      updated: 4,
      unchanged: 1,
      tracksTrashed: 1,
      problems: [],
    });
    const now = await tickets();
    expect(
      Object.fromEntries(Object.entries(now).map(([id, t]) => [id, [t.stage, ...t.labels]])),
    ).toEqual({
      'T-010': ['active', 'setup-and-repository'],
      'T-011': ['closed', 'setup-and-repository'],
      'T-020': ['new', 'tickets'],
      'T-021': ['new', 'tickets', 'needs-you'],
      'T-022': ['closed', 'tickets'],
      'T-030': ['new', 'flutter-app-stopped', 'later'],
    });
    expect(Object.keys(now)).toHaveLength(6);
    expect(await trashed('MORE')).toBe(true);
    expect(await trashed('BE')).toBe(false);
  });

  it('[IAM-007] works with a token of its own each time, deleted when it ends or fails', async () => {
    expect(seen.size).toBe(3);
    expect(await tokenRows()).toBe(0);
    const failing: DemoRequest = async (...args) => {
      const res = await request(...args);
      if (args[0] === 'POST') throw new Error('the server went away');
      return res;
    };
    await expect(
      loadDemoTickets(
        database.db,
        parseTicketsFile(file(['BE | T-099 | Never made | To do | |'])),
        failing,
      ),
    ).rejects.toThrow('the server went away');
    expect(await tokenRows()).toBe(0);
    // A token the loader used no longer opens anything.
    const [used] = [...seen];
    expect((await request('GET', '/tracks', undefined, used as string)).status).toBe(401);
  });
});
