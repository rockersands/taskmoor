import type { Database } from '@taskmoor/db';
import { knownTimeZone, localDate } from '@taskmoor/query';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { boardScope, compileQuery, type Scope } from '../boards/data';
import type { FieldCatalogs } from '../fields/catalog';
import { notesLanguage, notesTypeName, plannedFor, releasedOn } from '../releases/notes-text';
import { viewerDay, viewerTimeZone } from '../reports/zone';
import { COUNT_CAP, DEFAULT_QUERY_TIMEOUT_MS, prepareSearch, readOnly } from '../search/run';
import { searchPerson, searchRefusal } from './search';

/**
 * The releases hub's reads (M1-050; CORE-016; ADR-061):
 *
 * - `GET /api/v1/releases/:id/overview`: the release's target tickets by stage, its warnings
 *   and its first tickets in rank order. Every count is its query's count through the search
 *   runner as the viewer (as track summaries do, ADR-060), and comes with that query, so the
 *   page links each number to the search that finds the same tickets.
 * - `GET /api/v1/releases/:id/notes`: release notes generated from the closed target tickets
 *   the viewer sees, grouped by ticket type in the order of the track's type set, as data and
 *   as Markdown (`?format=markdown` sends the Markdown as a file; `?timeZone=` gives the day a
 *   release with no release date shipped on, for a link that cannot send the reader's zone).
 *   The Markdown is written in the reader's language (T-283): `?locale=` (the app sends its
 *   page's), else the account's saved language, else English; English and Spanish are written,
 *   any other language reads as English. Its dating sentence, its days in words (T-277) and the
 *   seeded types' headings follow it; names people gave stay as written. Tickets closed with a
 *   reason other than the workspace's first (by default Completed: not planned, duplicates)
 *   are left out and counted by reason.
 *
 * Both read as anyone who may browse the release's track; nothing here changes a release.
 */
const MAX_INT = 2_147_483_647;
const idParam = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) }).strict();
const notesQuery = z
  .object({
    format: z.enum(['json', 'markdown']).default('json'),
    /** The reader's zone, for a link that cannot send the header (the Markdown file, T-277). */
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine((zone) => knownTimeZone(zone))
      .optional(),
    /** The language to write the Markdown in, a BCP 47 tag: the page's (T-283). */
    locale: z
      .string()
      .max(35)
      .regex(/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/)
      .optional(),
  })
  .strict();
/** How many tickets the overview lists; the counts cover them all. */
const LISTED = 200;
/** How many closed tickets the notes take; more and the notes say they are cut. */
const NOTES_CAP = 5000;

export interface ReleaseHubOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

/** A counted query: how many tickets the viewer's search finds, capped like the search page. */
export interface Counted {
  query: string;
  count: number;
  exact: boolean;
}

export type WarningCode =
  | 'overdue'
  | 'open_after_ship'
  | 'unassigned'
  | 'open_found'
  | 'no_approvers'
  | 'approvals_waiting'
  | 'approval_declined'
  /** Its day differs from its release across tracks' (PLN-007): said in words, with Align. */
  | 'cross_track_out_of_step';

interface Warning {
  code: WarningCode;
  count: number;
  /** The search that finds the tickets concerned; absent for approvals. */
  query?: string;
}

type Db = Kysely<Database> | Transaction<Database>;

/** A query's count as the search page would say it, read as the viewer. */
export async function countQuery(
  db: Kysely<Database>,
  timeoutMs: number,
  request: FastifyRequest,
  scope: Scope,
  q: string,
): Promise<Counted> {
  const { compiled } = await prepareSearch({
    db,
    workspaceId: scope.ws,
    catalog: scope.catalog,
    catalogue: scope.catalogue,
    filter: scope.filter,
    q,
    ...searchPerson(request),
  });
  const n = await readOnly(db, timeoutMs, async (trx) => {
    const { rows } = await compiled.count(COUNT_CAP + 1).execute(trx);
    return rows[0]?.n ?? 0;
  });
  return { query: q, count: Math.min(n, COUNT_CAP), exact: n <= COUNT_CAP };
}

/** The first tickets of a condition in rank order, and whether there are more. */
export async function listTicketsWhere(trx: Db, where: RawBuilder<boolean>) {
  const { rows } = await sql<{
    id: number;
    key: string;
    summary: string;
    type: string;
    status: string;
    stage: 'new' | 'active' | 'closed';
    assignee: string | null;
  }>`
    SELECT k.id, t.key || '-' || k.number AS key, k.summary, y.name AS type,
           s.name AS status, s.stage, u.name AS assignee
      FROM ticket k
      JOIN track t ON t.id = k.track_id
      JOIN status s ON s.id = k.status_id
      JOIN ticket_type y ON y.id = k.ticket_type_id
      LEFT JOIN app_user u ON u.id = k.assignee_id
     WHERE ${where}
     ORDER BY k.rank
     LIMIT ${LISTED + 1}`.execute(trx);
  return { rows: rows.slice(0, LISTED), truncated: rows.length > LISTED };
}

/** Markdown's own characters in text taken from tickets, escaped so they read as written. */
const escapeMarkdown = (text: string) => text.replace(/[\\`*_[\]<>#|]/g, (c) => `\\${c}`);

export function registerReleaseHubRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: ReleaseHubOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  async function isAdmin(request: FastifyRequest): Promise<boolean> {
    const global = await request.authz.global();
    return global.has('site_admin') || global.has('configuration_admin');
  }

  /** The release, if the caller may browse its track; answers 404 otherwise. */
  async function visibleRelease(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return null;
    }
    const p = idParam.safeParse(request.params);
    const release = p.success
      ? await db
          .selectFrom('release as r')
          .innerJoin('track as t', 't.id', 'r.track_id')
          .select([
            'r.id',
            'r.name',
            'r.description',
            'r.track_id',
            'r.release_date',
            'r.shipped_at',
            'r.archived_at',
            'r.require_approvals',
            't.key as track_key',
            't.name as track_name',
            't.type_set_id',
            't.archived_at as track_archived_at',
          ])
          .where('r.id', '=', p.data.id)
          .where('r.workspace_id', '=', request.workspaceId)
          .where('t.deleted_at', 'is', null)
          .executeTakeFirst()
      : undefined;
    const held = release ? await request.authz.track(release.track_id) : null;
    const sees =
      held &&
      (held.has('browse_track') || held.has('administer_track') || (await isAdmin(request)));
    if (!release || !sees) {
      await reply.code(404).send({ error: 'not_found' });
      return null;
    }
    return release;
  }

  /** A query's count as the search page would say it. */
  const count = (request: FastifyRequest, scope: Scope, q: string) =>
    countQuery(db, timeoutMs, request, scope, q);

  app.get('/api/v1/releases/:id/overview', async (request, reply) => {
    const release = await visibleRelease(request, reply);
    if (!release) return reply;
    try {
      const scope = await boardScope(db, options.catalogs, request);
      const base = `targetRelease = ${release.id}`;
      const open = `${base} AND stage != closed`;
      const [newCount, activeCount, closedCount, openCount] = await Promise.all([
        count(request, scope, `${base} AND stage = new`),
        count(request, scope, `${base} AND stage = active`),
        count(request, scope, `${base} AND stage = closed`),
        count(request, scope, open),
      ]);
      const shipped = release.shipped_at !== null;
      // Overdue against the viewer's own day, as their screens say today (T-282).
      const today = viewerDay(request);
      const warnings: Warning[] = [];
      const warn = (code: WarningCode, counted: Counted) => {
        if (counted.count > 0) warnings.push({ code, count: counted.count, query: counted.query });
      };
      if (!shipped && release.release_date !== null && release.release_date < today) {
        warn('overdue', openCount);
      }
      if (shipped) warn('open_after_ship', openCount);
      if (!shipped)
        warn('unassigned', await count(request, scope, `${open} AND assignee IS EMPTY`));
      warn(
        'open_found',
        await count(request, scope, `foundInRelease = ${release.id} AND stage != closed`),
      );
      const approvers = await db
        .selectFrom('release_approver as ra')
        .innerJoin('app_user as u', 'u.id', 'ra.user_id')
        .select(['ra.user_id', 'u.name', 'ra.decision', 'ra.comment', 'ra.decided_at'])
        .where('ra.release_id', '=', release.id)
        .orderBy('u.name')
        .orderBy('ra.user_id')
        .execute();
      if (release.require_approvals && !shipped) {
        const waiting = approvers.filter((a) => a.decision !== 'approved').length;
        const declined = approvers.filter((a) => a.decision === 'declined').length;
        if (approvers.length === 0) warnings.push({ code: 'no_approvers', count: 0 });
        else if (declined > 0) warnings.push({ code: 'approval_declined', count: declined });
        else if (waiting > 0) warnings.push({ code: 'approvals_waiting', count: waiting });
      }
      const where = await compileQuery(db, scope, base, new Date());
      const tickets = await readOnly(db, timeoutMs, (trx) => listTicketsWhere(trx, where));
      // Upcoming with a day other than its release across tracks' fixed day (PLN-007). The track's
      // administrators get Align, which is the release's own change.
      const linked = await db
        .selectFrom('cross_track_release_member as m')
        .innerJoin('cross_track_release as c', 'c.id', 'm.cross_track_release_id')
        .select(sql<string | null>`c.release_date::text`.as('date'))
        .where('m.release_id', '=', release.id)
        .executeTakeFirst();
      if (
        linked?.date &&
        !shipped &&
        release.archived_at === null &&
        release.release_date !== linked.date
      ) {
        warnings.push({ code: 'cross_track_out_of_step', count: 1 });
      }
      const self = request.user?.id;
      const mine = approvers.find((a) => a.user_id === self);
      const mayManage =
        release.track_archived_at === null &&
        ((await request.authz.can('administer_track', release.track_id)) ||
          (await isAdmin(request)));
      return {
        stages: { new: newCount, active: activeCount, closed: closedCount },
        open: openCount,
        warnings,
        approvers: approvers.map((a) => ({
          user: { id: a.user_id, name: a.name },
          decision: a.decision,
          comment: a.comment,
          decidedAt: a.decided_at?.toISOString() ?? null,
        })),
        tickets: tickets.rows,
        truncated: tickets.truncated,
        viewer: {
          mayManage,
          // Whether the viewer is one of the approvers, and what they decided.
          approver: mine ? { decision: mine.decision } : null,
        },
      };
    } catch (error) {
      return searchRefusal(reply as FastifyReply, error, timeoutMs);
    }
  });

  app.get('/api/v1/releases/:id/notes', async (request, reply) => {
    const release = await visibleRelease(request, reply);
    if (!release) return reply;
    const format = notesQuery.safeParse(request.query ?? {});
    if (!format.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const scope = await boardScope(db, options.catalogs, request);
      const where = await compileQuery(
        db,
        scope,
        `targetRelease = ${release.id} AND stage = closed`,
        new Date(),
      );
      const rows = await readOnly(db, timeoutMs, async (trx) => {
        // The workspace's first close reason means done; tickets closed with no reason count too.
        const first = await sql<{ id: number }>`
          SELECT id FROM close_reason WHERE workspace_id = ${request.workspaceId}::int
           ORDER BY sort_order, id LIMIT 1`.execute(trx);
        const done = first.rows[0]?.id ?? null;
        return (
          await sql<{
            id: number;
            key: string;
            summary: string;
            type: string;
            type_order: number | null;
            reason_id: number | null;
            reason: string | null;
            done: boolean;
          }>`
            SELECT k.id, t.key || '-' || k.number AS key, k.summary, y.name AS type,
                   m.sort_order AS type_order, k.close_reason_id AS reason_id, c.name AS reason,
                   (k.close_reason_id IS NULL OR k.close_reason_id = ${done}::int) AS done
              FROM ticket k
              JOIN track t ON t.id = k.track_id
              JOIN ticket_type y ON y.id = k.ticket_type_id
              LEFT JOIN type_set_member m
                     ON m.ticket_type_id = y.id AND m.type_set_id = ${release.type_set_id}::int
              LEFT JOIN close_reason c ON c.id = k.close_reason_id
             WHERE ${where}
             ORDER BY m.sort_order NULLS LAST, y.name, t.key, k.number
             LIMIT ${NOTES_CAP + 1}`.execute(trx)
        ).rows;
      });
      const taken = rows.slice(0, NOTES_CAP);
      const sections: { type: string; tickets: { id: number; key: string; summary: string }[] }[] =
        [];
      const leftOut = new Map<string, number>();
      for (const r of taken) {
        if (!r.done) {
          const reason = r.reason ?? '';
          leftOut.set(reason, (leftOut.get(reason) ?? 0) + 1);
          continue;
        }
        let section = sections[sections.length - 1];
        if (section?.type !== r.type) {
          section = { type: r.type, tickets: [] };
          sections.push(section);
        }
        section.tickets.push({ id: r.id, key: r.key, summary: r.summary });
      }
      // The day it shipped: its release date, or else the day its shipping fell on in the
      // reader's zone, as the release's page says it (T-240, T-277).
      const shippedOn =
        release.shipped_at === null
          ? null
          : (release.release_date ??
            localDate(release.shipped_at, viewerTimeZone(request, format.data.timeZone)));
      const language = notesLanguage(format.data.locale, request.user?.locale);
      const lines = [`# ${escapeMarkdown(`${release.track_name} ${release.name}`)}`, ''];
      if (shippedOn) lines.push(releasedOn(language, shippedOn), '');
      else if (release.release_date) {
        lines.push(plannedFor(language, release.release_date), '');
      }
      if (release.description.trim() !== '') lines.push(release.description.trim(), '');
      for (const s of sections) {
        lines.push(`## ${escapeMarkdown(notesTypeName(language, s.type))}`, '');
        for (const k of s.tickets) lines.push(`- ${k.key} ${escapeMarkdown(k.summary)}`);
        lines.push('');
      }
      const markdown = `${lines.join('\n').trimEnd()}\n`;
      if (format.data.format === 'markdown') {
        const file = `${release.track_key}-${release.name}`.replace(/[^A-Za-z0-9._-]+/g, '-');
        return reply
          .header('content-type', 'text/markdown; charset=utf-8')
          .header('content-disposition', `attachment; filename="${file}-notes.md"`)
          .send(markdown);
      }
      return {
        release: {
          id: release.id,
          name: release.name,
          track: { id: release.track_id, key: release.track_key, name: release.track_name },
          releaseDate: release.release_date,
          shipped: release.shipped_at !== null,
          shippedOn,
        },
        sections,
        leftOut: [...leftOut].map(([reason, n]) => ({ reason, count: n })),
        truncated: rows.length > NOTES_CAP,
        markdown,
      };
    } catch (error) {
      return searchRefusal(reply as FastifyReply, error, timeoutMs);
    }
  });
}
