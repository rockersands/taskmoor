import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { fc } from '@taskmoor/testkit/property';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { matcher, parseRange } from './allowlist';

// Made for this run: no password is written in the repository.
const PASSWORD = `allow-${randomBytes(18).toString('base64url')}`;

describe('allowlist ranges (M1-085)', () => {
  it('[IAM-015] reads IPv4 and IPv6 addresses and CIDR ranges, and refuses anything else', () => {
    expect(parseRange('203.0.113.7')).toEqual({
      address: '203.0.113.7',
      prefix: 32,
      family: 'ipv4',
    });
    expect(parseRange(' 198.51.100.0/24 ')).toMatchObject({ prefix: 24, family: 'ipv4' });
    expect(parseRange('2001:DB8::/32')).toEqual({
      address: '2001:db8::',
      prefix: 32,
      family: 'ipv6',
    });
    expect(parseRange('::ffff:192.0.2.1')).toMatchObject({ address: '192.0.2.1', family: 'ipv4' });
    for (const bad of [
      '',
      '10.0.0.0/33',
      '10.0.0.0/-1',
      '10.0.0/8',
      'example.com',
      '1.2.3.4/8/1',
      '::1/129',
      '10.0.0.0/8x',
    ]) {
      expect(parseRange(bad), bad).toBeNull();
    }
  });

  it('[IAM-015] (1) lets in exactly the addresses inside a range', () => {
    fc.assert(
      fc.property(fc.ipV4(), fc.integer({ min: 0, max: 32 }), fc.ipV4(), (network, prefix, ip) => {
        const toInt = (a: string) => a.split('.').reduce((n, part) => n * 256 + Number(part), 0);
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        const inside = (toInt(network) & mask) >>> 0 === (toInt(ip) & mask) >>> 0;
        expect(matcher([{ range: `${network}/${prefix}` }])(ip)).toBe(inside);
      }),
    );
    const allows = matcher([{ range: '2001:db8::/32' }, { range: '203.0.113.7' }]);
    expect(allows('2001:db8:1::5')).toBe(true);
    expect(allows('2001:db9::1')).toBe(false);
    expect(allows('::ffff:203.0.113.7')).toBe(true);
    expect(allows('203.0.113.8')).toBe(false);
  });
});

/**
 * The allowlist through the server (M1-085; IAM-015): requests from outside it are refused on
 * the API and the web app alike, exempt groups get in from anywhere, and saving a list that
 * leaves the administrator outside needs a confirmation.
 */
describe('the IP allowlist through the API (M1-085)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const OFFICE = '203.0.113.10';
  const HOME = '198.51.100.20';

  const as = (who: string | null, options: InjectOptions, from = OFFICE) =>
    app.inject({
      ...options,
      remoteAddress: from,
      headers: { ...(options.headers ?? {}), ...(who ? { cookie: cookies[who] ?? '' } : {}) },
    });

  async function person(name: string, admin = false) {
    const row = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: `${name}@example.com`,
        name,
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: admin,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids[name] = row.id;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: `${name}@example.com`, password: PASSWORD },
      remoteAddress: OFFICE,
    });
    const cookie = [res.headers['set-cookie']]
      .flat()
      .find((c) => c?.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`));
    cookies[name] = (cookie ?? '').split(';')[0] ?? '';
  }
  const save = (payload: Record<string, unknown>, from = OFFICE) =>
    as('admin', { method: 'PUT', url: '/api/v1/admin/ip-allowlist', payload }, from);

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await person('admin', true);
    await person('pat');
    await person('travel');
  });
  afterAll(async () => {
    await app?.close();
  });

  it('[IAM-015] (2) asks for confirmation before a list leaves the administrator outside', async () => {
    const outside = await save({ enabled: true, entries: [{ range: '192.0.2.0/24' }] });
    expect(outside.statusCode).toBe(409);
    expect(outside.json()).toEqual({ error: 'would_lock_you_out', address: OFFICE });
    const invalid = await save({ enabled: false, entries: [{ range: '10.0.0.0/33' }] });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().fields).toEqual({ 'entries.0.range': 'invalid_range' });
    // Nothing was saved: the list is still off.
    const read = await as('admin', { method: 'GET', url: '/api/v1/admin/ip-allowlist' });
    expect(read.json()).toMatchObject({
      allowlist: { enabled: false, entries: [] },
      yourAddress: OFFICE,
      yourAddressAllowed: false,
    });
  });

  it('[IAM-015] (1) refuses API calls and the app from outside the list, with exempt groups let in', async () => {
    const group = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'Travelling staff' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('group_member')
      .values({ workspace_id: 1, group_id: group.id, user_id: ids.travel as number })
      .execute();
    const saved = await save({
      enabled: true,
      entries: [{ range: '203.0.113.0/24', note: 'Office' }, { range: '2001:db8::/32' }],
      exemptGroupIds: [group.id],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      allowlist: {
        enabled: true,
        exemptGroups: [{ id: group.id, name: 'Travelling staff' }],
        entries: [
          { range: '203.0.113.0/24', note: 'Office' },
          { range: '2001:db8::/32', note: '' },
        ],
      },
      yourAddressAllowed: true,
    });

    expect((await as('pat', { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(200);
    const blocked = await as('pat', { method: 'GET', url: '/api/v1/session' }, HOME);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual({ error: 'ip_not_allowed', address: HOME });
    expect(
      (await as('pat', { method: 'GET', url: '/api/v1/session' }, '2001:db8:5::1')).statusCode,
    ).toBe(200);
    // Signing in from outside is refused too.
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'pat@example.com', password: PASSWORD },
      remoteAddress: HOME,
    });
    expect(signIn.statusCode).toBe(403);
    // A member of an exempt group gets in from anywhere.
    expect((await as('travel', { method: 'GET', url: '/api/v1/session' }, HOME)).statusCode).toBe(
      200,
    );
    // The health probes stay open.
    expect((await as(null, { method: 'GET', url: '/health' }, HOME)).statusCode).toBe(200);

    // The change is a domain event, which the audit log records.
    const events = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'ip_allowlist.updated')
      .execute();
    expect(events.at(-1)?.payload).toMatchObject({
      enabled: { from: false, to: true },
      added: expect.arrayContaining(['2001:db8::/32', '203.0.113.0/24']),
    });
  });

  it('[IAM-015] lets the administrator turn the list off from inside it', async () => {
    const off = await save({ enabled: false, entries: [] });
    expect(off.statusCode, off.body).toBe(200);
    expect((await as('pat', { method: 'GET', url: '/api/v1/session' }, HOME)).statusCode).toBe(200);
    // Only site administrators see or change the list.
    expect((await as('pat', { method: 'GET', url: '/api/v1/admin/ip-allowlist' })).statusCode).toBe(
      403,
    );
  });
});
