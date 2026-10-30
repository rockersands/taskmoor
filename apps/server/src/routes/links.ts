import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireGlobal, requireUser } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import { diff, emit } from '../events/bus';
import { autoFollows } from '../tickets/followers';
import { type FieldChange, linkChange, recordChanges } from '../tickets/history';
import { ticketKey } from '../tickets/model';
import { loadTicket, resolveTicket, type TicketRow } from '../tickets/store';

/**
 * Ticket links, link types, web links, followers and votes (M1-015; CORE-018, CORE-019).
 *
 * - Link types belong to the workspace; everyone signed in reads them, site and
 *   configuration administrators change them. Deleting one in use needs a replacement, which
 *   takes over its links (CORE-018 (1)). The copy type (cloning's) is never deleted. A
 *   switch turns ticket links off for the workspace: existing links stay, no new ones.
 * - A link reads from each side: "blocks" from its source, "is blocked by" from its target
 *   (CORE-018 (2)). Linking needs "Link tickets" in the ticket's track and the right to
 *   browse the other ticket; either may be in any track. A ticket lists only the links whose
 *   other ticket the viewer may browse, and none to tickets in the trash (their links come
 *   back with them).
 * - Web links point outside, with a title and an icon; one with a global id is replaced when
 *   the same global id is added again, so an integration keeps one link per object.
 * - Everyone who may browse a ticket follows and votes for themselves; the counts are public
 *   to them. The lists need "View voters and followers"; changing someone else's following
 *   needs "Manage followers" (CORE-019 (2)). There is no cap (CORE-019 (3)).
 * - Links and web links are history on the tickets they touch (CORE-022); following and
 *   voting are not.
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const idValue = z.number().int().positive().max(MAX_INT);
const ref = z.union([idValue, z.string().trim().min(1).max(300)]);
const phrase = z.string().trim().min(1).max(255);
const webUrl = z
  .string()
  .trim()
  .max(4000)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'an http or https URL');

const linkTypeBody = z.object({ name: phrase, outward: phrase, inward: phrase }).strict();
const updateLinkTypeBody = linkTypeBody.partial().strict();
const deleteQuery = z.object({ replacementId: id.optional() }).strict();
export const createLinkBody = z
  .object({
    linkTypeId: idValue,
    ticket: ref,
    /** The side this ticket takes: the source ("blocks") by default. */
    direction: z.enum(['outward', 'inward']).default('outward'),
  })
  .strict();
const webLinkFields = {
  url: webUrl,
  title: z.string().trim().min(1).max(500),
  summary: z.string().max(2000),
  iconUrl: webUrl.nullable(),
  relationship: z.string().trim().max(255),
};
const createWebLinkBody = z
  .object({
    url: webLinkFields.url,
    title: webLinkFields.title,
    summary: webLinkFields.summary.optional(),
    iconUrl: webLinkFields.iconUrl.optional(),
    relationship: webLinkFields.relationship.optional(),
    globalId: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
const updateWebLinkBody = z.object(webLinkFields).partial().strict();
const ticketParams = z.object({ id: z.string().min(1).max(300) });
const personParams = z.object({
  id: z.string().min(1).max(300),
  userId: z.union([z.literal('me'), id]),
});

type Db = Kysely<Database> | Transaction<Database>;

function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' ? (e.constraint ?? '') : null;
}

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

function linkTypeRows(db: Db, workspaceId: number) {
  return db
    .selectFrom('link_type')
    .select(['id', 'name', 'outward', 'inward', 'is_copy'])
    .where('workspace_id', '=', workspaceId)
    .orderBy(sql`lower(name)`)
    .orderBy('id')
    .execute();
}
type LinkTypeRow = Awaited<ReturnType<typeof linkTypeRows>>[number];
const linkTypeView = (t: LinkTypeRow) => ({
  id: t.id,
  name: t.name,
  outward: t.outward,
  inward: t.inward,
  isCopy: t.is_copy,
});

/** Whether ticket links are on in the workspace (the copy link of a clone too). */
export async function linksEnabled(db: Db, workspaceId: number): Promise<boolean> {
  const row = await db
    .selectFrom('link_policy')
    .select('enabled')
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  return row?.enabled ?? true;
}

/** Every link of a ticket, from its side, with the other ticket. */
function linkRows(db: Db, ticketId: number) {
  const side = (mine: 'source_id' | 'target_id', other: 'source_id' | 'target_id') =>
    db
      .selectFrom('ticket_link as l')
      .innerJoin('link_type as lt', 'lt.id', 'l.link_type_id')
      .innerJoin('ticket as o', 'o.id', `l.${other}`)
      .innerJoin('track as t', 't.id', 'o.track_id')
      .select([
        'l.id',
        'l.link_type_id',
        'lt.name as type_name',
        sql<'outward' | 'inward'>`${mine === 'source_id' ? 'outward' : 'inward'}::text`.as(
          'direction',
        ),
        sql<string>`${sql.ref(mine === 'source_id' ? 'lt.outward' : 'lt.inward')}`.as('phrase'),
        'o.id as other_id',
        'o.number as other_number',
        'o.summary as other_summary',
        'o.track_id as other_track_id',
        't.key as other_track_key',
        'o.deleted_at as other_deleted_at',
        'o.closed_at as other_closed_at',
        'l.created_at',
      ])
      .where(`l.${mine}`, '=', ticketId);
  return side('source_id', 'target_id')
    .unionAll(side('target_id', 'source_id'))
    .orderBy('type_name')
    .orderBy('direction', 'desc')
    .orderBy('id')
    .execute();
}

function webLinkRows(db: Db, ticketId: number) {
  return db
    .selectFrom('ticket_web_link')
    .select([
      'id',
      'url',
      'title',
      'summary',
      'icon_url',
      'relationship',
      'global_id',
      'created_at',
      'updated_at',
    ])
    .where('ticket_id', '=', ticketId)
    .orderBy('id')
    .execute();
}
type WebLinkRow = Awaited<ReturnType<typeof webLinkRows>>[number];
const webLinkView = (w: WebLinkRow) => ({
  id: w.id,
  url: w.url,
  title: w.title,
  summary: w.summary,
  iconUrl: w.icon_url,
  relationship: w.relationship,
  globalId: w.global_id,
  createdAt: w.created_at.toISOString(),
  updatedAt: w.updated_at.toISOString(),
});

const webLinkChange = (
  ticketId: number,
  before: { url: string; title: string } | null,
  after: { url: string; title: string } | null,
): FieldChange => ({
  ticketId,
  field: 'webLink',
  from: before?.url ?? null,
  to: after?.url ?? null,
  fromDisplay: before?.title ?? null,
  toDisplay: after?.title ?? null,
});

export function registerLinkRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  authorizer: Authorizer,
): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });
  const configAdmin = (request: FastifyRequest, reply: FastifyReply) =>
    requireGlobal(request, reply, 'site_admin', 'configuration_admin');

  /** A ticket outside the trash that the caller may see (M1-020), by id or key. */
  async function findTicket(request: FastifyRequest, ticketRef: string | number) {
    const found = await resolveTicket(db, request.workspaceId, ticketRef);
    if (!found) return null;
    const row = await loadTicket(db, request.workspaceId, found.id);
    if (!row || row.deleted_at || !(await request.authz.seesTicket(row))) return null;
    return row;
  }

  /** The ticket of the route, or the refusal; for writes also "track archived". */
  async function routeTicket(request: FastifyRequest, reply: FastifyReply, writing: boolean) {
    const params = ticketParams.safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    const row = await findTicket(request, params.data.id);
    if (!row) {
      await notFound(reply);
      return null;
    }
    if (writing && row.track_archived_at) {
      await reply.code(409).send({ error: 'track_archived' });
      return null;
    }
    return row;
  }

  const keyOf = (row: TicketRow) => ticketKey(row.track_key, row.number);

  // Link types (CORE-018)

  app.get('/api/v1/link-types', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const ws = request.workspaceId;
    return {
      enabled: await linksEnabled(db, ws),
      linkTypes: (await linkTypeRows(db, ws)).map(linkTypeView),
    };
  });

  app.put('/api/v1/link-policy', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const ws = request.workspaceId;
    await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('link_policy')
        .select('enabled')
        .where('workspace_id', '=', ws)
        .forUpdate()
        .executeTakeFirst();
      const was = current?.enabled ?? true;
      if (was === parsed.data.enabled) return;
      await trx
        .insertInto('link_policy')
        .values({ workspace_id: ws, enabled: parsed.data.enabled })
        .onConflict((oc) =>
          oc
            .column('workspace_id')
            .doUpdateSet({ enabled: parsed.data.enabled, updated_at: new Date() }),
        )
        .execute();
      await emit(trx, by(request), {
        type: 'link_policy.updated',
        subjectId: ws,
        payload: { changes: { enabled: { from: was, to: parsed.data.enabled } } },
      });
    });
    return { enabled: parsed.data.enabled };
  });

  app.post('/api/v1/link-types', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const parsed = linkTypeBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    try {
      const row = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto('link_type')
          .values({ workspace_id: ws, ...body })
          .returning(['id', 'name', 'outward', 'inward', 'is_copy'])
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'link_type.created',
          subjectId: created.id,
          payload: body,
        });
        return created;
      });
      return reply.code(201).send({ linkType: linkTypeView(row) });
    } catch (error) {
      if (uniqueViolation(error) === 'link_type_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.patch('/api/v1/link-types/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = updateLinkTypeBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    try {
      const row = await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom('link_type')
          .select(['id', 'name', 'outward', 'inward', 'is_copy'])
          .where('id', '=', params.data.id)
          .where('workspace_id', '=', ws)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!current) return null;
        const changes = diff<Record<string, unknown>>(
          { name: current.name, outward: current.outward, inward: current.inward },
          body,
        );
        if (Object.keys(changes).length === 0) return current;
        const updated = await trx
          .updateTable('link_type')
          .set({ ...body, updated_at: new Date() })
          .where('id', '=', current.id)
          .returning(['id', 'name', 'outward', 'inward', 'is_copy'])
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'link_type.updated',
          subjectId: current.id,
          payload: { changes },
        });
        return updated;
      });
      if (!row) return notFound(reply);
      return { linkType: linkTypeView(row) };
    } catch (error) {
      if (uniqueViolation(error) === 'link_type_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  // Its links take the replacement (CORE-018 (1)); a pair already linked by the
  // replacement keeps that one link.
  app.delete('/api/v1/link-types/:id', async (request, reply) => {
    const user = await configAdmin(request, reply);
    if (!user) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const query = deleteQuery.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply);
    const typeId = params.data.id;
    const replacementId = query.data.replacementId ?? null;
    if (replacementId === typeId) return invalid(reply, 'replacementId');
    const ws = request.workspaceId;
    const result = await db.transaction().execute(async (trx) => {
      const held = await trx
        .selectFrom('link_type')
        .select(['id', 'name', 'outward', 'inward', 'is_copy'])
        .where('workspace_id', '=', ws)
        .where('id', 'in', replacementId === null ? [typeId] : [typeId, replacementId])
        .orderBy('id')
        .forUpdate()
        .execute();
      const current = held.find((t) => t.id === typeId);
      const replacement = held.find((t) => t.id === replacementId);
      if (!current) return { missing: true as const };
      if (current.is_copy) return { conflict: 'copy_type' };
      if (replacementId !== null && !replacement) return { badReplacement: true as const };
      const links = await trx
        .selectFrom('ticket_link as l')
        .innerJoin('ticket as s', 's.id', 'l.source_id')
        .innerJoin('track as st', 'st.id', 's.track_id')
        .innerJoin('ticket as t', 't.id', 'l.target_id')
        .innerJoin('track as tt', 'tt.id', 't.track_id')
        .select([
          'l.id',
          'l.source_id',
          'l.target_id',
          's.number as source_number',
          'st.key as source_track_key',
          't.number as target_number',
          'tt.key as target_track_key',
        ])
        .where('l.link_type_id', '=', typeId)
        .orderBy('l.id')
        .execute();
      if (links.length > 0 && !replacement) return { inUse: links.length };
      const changes: FieldChange[] = [];
      if (replacement) {
        // Pairs the replacement already links keep that link; the rest move over.
        await sql`
          DELETE FROM ticket_link l USING ticket_link r
           WHERE l.link_type_id = ${typeId} AND r.link_type_id = ${replacement.id}
             AND r.source_id = l.source_id AND r.target_id = l.target_id`.execute(trx);
        await trx
          .updateTable('ticket_link')
          .set({ link_type_id: replacement.id })
          .where('link_type_id', '=', typeId)
          .execute();
        for (const l of links) {
          const sourceKey = ticketKey(l.source_track_key, l.source_number);
          const targetKey = ticketKey(l.target_track_key, l.target_number);
          for (const [ticketId, direction, otherId, otherKey] of [
            [l.source_id, 'outward', l.target_id, targetKey],
            [l.target_id, 'inward', l.source_id, sourceKey],
          ] as const) {
            const was = linkChange(
              ticketId,
              { typeId, direction, phrase: current[direction], otherId },
              otherKey,
              false,
            );
            const now = linkChange(
              ticketId,
              { typeId: replacement.id, direction, phrase: replacement[direction], otherId },
              otherKey,
              true,
            );
            changes.push({ ...was, to: now.to, toDisplay: now.toDisplay });
          }
        }
      }
      await recordChanges(trx, ws, user.id, changes);
      await trx.deleteFrom('link_type').where('id', '=', typeId).execute();
      await emit(trx, by(request), {
        type: 'link_type.deleted',
        subjectId: typeId,
        payload: { name: current.name, replacementId, linkCount: links.length },
      });
      return { done: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('badReplacement' in result) return invalid(reply, 'replacementId');
    if ('conflict' in result) return reply.code(409).send({ error: result.conflict });
    if ('inUse' in result) {
      return reply.code(409).send({ error: 'in_use', linkCount: result.inUse });
    }
    return reply.code(204).send();
  });

  // Ticket links (CORE-018)

  app.get('/api/v1/tickets/:id/links', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const ticket = await routeTicket(request, reply, false);
    if (!ticket) return reply;
    const [rows, webLinks] = await Promise.all([
      linkRows(db, ticket.id),
      webLinkRows(db, ticket.id),
    ]);
    // One statement for the other tickets the caller may see, however many links there are.
    const visible = await request.authz.visibleTickets(rows.map((r) => r.other_id));
    const links = rows
      .filter((r) => r.other_deleted_at === null && visible.has(r.other_id))
      .map((r) => ({
        id: r.id,
        type: { id: r.link_type_id, name: r.type_name },
        direction: r.direction,
        phrase: r.phrase,
        ticket: {
          id: r.other_id,
          key: ticketKey(r.other_track_key, r.other_number),
          summary: r.other_summary,
          closed: r.other_closed_at !== null,
        },
        createdAt: r.created_at.toISOString(),
      }));
    return { links, webLinks: webLinks.map(webLinkView) };
  });

  app.post('/api/v1/tickets/:id/links', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return reply;
    const parsed = createLinkBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    if (!(await request.authz.canTicket('link_tickets', ticket))) {
      return reply.code(403).send({ error: 'forbidden', permission: 'link_tickets' });
    }
    if (!(await linksEnabled(db, ws))) return reply.code(409).send({ error: 'links_disabled' });
    const other = await findTicket(request, body.ticket);
    if (!other)
      return reply.code(400).send({ error: 'invalid_fields', fields: { ticket: 'not_found' } });
    if (other.id === ticket.id) {
      return reply.code(400).send({ error: 'invalid_fields', fields: { ticket: 'self' } });
    }
    if (other.track_archived_at) return reply.code(409).send({ error: 'track_archived' });
    const [sourceId, targetId] =
      body.direction === 'outward' ? [ticket.id, other.id] : [other.id, ticket.id];
    try {
      const result = await db.transaction().execute(async (trx) => {
        const type = await trx
          .selectFrom('link_type')
          .select(['id', 'name', 'outward', 'inward'])
          .where('id', '=', body.linkTypeId)
          .where('workspace_id', '=', ws)
          .forKeyShare()
          .executeTakeFirst();
        if (!type) return { badType: true as const };
        // Both tickets stay out of the trash until this commits.
        const live = await trx
          .selectFrom('ticket')
          .select('id')
          .where('id', 'in', [ticket.id, other.id])
          .where('deleted_at', 'is', null)
          .orderBy('id')
          .forShare()
          .execute();
        if (live.length !== 2) return { gone: true as const };
        const link = await trx
          .insertInto('ticket_link')
          .values({
            workspace_id: ws,
            link_type_id: type.id,
            source_id: sourceId,
            target_id: targetId,
            created_by: user.id,
          })
          .returning(['id', 'created_at'])
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'ticket.linked',
          subjectId: ticket.id,
          payload: { key: keyOf(ticket), linkId: link.id, linkTypeId: type.id, sourceId, targetId },
        });
        const side = (mine: TicketRow, theirs: TicketRow, direction: 'outward' | 'inward') =>
          linkChange(
            mine.id,
            { typeId: type.id, direction, phrase: type[direction], otherId: theirs.id },
            keyOf(theirs),
            true,
          );
        const otherSide = body.direction === 'outward' ? 'inward' : 'outward';
        await recordChanges(trx, ws, user.id, [
          side(ticket, other, body.direction),
          side(other, ticket, otherSide),
        ]);
        return { link, type };
      });
      if ('badType' in result) {
        return reply
          .code(400)
          .send({ error: 'invalid_fields', fields: { linkTypeId: 'not_found' } });
      }
      if ('gone' in result) return notFound(reply);
      return reply.code(201).send({
        link: {
          id: result.link.id,
          type: { id: result.type.id, name: result.type.name },
          direction: body.direction,
          phrase: result.type[body.direction],
          ticket: {
            id: other.id,
            key: keyOf(other),
            summary: other.summary,
            closed: other.closed_at !== null,
          },
          createdAt: result.link.created_at.toISOString(),
        },
      });
    } catch (error) {
      if (uniqueViolation(error) === 'ticket_link_unique_idx') {
        return reply.code(409).send({ error: 'link_exists' });
      }
      throw error;
    }
  });

  app.delete('/api/v1/tickets/:id/links/:linkId', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return reply;
    const linkId = id.safeParse((request.params as { linkId?: string }).linkId);
    if (!linkId.success) return invalid(reply);
    const ws = request.workspaceId;
    if (!(await request.authz.canTicket('link_tickets', ticket))) {
      return reply.code(403).send({ error: 'forbidden', permission: 'link_tickets' });
    }
    const result = await db.transaction().execute(async (trx) => {
      const link = await trx
        .deleteFrom('ticket_link')
        .where('id', '=', linkId.data)
        .where((eb) => eb.or([eb('source_id', '=', ticket.id), eb('target_id', '=', ticket.id)]))
        .returning(['id', 'link_type_id', 'source_id', 'target_id'])
        .executeTakeFirst();
      if (!link) return null;
      const type = await trx
        .selectFrom('link_type')
        .select(['outward', 'inward'])
        .where('id', '=', link.link_type_id)
        .executeTakeFirstOrThrow();
      const otherId = link.source_id === ticket.id ? link.target_id : link.source_id;
      const other = await loadTicket(trx, ws, otherId);
      await emit(trx, by(request), {
        type: 'ticket.unlinked',
        subjectId: ticket.id,
        payload: {
          key: keyOf(ticket),
          linkId: link.id,
          linkTypeId: link.link_type_id,
          sourceId: link.source_id,
          targetId: link.target_id,
        },
      });
      if (other) {
        const mine = link.source_id === ticket.id ? 'outward' : 'inward';
        const theirs = mine === 'outward' ? 'inward' : 'outward';
        await recordChanges(trx, ws, user.id, [
          linkChange(
            ticket.id,
            { typeId: link.link_type_id, direction: mine, phrase: type[mine], otherId },
            keyOf(other),
            false,
          ),
          linkChange(
            otherId,
            {
              typeId: link.link_type_id,
              direction: theirs,
              phrase: type[theirs],
              otherId: ticket.id,
            },
            keyOf(ticket),
            false,
          ),
        ]);
      }
      return link;
    });
    if (!result) return notFound(reply);
    return reply.code(204).send();
  });

  // Web links (CORE-018)

  app.post('/api/v1/tickets/:id/web-links', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return reply;
    const parsed = createWebLinkBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    if (!(await request.authz.canTicket('link_tickets', ticket))) {
      return reply.code(403).send({ error: 'forbidden', permission: 'link_tickets' });
    }
    const result = await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('ticket')
        .select('id')
        .where('id', '=', ticket.id)
        .forNoKeyUpdate()
        .execute();
      const existing =
        body.globalId === undefined
          ? undefined
          : await trx
              .selectFrom('ticket_web_link')
              .select(['id', 'url', 'title', 'summary', 'icon_url', 'relationship'])
              .where('ticket_id', '=', ticket.id)
              .where('global_id', '=', body.globalId)
              .executeTakeFirst();
      const values = {
        url: body.url,
        title: body.title,
        summary: body.summary ?? '',
        icon_url: body.iconUrl ?? null,
        relationship: body.relationship ?? '',
      };
      if (existing) {
        // The same object again: its link is brought up to date.
        const changes = diff<Record<string, unknown>>(
          {
            url: existing.url,
            title: existing.title,
            summary: existing.summary,
            iconUrl: existing.icon_url,
            relationship: existing.relationship,
          },
          {
            url: values.url,
            title: values.title,
            summary: values.summary,
            iconUrl: values.icon_url,
            relationship: values.relationship,
          },
        );
        if (Object.keys(changes).length > 0) {
          await trx
            .updateTable('ticket_web_link')
            .set({ ...values, updated_at: new Date() })
            .where('id', '=', existing.id)
            .execute();
          await emit(trx, by(request), {
            type: 'ticket.web_link_updated',
            subjectId: ticket.id,
            payload: { key: keyOf(ticket), webLinkId: existing.id, fields: Object.keys(changes) },
          });
          if (changes.url || changes.title) {
            await recordChanges(trx, ws, user.id, [webLinkChange(ticket.id, existing, values)]);
          }
        }
        return { id: existing.id, created: false };
      }
      const row = await trx
        .insertInto('ticket_web_link')
        .values({
          workspace_id: ws,
          ticket_id: ticket.id,
          ...values,
          global_id: body.globalId ?? null,
          created_by: user.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await emit(trx, by(request), {
        type: 'ticket.web_link_added',
        subjectId: ticket.id,
        payload: {
          key: keyOf(ticket),
          webLinkId: row.id,
          title: values.title,
          globalId: body.globalId ?? null,
        },
      });
      await recordChanges(trx, ws, user.id, [webLinkChange(ticket.id, null, values)]);
      return { id: row.id, created: true };
    });
    const rows = await webLinkRows(db, ticket.id);
    const view = rows.find((w) => w.id === result.id);
    return reply
      .code(result.created ? 201 : 200)
      .send({ webLink: view ? webLinkView(view) : null });
  });

  app.patch('/api/v1/tickets/:id/web-links/:linkId', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return reply;
    const linkId = id.safeParse((request.params as { linkId?: string }).linkId);
    const parsed = updateWebLinkBody.safeParse(request.body);
    if (!linkId.success || !parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    if (!(await request.authz.canTicket('link_tickets', ticket))) {
      return reply.code(403).send({ error: 'forbidden', permission: 'link_tickets' });
    }
    const found = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('ticket_web_link')
        .select(['id', 'url', 'title', 'summary', 'icon_url', 'relationship'])
        .where('id', '=', linkId.data)
        .where('ticket_id', '=', ticket.id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return false;
      const changes = diff<Record<string, unknown>>(
        {
          url: current.url,
          title: current.title,
          summary: current.summary,
          iconUrl: current.icon_url,
          relationship: current.relationship,
        },
        body,
      );
      if (Object.keys(changes).length === 0) return true;
      const next = {
        url: body.url ?? current.url,
        title: body.title ?? current.title,
        summary: body.summary ?? current.summary,
        icon_url: body.iconUrl !== undefined ? body.iconUrl : current.icon_url,
        relationship: body.relationship ?? current.relationship,
      };
      await trx
        .updateTable('ticket_web_link')
        .set({ ...next, updated_at: new Date() })
        .where('id', '=', current.id)
        .execute();
      await emit(trx, by(request), {
        type: 'ticket.web_link_updated',
        subjectId: ticket.id,
        payload: { key: keyOf(ticket), webLinkId: current.id, fields: Object.keys(changes) },
      });
      if (changes.url || changes.title) {
        await recordChanges(trx, ws, user.id, [webLinkChange(ticket.id, current, next)]);
      }
      return true;
    });
    if (!found) return notFound(reply);
    const view = (await webLinkRows(db, ticket.id)).find((w) => w.id === linkId.data);
    return { webLink: view ? webLinkView(view) : null };
  });

  app.delete('/api/v1/tickets/:id/web-links/:linkId', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return reply;
    const linkId = id.safeParse((request.params as { linkId?: string }).linkId);
    if (!linkId.success) return invalid(reply);
    const ws = request.workspaceId;
    if (!(await request.authz.canTicket('link_tickets', ticket))) {
      return reply.code(403).send({ error: 'forbidden', permission: 'link_tickets' });
    }
    const removed = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('ticket_web_link')
        .where('id', '=', linkId.data)
        .where('ticket_id', '=', ticket.id)
        .returning(['id', 'url', 'title'])
        .executeTakeFirst();
      if (!row) return false;
      await emit(trx, by(request), {
        type: 'ticket.web_link_removed',
        subjectId: ticket.id,
        payload: { key: keyOf(ticket), webLinkId: row.id },
      });
      await recordChanges(trx, ws, user.id, [webLinkChange(ticket.id, row, null)]);
      return true;
    });
    if (!removed) return notFound(reply);
    return reply.code(204).send();
  });

  // The tickets that carry a web link with this global id, among those the caller may
  // browse: what `ticketsWithWebLinksByGlobalId()` will find (CORE-018 (3)).
  app.get('/api/v1/web-links', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = z
      .object({ globalId: z.string().min(1).max(1000) })
      .strict()
      .safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const rows = await db
      .selectFrom('ticket_web_link as w')
      .innerJoin('ticket as k', 'k.id', 'w.ticket_id')
      .innerJoin('track as t', 't.id', 'k.track_id')
      .select(['k.id', 'k.number', 'k.summary', 'k.track_id', 't.key', 'w.id as web_link_id'])
      .where('w.workspace_id', '=', request.workspaceId)
      .where('w.global_id', '=', parsed.data.globalId)
      .where('k.deleted_at', 'is', null)
      .orderBy('k.id')
      .execute();
    const tickets = [];
    const visible = await request.authz.visibleTickets(rows.map((r) => r.id));
    for (const r of rows) {
      if (!visible.has(r.id)) continue;
      tickets.push({
        id: r.id,
        key: ticketKey(r.key, r.number),
        summary: r.summary,
        webLinkId: r.web_link_id,
      });
    }
    return { tickets };
  });

  // Followers and votes (CORE-019)

  for (const kind of ['followers', 'votes'] as const) {
    const table = kind === 'followers' ? 'ticket_follower' : 'ticket_vote';
    app.get(`/api/v1/tickets/:id/${kind}`, async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return reply;
      const ticket = await routeTicket(request, reply, false);
      if (!ticket) return reply;
      const rows = await db
        .selectFrom(`${table} as f`)
        .innerJoin('app_user as u', 'u.id', 'f.user_id')
        .select(['u.id', 'u.name'])
        .where('f.ticket_id', '=', ticket.id)
        .orderBy('u.name')
        .orderBy('u.id')
        .execute();
      // The count is everyone's; the names need "View voters and followers".
      const mayList = await request.authz.canTicket('view_voters_followers', ticket);
      return {
        count: rows.length,
        mine: rows.some((r) => r.id === user.id),
        people: mayList ? rows : null,
      };
    });
  }

  /** Who a follower route acts for, checked; answers the refusal and returns null. */
  async function followerTarget(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request, reply);
    if (!user) return null;
    const params = personParams.safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return null;
    const userId = params.data.userId === 'me' ? user.id : params.data.userId;
    if (userId !== user.id) {
      if (!(await request.authz.canTicket('manage_followers', ticket))) {
        await reply.code(403).send({ error: 'forbidden', permission: 'manage_followers' });
        return null;
      }
      // Only someone who may see the ticket follows it.
      const person = await db
        .selectFrom('app_user')
        .select('id')
        .where('id', '=', userId)
        .where('workspace_id', '=', request.workspaceId)
        .where('deactivated_at', 'is', null)
        .executeTakeFirst();
      const sees =
        person !== undefined &&
        (await authorizer.ticketPermissions(request.workspaceId, { userId }, ticket)).has(
          'browse_track',
        );
      if (!sees) {
        await invalid(reply, 'userId');
        return null;
      }
    }
    return { ticket, userId };
  }

  app.put('/api/v1/tickets/:id/followers/:userId', async (request, reply) => {
    const target = await followerTarget(request, reply);
    if (!target) return reply;
    const ws = request.workspaceId;
    await db.transaction().execute(async (trx) => {
      const added = await trx
        .insertInto('ticket_follower')
        .values({ workspace_id: ws, ticket_id: target.ticket.id, user_id: target.userId })
        .onConflict((oc) => oc.doNothing())
        .returning('user_id')
        .executeTakeFirst();
      if (!added) return;
      await emit(trx, by(request), {
        type: 'ticket.followed',
        subjectId: target.ticket.id,
        payload: { key: keyOf(target.ticket), userId: target.userId },
      });
    });
    return reply.code(204).send();
  });

  app.delete('/api/v1/tickets/:id/followers/:userId', async (request, reply) => {
    const target = await followerTarget(request, reply);
    if (!target) return reply;
    await db.transaction().execute(async (trx) => {
      const removed = await trx
        .deleteFrom('ticket_follower')
        .where('ticket_id', '=', target.ticket.id)
        .where('user_id', '=', target.userId)
        .returning('user_id')
        .executeTakeFirst();
      if (!removed) return;
      await emit(trx, by(request), {
        type: 'ticket.unfollowed',
        subjectId: target.ticket.id,
        payload: { key: keyOf(target.ticket), userId: target.userId },
      });
    });
    return reply.code(204).send();
  });

  // A vote is one's own.
  for (const voting of [true, false]) {
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      const user = requireUser(request, reply);
      if (!user) return reply;
      const ticket = await routeTicket(request, reply, true);
      if (!ticket) return reply;
      const ws = request.workspaceId;
      await db.transaction().execute(async (trx) => {
        const changed = voting
          ? await trx
              .insertInto('ticket_vote')
              .values({ workspace_id: ws, ticket_id: ticket.id, user_id: user.id })
              .onConflict((oc) => oc.doNothing())
              .returning('user_id')
              .executeTakeFirst()
          : await trx
              .deleteFrom('ticket_vote')
              .where('ticket_id', '=', ticket.id)
              .where('user_id', '=', user.id)
              .returning('user_id')
              .executeTakeFirst();
        if (!changed) return;
        await emit(trx, by(request), {
          type: voting ? 'ticket.voted' : 'ticket.unvoted',
          subjectId: ticket.id,
          payload: { key: keyOf(ticket) },
        });
      });
      return reply.code(204).send();
    };
    if (voting) app.put('/api/v1/tickets/:id/votes', handler);
    else app.delete('/api/v1/tickets/:id/votes', handler);
  }

  // Personal settings (CORE-019: auto-follow).

  app.get('/api/v1/account/preferences', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    return { preferences: { autoFollow: await autoFollows(db, user.id) } };
  });

  app.patch('/api/v1/account/preferences', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = z.object({ autoFollow: z.boolean() }).partial().strict().safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    await db.transaction().execute(async (trx) => {
      const was = await autoFollows(trx, user.id);
      const changes = diff<Record<string, unknown>>({ autoFollow: was }, body);
      if (Object.keys(changes).length === 0) return;
      await trx
        .insertInto('user_preference')
        .values({
          user_id: user.id,
          workspace_id: request.workspaceId,
          auto_follow: body.autoFollow ?? was,
        })
        .onConflict((oc) =>
          oc
            .column('user_id')
            .doUpdateSet({ auto_follow: body.autoFollow ?? was, updated_at: new Date() }),
        )
        .execute();
      await emit(trx, by(request), {
        type: 'user.preferences_updated',
        subjectId: user.id,
        payload: { changes },
      });
    });
    return { preferences: { autoFollow: await autoFollows(db, user.id) } };
  });
}
