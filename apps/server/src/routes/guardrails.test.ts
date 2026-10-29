import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { GUARDRAILS } from '../guardrails/model';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.73.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Guardrail {
  name: string;
  limit: number;
  default: number;
  usage: { value: number; where: { kind: string; id: number; name: string } | null };
}

describe('configuration guardrails (M1-055)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  let trackId = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: cookies[who] ?? '' },
    });
  const admin = (options: InjectOptions) => as('admin', options);
  const setLimit = async (name: string, limit: number) => {
    const res = await admin({
      method: 'PUT',
      url: `/api/v1/admin/guardrails/${name}`,
      payload: { limit },
    });
    expect(res.statusCode, res.body).toBe(200);
  };
  const guardrails = async () => {
    const res = await admin({ method: 'GET', url: '/api/v1/admin/guardrails' });
    expect(res.statusCode, res.body).toBe(200);
    return new Map((res.json().guardrails as Guardrail[]).map((g) => [g.name, g]));
  };
  const refused = (body: unknown, guardrail: string, limit: number) =>
    expect(body).toEqual({ error: 'guardrail_exceeded', guardrail, limit });

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, isAdmin] of [
      ['admin', true],
      ['alice', false],
    ] as const) {
      await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: isAdmin,
        })
        .execute();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      cookies[name] = sessionCookie(res.headers['set-cookie']);
    }
    const res = await admin({
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'GRD', name: 'Guarded', mode: 'shared' },
    });
    trackId = res.json().track.id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-026] shows every guardrail with its default, limit and largest usage; administrators only', async () => {
    const list = await guardrails();
    expect([...list.keys()]).toEqual(GUARDRAILS.map((g) => g.name));
    expect(list.get('releases_per_track')).toMatchObject({ limit: 15_000, default: 15_000 });
    expect(list.get('priorities_per_track')?.usage.value).toBeGreaterThan(0);
    const member = await as('alice', { method: 'GET', url: '/api/v1/admin/guardrails' });
    expect(member.statusCode).toBe(403);
    const change = await as('alice', {
      method: 'PUT',
      url: '/api/v1/admin/guardrails/areas_per_track',
      payload: { limit: 5 },
    });
    expect(change.statusCode).toBe(403);
    const unknown = await admin({
      method: 'PUT',
      url: '/api/v1/admin/guardrails/nothing',
      payload: { limit: 5 },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('[CORE-026] refuses the release past the limit, counts only open releases, and a raise works at once', async () => {
    await setLimit('releases_per_track', 2);
    const add = (name: string) =>
      admin({ method: 'POST', url: `/api/v1/tracks/${trackId}/releases`, payload: { name } });
    expect((await add('1.0')).statusCode).toBe(201);
    const second = await add('1.1');
    expect(second.statusCode).toBe(201);
    const third = await add('1.2');
    expect(third.statusCode).toBe(409);
    refused(third.json(), 'releases_per_track', 2);
    // Nothing was written by the refusal.
    const rows = await database.db
      .selectFrom('release')
      .select('name')
      .where('track_id', '=', trackId)
      .execute();
    expect(rows.map((r) => r.name).sort()).toEqual(['1.0', '1.1']);
    // An archived release does not count; bringing it back does.
    const id = second.json().release.id as number;
    expect(
      (await admin({ method: 'POST', url: `/api/v1/releases/${id}/archive` })).statusCode,
    ).toBe(200);
    expect((await add('1.2')).statusCode).toBe(201);
    const restore = await admin({ method: 'POST', url: `/api/v1/releases/${id}/restore` });
    expect(restore.statusCode).toBe(409);
    await setLimit('releases_per_track', 3);
    expect(
      (await admin({ method: 'POST', url: `/api/v1/releases/${id}/restore` })).statusCode,
    ).toBe(200);
    expect((await guardrails()).get('releases_per_track')?.usage).toEqual({
      value: 3,
      where: { kind: 'track', id: trackId, name: 'GRD' },
    });
  });

  it('[CORE-026] refuses areas, priority sets, type sets and map entries beyond their limits', async () => {
    await setLimit('areas_per_track', 1);
    const area = (name: string) =>
      admin({ method: 'POST', url: `/api/v1/tracks/${trackId}/areas`, payload: { name } });
    expect((await area('Payments')).statusCode).toBe(201);
    refused((await area('Refunds')).json(), 'areas_per_track', 1);

    await setLimit('priorities_per_track', 1);
    const priorities = (await admin({ method: 'GET', url: '/api/v1/priorities' })).json()
      .priorities as { id: number }[];
    const set = await admin({
      method: 'POST',
      url: '/api/v1/priority-sets',
      payload: { name: 'Two', priorityIds: priorities.slice(0, 2).map((p) => p.id) },
    });
    refused(set.json(), 'priorities_per_track', 1);

    await setLimit('ticket_types_per_track', 1);
    const types = (await admin({ method: 'GET', url: '/api/v1/ticket-types' })).json()
      .ticketTypes as { id: number }[];
    const typeSet = await admin({
      method: 'POST',
      url: '/api/v1/type-sets',
      payload: { name: 'Two types', ticketTypeIds: types.slice(0, 2).map((t) => t.id) },
    });
    refused(typeSet.json(), 'ticket_types_per_track', 1);

    await setLimit('workflows_per_map', 1);
    const workflows = (await admin({ method: 'GET', url: '/api/v1/workflows' })).json()
      .workflows as { id: number }[];
    const first = workflows[0]?.id as number;
    const copy = await admin({
      method: 'POST',
      url: '/api/v1/workflows',
      payload: {
        name: 'Second',
        definition: (await admin({ method: 'GET', url: `/api/v1/workflows/${first}` })).json()
          .workflow.published.definition,
      },
    });
    expect(copy.statusCode, copy.body).toBe(201);
    const map = await admin({
      method: 'POST',
      url: '/api/v1/workflow-maps',
      payload: {
        name: 'Two workflows',
        defaultWorkflowId: first,
        entries: [{ ticketTypeId: types[0]?.id, workflowId: copy.json().workflow.id }],
      },
    });
    refused(map.json(), 'workflows_per_map', 1);
  });

  it('[CORE-026] refuses statuses, visibility levels, grants and options beyond their limits', async () => {
    const workflows = (await admin({ method: 'GET', url: '/api/v1/workflows' })).json()
      .workflows as { id: number }[];
    const definition = (
      await admin({ method: 'GET', url: `/api/v1/workflows/${workflows[0]?.id}` })
    ).json().workflow.published.definition as { statuses: unknown[] };
    await setLimit('statuses_per_workflow', 1);
    if (definition.statuses.length > 1) {
      const draft = await admin({
        method: 'PUT',
        url: `/api/v1/workflows/${workflows[0]?.id}/draft`,
        payload: { definition },
      });
      refused(draft.json(), 'statuses_per_workflow', 1);
    }

    await setLimit('visibility_levels_per_track', 1);
    const policy = await admin({
      method: 'POST',
      url: '/api/v1/visibility-policies',
      payload: { name: 'Levels', levels: [{ name: 'Staff' }] },
    });
    expect(policy.statusCode, policy.body).toBe(201);
    const level = await admin({
      method: 'POST',
      url: `/api/v1/visibility-policies/${policy.json().visibilityPolicy.id}/levels`,
      payload: { name: 'Board' },
    });
    refused(level.json(), 'visibility_levels_per_track', 1);

    await setLimit('grants_per_permission', 1);
    const access = await admin({
      method: 'POST',
      url: '/api/v1/access-policies',
      payload: { name: 'Grants' },
    });
    const roles = (await admin({ method: 'GET', url: '/api/v1/roles' })).json().roles as {
      id: number;
    }[];
    const grant = (roleId: number) =>
      admin({
        method: 'POST',
        url: `/api/v1/access-policies/${access.json().policy.id}/grants`,
        payload: { permission: 'browse_track', grantee: 'role', roleId },
      });
    expect((await grant(roles[0]?.id as number)).statusCode).toBe(201);
    refused((await grant(roles[1]?.id as number)).json(), 'grants_per_permission', 1);

    await setLimit('options_per_field', 2);
    const field = await admin({
      method: 'POST',
      url: '/api/v1/fields',
      payload: { name: 'Region', type: 'select', context: { options: [{ value: 'North' }] } },
    });
    expect(field.statusCode, field.body).toBe(201);
    const made = field.json().field as { id: number; contexts: { id: number }[] };
    const option = (value: string) =>
      admin({
        method: 'POST',
        url: `/api/v1/fields/${made.id}/contexts/${made.contexts[0]?.id}/options`,
        payload: { value },
      });
    expect((await option('South')).statusCode).toBe(201);
    refused((await option('East')).json(), 'options_per_field', 2);
  });

  it('[CORE-026] refuses a field that would give a track more fields than its limit', async () => {
    const before = (await guardrails()).get('fields_per_track')?.usage.value ?? 0;
    await setLimit('fields_per_track', before + 1);
    const add = (name: string) =>
      admin({ method: 'POST', url: '/api/v1/fields', payload: { name, type: 'text' } });
    expect((await add('Customer')).statusCode).toBe(201);
    refused((await add('Contract')).json(), 'fields_per_track', before + 1);
    // A field for another track only still fits.
    const other = await admin({
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'GRE', name: 'Other', mode: 'shared' },
    });
    expect(other.statusCode).toBe(201);
    await setLimit('fields_per_track', before + 2);
    const scoped = await admin({
      method: 'POST',
      url: '/api/v1/fields',
      payload: {
        name: 'Contract',
        type: 'text',
        context: { trackIds: [other.json().track.id as number] },
      },
    });
    expect(scoped.statusCode, scoped.body).toBe(201);
    expect((await guardrails()).get('fields_per_track')?.usage.value).toBe(before + 2);
  });
});
