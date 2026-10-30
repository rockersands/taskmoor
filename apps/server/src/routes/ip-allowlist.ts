import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { presentedToken, requireSiteAdmin, resolveSession } from '../auth';
import { emit } from '../events/bus';
import {
  type Allowlist,
  type Allowlists,
  matcher,
  parseRange,
  readAllowlist,
} from '../network/allowlist';
import { defaultWorkspaceId } from '../workspace';

/** Answers that stay open: probes, so a balancer can still tell the process is up. */
const OPEN_PATHS = new Set(['/health', '/ready']);

async function inGroups(
  db: Kysely<Database>,
  userId: number,
  groupIds: readonly number[],
): Promise<boolean> {
  if (groupIds.length === 0) return false;
  const row = await db
    .selectFrom('group_member')
    .select('user_id')
    .where('user_id', '=', userId)
    .where('group_id', 'in', [...groupIds])
    .executeTakeFirst();
  return row !== undefined;
}

function refuse(request: FastifyRequest, reply: FastifyReply) {
  if (request.url.startsWith('/api/')) {
    return reply.code(403).send({ error: 'ip_not_allowed', address: request.ip });
  }
  return reply
    .code(403)
    .header('content-type', 'text/plain; charset=utf-8')
    .send(`Access from ${request.ip} is not allowed on this Taskmoor server.\n`);
}

/**
 * Applies the allowlist (M1-085; IAM-015 (1)) to every request but the health probes, after
 * authentication, so a member of an exempt group gets in from anywhere. Requests for the web
 * app itself carry no session check of their own; the cookie is read here when the address is
 * outside the list.
 */
export function registerAllowlist(
  app: FastifyInstance,
  db: Kysely<Database>,
  allowlists: Allowlists,
): void {
  app.addHook('onRequest', async (request, reply) => {
    if (reply.sent || OPEN_PATHS.has(request.url.split('?')[0] ?? '')) return;
    const workspaceId = request.url.startsWith('/api/')
      ? request.workspaceId
      : await defaultWorkspaceId(db);
    const { list, allows } = await allowlists.get(workspaceId);
    if (!list.enabled || allows(request.ip)) return;
    let userId = request.user?.id ?? null;
    if (userId === null && !request.url.startsWith('/api/')) {
      userId = (await resolveSession(db, workspaceId, presentedToken(request)))?.user.id ?? null;
    }
    if (userId !== null && (await inGroups(db, userId, list.exemptGroupIds))) return;
    return refuse(request, reply);
  });
}

const body = z
  .object({
    enabled: z.boolean(),
    exemptGroupIds: z.array(z.number().int().positive()).max(1000).default([]),
    entries: z
      .array(z.object({ range: z.string().max(64), note: z.string().max(200).default('') }))
      .max(100_000),
    /** Saving a list that leaves the person saving it outside needs this (IAM-015 (2)). */
    confirmLockout: z.boolean().default(false),
  })
  .strict();

/** The normal form of a range: the address as typed, lower case, with its prefix length. */
function canonical(text: string): string | null {
  const range = parseRange(text);
  return range ? `${range.address}/${range.prefix}` : null;
}

/**
 * The allowlist for site administrators (M1-085; IAM-015): read it with the caller's address
 * and whether that address is in, and replace it whole. A list that would leave the caller
 * outside answers 409 `would_lock_you_out` unless `confirmLockout` is true.
 */
export function registerAllowlistRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  allowlists: Allowlists,
): void {
  const view = async (request: FastifyRequest, list: Allowlist) => {
    const groups =
      list.exemptGroupIds.length === 0
        ? []
        : await db
            .selectFrom('user_group')
            .select(['id', 'name'])
            .where('workspace_id', '=', request.workspaceId)
            .where('id', 'in', list.exemptGroupIds)
            .orderBy('name')
            .execute();
    return {
      allowlist: {
        enabled: list.enabled,
        exemptGroups: groups,
        entries: list.entries,
      },
      yourAddress: request.ip,
      yourAddressAllowed: matcher(list.entries)(request.ip),
    };
  };

  app.get('/api/v1/admin/ip-allowlist', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return view(request, await readAllowlist(db, request.workspaceId));
  });

  app.put('/api/v1/admin/ip-allowlist', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const fields: Record<string, string> = {};
    const entries: { range: string; note: string }[] = [];
    const seen = new Set<string>();
    for (const [i, entry] of parsed.data.entries.entries()) {
      const range = canonical(entry.range);
      if (!range) fields[`entries.${i}.range`] = 'invalid_range';
      else if (!seen.has(range)) {
        seen.add(range);
        entries.push({ range, note: entry.note.trim() });
      }
    }
    const groupIds = [...new Set(parsed.data.exemptGroupIds)];
    if (groupIds.length > 0) {
      const found = await db
        .selectFrom('user_group')
        .select('id')
        .where('workspace_id', '=', ws)
        .where('id', 'in', groupIds)
        .execute();
      if (found.length !== groupIds.length) fields.exemptGroupIds = 'not_found';
    }
    if (Object.keys(fields).length > 0) {
      return reply.code(400).send({ error: 'invalid_fields', fields });
    }
    if (parsed.data.enabled && !parsed.data.confirmLockout) {
      const inside = matcher(entries)(request.ip) || (await inGroups(db, admin.id, groupIds));
      if (!inside) {
        return reply.code(409).send({ error: 'would_lock_you_out', address: request.ip });
      }
    }
    const before = await readAllowlist(db, ws);
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('ip_allowlist')
        .values({ workspace_id: ws, enabled: parsed.data.enabled, exempt_group_ids: groupIds })
        .onConflict((oc) =>
          oc.column('workspace_id').doUpdateSet({
            enabled: parsed.data.enabled,
            exempt_group_ids: groupIds,
            updated_at: new Date(),
          }),
        )
        .execute();
      await trx.deleteFrom('ip_allowlist_entry').where('workspace_id', '=', ws).execute();
      for (let i = 0; i < entries.length; i += 1000) {
        await trx
          .insertInto('ip_allowlist_entry')
          .values(entries.slice(i, i + 1000).map((e) => ({ workspace_id: ws, ...e })))
          .execute();
      }
      const was = new Set(before.entries.map((e) => e.range));
      const now = new Set(entries.map((e) => e.range));
      await emit(
        trx,
        { workspaceId: ws, actorId: admin.id },
        {
          type: 'ip_allowlist.updated',
          subjectId: ws,
          payload: {
            enabled: { from: before.enabled, to: parsed.data.enabled },
            added: [...now].filter((r) => !was.has(r)),
            removed: [...was].filter((r) => !now.has(r)),
            exemptGroupIds: groupIds,
            lockoutConfirmed: parsed.data.confirmLockout,
          },
        },
      );
    });
    const saved = await readAllowlist(db, ws);
    allowlists.set(ws, saved);
    return view(request, saved);
  });
}
