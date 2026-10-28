import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { ENTRA_ID, OKTA, type ScimStep } from '../testing/scim-idp';

/**
 * Identity provider fixtures (M1-083 done-when; IAM-006 (1)): each provider's request sequence
 * runs against the service and every step must answer as the provider expects.
 */
const PASSWORD = 'ladder violet harbour';

/** Replaces `{name}` in strings, deep inside a value, with captured values. */
function fill(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string')
    return value.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`);
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [fill(k, vars) as string, fill(v, vars)]),
    );
  }
  return value;
}

function read(body: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], body);
}

describe('identity provider request sequences (M1-083)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let token = '';

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'Admin',
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
    const cookie =
      (Array.isArray(header) ? header : [String(header)])
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
        ?.split(';')[0] ?? '';
    const account = await app.inject({
      method: 'POST',
      url: '/api/v1/service-accounts',
      headers: { cookie },
      payload: { name: 'Provisioning' },
    });
    const issued = await app.inject({
      method: 'POST',
      url: `/api/v1/service-accounts/${account.json().serviceAccount.id}/tokens`,
      headers: { cookie },
      payload: { name: 'SCIM', scopes: ['scim'], expiresInDays: 30 },
    });
    token = issued.json().token;
  });
  afterAll(async () => {
    await app.close();
  });

  async function replay(steps: readonly ScimStep[]) {
    const vars: Record<string, string> = {};
    for (const step of steps) {
      const path = fill(step.path, vars) as string;
      const [route = '', query = ''] = path.split('?');
      // Providers send the filter unencoded in their logs; on the wire it is encoded.
      const url = `/api/v1/scim/v2${route}${query ? `?${new URLSearchParams(query).toString()}` : ''}`;
      const res = await app.inject({
        method: step.method,
        url,
        headers: {
          authorization: `Bearer ${token}`,
          ...(step.body !== undefined ? { 'content-type': 'application/scim+json' } : {}),
        },
        ...(step.body !== undefined ? { payload: JSON.stringify(fill(step.body, vars)) } : {}),
      });
      expect(res.statusCode, `${step.name}: ${res.body}`).toBe(step.status);
      if (res.statusCode === 204) continue;
      expect(res.headers['content-type'], step.name).toBe('application/scim+json; charset=utf-8');
      const body = res.json();
      if (step.expect) expect(body, step.name).toMatchObject(fill(step.expect, vars) as object);
      for (const name of step.absent ?? [])
        expect(body[name], `${step.name}: ${name}`).toBeUndefined();
      for (const [name, at] of Object.entries(step.capture ?? {}))
        vars[name] = String(read(body, at));
    }
  }

  it('[IAM-006] provisions, updates, groups and deprovisions people as Microsoft Entra ID does', async () => {
    await replay(ENTRA_ID);
  });

  it('[IAM-006] provisions, updates, groups and deprovisions people as Okta does', async () => {
    await replay(OKTA);
  });
});
