import type { Database, JsonValue } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import { refusedKeys } from '../clone/run';
import { emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { type FieldShape, parseValue, referencedIds } from '../fields/types';
import { offeredPeople } from '../fields/values';
import {
  createTemplateBody,
  expandSummary,
  mergeBody,
  type PatternValues,
  startValues,
  type TemplateDefaults,
  type TemplateSubticket,
  templateSubticket,
  todayIn,
  updateTemplateBody,
} from '../templates/model';
import { type Caller, callRoute } from '../tickets/caller';
import { SUBTICKET_RANK } from '../tickets/hierarchy';
import { canonicalJson } from '../tickets/model';
import {
  docHash,
  type RichTextFormat,
  readRichText,
  requestedFormat,
  writeRichText,
} from '../tickets/rich-text';
import { resolveTrack } from '../tickets/store';
import { ticketRoutes } from './tickets';

/**
 * Ticket templates (CORE-029, CORE-030; ADR-113).
 *
 * - `GET /api/v1/ticket-templates?track=KEY[&ticketTypeId=N]` lists the templates a ticket in
 *   that track may start from: the track's own and those for every track, limited to the type
 *   when one is named. Without `track` it lists the templates for every track. Each says
 *   whether the caller may change it (`mayEdit`), and names who `defaults.assigneeId` assigns
 *   (`assignee`) as the assignee picker would offer them: an active person, to readers who hold
 *   "Browse users and groups"; otherwise `assignee` is null and the id stays in the defaults
 *   (T-283). Who made it (`createdBy`) is named to every reader.
 * - `GET /api/v1/ticket-templates/:id[?track=KEY[&ticketTypeId=N]]` reads one; with a track,
 *   also the values it starts a ticket there with for this person (`start`): the summary pattern
 *   filled in, the dates counted from today in their time zone. `names` gives the names of the
 *   people, groups and teams its custom values name, by body key (`fields.12`), so a form can
 *   show them in its pickers (T-276) and the template form by name (T-299, also without a
 *   track): only those the reader may see, as the pickers would offer them. People and groups
 *   need "Browse users and groups" and people must be active; teams are seen by everyone signed
 *   in. Once the start knows the ticket type (the one named, else the template's first when it
 *   is limited to some, as when a ticket is made; a type the template does not fit is refused),
 *   a person field limited to a group or a track role names exactly the active people its own
 *   list offers there, to every reader (T-284). A value the reader may not see has no name there.
 * - Track templates are seen by those who browse the track and changed by its administrators
 *   ("Administer track") and configuration administrators; templates for every track are seen
 *   by everyone signed in and changed by configuration administrators.
 * - `POST /api/v1/ticket-templates/:id/tickets` creates a ticket from a template through the
 *   ticket create route, as the person: the body is a create body whose values win over the
 *   template's, plus `omit` (template values to leave out) and `subtickets` (false to make
 *   none). A template value the create route refuses for this person or track (an assignee they
 *   may not set, a field a rule hides, a locked field) is left out and listed in `left`; the
 *   person's own values are never left out. Then each of the template's subtickets is made the
 *   same way, under the new ticket; one that fails is listed with its reason, and the ticket
 *   stays.
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015): a
 * ticket made from a template is `ticket.created` with its `templateId`, one per ticket made.
 */
const MAX_INT = 2_147_483_647;
const MAX_TEMPLATES_PER_SCOPE = 500;
const idParam = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) });
const listQuery = z
  .object({
    track: z.string().trim().min(1).max(300).optional(),
    ticketTypeId: z.coerce.number().int().positive().max(MAX_INT).optional(),
    format: z.string().optional(),
  })
  .strict();
const readQuery = z
  .object({
    track: z.string().trim().min(1).max(300).optional(),
    /** The type of the ticket the start is for (T-284); read with a track only. */
    ticketTypeId: z.coerce.number().int().positive().max(MAX_INT).optional(),
    format: z.string().optional(),
  })
  .strict();
/** The apply route's own keys; the rest of its body is a ticket create body. */
const applyOptions = z
  .object({
    omit: z.array(z.string().min(1).max(100)).max(200).optional(),
    subtickets: z.boolean().optional(),
  })
  .passthrough();
/** Body keys never left out, even when they came from the template. */
const KEPT = new Set(['track', 'ticketTypeId', 'summary', 'parent', 'visibilityLevelId']);
const ATTEMPTS = 8;

type TemplateRow = {
  id: number;
  workspace_id: number;
  track_id: number | null;
  name: string;
  purpose: string;
  ticket_type_ids: number[];
  summary: string;
  description: JsonValue | null;
  defaults: JsonValue;
  subtickets: JsonValue;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  version: number;
};

const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });
const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: 'forbidden' });

function shapeErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) fields[[...issue.path, key].join('.')] = 'unknown';
    } else {
      fields[issue.path.join('.') || 'body'] ??= 'invalid';
    }
  }
  return fields;
}

/** Whether a create body carries a key (`fields.12` for a custom field). */
function inBody(body: Record<string, unknown>, key: string): boolean {
  if (key.startsWith('fields.')) {
    const fields = body.fields as Record<string, unknown> | undefined;
    return fields !== undefined && key.slice('fields.'.length) in fields;
  }
  return key in body;
}

/**
 * The ticket type a template starts or makes a ticket of: the one named, else the template's
 * first when it is limited to some, else none (the create route's default type);
 * `not_in_template` for a named type the template does not fit.
 */
function typeFor(
  row: { ticket_type_ids: number[] },
  named: number | undefined,
): number | undefined | 'not_in_template' {
  const limited = row.ticket_type_ids.length > 0;
  if (named === undefined) return limited ? row.ticket_type_ids[0] : undefined;
  return limited && !row.ticket_type_ids.includes(named) ? 'not_in_template' : named;
}

function uniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

export function registerTicketTemplateRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  authorizer: Authorizer,
  catalogs: FieldCatalogs,
): void {
  const createRoute = ticketRoutes(db, authorizer, catalogs).find(
    (r) => r.method === 'POST' && r.url === '/api/v1/tickets',
  );
  if (!createRoute) throw new Error('the ticket create route is missing');

  const selectTemplates = () =>
    db
      .selectFrom('ticket_template')
      .select([
        'id',
        'workspace_id',
        'track_id',
        'name',
        'purpose',
        'ticket_type_ids',
        'summary',
        'description',
        'defaults',
        'subtickets',
        'created_by',
        'created_at',
        'updated_at',
        'version',
      ]);

  async function configAdmin(request: FastifyRequest): Promise<boolean> {
    const held = await request.authz.global();
    return held.has('site_admin') || held.has('configuration_admin');
  }

  /** Who may see a template: its track's browsers, or everyone for a template of every track. */
  async function sees(request: FastifyRequest, row: { track_id: number | null }) {
    return row.track_id === null || (await request.authz.can('browse_track', row.track_id));
  }

  /** Who may change templates of a track (null: of every track). */
  async function mayManage(request: FastifyRequest, trackId: number | null) {
    if (await configAdmin(request)) return true;
    return trackId !== null && (await request.authz.can('administer_track', trackId));
  }

  async function trackInfo(trackIds: readonly number[]) {
    const ids = [...new Set(trackIds)];
    if (ids.length === 0) return new Map<number, { id: number; key: string; name: string }>();
    const rows = await db
      .selectFrom('track')
      .select(['id', 'key', 'name'])
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * The names of the active people among `ids`, by id: those a person picker could offer. Which
   * ids the reader may see named is the caller's to say, by the picker that takes the value
   * (T-276, T-283, T-284): the assignee's and an unrestricted person field's search the site's
   * people, for holders of "Browse users and groups" (`seesDirectory`); a person field limited
   * to a group or a track role offers its own list to anyone who may fill it.
   */
  async function activePeople(
    workspaceId: number,
    ids: Iterable<number>,
  ): Promise<Map<number, string>> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return new Map();
    const rows = await db
      .selectFrom('app_user')
      .select(['id', 'name'])
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', wanted)
      .where('deactivated_at', 'is', null)
      .where('kind', '=', 'person')
      .execute();
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Whether the reader's person pickers search the site's people ("Browse users and groups"). */
  const seesDirectory = (request: FastifyRequest) => request.authz.hasGlobal('browse_users');

  async function views(
    request: FastifyRequest,
    rows: readonly TemplateRow[],
    format: RichTextFormat,
  ) {
    const tracks = await trackInfo(rows.flatMap((r) => (r.track_id === null ? [] : [r.track_id])));
    const assigneeOf = (r: TemplateRow) =>
      (r.defaults as { assigneeId?: number } | null)?.assigneeId ?? null;
    const creators = [
      ...new Set(rows.flatMap((r) => (r.created_by === null ? [] : [r.created_by]))),
    ];
    const names = new Map(
      (creators.length === 0
        ? []
        : await db
            .selectFrom('app_user')
            .select(['id', 'name'])
            .where('id', 'in', creators)
            .execute()
      ).map((u) => [u.id, u.name]),
    );
    // The assignee is named as the assignee picker would offer them (T-283).
    const assignees = (await seesDirectory(request))
      ? await activePeople(
          request.workspaceId,
          rows.flatMap((r) => {
            const id = assigneeOf(r);
            return id === null ? [] : [id];
          }),
        )
      : new Map<number, string>();
    const manage = new Map<number | null, boolean>();
    const out = [];
    for (const r of rows) {
      if (!manage.has(r.track_id)) manage.set(r.track_id, await mayManage(request, r.track_id));
      const assignee = assigneeOf(r);
      out.push({
        id: r.id,
        name: r.name,
        purpose: r.purpose,
        track: r.track_id === null ? null : (tracks.get(r.track_id) ?? null),
        ticketTypeIds: r.ticket_type_ids,
        summary: r.summary,
        description: writeRichText(r.description, format),
        defaults: r.defaults,
        /** Who `defaults.assigneeId` names, so a form can show them; null for one not shown. */
        assignee:
          assignee === null || !assignees.has(assignee)
            ? null
            : { id: assignee, name: assignees.get(assignee) ?? '' },
        subtickets: r.subtickets,
        createdBy:
          r.created_by === null ? null : { id: r.created_by, name: names.get(r.created_by) ?? '' },
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        version: r.version,
        mayEdit: manage.get(r.track_id) === true,
      });
    }
    return out;
  }

  async function findTemplate(request: FastifyRequest, id: number) {
    const row = (await selectTemplates()
      .where('workspace_id', '=', request.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst()) as TemplateRow | undefined;
    if (!row || !(await sees(request, row))) return null;
    return row;
  }

  /**
   * What a template's values refer to, checked against the workspace and, for a track template,
   * the track: problems by body path. Values that depend on the person or the ticket type
   * (assignability, field contexts, rules) are checked when a ticket is made. `stored` is what
   * an edited template already holds: an archived release or area it names stays, as one stays
   * on a ticket that has it, so archiving a release never stops a template's other edits; only
   * one named anew is refused (T-287).
   */
  async function referenceProblems(
    workspaceId: number,
    trackId: number | null,
    typeIds: readonly number[] | undefined,
    defaults: TemplateDefaults | undefined,
    subtickets: readonly TemplateSubticket[] | undefined,
    stored?: JsonValue,
  ): Promise<Record<string, string>> {
    const held = (stored ?? {}) as {
      areaIds?: unknown;
      targetReleaseIds?: unknown;
      foundInReleaseIds?: unknown;
      fields?: Record<string, unknown>;
    };
    const problems: Record<string, string> = {};
    const allTypes = [
      ...(typeIds ?? []),
      ...(subtickets ?? []).flatMap((s) => (s.ticketTypeId ? [s.ticketTypeId] : [])),
    ];
    if (allTypes.length > 0) {
      const found = new Set(
        (
          await db
            .selectFrom('ticket_type')
            .select('id')
            .where('workspace_id', '=', workspaceId)
            .where('id', 'in', [...new Set(allTypes)])
            .execute()
        ).map((t) => t.id),
      );
      (typeIds ?? []).forEach((t, i) => {
        if (!found.has(t)) problems[`ticketTypeIds.${i}`] = 'not_found';
      });
      (subtickets ?? []).forEach((s, i) => {
        if (s.ticketTypeId && !found.has(s.ticketTypeId)) {
          problems[`subtickets.${i}.ticketTypeId`] = 'not_found';
        }
      });
    }
    if (!defaults) return problems;
    if (defaults.priorityId !== undefined) {
      const p = await db
        .selectFrom('priority')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', defaults.priorityId)
        .executeTakeFirst();
      if (!p) problems['defaults.priorityId'] = 'not_found';
    }
    if (defaults.assigneeId !== undefined) {
      const u = await db
        .selectFrom('app_user')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', defaults.assigneeId)
        .where('deactivated_at', 'is', null)
        .executeTakeFirst();
      if (!u) problems['defaults.assigneeId'] = 'not_found';
    }
    // Areas and releases belong to a track: a template for every track cannot name them.
    for (const [key, table] of [
      ['areaIds', 'area'],
      ['targetReleaseIds', 'release'],
      ['foundInReleaseIds', 'release'],
    ] as const) {
      const list = defaults[key];
      if (!list || list.length === 0) continue;
      if (trackId === null) {
        problems[`defaults.${key}`] = 'track_only';
        continue;
      }
      const found = new Map(
        (
          await db
            .selectFrom(table)
            .select(['id', 'archived_at'])
            .where('track_id', '=', trackId)
            .where('id', 'in', list)
            .execute()
        ).map((r) => [r.id, r.archived_at !== null]),
      );
      // An archived one is refused with the create route's code (T-287), as a ticket would be,
      // unless the template already holds it.
      const had = held[key];
      const kept = new Set(Array.isArray(had) ? had : []);
      list.forEach((v, i) => {
        const archived = found.get(v);
        if (archived === undefined) problems[`defaults.${key}.${i}`] = 'not_found';
        else if (archived && !kept.has(v)) problems[`defaults.${key}.${i}`] = 'archived';
      });
    }
    if (defaults.fields) {
      const catalog = await catalogs.get(workspaceId);
      for (const [key, raw] of Object.entries(defaults.fields)) {
        const field = catalog.fields.get(Number(key));
        const type = field?.type;
        if (field === undefined || type === undefined) {
          problems[`defaults.fields.${key}`] = 'not_found';
        } else if (type === 'formula' || type === 'read-only-text') {
          problems[`defaults.fields.${key}`] = 'read_only';
        } else if (type === 'area' || type === 'release') {
          if (trackId === null) problems[`defaults.fields.${key}`] = 'track_only';
          else {
            const had = held.fields?.[key];
            const problem = await trackValueProblem(workspaceId, trackId, field, raw, had);
            if (problem !== null) problems[`defaults.fields.${key}`] = problem;
          }
        }
      }
    }
    return problems;
  }

  /**
   * Why a custom release or area value cannot start a ticket in the track, with the create
   * route's codes (T-287): a value that does not read, one of another track ('not_in_track'),
   * or an archived one ('archived'), which no ticket takes anew (CORE-015, CORE-016), unless the
   * template already holds it (`had`, its stored value for the field).
   */
  async function trackValueProblem(
    workspaceId: number,
    trackId: number,
    field: FieldShape,
    raw: unknown,
    had: unknown,
  ): Promise<string | null> {
    const parsed = parseValue(field, raw);
    if (!parsed.ok) return parsed.problem;
    if (parsed.value === undefined) return null;
    const ids = [...new Set(referencedIds(field, parsed.value))];
    const before = had === undefined || had === null ? undefined : parseValue(field, had);
    const kept = new Set(
      before?.ok && before.value !== undefined ? referencedIds(field, before.value) : [],
    );
    if (ids.length === 0) return null;
    const table = field.type === 'area' ? 'area' : 'release';
    const rows = await db
      .selectFrom(table)
      .select(['id', 'archived_at'])
      .where('workspace_id', '=', workspaceId)
      .where('track_id', '=', trackId)
      .where('id', 'in', ids)
      .execute();
    if (rows.length !== ids.length) return 'not_in_track';
    return rows.some((r) => r.archived_at !== null && !kept.has(r.id)) ? 'archived' : null;
  }

  /** A description outline in the request's format, as stored; a problem by name otherwise. */
  function outline(value: unknown, format: RichTextFormat) {
    if (value === undefined) return { ok: true as const, doc: undefined };
    const read = readRichText(value, format);
    if (!read.ok) return { ok: false as const, problem: read.problem };
    return { ok: true as const, doc: read.text.doc };
  }

  app.get('/api/v1/ticket-templates', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const q = listQuery.safeParse(request.query);
    const format = requestedFormat(request.query);
    if (!q.success || !format) return invalid(reply);
    const ws = request.workspaceId;
    let trackId: number | null = null;
    if (q.data.track !== undefined) {
      trackId = await resolveTrack(db, ws, q.data.track);
      if (trackId === null || !(await request.authz.can('browse_track', trackId))) {
        return notFound(reply);
      }
    }
    let query = selectTemplates().where('workspace_id', '=', ws);
    query =
      trackId === null
        ? query.where('track_id', 'is', null)
        : query.where((eb) => eb.or([eb('track_id', 'is', null), eb('track_id', '=', trackId)]));
    let rows = (await query.orderBy('name').orderBy('id').execute()) as TemplateRow[];
    const typeId = q.data.ticketTypeId;
    if (typeId !== undefined) {
      rows = rows.filter(
        (r) => r.ticket_type_ids.length === 0 || r.ticket_type_ids.includes(typeId),
      );
    }
    return {
      templates: await views(request, rows, format),
      mayCreate: await mayManage(request, trackId),
    };
  });

  app.get('/api/v1/ticket-templates/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    const q = readQuery.safeParse(request.query);
    const format = requestedFormat(request.query);
    if (!p.success || !q.success || !format) return invalid(reply);
    const row = await findTemplate(request, p.data.id);
    if (!row) return notFound(reply);
    const [view] = await views(request, [row], format);
    if (q.data.track === undefined) {
      // Read to edit (T-299): the names of the people, groups and teams its own values name.
      const own = (row.defaults as { fields?: Record<string, unknown> } | null)?.fields;
      return { template: view, names: await startNames(request, { fields: own ?? {} }) };
    }
    const trackId = await resolveTrack(db, request.workspaceId, q.data.track);
    if (
      trackId === null ||
      !(await request.authz.can('browse_track', trackId)) ||
      (row.track_id !== null && row.track_id !== trackId)
    ) {
      return invalidFields(reply, { track: 'not_found' });
    }
    // The ticket's type, as making the ticket picks it (T-284).
    const typeId = typeFor(row, q.data.ticketTypeId);
    if (typeId === 'not_in_template') {
      return invalidFields(reply, { ticketTypeId: 'not_in_template' });
    }
    const track = await db
      .selectFrom('track')
      .select('key')
      .where('id', '=', trackId)
      .executeTakeFirstOrThrow();
    const start = startValues(row, patternValues(user, track.key));
    if (start.description !== undefined) {
      start.description = writeRichText(start.description as JsonValue, format);
    }
    const here = typeId === undefined ? undefined : { trackId, ticketTypeId: typeId };
    return { template: view, start, names: await startNames(request, start, here) };
  });

  /**
   * The names of the people, groups and teams a template's custom values name, by body key, as
   * far as the reader may see them (T-276): the same people and groups the create form's
   * pickers offer (those who hold "Browse users and groups"; active people only), and the
   * site's teams. Once the ticket's track and type are known (`here`), a person field limited
   * to a group or a track role there names exactly the active people its own list offers, to
   * every reader (T-284): one no longer allowed stays unnamed, like an archived release. A value
   * left unnamed is never told apart from one that is gone.
   */
  async function startNames(
    request: FastifyRequest,
    start: Record<string, unknown>,
    here?: { trackId: number; ticketTypeId: number },
  ): Promise<Record<string, { id: number; name: string }[]>> {
    const values = (start.fields ?? {}) as Record<string, unknown>;
    const ws = request.workspaceId;
    const catalog = await catalogs.get(ws);
    const wanted: { key: string; kind: 'user' | 'group' | 'team'; ids: number[] }[] = [];
    for (const [id, value] of Object.entries(values)) {
      const kind = catalog.fields.get(Number(id))?.type;
      if (kind !== 'user' && kind !== 'group' && kind !== 'team') continue;
      const ids = (Array.isArray(value) ? value : [value]).filter(
        (v): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_INT,
      );
      if (ids.length > 0) wanted.push({ key: `fields.${id}`, kind, ids });
    }
    if (wanted.length === 0) return {};
    const browse = await seesDirectory(request);
    // Which of each field's values the reader may see named, by the picker that takes them.
    for (const w of wanted) {
      if (w.kind === 'group') {
        if (!browse) w.ids = [];
        continue;
      }
      if (w.kind !== 'user') continue;
      const offered = here
        ? await offeredPeople(
            db,
            catalog,
            { workspaceId: ws, ...here },
            Number(w.key.slice('fields.'.length)),
          )
        : null;
      if (offered instanceof Set) w.ids = w.ids.filter((id) => offered.has(id));
      else if (!browse) w.ids = [];
    }
    const of = (kind: 'user' | 'group' | 'team') => [
      ...new Set(wanted.filter((w) => w.kind === kind).flatMap((w) => w.ids)),
    ];
    const groups = of('group');
    const teams = of('team');
    const named = new Map<string, string>();
    for (const [id, name] of await activePeople(ws, of('user'))) named.set(`user:${id}`, name);
    if (groups.length > 0) {
      const rows = await db
        .selectFrom('user_group')
        .select(['id', 'name'])
        .where('workspace_id', '=', ws)
        .where('id', 'in', groups)
        .execute();
      for (const r of rows) named.set(`group:${r.id}`, r.name);
    }
    if (teams.length > 0) {
      const rows = await db
        .selectFrom('team')
        .select(['id', 'name'])
        .where('workspace_id', '=', ws)
        .where('id', 'in', teams)
        .execute();
      for (const r of rows) named.set(`team:${r.id}`, r.name);
    }
    const out: Record<string, { id: number; name: string }[]> = {};
    for (const { key, kind, ids } of wanted) {
      const list = ids.flatMap((id) => {
        const name = named.get(`${kind}:${id}`);
        return name === undefined ? [] : [{ id, name }];
      });
      if (list.length > 0) out[key] = list;
    }
    return out;
  }

  const patternValues = (
    user: { name: string; timeZone: string | null },
    trackKey: string,
  ): PatternValues => ({ date: todayIn(user.timeZone), track: trackKey, user: user.name });

  app.post('/api/v1/ticket-templates', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const format = requestedFormat(request.query);
    if (!format) return invalid(reply);
    const parsed = createTemplateBody.safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    let trackId: number | null = null;
    if (body.track != null) {
      trackId = await resolveTrack(db, ws, body.track);
      if (trackId === null || !(await request.authz.can('browse_track', trackId))) {
        return invalidFields(reply, { track: 'not_found' });
      }
      const track = await db
        .selectFrom('track')
        .select('archived_at')
        .where('id', '=', trackId)
        .executeTakeFirstOrThrow();
      if (track.archived_at) return reply.code(409).send({ error: 'track_archived' });
    }
    if (!(await mayManage(request, trackId))) return forbidden(reply);
    const text = outline(body.description, format);
    if (!text.ok) return invalidFields(reply, { description: text.problem });
    const problems = await referenceProblems(
      ws,
      trackId,
      body.ticketTypeIds,
      body.defaults,
      body.subtickets,
    );
    if (Object.keys(problems).length > 0) return invalidFields(reply, problems);
    try {
      const outcome = await db.transaction().execute(async (trx) => {
        let count = trx
          .selectFrom('ticket_template')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('workspace_id', '=', ws);
        count =
          trackId === null
            ? count.where('track_id', 'is', null)
            : count.where('track_id', '=', trackId);
        if (Number((await count.executeTakeFirstOrThrow()).n) >= MAX_TEMPLATES_PER_SCOPE) {
          return null;
        }
        const row = (await trx
          .insertInto('ticket_template')
          .values({
            workspace_id: ws,
            track_id: trackId,
            name: body.name,
            purpose: body.purpose ?? '',
            ticket_type_ids: body.ticketTypeIds ?? [],
            summary: body.summary ?? '',
            description: text.doc == null ? null : JSON.stringify(text.doc),
            defaults: JSON.stringify(body.defaults ?? {}),
            subtickets: JSON.stringify(body.subtickets ?? []),
            created_by: user.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow()) as TemplateRow;
        await emit(
          trx,
          { workspaceId: ws, actorId: user.id },
          {
            type: 'ticket_template.created',
            subjectId: row.id,
            payload: { name: row.name, trackId },
          },
        );
        return row;
      });
      if (!outcome) {
        return reply.code(409).send({ error: 'limit_reached', limit: MAX_TEMPLATES_PER_SCOPE });
      }
      const [view] = await views(request, [outcome], format);
      return reply.code(201).send({ template: view });
    } catch (error) {
      if (uniqueViolation(error)) return invalidFields(reply, { name: 'taken' });
      throw error;
    }
  });

  app.patch('/api/v1/ticket-templates/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    const format = requestedFormat(request.query);
    if (!p.success || !format) return invalid(reply);
    const parsed = updateTemplateBody.safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    const row = await findTemplate(request, p.data.id);
    if (!row) return notFound(reply);
    if (!(await mayManage(request, row.track_id))) return forbidden(reply);
    const text = outline(body.description, format);
    if (!text.ok) return invalidFields(reply, { description: text.problem });
    const problems = await referenceProblems(
      ws,
      row.track_id,
      body.ticketTypeIds,
      body.defaults,
      body.subtickets,
      row.defaults,
    );
    if (Object.keys(problems).length > 0) return invalidFields(reply, problems);
    try {
      const outcome = await db.transaction().execute(async (trx) => {
        const now = (await trx
          .selectFrom('ticket_template')
          .selectAll()
          .where('id', '=', row.id)
          .forUpdate()
          .executeTakeFirst()) as TemplateRow | undefined;
        if (!now) return 'missing' as const;
        if (body.version !== undefined && body.version !== now.version) {
          return 'conflict' as const;
        }
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        const set: Record<string, unknown> = {};
        const change = (name: string, column: string, from: unknown, to: unknown, stored = to) => {
          if (to === undefined) return;
          if (canonicalJson(from as JsonValue) === canonicalJson(to as JsonValue)) return;
          changes[name] = { from, to };
          set[column] = stored;
        };
        change('name', 'name', now.name, body.name);
        change('purpose', 'purpose', now.purpose, body.purpose);
        change('ticketTypeIds', 'ticket_type_ids', now.ticket_type_ids, body.ticketTypeIds);
        change('summary', 'summary', now.summary, body.summary);
        change(
          'defaults',
          'defaults',
          now.defaults,
          body.defaults,
          body.defaults && JSON.stringify(body.defaults),
        );
        change(
          'subtickets',
          'subtickets',
          now.subtickets,
          body.subtickets,
          body.subtickets && JSON.stringify(body.subtickets),
        );
        if (text.doc !== undefined && canonicalJson(text.doc) !== canonicalJson(now.description)) {
          // The documents' hashes, not the documents: an outline can be long.
          changes.description = {
            from: now.description === null ? null : docHash(now.description),
            to: text.doc === null ? null : docHash(text.doc),
          };
          set.description = text.doc === null ? null : JSON.stringify(text.doc);
        }
        if (Object.keys(changes).length === 0) return now;
        const updated = (await trx
          .updateTable('ticket_template')
          .set({ ...set, updated_at: new Date(), version: now.version + 1 })
          .where('id', '=', now.id)
          .returningAll()
          .executeTakeFirstOrThrow()) as TemplateRow;
        await emit(
          trx,
          { workspaceId: ws, actorId: user.id },
          { type: 'ticket_template.updated', subjectId: now.id, payload: { changes } },
        );
        return updated;
      });
      if (outcome === 'missing') return notFound(reply);
      if (outcome === 'conflict') return reply.code(409).send({ error: 'version_conflict' });
      const [view] = await views(request, [outcome], format);
      return { template: view };
    } catch (error) {
      if (uniqueViolation(error)) return invalidFields(reply, { name: 'taken' });
      throw error;
    }
  });

  app.delete('/api/v1/ticket-templates/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const ws = request.workspaceId;
    const row = await findTemplate(request, p.data.id);
    if (!row) return notFound(reply);
    if (!(await mayManage(request, row.track_id))) return forbidden(reply);
    const gone = await db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom('ticket_template')
        .where('id', '=', row.id)
        .returning(['id', 'name', 'track_id'])
        .executeTakeFirst();
      if (!deleted) return false;
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        {
          type: 'ticket_template.deleted',
          subjectId: deleted.id,
          payload: { name: deleted.name, trackId: deleted.track_id },
        },
      );
      return true;
    });
    if (!gone) return notFound(reply);
    return reply.code(204).send();
  });

  /** The first type the track offers at the subticket level, in its set's order. */
  async function subticketType(trackId: number): Promise<number | null> {
    const row = await db
      .selectFrom('track as t')
      .innerJoin('type_set_member as m', 'm.type_set_id', 't.type_set_id')
      .innerJoin('ticket_type as ty', 'ty.id', 'm.ticket_type_id')
      .innerJoin('hierarchy_level as l', 'l.id', 'ty.level_id')
      .select('ty.id')
      .where('t.id', '=', trackId)
      .where('l.rank', '=', SUBTICKET_RANK)
      .orderBy('m.sort_order')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  app.post('/api/v1/ticket-templates/:id/tickets', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const parsed = applyOptions.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const {
      omit,
      subtickets: withSubtickets,
      ...given
    } = parsed.data as {
      omit?: string[];
      subtickets?: boolean;
    } & Record<string, unknown>;
    const ws = request.workspaceId;
    const row = await findTemplate(request, p.data.id);
    if (!row) return notFound(reply);
    // The track: the template's own, or the one named for a template of every track.
    const trackRef = (given.track ?? row.track_id) as string | number | null | undefined;
    if (trackRef == null || (typeof trackRef !== 'string' && typeof trackRef !== 'number')) {
      return invalidFields(reply, { track: 'required' });
    }
    const trackId = await resolveTrack(db, ws, trackRef);
    if (trackId === null || !(await request.authz.can('browse_track', trackId))) {
      return invalidFields(reply, { track: 'not_found' });
    }
    if (row.track_id !== null && row.track_id !== trackId) {
      return invalidFields(reply, { track: 'not_template_track' });
    }
    // The type: the one named, else the template's first when it is limited to some.
    const typeId = typeFor(row, given.ticketTypeId as number | undefined);
    if (typeId === 'not_in_template') {
      return invalidFields(reply, { ticketTypeId: 'not_in_template' });
    }
    const track = await db
      .selectFrom('track')
      .select('key')
      .where('id', '=', trackId)
      .executeTakeFirstOrThrow();
    const pattern = patternValues(user, track.key);
    const start = startValues(row, pattern);
    const merged = mergeBody(start, given, new Set(omit ?? []));
    const body: Record<string, unknown> = {
      ...merged.body,
      track: trackId,
      ...(typeId !== undefined ? { ticketTypeId: typeId } : {}),
    };
    const caller = (b: unknown): Caller => ({
      workspaceId: ws,
      user: request.user,
      authz: request.authz,
      apiToken: request.apiToken,
      params: {},
      query: request.query,
      body: b,
      ticketTemplateId: row.id,
    });

    // The ticket, leaving out the template's values the create route refuses.
    const left: string[] = [];
    let answer = await callRoute(createRoute, caller(body));
    for (let attempt = 1; answer.statusCode !== 201 && attempt < ATTEMPTS; attempt++) {
      // A refused permission names every key it covers: only those the body carries count.
      const keys = (refusedKeys(answer) ?? []).filter((k) => inBody(body, k));
      if (keys.length === 0 || keys.some((k) => KEPT.has(k) || !merged.fromTemplate.has(k))) {
        break;
      }
      for (const key of keys) {
        const custom = key.startsWith('fields.') ? key.slice('fields.'.length) : null;
        const fields = body.fields as Record<string, unknown> | undefined;
        if (custom !== null && fields) {
          delete fields[custom];
          if (Object.keys(fields).length === 0) delete body.fields;
        } else {
          delete body[key];
        }
        merged.fromTemplate.delete(key);
        left.push(key);
      }
      answer = await callRoute(createRoute, caller(body));
    }
    if (answer.statusCode !== 201) return reply.code(answer.statusCode).send(answer.payload);
    const made = answer.payload as { ticket: { id: number; key: string } };

    // Its subtickets, each through the create route under it.
    const subs = (Array.isArray(row.subtickets) ? row.subtickets : [])
      .map((s) => templateSubticket.safeParse(s))
      .flatMap((s) => (s.success ? [s.data] : []));
    const results: { summary: string; key: string | null; error: string | null }[] = [];
    if (withSubtickets !== false && subs.length > 0) {
      const fallbackType = await subticketType(trackId);
      for (const sub of subs) {
        const summary = expandSummary(sub.summary, pattern);
        const subType = sub.ticketTypeId ?? fallbackType;
        if (subType === null) {
          results.push({ summary, key: null, error: 'no_subticket_type' });
          continue;
        }
        const res = await callRoute(
          createRoute,
          caller({ track: trackId, ticketTypeId: subType, parent: made.ticket.id, summary }),
        );
        const payload = res.payload as {
          ticket?: { key: string };
          error?: string;
          fields?: Record<string, string>;
        };
        results.push(
          res.statusCode === 201
            ? { summary, key: payload.ticket?.key ?? null, error: null }
            : {
                summary,
                key: null,
                error:
                  payload.error === 'invalid_fields' && payload.fields
                    ? `${Object.keys(payload.fields)[0]}: ${Object.values(payload.fields)[0]}`
                    : (payload.error ?? 'refused'),
              },
        );
      }
    }
    return reply.code(201).send({ ...made, left, subtickets: results });
  });
}
