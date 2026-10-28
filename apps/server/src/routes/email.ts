import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireGlobal } from '../auth';
import { unsubscribeHash } from '../email/deliver';
import { diff, emit } from '../events/bus';

/**
 * Email notification settings and unsubscribe links (M1-057; NTF-002).
 *
 * - `GET`/`PUT /api/v1/admin/email-settings`: the batch window and digest hour, and whether an
 *   SMTP server is configured (`TASKMOOR_SMTP_URL`; its password only in the environment).
 * - `GET /api/v1/unsubscribe?token=`: what a link would turn off, changing nothing (mail
 *   scanners open links). `POST` with the same token turns it off: one-click from the mail
 *   client (RFC 8058) or the confirmation page `#/unsubscribe`. No sign-in: the random token,
 *   stored as a hash, is the proof. A link names one event (its email turns off) or all email
 *   (email delivery turns off); using it again changes nothing.
 */
const settingsBody = z
  .object({
    batchWindowSeconds: z.number().int().min(0).max(3600),
    digestHour: z.number().int().min(0).max(23),
  })
  .partial()
  .strict();
const tokenQuery = z.object({ token: z.string().min(16).max(100) }).strict();

const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });

export async function registerEmailRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { smtpConfigured: boolean },
): Promise<void> {
  const by = (request: FastifyRequest, actorId: number | null = request.user?.id ?? null) => ({
    workspaceId: request.workspaceId,
    actorId,
  });

  async function settingsOf(workspaceId: number) {
    const row = await db
      .selectFrom('email_setting')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return {
      batchWindowSeconds: row?.batch_window_seconds ?? 120,
      digestHour: row?.digest_hour ?? 8,
      smtpConfigured: options.smtpConfigured,
    };
  }

  app.get('/api/v1/admin/email-settings', async (request, reply) => {
    if (!(await requireGlobal(request, reply, 'site_admin'))) return reply;
    return { emailSettings: await settingsOf(request.workspaceId) };
  });

  app.put('/api/v1/admin/email-settings', async (request, reply) => {
    if (!(await requireGlobal(request, reply, 'site_admin'))) return reply;
    const parsed = settingsBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    await db.transaction().execute(async (trx) => {
      const was = await trx
        .selectFrom('email_setting')
        .selectAll()
        .where('workspace_id', '=', ws)
        .forUpdate()
        .executeTakeFirst();
      const changes = diff<Record<string, unknown>>(
        {
          batchWindowSeconds: was?.batch_window_seconds ?? 120,
          digestHour: was?.digest_hour ?? 8,
        },
        body,
      );
      if (Object.keys(changes).length === 0) return;
      await trx
        .insertInto('email_setting')
        .values({
          workspace_id: ws,
          batch_window_seconds: body.batchWindowSeconds ?? was?.batch_window_seconds ?? 120,
          digest_hour: body.digestHour ?? was?.digest_hour ?? 8,
        })
        .onConflict((oc) =>
          oc.column('workspace_id').doUpdateSet({
            ...(body.batchWindowSeconds !== undefined
              ? { batch_window_seconds: body.batchWindowSeconds }
              : {}),
            ...(body.digestHour !== undefined ? { digest_hour: body.digestHour } : {}),
            updated_at: new Date(),
          }),
        )
        .execute();
      await emit(trx, by(request), {
        type: 'email_settings.updated',
        subjectId: ws,
        payload: { changes },
      });
    });
    return { emailSettings: await settingsOf(ws) };
  });

  /** The link a token names, or null for an unknown one. */
  async function linkOf(token: string) {
    return db
      .selectFrom('email_unsubscribe as e')
      .innerJoin('app_user as u', 'u.id', 'e.user_id')
      .select(['e.token_hash', 'e.workspace_id', 'e.user_id', 'e.event', 'e.used_at', 'u.email'])
      .where('e.token_hash', '=', unsubscribeHash(token))
      .executeTakeFirst();
  }

  /** An address shown only in part: enough to recognise, too little to harvest. */
  const masked = (email: string) => email.replace(/^(.).*(@.*)$/, '$1…$2');

  app.get('/api/v1/unsubscribe', async (request, reply) => {
    const parsed = tokenQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const link = await linkOf(parsed.data.token);
    if (!link) return reply.code(404).send({ error: 'not_found' });
    return {
      unsubscribe: { event: link.event, email: masked(link.email), used: link.used_at !== null },
    };
  });

  // Mail clients post the one-click form (RFC 8058). Only this route takes that body, and it
  // ignores it: the rest of the API stays JSON-only, which keeps cross-site forms out.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 1024 },
      (_request, _body, done) => done(null, {}),
    );
    scope.post('/api/v1/unsubscribe', unsubscribe);
  });

  async function unsubscribe(request: FastifyRequest, reply: FastifyReply) {
    const parsed = tokenQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const link = await linkOf(parsed.data.token);
    if (!link) return reply.code(404).send({ error: 'not_found' });
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('email_unsubscribe')
        .set({ used_at: new Date() })
        .where('token_hash', '=', link.token_hash)
        .execute();
      let changes: Record<string, { from: unknown; to: unknown }> = {};
      if (link.event === null) {
        const pref = await trx
          .selectFrom('user_preference')
          .select('email_delivery')
          .where('user_id', '=', link.user_id)
          .executeTakeFirst();
        const was = pref?.email_delivery ?? 'instant';
        if (was === 'off') return;
        await trx
          .insertInto('user_preference')
          .values({ user_id: link.user_id, workspace_id: link.workspace_id, email_delivery: 'off' })
          .onConflict((oc) =>
            oc.column('user_id').doUpdateSet({ email_delivery: 'off', updated_at: new Date() }),
          )
          .execute();
        changes = { emailDelivery: { from: was, to: 'off' } };
      } else {
        const had = await trx
          .selectFrom('notification_preference')
          .select('enabled')
          .where('user_id', '=', link.user_id)
          .where('event', '=', link.event)
          .where('channel', '=', 'email')
          .executeTakeFirst();
        if (had && !had.enabled) return;
        await trx
          .insertInto('notification_preference')
          .values({
            user_id: link.user_id,
            workspace_id: link.workspace_id,
            event: link.event,
            channel: 'email',
            enabled: false,
          })
          .onConflict((oc) =>
            oc.columns(['user_id', 'event', 'channel']).doUpdateSet({ enabled: false }),
          )
          .execute();
        changes = { [`${link.event}.email`]: { from: true, to: false } };
      }
      // The person acts through their link: the event is theirs.
      await emit(
        trx,
        { workspaceId: link.workspace_id, actorId: link.user_id },
        { type: 'user.preferences_updated', subjectId: link.user_id, payload: { changes } },
      );
    });
    return { unsubscribed: { event: link.event } };
  }
}
