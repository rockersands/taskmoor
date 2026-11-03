import { useMigratedDatabase } from '@taskmoor/db/testing';
import { passwordHasher, pepperFromSecret, pepperRing, tokenHash } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { renderInvitationEmail } from '../email/invitation';
import type { OutgoingEmail } from '../email/transport';
import { FakeIdp } from '../testing/fake-idp';
import { loopbackOutbound } from '../testing/outbound';
import { routeAccess } from '../tokens/scopes';

const PASSWORD = 'ladder violet harbour';
const NEW_PASSWORD = 'another otter lantern';
const ORIGIN = 'http://tracker.test';
const CLIENT_SECRET = 'a client secret only the fake provider knows';
const peppers = pepperRing(pepperFromSecret('a pepper for the invitation tests, long enough'));
let address = 0;
const nextAddress = () => `198.51.${100 + (address >> 8)}.${(address++ & 255) + 1}`;

function cookieNamed(res: LightMyRequestResponse, name: string): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (list.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`)) ?? '').split(
      ';',
    )[0] ?? ''
  );
}

const tokenOf = (link: string) =>
  new URL(link.replace('/#/', '/')).searchParams.get('token') as string;

describe('invitations and the people of a track (IAM-027 to IAM-030)', () => {
  const database = useMigratedDatabase();
  const passwords = passwordHasher(peppers);
  const idp = new FakeIdp('taskmoor', CLIENT_SECRET);
  let app: FastifyInstance;
  const outbox: OutgoingEmail[] = [];
  let mailOn = true;
  let failNextSend = false;
  const cookies: Record<string, string> = {};
  const ids: Record<string, number> = {};
  let roles: Record<string, number>;
  let policy: number;
  let track: number;
  let other: number;
  let nextTrack = 0;

  const as = (who: string | undefined, options: InjectOptions) =>
    app.inject({
      remoteAddress: nextAddress(),
      ...options,
      headers: {
        ...(options.headers ?? {}),
        ...(who ? { cookie: cookies[who] ?? who } : {}),
      },
    });

  const signIn = (email: string, password = PASSWORD) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password },
      remoteAddress: nextAddress(),
    });

  async function addUser(name: string, extra: { admin?: boolean } = {}) {
    const email = `${name}@example.com`;
    const row = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email,
        name,
        password_hash: await passwords.hash(PASSWORD),
        is_site_admin: extra.admin ?? false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids[name] = row.id;
    cookies[name] = cookieNamed(await signIn(email), SESSION_COOKIE);
    return row.id;
  }

  async function addTrack(key: string, access = policy) {
    const row = await database.db
      .insertInto('track')
      .values({ workspace_id: 1, key, name: `Track ${key}`, access_policy_id: access })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const give = (trackId: number, role: string, user: string) =>
    database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: trackId,
        role_id: roles[role] as number,
        user_id: ids[user] as number,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();

  const grant = (permission: string, role: string, policyId = policy) =>
    as('admin', {
      method: 'POST',
      url: `/api/v1/access-policies/${policyId}/grants`,
      payload: { permission, grantee: 'role', roleId: roles[role] },
    });

  /** Takes a role's grant of a permission away; returns a way to give it back. */
  async function removeGrant(permission: string, role: string) {
    const found = await database.db
      .selectFrom('access_grant')
      .select('id')
      .where('policy_id', '=', policy)
      .where('permission', '=', permission)
      .where('role_id', '=', roles[role] as number)
      .executeTakeFirstOrThrow();
    const res = await as('admin', {
      method: 'DELETE',
      url: `/api/v1/access-policies/${policy}/grants/${found.id}`,
    });
    expect(res.statusCode, res.body).toBe(204);
    return async () => expect((await grant(permission, role)).statusCode).toBe(201);
  }

  const invite = (
    who: string,
    addresses: string[],
    options: { role?: string; delivery?: 'email' | 'link'; trackId?: number } = {},
  ) =>
    as(who, {
      method: 'POST',
      url: `/api/v1/tracks/${options.trackId ?? track}/invitations`,
      payload: {
        addresses,
        roleId: roles[options.role ?? 'Members'],
        delivery: options.delivery ?? 'email',
      },
    });

  const inspect = (token: string) =>
    as(undefined, { method: 'POST', url: '/api/v1/invitations/inspect', payload: { token } });

  const redeem = (token: string, name = 'New Person', password = NEW_PASSWORD) =>
    as(undefined, {
      method: 'POST',
      url: '/api/v1/invitations/redeem',
      payload: { token, name, password },
    });

  const holds = async (trackId: number, role: string, userId: number) =>
    (await database.db
      .selectFrom('track_role_actor')
      .select('track_id')
      .where('track_id', '=', trackId)
      .where('role_id', '=', roles[role] as number)
      .where('user_id', '=', userId)
      .executeTakeFirst()) !== undefined;

  const personal = async (email: string) =>
    database.db
      .selectFrom('app_user')
      .select(['id', 'password_hash', 'name'])
      .where('email', '=', email)
      .executeTakeFirst();

  beforeAll(async () => {
    await idp.start();
    app = await buildApp({
      db: database.db,
      outbound: loopbackOutbound(),
      version: 'test',
      roles: ['api'],
      passwords,
      peppers,
      publicUrl: ORIGIN,
      invitationMail: async () =>
        mailOn
          ? {
              from: 'taskmoor@example.com',
              transport: {
                send: async (email) => {
                  if (failNextSend) {
                    failNextSend = false;
                    throw new Error('the mail server said no');
                  }
                  outbox.push(email);
                  return { messageId: null };
                },
              },
            }
          : null,
    });
    const found = await database.db
      .selectFrom('access_policy')
      .select('id')
      .where('name', '=', 'Default access policy')
      .executeTakeFirstOrThrow();
    policy = found.id;
    const rows = await database.db.selectFrom('role').select(['id', 'name']).execute();
    roles = Object.fromEntries(rows.map((r) => [r.name, r.id]));
    await addUser('admin', { admin: true });
    await addUser('manager');
    await addUser('member');
    await addUser('existing');
    await addUser('config');
    await database.db
      .insertInto('global_grant')
      .values({
        workspace_id: 1,
        permission: 'configuration_admin',
        grantee: 'user',
        user_id: ids.config as number,
      })
      .execute();
    track = await addTrack('PAY');
    other = await addTrack('OPS');
    await give(track, 'Administrators', 'manager');
    await give(track, 'Members', 'member');
  });

  afterAll(async () => {
    await app.close();
    await idp.stop();
  });

  describe('who may invite', () => {
    it('[IAM-027] inviting is off on a new install: a manager is refused, a site administrator is not', async () => {
      const list = await as('manager', {
        method: 'GET',
        url: `/api/v1/tracks/${track}/invitations`,
      });
      expect(list.json()).toMatchObject({ canInvite: false, invitingGiven: false });
      const refused = await invite('manager', ['nobody@example.net']);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ error: 'forbidden', permission: 'invite_people' });
      const allowed = await invite('admin', ['by-admin@example.net']);
      expect(allowed.statusCode).toBe(201);
      await as('admin', {
        method: 'DELETE',
        url: `/api/v1/tracks/${track}/invitations/${allowed.json().results[0].invitationId}`,
      });
    });

    it('[IAM-027] only a site administrator gives or takes the right to invite', async () => {
      const asConfig = await as('config', {
        method: 'POST',
        url: `/api/v1/access-policies/${policy}/grants`,
        payload: { permission: 'invite_people', grantee: 'role', roleId: roles.Administrators },
      });
      expect(asConfig.statusCode).toBe(403);
      expect((await grant('invite_people', 'Administrators')).statusCode).toBe(201);
      const held = await database.db
        .selectFrom('access_grant')
        .select('id')
        .where('policy_id', '=', policy)
        .where('permission', '=', 'invite_people')
        .executeTakeFirstOrThrow();
      const takeAsConfig = await as('config', {
        method: 'DELETE',
        url: `/api/v1/access-policies/${policy}/grants/${held.id}`,
      });
      expect(takeAsConfig.statusCode).toBe(403);
      const copy = await as('config', {
        method: 'POST',
        url: '/api/v1/access-policies',
        payload: { name: 'A configuration administrator copy', copyFrom: policy },
      });
      const copied = await database.db
        .selectFrom('access_grant')
        .select('id')
        .where('policy_id', '=', copy.json().policy.id)
        .where('permission', '=', 'invite_people')
        .execute();
      expect(copied).toEqual([]);
      // Left on for the tests below.
    });

    it('[IAM-027] a local-mode track starts without the right to invite, and its managers cannot give it to themselves', async () => {
      const made = await as('member', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key: 'SOLO', name: 'Solo', mode: 'local', type: 'business' },
      });
      expect(made.statusCode, made.body).toBe(201);
      const solo = made.json().track.id as number;
      const row = await database.db
        .selectFrom('track')
        .select('access_policy_id')
        .where('id', '=', solo)
        .executeTakeFirstOrThrow();
      const given = await database.db
        .selectFrom('access_grant')
        .select('id')
        .where('policy_id', '=', row.access_policy_id)
        .where('permission', '=', 'invite_people')
        .execute();
      expect(given).toEqual([]);
      expect((await invite('member', ['x@example.net'], { trackId: solo })).statusCode).toBe(403);
      const self = await as('member', {
        method: 'POST',
        url: `/api/v1/access-policies/${row.access_policy_id}/grants`,
        payload: { permission: 'invite_people', grantee: 'user', userId: ids.member },
      });
      expect(self.statusCode).toBe(403);
    });

    it('[IAM-027] an inviter invites only into a track they run', async () => {
      expect((await invite('manager', ['a@example.net'], { trackId: other })).statusCode).toBe(403);
      expect((await invite('member', ['a@example.net'])).statusCode).toBe(403);
      expect((await invite('manager', ['a@example.net'], { trackId: 999_999 })).statusCode).toBe(
        404,
      );
    });

    it('[IAM-027] the routes need the admin scope of an API token, and accepting needs a person', () => {
      expect(routeAccess('POST', '/api/v1/tracks/:id/invitations')).toBe('admin');
      expect(routeAccess('DELETE', '/api/v1/tracks/:id/invitations/:invitationId')).toBe('admin');
      expect(routeAccess('POST', '/api/v1/invitations/redeem')).toBe('public');
      expect(routeAccess('POST', '/api/v1/invitations/accept')).toBe('session');
    });
  });

  describe('a new person', () => {
    it('[IAM-027] gets an email, chooses a password, signs in and lands in that track only', async () => {
      const res = await invite('manager', ['  Nia@Example.net '], { role: 'Viewers' });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().results).toEqual([
        {
          email: 'nia@example.net',
          status: 'invited',
          invitationId: expect.any(Number),
          external: false,
        },
      ]);
      const mail = outbox.at(-1) as OutgoingEmail;
      expect(mail.to).toBe('nia@example.net');
      expect(mail.subject).toContain('PAY');
      const link = /http\S*invite\?token=\S+/.exec(mail.text)?.[0] as string;
      expect(link.startsWith(`${ORIGIN}/#/invite?token=`)).toBe(true);
      const token = tokenOf(link);

      // Single use, hashed, expiring in seven days.
      const stored = await database.db
        .selectFrom('track_invitation')
        .selectAll()
        .where('email', '=', 'nia@example.net')
        .executeTakeFirstOrThrow();
      expect(stored.token_hash).toBe(tokenHash(token));
      expect(JSON.stringify(stored)).not.toContain(token);
      const days = (stored.expires_at.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);

      const pending = await as('manager', {
        method: 'GET',
        url: `/api/v1/tracks/${track}/invitations`,
      });
      expect(pending.json().invitations).toEqual([
        expect.objectContaining({
          email: 'nia@example.net',
          role: { id: roles.Viewers, name: 'Viewers' },
          state: 'open',
          sendFailed: false,
          invitedBy: 'manager',
        }),
      ]);

      const seen = await inspect(token);
      expect(seen.json()).toMatchObject({
        email: 'nia@example.net',
        track: { key: 'PAY', name: 'Track PAY' },
        roleName: 'Viewers',
        invitedBy: 'manager',
        secondFactorRequired: false,
      });
      expect((await redeem(token, 'Nia', 'short')).statusCode).toBe(400);
      const done = await redeem(token, 'Nia');
      expect(done.statusCode, done.body).toBe(200);
      // Redeeming signs nobody in: the ordinary sign-in comes next, whatever it asks.
      expect(cookieNamed(done, SESSION_COOKIE)).toBe('');
      const person = await personal('nia@example.net');
      expect(person?.name).toBe('Nia');
      expect(await holds(track, 'Viewers', person?.id as number)).toBe(true);

      const session = await signIn('nia@example.net', NEW_PASSWORD);
      expect(session.json().status).toBe('signed_in');
      cookies.nia = cookieNamed(session, SESSION_COOKIE);
      const mine = await as('nia', { method: 'GET', url: '/api/v1/tracks' });
      expect((mine.json().tracks as { key: string }[]).map((t) => t.key)).toEqual(['PAY']);
      const perms = await as('nia', {
        method: 'GET',
        url: `/api/v1/me/permissions?trackId=${track}`,
      });
      expect(perms.json().track).toContain('browse_track');
      expect(perms.json().track).not.toContain('administer_track');
      expect(perms.json().global).not.toContain('site_admin');

      expect((await inspect(token)).statusCode).toBe(404);
      expect((await redeem(token, 'Again')).statusCode).toBe(404);
      const left = await as('manager', {
        method: 'GET',
        url: `/api/v1/tracks/${track}/invitations`,
      });
      expect(left.json().invitations).toEqual([]);
    });

    it('[IAM-027] a pasted list goes address by address: invalid ones are named, repeats count once', async () => {
      const res = await invite(
        'manager',
        ['one@example.net', 'ONE@example.net', 'not an address', 'ghost@erased.invalid'],
        { delivery: 'link' },
      );
      const results = res.json().results as { email: string; status: string }[];
      expect(results.map((r) => [r.email, r.status])).toEqual([
        ['not an address', 'invalid'],
        ['ghost@erased.invalid', 'invalid'],
        ['one@example.net', 'invited'],
      ]);
      const again = await invite('manager', ['one@example.net'], { delivery: 'link' });
      expect(again.json().results).toEqual([
        { email: 'one@example.net', status: 'already_invited' },
      ]);
    });

    it('[IAM-027] an email that cannot be sent is shown on the invitation', async () => {
      failNextSend = true;
      const res = await invite('manager', ['bounce@example.net']);
      expect(res.json().results[0]).toMatchObject({ status: 'invited', sendFailed: true });
      const list = await as('manager', {
        method: 'GET',
        url: `/api/v1/tracks/${track}/invitations`,
      });
      const row = (list.json().invitations as { email: string; sendFailed: boolean }[]).find(
        (i) => i.email === 'bounce@example.net',
      );
      expect(row?.sendFailed).toBe(true);
    });
  });

  describe('an address that has an account', () => {
    it('[IAM-027] gets the role at once and an email, and the inviter sees the same answer as for a new address', async () => {
      const before = outbox.length;
      const known = await invite('manager', ['existing@example.com']);
      const unknown = await invite('manager', ['stranger@example.net']);
      const shape = (res: LightMyRequestResponse) =>
        Object.keys(res.json().results[0]).sort().join();
      expect(known.statusCode).toBe(unknown.statusCode);
      expect(shape(known)).toBe(shape(unknown));
      expect(known.json().results[0].status).toBe(unknown.json().results[0].status);
      expect(await holds(track, 'Members', ids.existing as number)).toBe(true);
      const mails = outbox.slice(before);
      expect(mails.map((m) => m.to)).toEqual(['existing@example.com', 'stranger@example.net']);
      expect(mails[0]?.subject).toContain('added you');
      expect(mails[1]?.subject).toContain('invited you');

      // Both wait on the list alike.
      const list = await as('manager', {
        method: 'GET',
        url: `/api/v1/tracks/${track}/invitations`,
      });
      const rows = list.json().invitations as Record<string, unknown>[];
      const row = (email: string) => {
        const {
          id: _id,
          email: _email,
          lastSentAt: _a,
          expiresAt: _b,
          ...rest
        } = rows.find((r) => r.email === email) as Record<string, unknown>;
        return rest;
      };
      expect(row('existing@example.com')).toEqual(row('stranger@example.net'));

      // The link's page answers alike too.
      const knownLink = await invite('admin', ['existing@example.com'], {
        delivery: 'link',
        trackId: other,
      });
      const unknownLink = await invite('admin', ['stranger@example.net'], {
        delivery: 'link',
        trackId: other,
      });
      expect(knownLink.json().results[0].link).not.toContain('account=1');
      const knownPage = (await inspect(tokenOf(knownLink.json().results[0].link))).json();
      const unknownPage = (await inspect(tokenOf(unknownLink.json().results[0].link))).json();
      expect(Object.keys(knownPage).sort()).toEqual(Object.keys(unknownPage).sort());
      expect({ ...knownPage, email: '', expiresAt: '' }).toEqual({
        ...unknownPage,
        email: '',
        expiresAt: '',
      });
      // An existing person is told by email even when the inviter asked for a link.
      expect(outbox.at(-1)?.to).not.toBe('stranger@example.net');
      expect(outbox.map((m) => m.to)).toContain('existing@example.com');
    });

    it('[IAM-027] setting a password through a link never changes an existing account, but answers the same', async () => {
      const res = await invite('admin', ['member@example.com'], {
        delivery: 'link',
        trackId: other,
      });
      const token = tokenOf(res.json().results[0].link);
      const before = await personal('member@example.com');
      const answer = await redeem(token, 'Attacker', 'a password the taker chose');
      expect(answer.statusCode).toBe(200);
      expect(answer.json().status).toBe('ready');
      const after = await personal('member@example.com');
      expect(after).toEqual(before);
      expect((await signIn('member@example.com', 'a password the taker chose')).statusCode).toBe(
        401,
      );
      // The person's own password still signs in, and the link still works for them.
      const accept = await as('member', {
        method: 'POST',
        url: '/api/v1/invitations/accept',
        payload: { token },
      });
      expect(accept.statusCode, accept.body).toBe(200);
      expect(accept.json().track.key).toBe('OPS');
      expect((await inspect(token)).statusCode).toBe(404);
    });

    it("[IAM-027] another signed-in person cannot take someone else's invitation", async () => {
      const res = await invite('admin', ['taken@example.net'], { delivery: 'link' });
      const token = tokenOf(res.json().results[0].link);
      const accept = await as('manager', {
        method: 'POST',
        url: '/api/v1/invitations/accept',
        payload: { token },
      });
      expect(accept.statusCode).toBe(403);
      expect(accept.json()).toEqual({ error: 'other_account', email: 'taken@example.net' });
      expect((await inspect(token)).statusCode).toBe(200);
    });

    it('[IAM-027] a deactivated account gets the same answer and nothing else', async () => {
      await addUser('gone');
      await database.db
        .updateTable('app_user')
        .set({ deactivated_at: new Date() })
        .where('id', '=', ids.gone as number)
        .execute();
      const before = outbox.length;
      const res = await invite('manager', ['gone@example.com']);
      expect(res.json().results[0]).toMatchObject({ status: 'invited' });
      expect(await holds(track, 'Members', ids.gone as number)).toBe(false);
      expect(outbox.length).toBe(before);
    });

    it('[IAM-027] a person found by name gets the role and an email with no link to spend', async () => {
      await addUser('picked');
      const before = outbox.length;
      const res = await as('manager', {
        method: 'POST',
        url: `/api/v1/tracks/${track}/invitations`,
        payload: { userIds: [ids.picked], roleId: roles.Members, delivery: 'email' },
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().results).toEqual([{ userId: ids.picked, name: 'picked', status: 'added' }]);
      expect(await holds(track, 'Members', ids.picked as number)).toBe(true);
      expect(outbox.slice(before).map((m) => m.to)).toEqual(['picked@example.com']);
      expect(outbox.at(-1)?.text).toContain('/#/tracks/PAY');
      expect(outbox.at(-1)?.text).not.toContain('token=');
    });
  });

  describe('open invitations', () => {
    it('[IAM-027] a site with no mail server says so and offers a link to copy', async () => {
      mailOn = false;
      try {
        const list = await as('manager', {
          method: 'GET',
          url: `/api/v1/tracks/${track}/invitations`,
        });
        expect(list.json().emailAvailable).toBe(false);
        const refused = await invite('manager', ['nomail@example.net']);
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toEqual({ error: 'email_not_set_up' });
        const link = await invite('manager', ['nomail@example.net'], { delivery: 'link' });
        expect(link.statusCode).toBe(201);
        expect(link.json().results[0].link).toContain('/#/invite?token=');
      } finally {
        mailOn = true;
      }
    });

    it('[IAM-027] resending makes a new link and ends the old one', async () => {
      const made = await invite('manager', ['again@example.net'], { delivery: 'link' });
      const first = made.json().results[0];
      const resent = await as('manager', {
        method: 'POST',
        url: `/api/v1/tracks/${track}/invitations/${first.invitationId}/resend`,
        payload: { delivery: 'link' },
      });
      expect(resent.statusCode, resent.body).toBe(200);
      expect((await inspect(tokenOf(first.link))).statusCode).toBe(404);
      expect((await inspect(tokenOf(resent.json().link))).statusCode).toBe(200);
      const events = await database.db
        .selectFrom('domain_event')
        .select('payload')
        .where('type', '=', 'track_invitation.resent')
        .execute();
      expect(JSON.stringify(events)).not.toContain(tokenOf(resent.json().link));
    });

    it('[IAM-027] revoking ends the link and takes back only the role the invitation gave', async () => {
      const made = await invite('manager', ['revoked@example.net'], { delivery: 'link' });
      const row = made.json().results[0];
      const gone = await as('manager', {
        method: 'DELETE',
        url: `/api/v1/tracks/${track}/invitations/${row.invitationId}`,
      });
      expect(gone.statusCode).toBe(204);
      expect((await inspect(tokenOf(row.link))).statusCode).toBe(404);
      expect((await redeem(tokenOf(row.link))).statusCode).toBe(404);
      expect(await personal('revoked@example.net')).toBeUndefined();

      await addUser('fresh');
      const given = await invite('manager', ['fresh@example.com'], { delivery: 'link' });
      expect(await holds(track, 'Members', ids.fresh as number)).toBe(true);
      await as('manager', {
        method: 'DELETE',
        url: `/api/v1/tracks/${track}/invitations/${given.json().results[0].invitationId}`,
      });
      expect(await holds(track, 'Members', ids.fresh as number)).toBe(false);

      // Someone who held the role before keeps it.
      const held = await invite('manager', ['member@example.com'], { delivery: 'link' });
      await as('manager', {
        method: 'DELETE',
        url: `/api/v1/tracks/${track}/invitations/${held.json().results[0].invitationId}`,
      });
      expect(await holds(track, 'Members', ids.member as number)).toBe(true);
    });

    it('[IAM-027] an expired link is refused; a new invitation for the address replaces it', async () => {
      const made = await invite('manager', ['late@example.net'], { delivery: 'link' });
      const row = made.json().results[0];
      await database.db
        .updateTable('track_invitation')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', row.invitationId)
        .execute();
      expect((await inspect(tokenOf(row.link))).statusCode).toBe(404);
      expect((await redeem(tokenOf(row.link))).statusCode).toBe(404);
      const list = await as('manager', {
        method: 'GET',
        url: `/api/v1/tracks/${track}/invitations`,
      });
      const shown = (list.json().invitations as { id: number; state: string }[]).find(
        (i) => i.id === row.invitationId,
      );
      expect(shown?.state).toBe('lapsed');
      const again = await invite('manager', ['late@example.net'], { delivery: 'link' });
      expect(again.json().results[0].status).toBe('invited');
    });

    it("[IAM-027] taking the right to invite away ends the inviter's open links", async () => {
      const made = await invite('manager', ['cut@example.net'], { delivery: 'link' });
      const token = tokenOf(made.json().results[0].link);
      const restore = await removeGrant('invite_people', 'Administrators');
      try {
        expect((await inspect(token)).statusCode).toBe(404);
        expect((await redeem(token)).statusCode).toBe(404);
        expect((await invite('manager', ['more@example.net'])).statusCode).toBe(403);
      } finally {
        await restore();
      }
      expect((await inspect(token)).statusCode).toBe(200);
    });

    it('[IAM-027] sending is limited per address and per inviter', async () => {
      await addUser('busy');
      const busyTrack = await addTrack(`LIM${++nextTrack}`);
      await give(busyTrack, 'Administrators', 'busy');
      const made = await invite('busy', ['flood@example.net'], {
        delivery: 'link',
        trackId: busyTrack,
      });
      const row = made.json().results[0];
      const resend = () =>
        as('busy', {
          method: 'POST',
          url: `/api/v1/tracks/${busyTrack}/invitations/${row.invitationId}/resend`,
          payload: { delivery: 'link' },
        });
      for (let i = 0; i < 4; i++) expect((await resend()).statusCode).toBe(200);
      const stopped = await resend();
      expect(stopped.statusCode).toBe(429);
      expect(stopped.json().error).toBe('too_many_invitations');

      const batch = (from: number) =>
        Array.from({ length: 45 }, (_, i) => `bulk${from + i}@example.net`);
      for (const from of [0, 45]) {
        expect(
          (await invite('busy', batch(from), { delivery: 'link', trackId: busyTrack })).statusCode,
        ).toBe(201);
      }
      const over = await invite('busy', batch(90), { delivery: 'link', trackId: busyTrack });
      expect(over.statusCode).toBe(429);
    });

    it('[IAM-027] unknown tokens count against the address', async () => {
      const from = '203.0.113.77';
      for (let i = 0; i < 50; i++) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/invitations/inspect',
          payload: { token: `nothing-${i}` },
          remoteAddress: from,
        });
      }
      const locked = await app.inject({
        method: 'POST',
        url: '/api/v1/invitations/inspect',
        payload: { token: 'nothing' },
        remoteAddress: from,
      });
      expect(locked.statusCode).toBe(429);
    });
  });

  describe('giving the role that runs a track', () => {
    it('[IAM-028] by default a manager gives, invites with and takes the Administrators role', async () => {
      await addUser('deputy');
      await addUser('deputy2');
      const give1 = await as('manager', {
        method: 'PUT',
        url: `/api/v1/tracks/${track}/roles/${roles.Administrators}/users/${ids.deputy}`,
      });
      expect(give1.statusCode, give1.body).toBe(204);
      const invited = await invite('manager', ['deputy2@example.com'], {
        role: 'Administrators',
        delivery: 'link',
      });
      expect(invited.json().results[0].status).toBe('invited');
      expect(await holds(track, 'Administrators', ids.deputy2 as number)).toBe(true);
      const take = await as('manager', {
        method: 'DELETE',
        url: `/api/v1/tracks/${track}/roles/${roles.Administrators}/users/${ids.deputy}`,
      });
      expect(take.statusCode).toBe(204);
      const listed = await as('manager', { method: 'GET', url: `/api/v1/tracks/${track}/roles` });
      const role = (
        listed.json().roles as { id: number; runsTrack: boolean; givable: boolean }[]
      ).find((r) => r.id === roles.Administrators);
      expect(role).toMatchObject({ runsTrack: true, givable: true });
      await database.db
        .deleteFrom('track_role_actor')
        .where('user_id', '=', ids.deputy2 as number)
        .execute();
    });

    it('[IAM-028] with the permission removed a manager still gives other roles but not that one; a site administrator still can', async () => {
      await addUser('hopeful');
      const restore = await removeGrant('appoint_track_admins', 'Administrators');
      try {
        const roleUrl = (role: string, user: string) =>
          `/api/v1/tracks/${track}/roles/${roles[role]}/users/${ids[user]}`;
        const refused = await as('manager', {
          method: 'PUT',
          url: roleUrl('Administrators', 'hopeful'),
        });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toEqual({ error: 'forbidden', permission: 'appoint_track_admins' });
        const member = await as('manager', { method: 'PUT', url: roleUrl('Members', 'hopeful') });
        expect(member.statusCode).toBe(204);
        const takenMember = await as('manager', {
          method: 'DELETE',
          url: roleUrl('Members', 'hopeful'),
        });
        expect(takenMember.statusCode).toBe(204);
        // Taking it is the same decision as giving it.
        expect(
          (await as('manager', { method: 'DELETE', url: roleUrl('Administrators', 'manager') }))
            .statusCode,
        ).toBe(403);
        // Nor through an invitation, whichever kind of address it is.
        const invited = await invite('manager', ['hopeful@example.com'], {
          role: 'Administrators',
        });
        expect(invited.statusCode).toBe(403);
        expect(invited.json().permission).toBe('appoint_track_admins');
        expect(await holds(track, 'Administrators', ids.hopeful as number)).toBe(false);
        // Nor by making someone the owner.
        const owner = await as('manager', {
          method: 'PATCH',
          url: `/api/v1/tracks/${track}`,
          payload: { ownerId: ids.hopeful },
        });
        expect(owner.statusCode).toBe(403);
        const listed = await as('manager', {
          method: 'GET',
          url: `/api/v1/tracks/${track}/roles`,
        });
        const shown = listed.json().roles as { id: number; givable: boolean }[];
        expect(shown.find((r) => r.id === roles.Administrators)?.givable).toBe(false);
        expect(shown.find((r) => r.id === roles.Members)?.givable).toBe(true);
        // A site administrator always may.
        const byAdmin = await as('admin', {
          method: 'PUT',
          url: roleUrl('Administrators', 'hopeful'),
        });
        expect(byAdmin.statusCode).toBe(204);
        const undo = await as('admin', {
          method: 'DELETE',
          url: roleUrl('Administrators', 'hopeful'),
        });
        expect(undo.statusCode).toBe(204);
      } finally {
        await restore();
      }
    });

    it('[IAM-028] a pending invitation with that role ends when the inviter loses the permission', async () => {
      const made = await invite('manager', ['future-boss@example.net'], {
        role: 'Administrators',
        delivery: 'link',
      });
      const token = tokenOf(made.json().results[0].link);
      const restore = await removeGrant('appoint_track_admins', 'Administrators');
      try {
        expect((await inspect(token)).statusCode).toBe(404);
      } finally {
        await restore();
      }
    });

    it('[IAM-028] a renamed role is still protected: the grants decide, not the name', async () => {
      const renamed = await as('admin', {
        method: 'PATCH',
        url: `/api/v1/roles/${roles.Administrators}`,
        payload: { name: 'Leads' },
      });
      expect(renamed.statusCode).toBe(200);
      const restore = await removeGrant('appoint_track_admins', 'Administrators');
      try {
        const refused = await as('manager', {
          method: 'PUT',
          url: `/api/v1/tracks/${track}/roles/${roles.Administrators}/users/${ids.existing}`,
        });
        expect(refused.statusCode).toBe(403);
      } finally {
        await restore();
        await as('admin', {
          method: 'PATCH',
          url: `/api/v1/roles/${roles.Administrators}`,
          payload: { name: 'Administrators' },
        });
      }
    });

    it('[IAM-028] a local-mode manager without the permission cannot appoint through the policy or give it back', async () => {
      const made = await as('existing', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key: 'OWN', name: 'Own', mode: 'local', type: 'business' },
      });
      expect(made.statusCode, made.body).toBe(201);
      const own = made.json().track.id as number;
      const { access_policy_id: ownPolicy } = await database.db
        .selectFrom('track')
        .select('access_policy_id')
        .where('id', '=', own)
        .executeTakeFirstOrThrow();
      const grants = await database.db
        .selectFrom('access_grant')
        .select(['id', 'grantee'])
        .where('policy_id', '=', ownPolicy)
        .where('permission', '=', 'appoint_track_admins')
        .execute();
      expect(grants.length).toBeGreaterThan(0);
      // With the permission, the local manager may change it: removable by the policy's editor.
      for (const g of grants) {
        const removed = await as('admin', {
          method: 'DELETE',
          url: `/api/v1/access-policies/${ownPolicy}/grants/${g.id}`,
        });
        expect(removed.statusCode).toBe(204);
      }
      const back = await as('existing', {
        method: 'POST',
        url: `/api/v1/access-policies/${ownPolicy}/grants`,
        payload: { permission: 'appoint_track_admins', grantee: 'user', userId: ids.existing },
      });
      expect(back.statusCode).toBe(403);
      const around = await as('existing', {
        method: 'POST',
        url: `/api/v1/access-policies/${ownPolicy}/grants`,
        payload: { permission: 'administer_track', grantee: 'user', userId: ids.member },
      });
      expect(around.statusCode).toBe(403);
      // Ordinary permissions of their own policy stay theirs to change.
      const ordinary = await as('existing', {
        method: 'POST',
        url: `/api/v1/access-policies/${ownPolicy}/grants`,
        payload: { permission: 'browse_track', grantee: 'user', userId: ids.member },
      });
      expect(ordinary.statusCode).toBe(201);
    });

    it('[IAM-028] it reaches one track only: a site administrator keeps their rights, and other tracks are untouched', async () => {
      await addUser('boss', { admin: true });
      await give(track, 'Administrators', 'boss');
      await give(other, 'Administrators', 'boss');
      const taken = await as('manager', {
        method: 'DELETE',
        url: `/api/v1/tracks/${track}/roles/${roles.Administrators}/users/${ids.boss}`,
      });
      expect(taken.statusCode).toBe(204);
      const boss = await personal('boss@example.com');
      expect(await holds(other, 'Administrators', boss?.id as number)).toBe(true);
      const perms = await as('boss', {
        method: 'GET',
        url: `/api/v1/me/permissions?trackId=${track}`,
      });
      expect(perms.json().global).toContain('site_admin');
      expect(perms.json().track).toContain('administer_track');
      // Another track's roles are out of reach.
      const outside = await as('manager', {
        method: 'DELETE',
        url: `/api/v1/tracks/${other}/roles/${roles.Administrators}/users/${ids.boss}`,
      });
      expect(outside.statusCode).toBe(403);
      const flag = await as('manager', {
        method: 'PATCH',
        url: `/api/v1/users/${ids.boss}`,
        payload: { isSiteAdmin: false },
      });
      expect(flag.statusCode).toBe(403);
      await database.db
        .deleteFrom('track_role_actor')
        .where('user_id', '=', ids.boss as number)
        .execute();
    });

    it('[IAM-028] the last administrator of a track cannot be removed; everyone is told to appoint someone first', async () => {
      const lone = await addTrack(`LAST${++nextTrack}`);
      await addUser('lone');
      await addUser('second');
      await give(lone, 'Administrators', 'lone');
      const url = (user: string) =>
        `/api/v1/tracks/${lone}/roles/${roles.Administrators}/users/${ids[user]}`;
      for (const who of ['lone', 'admin']) {
        const refused = await as(who, { method: 'DELETE', url: url('lone') });
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toEqual({ error: 'last_track_admin' });
      }
      expect(await holds(lone, 'Administrators', ids.lone as number)).toBe(true);
      await give(lone, 'Administrators', 'second');
      expect((await as('lone', { method: 'DELETE', url: url('second') })).statusCode).toBe(204);
      await give(lone, 'Administrators', 'second');
      expect((await as('second', { method: 'DELETE', url: url('lone') })).statusCode).toBe(204);

      // A deactivated person runs nothing; an owner does.
      await database.db
        .updateTable('track')
        .set({ owner_id: ids.lone as number })
        .where('id', '=', lone)
        .execute();
      expect((await as('second', { method: 'DELETE', url: url('second') })).statusCode).toBe(204);
      await give(lone, 'Administrators', 'second');
      await database.db
        .updateTable('track')
        .set({ owner_id: null })
        .where('id', '=', lone)
        .execute();
      await give(lone, 'Administrators', 'lone');
      await database.db
        .updateTable('app_user')
        .set({ deactivated_at: new Date() })
        .where('id', '=', ids.lone as number)
        .execute();
      expect((await as('admin', { method: 'DELETE', url: url('second') })).statusCode).toBe(409);
      await database.db
        .updateTable('app_user')
        .set({ deactivated_at: null })
        .where('id', '=', ids.lone as number)
        .execute();
      // Other roles are not concerned.
      await give(lone, 'Members', 'lone');
      const member = await as('admin', {
        method: 'DELETE',
        url: `/api/v1/tracks/${lone}/roles/${roles.Members}/users/${ids.lone}`,
      });
      expect(member.statusCode).toBe(204);
    });

    it('[IAM-028] a local-mode track keeps someone who runs it when grants change', async () => {
      const made = await as('existing', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key: 'KEEP', name: 'Keep', mode: 'local', type: 'business' },
      });
      const keep = made.json().track.id as number;
      const { access_policy_id: keepPolicy } = await database.db
        .selectFrom('track')
        .select('access_policy_id')
        .where('id', '=', keep)
        .executeTakeFirstOrThrow();
      const grants = await database.db
        .selectFrom('access_grant')
        .select(['id', 'grantee'])
        .where('policy_id', '=', keepPolicy)
        .where('permission', '=', 'administer_track')
        .orderBy('id')
        .execute();
      const [first, ...rest] = grants;
      for (const g of rest) {
        const res = await as('existing', {
          method: 'DELETE',
          url: `/api/v1/access-policies/${keepPolicy}/grants/${g.id}`,
        });
        expect(res.statusCode, res.body).toBe(204);
      }
      const last = await as('existing', {
        method: 'DELETE',
        url: `/api/v1/access-policies/${keepPolicy}/grants/${first?.id}`,
      });
      expect(last.statusCode).toBe(409);
      expect(last.json()).toEqual({ error: 'last_track_admin' });
    });

    it('[IAM-028] a new install and an upgrade give the permission wherever a track can be run', async () => {
      const held = await database.db
        .selectFrom('access_grant')
        .select(['grantee', 'role_id'])
        .where('policy_id', '=', policy)
        .where('permission', '=', 'appoint_track_admins')
        .execute();
      expect(held).toContainEqual({ grantee: 'role', role_id: roles.Administrators });
      expect(held).toContainEqual({ grantee: 'track_owner', role_id: null });
      expect(held.some((g) => g.role_id === roles.Members || g.role_id === roles.Viewers)).toBe(
        false,
      );
    });
  });

  describe('two-factor and single sign-on', () => {
    it("[IAM-029] someone outside the organization's domains must set up two-factor after the link; the rule stays", async () => {
      const res = await as('admin', {
        method: 'PUT',
        url: '/api/v1/security/two-factor',
        payload: { required: 'none', groupIds: [], organizationDomains: ['company.example'] },
      });
      expect(res.statusCode, res.body).toBe(200);
      try {
        const made = await invite(
          'manager',
          ['friend@personal.example', 'colleague@company.example'],
          { delivery: 'link' },
        );
        const [friend, colleague] = made.json().results;
        expect(friend).toMatchObject({ email: 'friend@personal.example', external: true });
        expect(colleague).toMatchObject({ email: 'colleague@company.example', external: false });
        const seen = await inspect(tokenOf(friend.link));
        expect(seen.json().secondFactorRequired).toBe(true);
        expect((await inspect(tokenOf(colleague.link))).json().secondFactorRequired).toBe(false);

        expect((await redeem(tokenOf(friend.link), 'Friend')).statusCode).toBe(200);
        const session = await signIn('friend@personal.example', NEW_PASSWORD);
        expect(session.json().status).toBe('enrollment_required');
        expect(cookieNamed(session, SESSION_COOKIE)).toBe('');
        // Without a second factor there is no session, role or no role.
        const person = await personal('friend@personal.example');
        expect(await holds(track, 'Members', person?.id as number)).toBe(true);

        expect((await redeem(tokenOf(colleague.link), 'Colleague')).statusCode).toBe(200);
        expect((await signIn('colleague@company.example', NEW_PASSWORD)).json().status).toBe(
          'signed_in',
        );
      } finally {
        await as('admin', {
          method: 'PUT',
          url: '/api/v1/security/two-factor',
          payload: { required: 'none', groupIds: [], organizationDomains: [] },
        });
      }
    });

    /** A whole sign-in through the fake provider, as a browser would; the cookie it ends with. */
    async function ssoSignIn(providerId: number) {
      const start = await as(undefined, {
        method: 'GET',
        url: `/api/v1/auth/oidc/${providerId}/start`,
      });
      const browser = cookieNamed(start, 'taskmoor_oidc');
      const authorize = await fetch(String(start.headers.location), { redirect: 'manual' });
      const back = new URL(authorize.headers.get('location') ?? '');
      const callback = await as(undefined, {
        method: 'GET',
        url: `${back.pathname}${back.search}`,
        headers: { cookie: browser },
      });
      return {
        location: String(callback.headers.location),
        session: cookieNamed(callback, SESSION_COOKIE),
      };
    }

    async function closedProvider(name: string, domain: string, extra = {}) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/identity-providers',
        payload: {
          name,
          issuer: idp.issuer,
          clientId: 'taskmoor',
          clientSecret: CLIENT_SECRET,
          domains: [domain],
          jit: false,
          ...extra,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().provider as { id: number };
    }

    it('[IAM-029] a provider that vouches for an invited address opens the invitation, also when it makes no accounts of its own', async () => {
      const provider = await closedProvider('Closed', 'closed.example');
      // No invitation, no account: refused, as before.
      idp.person = { sub: 'c-1', email: 'stranger@closed.example', name: 'Stranger' };
      expect((await ssoSignIn(provider.id)).location).toBe(
        `${ORIGIN}/#/sign-in?sso_error=no_account`,
      );
      expect(await personal('stranger@closed.example')).toBeUndefined();

      const made = await invite('manager', ['guest@closed.example'], {
        role: 'Viewers',
        delivery: 'link',
      });
      const token = tokenOf(made.json().results[0].link);

      // Unverified: the provider vouches for nothing.
      idp.person = {
        sub: 'c-2',
        email: 'guest@closed.example',
        name: 'Guest',
        emailVerified: false,
      };
      expect((await ssoSignIn(provider.id)).location).toBe(
        `${ORIGIN}/#/sign-in?sso_error=email_unverified`,
      );
      expect(await personal('guest@closed.example')).toBeUndefined();

      idp.person = { sub: 'c-2', email: 'guest@closed.example', name: 'Guest' };
      const signedIn = await ssoSignIn(provider.id);
      expect(signedIn.session).not.toBe('');
      const person = await personal('guest@closed.example');
      expect(person?.password_hash).toBeNull();
      expect(await holds(track, 'Viewers', person?.id as number)).toBe(false);
      const accepted = await as(signedIn.session, {
        method: 'POST',
        url: '/api/v1/invitations/accept',
        payload: { token },
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(await holds(track, 'Viewers', person?.id as number)).toBe(true);
      expect((await inspect(token)).statusCode).toBe(404);

      // A used invitation opens nothing for anyone else.
      idp.person = { sub: 'c-3', email: 'other@closed.example', name: 'Other' };
      expect((await ssoSignIn(provider.id)).location).toBe(
        `${ORIGIN}/#/sign-in?sso_error=no_account`,
      );
    });

    it('[IAM-029] a provider never opens an invitation for an address outside its domains, nor a revoked one', async () => {
      const provider = await closedProvider('Narrow', 'narrow.example');
      const elsewhere = await invite('manager', ['outside@elsewhere.example'], {
        delivery: 'link',
      });
      expect(elsewhere.statusCode).toBe(201);
      idp.person = { sub: 'n-1', email: 'outside@elsewhere.example', name: 'Outside' };
      expect((await ssoSignIn(provider.id)).location).toBe(
        `${ORIGIN}/#/sign-in?sso_error=domain_not_allowed`,
      );
      const made = await invite('manager', ['cancelled@narrow.example'], { delivery: 'link' });
      await as('manager', {
        method: 'DELETE',
        url: `/api/v1/tracks/${track}/invitations/${made.json().results[0].invitationId}`,
      });
      idp.person = { sub: 'n-2', email: 'cancelled@narrow.example', name: 'Cancelled' };
      expect((await ssoSignIn(provider.id)).location).toBe(
        `${ORIGIN}/#/sign-in?sso_error=no_account`,
      );
    });

    it('[IAM-029] where a domain must use its provider, a password cannot be chosen', async () => {
      await closedProvider('Strict', 'strict.example', { enforceSso: true });
      const made = await invite('manager', ['someone@strict.example'], { delivery: 'link' });
      const res = await redeem(tokenOf(made.json().results[0].link), 'Someone');
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('sso_required');
      expect(await personal('someone@strict.example')).toBeUndefined();
    });
  });

  describe('the tracks a person runs', () => {
    it('[IAM-030] lists the tracks a manager runs, none for others, and every track for a site administrator', async () => {
      const mine = await as('manager', { method: 'GET', url: '/api/v1/me/managed-tracks' });
      expect((mine.json().tracks as { key: string }[]).map((t) => t.key)).toEqual(['PAY']);
      await addUser('bystander');
      const none = await as('bystander', { method: 'GET', url: '/api/v1/me/managed-tracks' });
      expect(none.json().tracks).toEqual([]);
      const all = await as('admin', { method: 'GET', url: '/api/v1/me/managed-tracks' });
      expect((all.json().tracks as { key: string }[]).map((t) => t.key)).toEqual(
        expect.arrayContaining(['OPS', 'PAY']),
      );
      expect(
        (await as(undefined, { method: 'GET', url: '/api/v1/me/managed-tracks' })).statusCode,
      ).toBe(401);
      for (const url of [
        `/api/v1/tracks/${track}/roles`,
        `/api/v1/tracks/${track}/invitations`,
        `/api/v1/tracks/${track}/role-actors`,
      ]) {
        expect((await as('bystander', { method: 'GET', url })).statusCode, url).toBe(403);
        expect((await as('manager', { method: 'GET', url })).statusCode, url).toBe(200);
      }
    });

    it('[IAM-027] the emails escape what comes from data, and speak Spanish to Spanish readers', () => {
      const body = {
        inviterName: '<b>Eve</b>',
        trackKey: 'PAY',
        trackName: 'Pay & "pals"',
        roleName: 'Members',
        url: `${ORIGIN}/#/invite?token=abc`,
        expiresAt: new Date('2026-11-10T00:00:00Z'),
      };
      const en = renderInvitationEmail('invited', body, null);
      expect(en.html).not.toContain('<b>Eve</b>');
      expect(en.html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
      expect(en.text).toContain(body.url);
      const es = renderInvitationEmail('added', body, 'es-ES');
      expect(es.subject).toContain('te añadió');
      const header = renderInvitationEmail(
        'invited',
        { ...body, inviterName: 'Eve\r\nBcc: x' },
        null,
      );
      expect(header.subject).not.toMatch(/[\r\n]/);
    });
  });
});
