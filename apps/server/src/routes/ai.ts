import {
  AI_FEATURES,
  AiError,
  AiProviderError,
  CLAUDE_MODELS,
  DEFAULT_MODEL,
  EFFORTS,
  redactSecrets,
} from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  credentialSummaries,
  openCredentials,
  removeCredential,
  storeCredential,
} from '../ai/credentials';
import type { KeyStorage } from '../ai/keyring';
import { type AiService, AiUnavailableError } from '../ai/service';
import {
  aiSettingsInput,
  CREDENTIAL_SLOTS,
  type CredentialSlot,
  checkProvider,
  PROVIDER_IDS,
  PROVIDER_SLOTS,
  providerSettings,
  REQUIRED_SLOTS,
  readAiSettings,
  type StoredAiSettings,
  scopeBlock,
  updateAiSettings,
} from '../ai/settings';
import { requireSiteAdmin } from '../auth';
import { emit } from '../events/bus';
import { diff } from '../events/catalogue';

const slotParams = z.object({ slot: z.enum(CREDENTIAL_SLOTS) }).strict();
const idParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) }).strict();
/** A pasted key: surrounding white space is dropped; inside, no spaces or control characters. */
const credentialValue = z
  .string()
  .trim()
  .min(1)
  .max(8000)
  .regex(/^[\x21-\x7e]+$/, 'printable characters without spaces');
const credentialBody = z.object({ value: credentialValue }).strict();
const trackBody = z.object({ enabled: z.boolean().nullable() }).strict();
const testBody = z
  .object({
    provider: providerSettings.optional(),
    credentials: z.partialRecord(z.enum(CREDENTIAL_SLOTS), credentialValue).default({}),
  })
  .strict();
const featuresQuery = z
  .object({ trackId: z.coerce.number().int().positive().max(2_147_483_647).optional() })
  .strict();

/** How long "test connection" waits for the provider. */
const TEST_TIMEOUT_MS = 20_000;

export interface AiRouteOptions {
  ai: AiService;
  keyStorage: KeyStorage;
}

/** The settings a change event compares: everything an administrator sets on the page. */
const comparable = (s: StoredAiSettings) => ({
  enabled: s.enabled,
  strict: s.strict,
  provider: s.provider,
  features: s.features,
});

/**
 * AI settings for site administrators (M1-075, M1-076; AI-001, AI-006, IAM-019, IAM-020;
 * ADR-098, ADR-099). Credentials are write-only: they can be set, replaced and removed, and every
 * answer shows only their last four characters.
 *
 * - `GET /api/v1/admin/ai`: the settings, the stored credentials (slot, last four, source, who
 *   and when), where their keys are wrapped, what each provider takes, the features with their
 *   default effort, the models and efforts to choose from, and every track with its switch;
 * - `PUT /api/v1/admin/ai`: the workspace switch, strict mode, the provider's settings (no keys)
 *   and each feature's switch, model and effort;
 * - `PUT /api/v1/admin/ai/credentials/:slot`, `DELETE`: set or replace a credential (rotation:
 *   new calls use it at once, calls in flight finish on the old one), or remove it;
 * - `PUT /api/v1/admin/ai/tracks/:id`: a track's switch (`true` opts it in under strict mode,
 *   `false` turns AI off there, `null` back to the default);
 * - `POST /api/v1/admin/ai/test`: "test connection" with the saved settings, or with the
 *   provider settings and keys given (not saved): the models the provider lists right now, or
 *   its error message without any key in it;
 * - `GET /api/v1/ai/features?trackId=`: for anyone signed in, which AI features they may use
 *   there, so the app shows AI controls only where calls would be accepted.
 */
export function registerAiRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: AiRouteOptions,
): void {
  const { ai } = options;

  async function adminView(workspaceId: number) {
    const current = await readAiSettings(db, workspaceId);
    const tracks = await db
      .selectFrom('track')
      .select(['id', 'key', 'name'])
      .where('workspace_id', '=', workspaceId)
      .where('archived_at', 'is', null)
      .where('deleted_at', 'is', null)
      .orderBy('key')
      .execute();
    return {
      settings: current.settings,
      credentials: await credentialSummaries(db, workspaceId),
      keyStorage: options.keyStorage,
      environmentImportedAt: current.environmentImportedAt?.toISOString() ?? null,
      updatedAt: current.updatedAt?.toISOString() ?? null,
      providers: PROVIDER_IDS.map((id) => ({
        id,
        slots: PROVIDER_SLOTS[id],
        required: REQUIRED_SLOTS[id],
      })),
      features: Object.entries(AI_FEATURES).map(([id, spec]) => ({
        id,
        effort: spec.effort,
        output: spec.output,
      })),
      models: [...CLAUDE_MODELS],
      defaultModel: DEFAULT_MODEL,
      efforts: [...EFFORTS],
      tracks: tracks.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        enabled: current.settings.tracks[String(t.id)] ?? null,
        /** Whether AI may run there, by the workspace switch, strict mode and its own switch. */
        on: scopeBlock(current.settings, t.id) === null,
      })),
    };
  }

  app.get('/api/v1/admin/ai', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return adminView(request.workspaceId);
  });

  app.put('/api/v1/admin/ai', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = aiSettingsInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const input = parsed.data;
    if (input.provider) {
      const problems = checkProvider(input.provider);
      if (problems.length > 0) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', fields: { provider: 'invalid_provider' }, problems });
      }
    }
    const workspaceId = request.workspaceId;
    await db.transaction().execute(async (trx) => {
      const { before, after } = await updateAiSettings(trx, workspaceId, admin.id, (current) => ({
        ...current,
        enabled: input.enabled,
        strict: input.strict,
        provider: input.provider,
        features: input.features,
      }));
      await emit(
        trx,
        { workspaceId, actorId: admin.id },
        {
          type: 'ai.settings_updated',
          subjectId: workspaceId,
          payload: { changes: diff(comparable(before), comparable(after)) },
        },
      );
    });
    return adminView(workspaceId);
  });

  app.put('/api/v1/admin/ai/credentials/:slot', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = slotParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const body = credentialBody.safeParse(request.body);
    // Never echo what was sent: it may be a key.
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', fields: { value: 'invalid_key' } });
    }
    if (!ai.ring.active) return reply.code(409).send({ error: 'key_storage_unavailable' });
    const workspaceId = request.workspaceId;
    const slot = params.data.slot;
    await db.transaction().execute(async (trx) => {
      const stored = await storeCredential(trx, ai.ring, {
        workspaceId,
        slot,
        value: body.data.value,
        source: 'admin',
        actorId: admin.id,
      });
      await emit(
        trx,
        { workspaceId, actorId: admin.id },
        {
          type: 'ai.credential_set',
          subjectId: workspaceId,
          payload: { slot, last4: stored.last4, replaced: stored.replaced, source: 'admin' },
        },
      );
    });
    const credential = (await credentialSummaries(db, workspaceId)).find((c) => c.slot === slot);
    return { credential };
  });

  app.delete('/api/v1/admin/ai/credentials/:slot', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = slotParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const workspaceId = request.workspaceId;
    const slot = params.data.slot;
    const removed = await db.transaction().execute(async (trx) => {
      const gone = await removeCredential(trx, workspaceId, slot, admin.id);
      if (gone) {
        await emit(
          trx,
          { workspaceId, actorId: admin.id },
          { type: 'ai.credential_deleted', subjectId: workspaceId, payload: { slot } },
        );
      }
      return gone;
    });
    if (!removed) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.put('/api/v1/admin/ai/tracks/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const body = trackBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const workspaceId = request.workspaceId;
    const track = await db
      .selectFrom('track')
      .select(['id', 'key'])
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', params.data.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!track) return reply.code(404).send({ error: 'not_found' });
    const enabled = body.data.enabled;
    await db.transaction().execute(async (trx) => {
      await updateAiSettings(trx, workspaceId, admin.id, (current) => {
        const tracks = { ...current.tracks };
        if (enabled === null) delete tracks[String(track.id)];
        else tracks[String(track.id)] = enabled;
        return { ...current, tracks };
      });
      await emit(
        trx,
        { workspaceId, actorId: admin.id },
        { type: 'ai.track_switched', subjectId: track.id, payload: { key: track.key, enabled } },
      );
    });
    const view = await adminView(workspaceId);
    return { track: view.tracks.find((t) => t.id === track.id) ?? null };
  });

  app.post('/api/v1/admin/ai/test', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const body = testBody.safeParse(request.body ?? {});
    // Never echo what was sent: it may hold keys.
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const workspaceId = request.workspaceId;
    const current = await readAiSettings(db, workspaceId);
    const provider = body.data.provider ?? current.settings.provider;
    if (!provider) {
      return {
        ok: false,
        error: { kind: 'not_configured', message: 'Choose a provider first.' },
      };
    }
    const problems = checkProvider(provider);
    if (problems.length > 0) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', fields: { provider: 'invalid_provider' }, problems });
    }
    let credentials = new Map<CredentialSlot, string>();
    try {
      credentials = await openCredentials(db, ai.ring, workspaceId);
    } catch {
      // Keys sealed under another master key: the ones given here may still be enough.
    }
    for (const [slot, value] of Object.entries(body.data.credentials)) {
      if (value) credentials.set(slot as CredentialSlot, value);
    }
    const secrets = [...credentials.values()];
    try {
      const gateway = await ai.probe({ ...current.settings, provider, features: {} }, credentials);
      const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
      if (gateway.capabilities('summarize').modelListing) {
        // AI-001 (2): listed live by the provider, not from a list of our own.
        const models = await gateway.listModels({ signal });
        return {
          ok: true,
          models: models.map((m) => ({
            id: m.id,
            ...(m.displayName ? { displayName: m.displayName } : {}),
          })),
        };
      }
      // Platforms without a model listing: a token count proves the key and the address.
      await gateway.countTokens(
        {
          feature: 'summarize',
          system: 'Connection test.',
          messages: [{ role: 'user', content: 'Hello.' }],
        },
        { signal },
      );
      return { ok: true, models: null };
    } catch (error) {
      const kind =
        error instanceof AiUnavailableError
          ? error.reason
          : error instanceof AiProviderError
            ? error.kind
            : error instanceof AiError
              ? 'error'
              : 'unknown';
      // AI-001 (1): the provider's own message, with every key scrubbed out of it.
      const message = redactSecrets(
        error instanceof Error ? error.message : 'The connection test failed.',
        secrets,
      );
      return { ok: false, error: { kind, message } };
    }
  });

  app.get('/api/v1/ai/features', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    const query = featuresQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const workspaceId = request.workspaceId;
    const trackId = query.data.trackId;
    if (trackId !== undefined) {
      const track = await db
        .selectFrom('track')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', trackId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!track) return reply.code(404).send({ error: 'not_found' });
    }
    return { features: await ai.features(workspaceId, trackId ?? null) };
  });
}
