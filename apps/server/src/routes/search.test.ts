import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.74.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface CheckJson {
  ok: boolean;
  fields?: { name: string; custom: number | null }[];
  error?: { message: string; position: number; length: number; expected: string[] };
}

/** Checking queries against the workspace's fields (M1-036; QRY-002, QRY-003). */
describe('query check (M1-036)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const check = async (who: string, q: string) =>
    (
      await as(who, { method: 'GET', url: `/api/v1/search/check?q=${encodeURIComponent(q)}` })
    ).json() as CheckJson;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
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
    const roles = await database.db.selectFrom('role').select(['id', 'name']).execute();
    const member = roles.find((r) => r.name === 'Members')?.id as number;
    for (const [key, mode, members] of [
      ['ABC', 'shared', ['alice', 'bob']],
      ['LOA', 'local', ['alice']],
      ['LOB', 'local', ['alice']],
    ] as const) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name: key, mode },
      });
      tracks[key] = res.json().track.id;
      for (const who of members) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: member,
            user_id: users[who]?.id as number,
          })
          .execute();
      }
    }
    for (const [name, type, trackId] of [
      ['Story Points', 'number', undefined],
      ['Team', 'select', tracks.LOA],
      ['Team', 'select', tracks.LOB],
    ] as const) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/fields',
        payload: { name, type, ...(trackId ? { trackId } : {}) },
      });
      expect(res.statusCode, res.body).toBe(201);
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[QRY-003] reads both vocabularies and the fields a query uses', async () => {
    const native = await check('alice', 'track = ABC AND type = Bug ORDER BY "Story Points" DESC');
    expect(native).toMatchObject({ ok: true });
    expect(native.fields?.map((f) => f.name).sort()).toEqual(['Story Points', 'track', 'type']);
    expect(await check('alice', 'project = ABC AND issuetype = Bug')).toMatchObject({ ok: true });
    // A track's old key still names it after a rename.
    await as('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${tracks.ABC}`,
      payload: { key: 'XYZ' },
    });
    expect(await check('alice', 'track = ABC')).toMatchObject({ ok: true });
    expect(await check('alice', 'track = XYZ')).toMatchObject({ ok: true });
  });

  it('[QRY-002] refuses an operator its field type does not take, saying where', async () => {
    const q = 'type = Bug AND "Story Points" ~ "3"';
    const refused = await check('alice', q);
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toMatch(/^"Story Points" \(cf\[\d+\]\) is not a text field/);
    expect(refused.error?.position).toBe(q.indexOf('"Story Points"'));
    const broken = await check('alice', 'status = ');
    expect(broken.ok).toBe(false);
    expect(broken.error?.position).toBe(9);
  });

  it('[QRY-003] names the ids of an ambiguous custom field, among the fields a person may see', async () => {
    // Alice sees both local tracks' Team fields; Bob sees neither.
    const alice = await check('alice', 'Team = Red');
    expect(alice.ok).toBe(false);
    expect(alice.error?.message).toMatch(
      /^Several custom fields are called "Team" \(cf\[\d+\], cf\[\d+\]\); name one by its id$/,
    );
    const bob = await check('bob', 'Team = Red');
    expect(bob.error?.message).toBe('Unknown field "Team"');
    expect(await check('bob', 'track = LOA')).toMatchObject({ ok: false });
  });
});
