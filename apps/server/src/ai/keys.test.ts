import { randomBytes } from 'node:crypto';
import type { AdapterRequest, AdapterResponse, ProviderConfig, SecretStore } from '@taskmoor/ai';
import { AiProviderError } from '@taskmoor/ai';
import { FakeAdapter, FakeProviderFailure } from '@taskmoor/ai/testing';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword, pepperFromSecret, pepperRing } from '@taskmoor/iam';
import { FakeKeyService } from '@taskmoor/iam/testing';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { loadConfig } from '../config';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { openCredentials, rewrapCredentials } from './credentials';
import { importAiEnvironment } from './environment';
import { aiKeyRing } from './keyring';
import { type AdapterFactory, AiService, AiUnavailableError } from './service';
import { readAiSettings } from './settings';

const PASSWORD = 'harbour lantern willow';
/** Keys made at run time and shaped so no secret scanner mistakes them for real ones. */
const fakeKey = () => `fake-ai-key-${randomBytes(18).toString('hex')}`;
const masterKey = () => randomBytes(32).toString('base64url');
const ending = (key: string) => key.slice(-4);

let address = 0;
const nextAddress = () => `100.82.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

/**
 * A provider in process: it accepts the keys it was given, answers after a short random delay
 * and records which key each call used. `revoke` turns a key away, as the provider's console
 * would after a rotation.
 */
class FakeProvider {
  readonly accepted = new Set<string>();
  readonly used: { key: string; at: number }[] = [];

  factory: AdapterFactory = async (config: ProviderConfig, secrets: SecretStore) => {
    const ref = 'apiKey' in config ? config.apiKey : undefined;
    const key = ref ? await secrets.reveal(ref) : '';
    const provider = this;
    return new (class extends FakeAdapter {
      override async generate(request: AdapterRequest): Promise<AdapterResponse> {
        // The provider checks the key when the request arrives, then takes its time.
        if (!provider.accepted.has(key)) {
          throw new FakeProviderFailure(
            'authentication',
            `invalid x-api-key: ${key} was not accepted`,
            401,
          );
        }
        await new Promise((r) => setTimeout(r, 1 + Math.floor(Math.random() * 12)));
        provider.used.push({ key, at: Date.now() });
        return super.generate(request);
      }
    })([{ text: 'ok' }], { secretValues: [key] });
  };
}

function sessionCookie(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    list
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
      ?.split(';')[0] ?? ''
  );
}

describe('AI key storage (M1-075; IAM-020, AI-001; ADR-098)', () => {
  const database = useMigratedDatabase();
  const provider = new FakeProvider();
  const testMaster = masterKey();
  const keys = aiKeyRing({ masterKey: testMaster });
  /** Everything the server logged, at trace level. */
  const logLines: string[] = [];
  /** Every answer the API gave in these tests. */
  const answers: string[] = [];
  /** Every key these tests used, so the leak checks look for each. */
  const used: string[] = [];
  let app: FastifyInstance;
  let admin = '';
  let member = '';

  const call = async (options: InjectOptions) => {
    const res = await app.inject({ remoteAddress: nextAddress(), ...options });
    answers.push(`${JSON.stringify(res.headers)}\n${res.body}`);
    return res;
  };
  const asAdmin = (options: InjectOptions) =>
    call({ ...options, headers: { cookie: admin, ...options.headers } });
  const newKey = () => {
    const key = fakeKey();
    used.push(key);
    return key;
  };
  const generate = () =>
    (app.ai?.service as AiService).use(1, (gateway) =>
      gateway.generate({
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

  async function deliverEvents(): Promise<void> {
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'ai-keys-test');
    bus.attach(runner);
    while ((await bus.relayOnce()) > 0) {}
    while ((await runner.runOnce()) > 0) {}
  }

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      logLevel: 'trace',
      logStream: { write: (line) => void logLines.push(line) },
      aiKeys: keys,
      aiAdapterFactory: provider.factory,
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('[AI-001] (3) moves the environment key into sealed storage on first start, then ignores the environment', async () => {
    const key = newKey();
    provider.accepted.add(key);
    const log: Record<string, unknown>[] = [];
    const env = loadConfig({
      DATABASE_URL: 'postgres://localhost/x',
      TASKMOOR_AI_PROVIDER: 'anthropic',
      TASKMOOR_AI_KEY: key,
    }).aiEnvironment;
    // Two API processes start at once: one moves the settings in.
    const outcomes = await Promise.all([
      importAiEnvironment(database.db, keys.ring, env, (e) => log.push(e)),
      importAiEnvironment(database.db, keys.ring, env, (e) => log.push(e)),
    ]);
    expect(outcomes.sort()).toEqual(['ignored', 'imported']);
    const stored = await readAiSettings(database.db, 1);
    expect(stored.settings).toMatchObject({ enabled: true, provider: { provider: 'anthropic' } });
    expect(stored.environmentImportedAt).not.toBeNull();
    // AI works with no UI step.
    expect((await generate()).text).toBe('ok');

    // A later start with another key in the environment changes nothing, and says so.
    const later = { ...env, key: fakeKey() };
    expect(await importAiEnvironment(database.db, keys.ring, later, (e) => log.push(e))).toBe(
      'ignored',
    );
    expect((await openCredentials(database.db, keys.ring, 1)).get('apiKey')).toBe(key);
    const text = JSON.stringify(log);
    expect(text).toContain('TASKMOOR_AI_KEY');
    for (const k of [key, later.key]) {
      expect(text).not.toContain(k);
      expect(text).not.toContain(ending(k));
    }

    const listed = await asAdmin({ method: 'GET', url: '/api/v1/admin/ai' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      settings: { enabled: true, provider: { provider: 'anthropic' } },
      credentials: [{ slot: 'apiKey', last4: ending(key), source: 'environment' }],
      keyStorage: 'master_key',
    });
  });

  it('[IAM-020] is write-only: set, replace and remove, showing only the last four characters', async () => {
    const key = newKey();
    const set = await asAdmin({
      method: 'PUT',
      url: '/api/v1/admin/ai/credentials/apiKey',
      payload: { value: `  ${key}\n` },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().credential).toMatchObject({
      slot: 'apiKey',
      last4: ending(key),
      source: 'admin',
      updatedBy: { name: 'Ada' },
    });
    // The row holds ciphertext, a wrapped data key and the master key's id, never the key.
    const row = await database.db
      .selectFrom('ai_credential')
      .selectAll()
      .where('slot', '=', 'apiKey')
      .executeTakeFirstOrThrow();
    expect(row.kek_id).toBe(keys.ring.active?.id);
    expect(JSON.stringify(row)).not.toContain(key);
    expect((await openCredentials(database.db, keys.ring, 1)).get('apiKey')).toBe(key);

    // Short secrets show nothing at all; bad input is refused without being echoed.
    const short = 'short-0123';
    const shortSet = await asAdmin({
      method: 'PUT',
      url: '/api/v1/admin/ai/credentials/sessionToken',
      payload: { value: short },
    });
    expect(shortSet.json().credential.last4).toBe('');
    const spaced = `${fakeKey()} ${fakeKey()}`;
    const refused = await asAdmin({
      method: 'PUT',
      url: '/api/v1/admin/ai/credentials/apiKey',
      payload: { value: spaced },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).not.toContain(spaced.slice(0, 20));
    expect(
      (
        await asAdmin({
          method: 'PUT',
          url: '/api/v1/admin/ai/credentials/password',
          payload: { value: key },
        })
      ).statusCode,
    ).toBe(404);
    // Only site administrators, and nobody reads it back.
    const asMember = await call({
      method: 'PUT',
      url: '/api/v1/admin/ai/credentials/apiKey',
      payload: { value: fakeKey() },
      headers: { cookie: member },
    });
    expect(asMember.statusCode).toBe(403);
    expect(
      (await call({ method: 'GET', url: '/api/v1/admin/ai', headers: { cookie: member } }))
        .statusCode,
    ).toBe(403);

    const removed = await asAdmin({
      method: 'DELETE',
      url: '/api/v1/admin/ai/credentials/sessionToken',
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await asAdmin({ method: 'DELETE', url: '/api/v1/admin/ai/credentials/sessionToken' }))
        .statusCode,
    ).toBe(404);
    const after = await asAdmin({ method: 'GET', url: '/api/v1/admin/ai' });
    expect(after.json().credentials.map((c: { slot: string }) => c.slot)).toEqual(['apiKey']);
    provider.accepted.add(key);
  });

  it('[IAM-020] (2) rotation under load: new calls take the new key, calls in flight finish, 0 fail', async () => {
    const before = (await openCredentials(database.db, keys.ring, 1)).get('apiKey') ?? '';
    provider.accepted.add(before);
    const next = newKey();
    provider.accepted.add(next);
    provider.used.length = 0;
    let failures = 0;
    let calls = 0;
    let stop = false;
    let revokedAt = Number.POSITIVE_INFINITY;
    const worker = async () => {
      while (!stop) {
        calls += 1;
        try {
          await generate();
        } catch (error) {
          failures += 1;
          throw error;
        }
      }
    };
    const load = Promise.all(Array.from({ length: 16 }, worker));
    await new Promise((r) => setTimeout(r, 150));
    const version = (await readAiSettings(database.db, 1)).version;
    const rotated = await asAdmin({
      method: 'PUT',
      url: '/api/v1/admin/ai/credentials/apiKey',
      payload: { value: next },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().credential.last4).toBe(ending(next));
    // Calls that started on the old key finish on it; then the provider may revoke it.
    await (app.ai?.service as AiService).drained(1, version + 1);
    expect((app.ai?.service as AiService).inFlightOnRetired(1)).toBe(0);
    provider.accepted.delete(before);
    revokedAt = Date.now();
    await new Promise((r) => setTimeout(r, 150));
    stop = true;
    await load;

    expect(failures).toBe(0);
    expect(calls).toBeGreaterThan(100);
    const withOld = provider.used.filter((u) => u.key === before);
    const withNew = provider.used.filter((u) => u.key === next);
    expect(withOld.length).toBeGreaterThan(0);
    expect(withNew.length).toBeGreaterThan(0);
    // Every call on the old key had finished when it was revoked; calls went on with the new one.
    expect(withOld.every((u) => u.at <= revokedAt)).toBe(true);
    expect(withNew.filter((u) => u.at > revokedAt).length).toBeGreaterThan(0);
  });

  it('[IAM-020] (1) no key reaches the logs, API answers, events or audit log, even in provider errors', async () => {
    // A provider error that quotes the key: the gateway scrubs it before anyone sees it.
    const rejected = newKey();
    const set = await asAdmin({
      method: 'PUT',
      url: '/api/v1/admin/ai/credentials/apiKey',
      payload: { value: rejected },
    });
    expect(set.statusCode).toBe(200);
    const error = await generate().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as Error).message).toContain('[redacted]');
    expect((error as Error).message).not.toContain(rejected);
    app.log.warn({ err: error }, 'AI call failed');

    await deliverEvents();
    const events = await database.db.selectFrom('domain_event').selectAll().execute();
    const audit = await database.db.selectFrom('audit_event').selectAll().execute();
    const credentialEvents = events.filter((e) => e.type.startsWith('ai.credential_'));
    expect(credentialEvents.map((e) => e.type)).toEqual([
      'ai.credential_set',
      'ai.credential_set',
      'ai.credential_set',
      'ai.credential_deleted',
      'ai.credential_set',
      'ai.credential_set',
    ]);
    expect(audit.filter((a) => JSON.stringify(a).includes('ai.credential_set')).length).toBe(
      events.filter((e) => e.type === 'ai.credential_set').length,
    );

    const logs = logLines.join('\n');
    expect(logs).toContain('/api/v1/admin/ai/credentials/apiKey');
    const haystacks = {
      logs,
      answers: answers.join('\n'),
      events: JSON.stringify(events),
      audit: JSON.stringify(audit),
    };
    expect(used.length).toBe(4);
    for (const key of used) {
      for (const [where, text] of Object.entries(haystacks)) {
        expect(text.includes(key), `a key ending ${ending(key)} is in the ${where}`).toBe(false);
      }
    }
  });

  it('[IAM-020] rotates the master key: data keys are re-wrapped at start, the old key can then go', async () => {
    const before = await openCredentials(database.db, keys.ring, 1);
    expect(before.size).toBeGreaterThan(0);
    const next = masterKey();
    // The next start: the new key in TASKMOOR_MASTER_KEY, the old one in _PREVIOUS.
    const during = aiKeyRing({ masterKey: next, previousMasterKeys: [testMaster] });
    expect(await rewrapCredentials(database.db, during.ring)).toEqual({
      rewrapped: before.size,
      unreadable: 0,
    });
    expect(await rewrapCredentials(database.db, during.ring)).toEqual({
      rewrapped: 0,
      unreadable: 0,
    });
    // Then the old key can be dropped: everything opens with the new one alone.
    const after = aiKeyRing({ masterKey: next });
    expect(await openCredentials(database.db, after.ring, 1)).toEqual(before);
    // A server with neither key cannot open them, and says why without naming a value.
    const stranger = new AiService(database.db, {
      ring: aiKeyRing({ masterKey: masterKey() }).ring,
    });
    const refused = await stranger.use(1, async () => 'never').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AiUnavailableError);
    expect(refused).toMatchObject({ reason: 'key_unreadable' });
    const stuck = aiKeyRing({ masterKey: masterKey() });
    expect(await rewrapCredentials(database.db, stuck.ring)).toEqual({
      rewrapped: 0,
      unreadable: before.size,
    });
    // Back to the tests' own key.
    await rewrapCredentials(
      database.db,
      aiKeyRing({ masterKey: testMaster, previousMasterKeys: [next] }).ring,
    );
  });

  it('[IAM-020] wraps data keys with a key service when one is plugged in, or the pepper without a master key', async () => {
    const kms = new FakeKeyService({ kind: 'kms', keyRef: 'alias/taskmoor-test' });
    const viaKms = aiKeyRing({ masterKey: masterKey(), external: kms });
    expect(viaKms.storage).toBe('kms');
    expect(viaKms.ring.active?.id).toBe('kms:alias/taskmoor-test');
    const pepper = pepperFromSecret(randomBytes(32));
    const viaPepper = aiKeyRing({ peppers: pepperRing(pepper) });
    expect(viaPepper.storage).toBe('pepper');
    expect(viaPepper.ring.active?.id).toBe(`pepper:${pepper.id}`);
    // Neither: the API says credentials cannot be stored, and the environment key stays out.
    const none = aiKeyRing({});
    expect(none.storage).toBe('none');
    const bare = await buildApp({ db: database.db, version: 'test', roles: ['api'], aiKeys: none });
    try {
      const res = await bare.inject({
        method: 'PUT',
        url: '/api/v1/admin/ai/credentials/apiKey',
        payload: { value: fakeKey() },
        headers: { cookie: admin },
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'key_storage_unavailable' });
    } finally {
      await bare.close();
    }
  });
});
