import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { credentialSummaries, removeCredential, storeCredential } from '../ai/credentials';
import type { KeyStorage } from '../ai/keyring';
import type { AiService } from '../ai/service';
import { CREDENTIAL_SLOTS, readAiSettings } from '../ai/settings';
import { requireSiteAdmin } from '../auth';
import { emit } from '../events/bus';

const slotParams = z.object({ slot: z.enum(CREDENTIAL_SLOTS) }).strict();
/** A pasted key: surrounding white space is dropped; inside, no spaces or control characters. */
const credentialBody = z
  .object({
    value: z
      .string()
      .trim()
      .min(1)
      .max(8000)
      .regex(/^[\x21-\x7e]+$/, 'printable characters without spaces'),
  })
  .strict();

export interface AiRouteOptions {
  ai: AiService;
  keyStorage: KeyStorage;
}

/**
 * AI provider settings for site administrators (M1-075; AI-001, IAM-020; ADR-098). Credentials
 * are write-only: they can be set, replaced and removed, and every answer shows only their last
 * four characters.
 *
 * - `GET /api/v1/admin/ai`: the settings, which credentials are stored (slot, last four, where it
 *   came from, who set it when) and where their keys are wrapped;
 * - `PUT /api/v1/admin/ai/credentials/:slot`: set or replace one (rotation: new calls use the new
 *   one at once, calls in flight finish on the old one);
 * - `DELETE /api/v1/admin/ai/credentials/:slot`: remove one.
 */
export function registerAiRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: AiRouteOptions,
): void {
  const { ai } = options;

  app.get('/api/v1/admin/ai', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const workspaceId = request.workspaceId;
    const current = await readAiSettings(db, workspaceId);
    return {
      settings: current.settings,
      credentials: await credentialSummaries(db, workspaceId),
      keyStorage: options.keyStorage,
      environmentImportedAt: current.environmentImportedAt?.toISOString() ?? null,
      updatedAt: current.updatedAt?.toISOString() ?? null,
    };
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
}
