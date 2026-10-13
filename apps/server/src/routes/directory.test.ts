import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword, tokenHash } from '@taskmoor/iam';
import { fc } from '@taskmoor/testkit/property';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `192.0.2.${++address}`;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  const found = list.find(
    (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
  );
  return (found ?? '').split(';')[0] ?? '';
}

describe('users, groups and password links (M1-001)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let admin: string;
  let member: string;
  let adminId: number;

  async function insertUser(email: string, isSiteAdmin = false): Promise<number> {
    const row = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email,
        name: email.split('@')[0] ?? email,
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: isSiteAdmin,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function signIn(email: string, password = PASSWORD): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password },
      remoteAddress: nextAddress(),
    });
    expect(res.statusCode).toBe(200);
    return sessionCookie(res.headers['set-cookie']);
  }

  const as = (cookie: string, options: InjectOptions) =>
    app.inject({ ...options, headers: { ...(options.headers ?? {}), cookie } });

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      publicUrl: 'https://tracker.example.com/',
    });
    adminId = await insertUser('admin@example.com', true);
    await insertUser('member@example.com');
    admin = await signIn('admin@example.com');
    member = await signIn('member@example.com');
  });
  afterAll(async () => {
    await app.close();
  });

  describe('user administration', () => {
    it('[IAM-008] is for site administrators only', async () => {
      const routes: InjectOptions[] = [
        { method: 'GET', url: '/api/v1/users' },
        { method: 'POST', url: '/api/v1/users', payload: { email: 'x@example.com', name: 'X' } },
        { method: 'GET', url: `/api/v1/users/${adminId}` },
        { method: 'PATCH', url: `/api/v1/users/${adminId}`, payload: { name: 'X' } },
        { method: 'POST', url: `/api/v1/users/${adminId}/deactivate` },
        { method: 'POST', url: `/api/v1/users/${adminId}/reactivate` },
        { method: 'POST', url: `/api/v1/users/${adminId}/password-link` },
        { method: 'DELETE', url: `/api/v1/users/${adminId}/sessions` },
        { method: 'GET', url: '/api/v1/groups' },
        { method: 'POST', url: '/api/v1/groups', payload: { name: 'g' } },
      ];
      for (const route of routes) {
        expect((await app.inject(route)).statusCode, `${route.method} ${route.url}`).toBe(401);
        expect((await as(member, route)).statusCode, `${route.method} ${route.url}`).toBe(403);
      }
    });

    it('[IAM-008] creates a person with a password who can then sign in', async () => {
      const res = await as(admin, {
        method: 'POST',
        url: '/api/v1/users',
        payload: {
          email: 'Ana@Example.com',
          name: 'Ana',
          password: 'quiet otter lantern',
          timeZone: 'Europe/Madrid',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().user).toMatchObject({
        email: 'ana@example.com',
        name: 'Ana',
        active: true,
        hasPassword: true,
        timeZone: 'Europe/Madrid',
      });
      expect(res.json().activationLink).toBeUndefined();
      await signIn('ana@example.com', 'quiet otter lantern');

      const again = await as(admin, {
        method: 'POST',
        url: '/api/v1/users',
        payload: { email: 'ANA@example.com', name: 'Ana Two' },
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({ error: 'email_taken' });

      const weak = await as(admin, {
        method: 'POST',
        url: '/api/v1/users',
        payload: { email: 'weak@example.com', name: 'Weak', password: 'password1234' },
      });
      expect(weak.json()).toMatchObject({ error: 'weak_password', codes: ['common'] });
    });

    it('[IAM-001] activates a person without a password through a one-time link', async () => {
      const res = await as(admin, {
        method: 'POST',
        url: '/api/v1/users',
        payload: { email: 'bea@example.com', name: 'Bea' },
      });
      expect(res.statusCode).toBe(201);
      const link: string = res.json().activationLink;
      expect(link).toMatch(
        /^https:\/\/tracker\.example\.com\/#\/password\?token=[A-Za-z0-9_-]{43}$/,
      );
      const token = new URL(link.replace('/#/', '/')).searchParams.get('token') ?? '';
      // Only the hash is stored.
      const stored = await database.db
        .selectFrom('password_link')
        .select('token_hash')
        .where('token_hash', '=', tokenHash(token))
        .executeTakeFirst();
      expect(stored).toBeDefined();

      const inspect = await app.inject({
        method: 'POST',
        url: '/api/v1/password-links/inspect',
        payload: { token },
      });
      expect(inspect.json()).toEqual({
        purpose: 'activate',
        name: 'Bea',
        email: 'bea@example.com',
      });

      const weak = await app.inject({
        method: 'POST',
        url: '/api/v1/password-links/redeem',
        payload: { token, password: 'bea@example.com rocks' },
      });
      expect(weak.json()).toMatchObject({ error: 'weak_password', codes: ['contains_identity'] });

      const redeem = await app.inject({
        method: 'POST',
        url: '/api/v1/password-links/redeem',
        payload: { token, password: 'quiet otter lantern' },
      });
      expect(redeem.statusCode).toBe(200);
      expect(redeem.json().user).toMatchObject({ email: 'bea@example.com' });
      const cookie = sessionCookie(redeem.headers['set-cookie']);
      expect((await as(cookie, { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(200);

      // A link works once.
      const reuse = await app.inject({
        method: 'POST',
        url: '/api/v1/password-links/redeem',
        payload: { token, password: 'another quiet lantern' },
      });
      expect(reuse.statusCode).toBe(404);
      expect(reuse.json()).toEqual({ error: 'invalid_link' });
    });

    it('[IAM-001] resets a password through a new link, which voids the older ones and ends sessions', async () => {
      const id = await insertUser('cleo@example.com');
      const old = await signIn('cleo@example.com');
      const first = await as(admin, { method: 'POST', url: `/api/v1/users/${id}/password-link` });
      const second = await as(admin, { method: 'POST', url: `/api/v1/users/${id}/password-link` });
      expect(second.json()).toMatchObject({ purpose: 'reset' });
      const tokenOf = (link: string) =>
        new URL(link.replace('/#/', '/')).searchParams.get('token') ?? '';
      const stale = await app.inject({
        method: 'POST',
        url: '/api/v1/password-links/inspect',
        payload: { token: tokenOf(first.json().link) },
      });
      expect(stale.statusCode).toBe(404);
      const redeem = await app.inject({
        method: 'POST',
        url: '/api/v1/password-links/redeem',
        payload: { token: tokenOf(second.json().link), password: 'quiet otter lantern' },
      });
      expect(redeem.statusCode).toBe(200);
      expect((await as(old, { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(401);
    });

    it('[IAM-001] refuses expired links and throttles guessing', async () => {
      const id = await insertUser('dora@example.com');
      const res = await as(admin, { method: 'POST', url: `/api/v1/users/${id}/password-link` });
      const token =
        new URL((res.json().link as string).replace('/#/', '/')).searchParams.get('token') ?? '';
      await database.db
        .updateTable('password_link')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('token_hash', '=', tokenHash(token))
        .execute();
      const expired = await app.inject({
        method: 'POST',
        url: '/api/v1/password-links/inspect',
        payload: { token },
      });
      expect(expired.statusCode).toBe(404);

      const from = nextAddress();
      let last = 0;
      for (let i = 0; i < 51; i++) {
        const guess = await app.inject({
          method: 'POST',
          url: '/api/v1/password-links/inspect',
          payload: { token: `guess-${i}` },
          remoteAddress: from,
        });
        last = guess.statusCode;
      }
      expect(last).toBe(429);
    });

    it('[IAM-008] lists, searches and pages people, active or not', async () => {
      for (const name of ['zed', 'yara', 'xavi']) await insertUser(`${name}@list.example.com`);
      const xavi = await database.db
        .selectFrom('app_user')
        .select('id')
        .where('email', '=', 'xavi@list.example.com')
        .executeTakeFirstOrThrow();
      await as(admin, { method: 'POST', url: `/api/v1/users/${xavi.id}/deactivate` });

      const list = (query: string) => as(admin, { method: 'GET', url: `/api/v1/users?${query}` });
      const active = await list('query=list.example');
      expect(active.json().users.map((u: { name: string }) => u.name)).toEqual(['yara', 'zed']);
      expect(active.json().total).toBe(2);
      const all = await list('query=LIST.EXAMPLE&status=all&limit=2&offset=1');
      expect(all.json().users.map((u: { name: string }) => u.name)).toEqual(['yara', 'zed']);
      expect(all.json().total).toBe(3);
      const gone = await list('query=list.example&status=deactivated');
      expect(gone.json().users).toMatchObject([{ name: 'xavi', active: false }]);
      // Wildcards in the search are taken literally.
      expect((await list('query=%25')).json().total).toBe(0);
    });

    it('[IAM-008] deactivates and reactivates, keeping the person and ending their sessions', async () => {
      const id = await insertUser('eve@example.com');
      const cookie = await signIn('eve@example.com');
      const off = await as(admin, { method: 'POST', url: `/api/v1/users/${id}/deactivate` });
      expect(off.json().user).toMatchObject({ active: false });
      expect((await as(cookie, { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(401);
      const signInAgain = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: 'eve@example.com', password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      expect(signInAgain.statusCode).toBe(401);
      const on = await as(admin, { method: 'POST', url: `/api/v1/users/${id}/reactivate` });
      expect(on.json().user).toMatchObject({ active: true });
      await signIn('eve@example.com');
    });

    it('[IAM-008] protects the last site administrator and the administrator themself', async () => {
      const self = await as(admin, { method: 'POST', url: `/api/v1/users/${adminId}/deactivate` });
      expect(self.json()).toEqual({ error: 'cannot_deactivate_self' });
      const demote = await as(admin, {
        method: 'PATCH',
        url: `/api/v1/users/${adminId}`,
        payload: { isSiteAdmin: false },
      });
      expect(demote.json()).toEqual({ error: 'last_admin' });

      // With a second administrator the first can step down.
      const second = await insertUser('second-admin@example.com', true);
      const ok = await as(admin, {
        method: 'PATCH',
        url: `/api/v1/users/${second}`,
        payload: { isSiteAdmin: false, name: 'Second', locale: 'pt-br' },
      });
      expect(ok.json().user).toMatchObject({ isSiteAdmin: false, name: 'Second', locale: 'pt-BR' });
    });

    it('[IAM-004] lets an administrator sign a person out everywhere', async () => {
      const id = await insertUser('fede@example.com');
      const a = await signIn('fede@example.com');
      const b = await signIn('fede@example.com');
      const res = await as(admin, { method: 'DELETE', url: `/api/v1/users/${id}/sessions` });
      expect(res.json()).toEqual({ revoked: 2 });
      for (const cookie of [a, b]) {
        expect((await as(cookie, { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(401);
      }
    });
  });

  describe('groups', () => {
    const create = async (name: string) => {
      const res = await as(admin, { method: 'POST', url: '/api/v1/groups', payload: { name } });
      expect(res.statusCode).toBe(201);
      return res.json().group.id as number;
    };
    const nest = (parent: number, child: number) =>
      as(admin, { method: 'PUT', url: `/api/v1/groups/${parent}/children/${child}` });

    it('[IAM-008] creates groups with unique names and manages members', async () => {
      const devs = await create('Developers');
      const dup = await as(admin, {
        method: 'POST',
        url: '/api/v1/groups',
        payload: { name: 'developers' },
      });
      expect(dup.json()).toEqual({ error: 'name_taken' });
      const gus = await insertUser('gus@example.com');
      const add = () => as(admin, { method: 'PUT', url: `/api/v1/groups/${devs}/members/${gus}` });
      expect((await add()).statusCode).toBe(204);
      expect((await add()).statusCode).toBe(204);
      const detail = await as(admin, { method: 'GET', url: `/api/v1/groups/${devs}` });
      expect(detail.json().members.map((m: { email: string }) => m.email)).toEqual([
        'gus@example.com',
      ]);
      const list = await as(admin, { method: 'GET', url: '/api/v1/groups?query=dev' });
      expect(list.json().groups).toMatchObject([
        { name: 'Developers', memberCount: 1, childCount: 0 },
      ]);
      const user = await as(admin, { method: 'GET', url: `/api/v1/users/${gus}` });
      expect(user.json().groups).toEqual([{ id: devs, name: 'Developers' }]);
      const remove = await as(admin, {
        method: 'DELETE',
        url: `/api/v1/groups/${devs}/members/${gus}`,
      });
      expect(remove.statusCode).toBe(204);
      const renamed = await as(admin, {
        method: 'PATCH',
        url: `/api/v1/groups/${devs}`,
        payload: { name: 'Engineering', description: 'Everyone who builds' },
      });
      expect(renamed.json().group).toMatchObject({ name: 'Engineering' });
      expect(
        (await as(admin, { method: 'DELETE', url: `/api/v1/groups/${devs}` })).statusCode,
      ).toBe(204);
      expect((await as(admin, { method: 'GET', url: `/api/v1/groups/${devs}` })).statusCode).toBe(
        404,
      );
    });

    it('[IAM-008] counts members of nested groups and refuses loops', async () => {
      const company = await create('Company');
      const eng = await create('Eng');
      const web = await create('Web');
      const hana = await insertUser('hana@example.com');
      await as(admin, { method: 'PUT', url: `/api/v1/groups/${web}/members/${hana}` });
      expect((await nest(company, eng)).statusCode).toBe(204);
      expect((await nest(eng, web)).statusCode).toBe(204);
      expect((await nest(web, company)).json()).toEqual({ error: 'nesting_cycle' });
      expect((await nest(web, web)).json()).toEqual({ error: 'nesting_cycle' });

      const effective = await as(admin, {
        method: 'GET',
        url: `/api/v1/groups/${company}/effective-members`,
      });
      expect(effective.json()).toEqual({ userIds: [hana] });
      const user = await as(admin, { method: 'GET', url: `/api/v1/users/${hana}` });
      expect(user.json().effectiveGroupIds).toEqual([company, eng, web].sort((a, b) => a - b));
      const detail = await as(admin, { method: 'GET', url: `/api/v1/groups/${eng}` });
      expect(detail.json()).toMatchObject({
        children: [{ id: web, name: 'Web' }],
        parents: [{ id: company, name: 'Company' }],
      });
    });

    it('[IAM-008] agrees with a reference model on random nesting', async () => {
      const users = [await insertUser('p1@example.com'), await insertUser('p2@example.com')];
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.tuple(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 })), {
            maxLength: 12,
          }),
          fc.array(fc.tuple(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 1 })), {
            maxLength: 4,
          }),
          async (nestings, memberships) => {
            await database.db.deleteFrom('user_group').where('name', 'like', 'prop-%').execute();
            const ids: number[] = [];
            for (let i = 0; i < 5; i++) ids.push(await create(`prop-${i}`));
            const edges = new Set<string>();
            const reaches = (from: number, to: number): boolean => {
              const seen = new Set([from]);
              const queue = [from];
              while (queue.length) {
                const at = queue.shift() as number;
                if (at === to) return true;
                for (const e of edges) {
                  const [p, c] = e.split('>').map(Number) as [number, number];
                  if (p === at && !seen.has(c)) {
                    seen.add(c);
                    queue.push(c);
                  }
                }
              }
              return false;
            };
            for (const [p, c] of nestings) {
              const cycle = p === c || reaches(c, p);
              const res = await nest(ids[p] as number, ids[c] as number);
              expect(res.statusCode).toBe(cycle ? 409 : 204);
              if (!cycle) edges.add(`${p}>${c}`);
            }
            for (const [g, u] of memberships) {
              await as(admin, {
                method: 'PUT',
                url: `/api/v1/groups/${ids[g]}/members/${users[u]}`,
              });
            }
            for (let g = 0; g < 5; g++) {
              const expected = new Set<number>();
              for (const [mg, u] of memberships) {
                if (mg === g || reaches(g, mg)) expected.add(users[u] as number);
              }
              const res = await as(admin, {
                method: 'GET',
                url: `/api/v1/groups/${ids[g]}/effective-members`,
              });
              expect(res.json().userIds).toEqual([...expected].sort((a, b) => a - b));
            }
          },
        ),
        { numRuns: 15 },
      );
    });
  });
});
