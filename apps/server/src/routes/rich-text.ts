import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireGlobal, requireUser } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import { docHash, loadOriginal, RICH_TEXT_FIELDS } from '../tickets/rich-text';
import { loadTicket, resolveTicket, resolveTrack, type TicketRow } from '../tickets/store';

/**
 * Rich text beside the ticket routes (M1-017; NTF-005, NTF-007, IMP-008).
 *
 * - `GET /api/v1/tickets/:id/rich-text/:field/original`: the document a description or
 *   environment was last written as in the Jira-compatible format, as it came, and whether
 *   the ticket's text is still what was converted from it (`current`). Needs the ticket.
 * - `GET /api/v1/people/mentionable?track=|ticket=&q=`: people an editor offers when someone
 *   types "@": active people whose name contains the text or whose email starts with it, with
 *   `canView` saying whether they may see the ticket (or browse the track, before the ticket
 *   exists), so the editor can warn before mentioning someone who cannot (NTF-005 (1)). Those
 *   who can come first. Needs "Browse users and groups" and the track or ticket.
 *
 * Both only read.
 */
const params = z.object({
  id: z.string().min(1).max(300),
  field: z.enum(RICH_TEXT_FIELDS),
});
const mentionQuery = z
  .object({
    track: z.string().min(1).max(300).optional(),
    ticket: z.string().min(1).max(300).optional(),
    q: z.string().max(200).default(''),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict()
  .refine((q) => (q.track === undefined) !== (q.ticket === undefined), 'track or ticket');

const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

export function registerRichTextRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  authorizer: Authorizer,
): void {
  app.get('/api/v1/tickets/:id/rich-text/:field/original', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const ws = request.workspaceId;
    const found = await resolveTicket(db, ws, p.data.id);
    const row = found ? await loadTicket(db, ws, found.id) : undefined;
    if (!row || !(await request.authz.seesTicket(row))) return notFound(reply);
    if (row.deleted_at && !(await request.authz.canTicket('delete_tickets', row))) {
      return notFound(reply);
    }
    const original = await loadOriginal(db, row.id, p.data.field);
    if (!original) return notFound(reply);
    return {
      field: p.data.field,
      format: original.format,
      original: original.source,
      writtenAt: original.written_at.toISOString(),
      writtenBy:
        original.written_by === null
          ? null
          : { id: original.written_by, name: original.written_by_name ?? '' },
      current: original.doc_sha256 === docHash(row[p.data.field]),
    };
  });

  app.get('/api/v1/people/mentionable', async (request, reply) => {
    if (!(await requireGlobal(request, reply, 'browse_users'))) return reply;
    const q = mentionQuery.safeParse(request.query);
    if (!q.success) return invalid(reply);
    const ws = request.workspaceId;
    let ticket: TicketRow | undefined;
    let trackId: number | null = null;
    if (q.data.ticket !== undefined) {
      const found = await resolveTicket(db, ws, q.data.ticket);
      ticket = found ? await loadTicket(db, ws, found.id) : undefined;
      if (!ticket || ticket.deleted_at || !(await request.authz.seesTicket(ticket))) {
        return notFound(reply);
      }
      trackId = ticket.track_id;
    } else {
      trackId = await resolveTrack(db, ws, q.data.track as string);
      if (trackId === null || !(await request.authz.can('browse_track', trackId))) {
        return notFound(reply);
      }
    }
    const text = q.data.q
      .trim()
      .replace(/^@/, '')
      .toLowerCase()
      .replace(/[\\%_]/g, (c) => `\\${c}`);
    let query = db
      .selectFrom('app_user')
      .select(['id', 'name'])
      .where('workspace_id', '=', ws)
      .where('deactivated_at', 'is', null)
      .where('kind', '=', 'person');
    if (text !== '') {
      query = query.where((eb) =>
        eb.or([
          sql<boolean>`lower(name) LIKE ${`%${text}%`}`,
          sql<boolean>`lower(email) LIKE ${`${text}%`}`,
        ]),
      );
    }
    // A few more than asked, so those who can see the ticket fill the list first.
    const rows = await query
      .orderBy(sql`lower(name)`)
      .orderBy('id')
      .limit(q.data.limit * 3)
      .execute();
    const people = await Promise.all(
      rows.map(async (r) => {
        const as = authorizer.context(ws, { userId: r.id });
        const canView = ticket
          ? await as.seesTicket(ticket)
          : await as.can('browse_track', trackId as number);
        return { id: r.id, name: r.name, canView };
      }),
    );
    people.sort((a, b) => Number(b.canView) - Number(a.canView));
    return { people: people.slice(0, q.data.limit) };
  });
}
