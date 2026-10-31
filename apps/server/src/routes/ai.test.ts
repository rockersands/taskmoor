import { randomBytes } from 'node:crypto';
import type { AdapterRequest, AdapterResponse } from '@taskmoor/ai';
import { FakeAdapter, FakeProviderServer } from '@taskmoor/ai/testing';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiKeyRing } from '../ai/keyring';
import { type AdapterFactory, type AiService, AiUnavailableError } from '../ai/service';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'harbour lantern willow';
/** Keys made at run time, shaped so no secret scanner mistakes them for real ones. */
const fakeKey = () => `fake-ai-key-${randomBytes(18).toString('hex')}`;
let address = 0;
const nextAddress = () => `100.83.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

function sessionCookie(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    list
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
      ?.split(';')[0] ?? ''
  );
}

/**
 * The AI settings (M1-076; AI-001, AI-006, IAM-019; ADR-099). Two servers on one database: one
 * with the gateway's real Anthropic adapter against a provider on a local port that answers
 * from the recorded fixtures (test connection), one with a scripted adapter that records each
 * request's model and effort (defaults, switches, strict mode).
 */
describe('AI settings (M1-076)', () => {
  const database = useMigratedDatabase();
  const keys = aiKeyRing({ masterKey: randomBytes(32).toString('base64url') });
  const provider = new FakeProviderServer();
  const sent: AdapterRequest[] = [];
  const scripted: AdapterFactory = async () =>
    new (class extends FakeAdapter {
      override async generate(request: AdapterRequest): Promise<AdapterResponse> {
        sent.push(request);
        return super.generate(request);
      }
    })([{ text: 'ok' }]);
  let base = '';
  let app: FastifyInstance;
  let scriptedApp: FastifyInstance;
  let admin = '';
  let member = '';
  let web = 0;
  let ops = 0;

  const call = (options: InjectOptions, on = app) =>
    on.inject({ remoteAddress: nextAddress(), ...options });
  const asAdmin = (options: InjectOptions, on = app) =>
    call({ ...options, headers: { cookie: admin, ...options.headers } }, on);
  const save = (settings: Record<string, unknown>) =>
    asAdmin({
      method: 'PUT',
      url: '/api/v1/admin/ai',
      payload: { enabled: true, strict: false, features: {}, ...settings },
    });
  const features = async (cookie: string, trackId?: number) => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/ai/features${trackId ? `?trackId=${trackId}` : ''}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().features as Record<string, { available: boolean; reason?: string }>;
  };
  const summarize = (trackId?: number) =>
    (scriptedApp.ai as AiService).call(
      { workspaceId: 1, trackId: trackId ?? null, feature: 'summarize' },
      (g) =>
        g.generate({
          feature: 'summarize',
          system: 'Summarise.',
          messages: [{ role: 'user', content: 'A ticket.' }],
        }),
    );

  async function signIn(email: string): Promise<string> {
    const res = await call({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return sessionCookie(res);
  }

  beforeAll(async () => {
    base = await provider.start();
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], aiKeys: keys });
    scriptedApp = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      aiKeys: keys,
      aiAdapterFactory: scripted,
    });
    const hash = await hashPassword(PASSWORD);
    await database.db
      .insertInto('app_user')
      .values([
        { workspace_id: 1, email: 'ada@example.com', name: 'Ada', password_hash: hash },
        { workspace_id: 1, email: 'bo@example.com', name: 'Bo', password_hash: hash },
      ])
      .execute();
    await database.db
      .updateTable('app_user')
      .set({ is_site_admin: true })
      .where('email', '=', 'ada@example.com')
      .execute();
    admin = await signIn('ada@example.com');
    member = await signIn('bo@example.com');
    for (const [key, name] of [
      ['WEB', 'Website'],
      ['OPS', 'Operations'],
    ] as const) {
      const res = await asAdmin({
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name, mode: 'shared' },
      });
      expect(res.statusCode, res.body).toBe(201);
      if (key === 'WEB') web = res.json().track.id;
      else ops = res.json().track.id;
    }
  });

  afterAll(async () => {
    await app.close();
    await scriptedApp.close();
    await provider.stop();
  });

  it('[AI-001] starts with AI off and hidden: no provider, every feature unavailable', async () => {
    const view = await asAdmin({ method: 'GET', url: '/api/v1/admin/ai' });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      settings: { enabled: false, strict: false, provider: null, features: {}, tracks: {} },
      defaultModel: 'claude-opus-5-5',
      features: [
        { id: 'summarize', effort: 'low' },
        { id: 'query-from-text', effort: 'low' },
        { id: 'assisted-creation', effort: 'medium' },
        { id: 'duplicates', effort: 'low' },
      ],
      tracks: [
        { key: 'OPS', enabled: null, on: false },
        { key: 'WEB', enabled: null, on: false },
      ],
    });
    expect(Object.values(await features(member, web))).toEqual(
      Array(4).fill({ available: false, reason: 'disabled' }),
    );
    await expect(summarize(web)).rejects.toMatchObject({ reason: 'disabled' });
  });

  it('[AI-001] (2) test connection lists the models the provider offers, live; (1) a bad key fails with its message', async () => {
    const key = fakeKey();
    provider.accepted.add(key);
    // Not saved yet: the provider settings and key come with the test.
    const untested = await asAdmin({
      method: 'POST',
      url: '/api/v1/admin/ai/test',
      payload: { provider: { provider: 'anthropic', baseUrl: base }, credentials: { apiKey: key } },
    });
    expect(untested.statusCode, untested.body).toBe(200);
    expect(untested.json()).toEqual({
      ok: true,
      models: [
        { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
        { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
      ],
    });
    expect(provider.requests.at(-1)).toEqual({ method: 'GET', path: '/v1/models', accepted: true });

    // Saved, then tested with what is stored.
    expect((await save({ provider: { provider: 'anthropic', baseUrl: base } })).statusCode).toBe(
      200,
    );
    const stored = await asAdmin({
      method: 'PUT',
      url: '/api/v1/admin/ai/credentials/apiKey',
      payload: { value: key },
    });
    expect(stored.statusCode).toBe(200);
    const again = await asAdmin({ method: 'POST', url: '/api/v1/admin/ai/test', payload: {} });
    expect(again.json().models.map((m: { id: string }) => m.id)).toEqual([
      'claude-opus-5-5',
      'claude-haiku-5-5',
    ]);

    // A key the provider refuses: its message, which quotes the key, arrives scrubbed.
    const wrong = fakeKey();
    const refused = await asAdmin({
      method: 'POST',
      url: '/api/v1/admin/ai/test',
      payload: { credentials: { apiKey: wrong } },
    });
    expect(refused.json()).toMatchObject({ ok: false, error: { kind: 'authentication' } });
    expect(refused.json().error.message).toContain('invalid x-api-key [redacted]');
    for (const k of [key, wrong]) {
      expect(untested.body + again.body + refused.body).not.toContain(k);
    }
    // Keys never go into the provider settings themselves.
    const smuggled = await save({ provider: { provider: 'anthropic', apiKey: fakeKey() } });
    expect(smuggled.statusCode).toBe(400);
    expect(smuggled.json().problems).toEqual(['apiKey: set keys on their own route']);
    // Incomplete settings are refused by field, without values.
    const incomplete = await save({ provider: { provider: 'bedrock' } });
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json().fields).toEqual({ provider: 'invalid_provider' });
    // Only site administrators test or change anything.
    for (const options of [
      { method: 'POST', url: '/api/v1/admin/ai/test', payload: {} },
      {
        method: 'PUT',
        url: '/api/v1/admin/ai',
        payload: { enabled: true, strict: false, provider: null },
      },
      { method: 'PUT', url: `/api/v1/admin/ai/tracks/${web}`, payload: { enabled: true } },
    ] as InjectOptions[]) {
      expect((await call({ ...options, headers: { cookie: member } })).statusCode).toBe(403);
    }
  });

  it('[AI-006] (1) every feature defaults to claude-opus-5-5 with its effort; (3) a change to Haiku takes effect on the next call', async () => {
    sent.length = 0;
    await summarize(web);
    expect(sent.at(-1)).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' });
    expect(Object.values(await features(member, web)).every((f) => f.available)).toBe(true);

    const changed = await save({
      provider: { provider: 'anthropic', baseUrl: base },
      features: { summarize: { enabled: true, model: 'claude-haiku-5-5', effort: 'medium' } },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    await summarize(web);
    expect(sent.at(-1)).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' });
    expect(
      (
        await save({
          provider: { provider: 'anthropic', baseUrl: base },
          features: { summarize: { enabled: true, model: 'claude-opus-4' } },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('[AI-001] the workspace, track and feature switches hide the controls and block calls', async () => {
    const providerSettings = { provider: 'anthropic', baseUrl: base };
    // A feature off: hidden, and its calls refused before anything is sent.
    await save({ provider: providerSettings, features: { summarize: { enabled: false } } });
    expect((await features(member, web)).summarize).toEqual({
      available: false,
      reason: 'feature_off',
    });
    const before = sent.length;
    await expect(summarize(web)).rejects.toMatchObject({ reason: 'feature_off' });
    await save({ provider: providerSettings, features: {} });

    // A track off: only there.
    const off = await asAdmin({
      method: 'PUT',
      url: `/api/v1/admin/ai/tracks/${ops}`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().track).toMatchObject({ key: 'OPS', enabled: false, on: false });
    expect((await features(member, ops)).summarize).toEqual({
      available: false,
      reason: 'track_off',
    });
    expect((await features(member, web)).summarize).toEqual({ available: true });
    await expect(summarize(ops)).rejects.toBeInstanceOf(AiUnavailableError);
    await summarize(web);

    // The workspace off: everywhere.
    await save({ enabled: false, provider: providerSettings });
    expect((await features(member, web)).summarize).toMatchObject({ reason: 'disabled' });
    await expect(summarize(web)).rejects.toMatchObject({ reason: 'disabled' });
    expect(sent.length).toBe(before + 1);
    expect(
      (
        await call({
          method: 'GET',
          url: '/api/v1/ai/features?trackId=999999',
          headers: { cookie: member },
        })
      ).statusCode,
    ).toBe(404);
    expect((await call({ method: 'GET', url: '/api/v1/ai/features' })).statusCode).toBe(401);
  });

  it('[IAM-019] (2) strict mode keeps AI off and hidden until a track is opted in', async () => {
    const providerSettings = { provider: 'anthropic', baseUrl: base };
    await asAdmin({
      method: 'PUT',
      url: `/api/v1/admin/ai/tracks/${ops}`,
      payload: { enabled: null },
    });
    const strict = await save({ strict: true, provider: providerSettings });
    expect(strict.json().tracks).toMatchObject([
      { key: 'OPS', enabled: null, on: false },
      { key: 'WEB', enabled: null, on: false },
    ]);
    for (const trackId of [web, ops, undefined]) {
      expect((await features(member, trackId)).summarize).toEqual({
        available: false,
        reason: 'strict',
      });
    }
    await expect(summarize(web)).rejects.toMatchObject({ reason: 'strict' });
    await expect(summarize()).rejects.toMatchObject({ reason: 'strict' });

    await asAdmin({
      method: 'PUT',
      url: `/api/v1/admin/ai/tracks/${web}`,
      payload: { enabled: true },
    });
    expect((await features(member, web)).summarize).toEqual({ available: true });
    expect((await features(member, ops)).summarize).toMatchObject({ reason: 'strict' });
    expect((await summarize(web)).text).toBe('ok');
    await expect(summarize(ops)).rejects.toMatchObject({ reason: 'strict' });
    // Strict mode off: the opted-in track stays on, the others follow the workspace.
    await save({ strict: false, provider: providerSettings });
    expect((await features(member, ops)).summarize).toEqual({ available: true });
  });
});
