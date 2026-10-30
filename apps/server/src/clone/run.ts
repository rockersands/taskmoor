import type { Database, JsonValue } from '@taskmoor/db';
import { newObjectKey, type ObjectStore, type PutResult } from '@taskmoor/storage';
import { type Kysely, sql } from 'kysely';
import { dropUpload, keepUpload, registerUpload } from '../attachments/cleanup';
import { queueProcessing } from '../attachments/jobs';
import { attachmentChange } from '../attachments/records';
import { thumbnailable } from '../attachments/sniff';
import type { AttachmentStores } from '../attachments/stores';
import type { SessionUser } from '../auth';
import type { AuthzContext } from '../authz/authorizer';
import { storedError } from '../bulk/model';
import { emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { bodyKey } from '../fields/layouts';
import { customFieldViews } from '../fields/values';
import { linksEnabled } from '../routes/links';
import { type Caller, callRoute, type TicketRoute } from '../tickets/caller';
import { type FieldChange, linkChange, recordChanges } from '../tickets/history';
import { ticketKey } from '../tickets/model';
import { loadTicket, loadTickets, type TicketRow } from '../tickets/store';
import { trackVisibility } from '../tickets/visibility';
import type { CloneParams, CloneResult } from './model';

/**
 * One ticket of a clone (M1-124; CORE-023; ADR-077), run by the bulk job as the person who
 * asked. Items run one at a time, parents before their children.
 *
 * 1. The copy is made through the ticket create route, so it meets exactly the checks, defaults,
 *    workflow, history and events a ticket created by hand does. It takes the original's type,
 *    text, people, dates, priority, labels, estimate and custom values; releases, areas and the
 *    visibility level only within the same track. A value the route refuses for this person or
 *    track (an assignee they may not set, a field the create layout leaves out, a locked field)
 *    is left out and the copy is made without it; the result lists what was left out. A
 *    refusal of anything else (the type, the parent, the visibility level, a required field)
 *    fails the item.
 * 2. In one transaction with the item's outcome: the Copies link from the copy to its original,
 *    then, when asked for and allowed, the original's links (to the other copy when both ends
 *    were copied, by whichever comes second) and web links, and its attachments, whose bytes
 *    are copied first. One `ticket.cloned` event.
 *
 * The copy's id is kept on the item as soon as it exists, so an item cut short goes on from it
 * rather than make a second copy.
 */
export interface CloneDeps {
  db: Kysely<Database>;
  create: TicketRoute;
  catalogs: FieldCatalogs;
  stores: AttachmentStores;
}

export interface CloneItem {
  position: number;
  ticket_id: number | null;
  result_ticket_id: number | null;
  result: JsonValue | null;
}

interface Operation {
  id: string;
  workspace_id: number;
  params: JsonValue;
}

/** Body keys a copy keeps or fails without: never left out. */
const KEPT = new Set(['track', 'ticketTypeId', 'summary', 'parent', 'visibilityLevelId']);
/** Body keys a refused permission names. */
const PERMISSION_KEYS: Record<string, string[]> = {
  assign_tickets: ['assigneeId'],
  modify_requester: ['requesterId'],
  schedule_tickets: ['startDate', 'dueDate'],
};
const ATTEMPTS = 8;

type Answer = { statusCode: number; payload: unknown };

/** The body keys a refusal of a create names, when leaving them out could help; else null. */
function refusedKeys(answer: Answer): string[] | null {
  const body = (answer.payload ?? {}) as {
    error?: string;
    fields?: Record<string, string>;
    permission?: string;
    locks?: { field?: string }[];
  };
  if (answer.statusCode === 400 && body.error === 'invalid_fields' && body.fields) {
    return Object.keys(body.fields);
  }
  if (answer.statusCode === 403 && body.permission === 'edit_field' && body.locks) {
    return body.locks.flatMap((l) => (l.field ? [bodyKey(l.field)] : []));
  }
  if (answer.statusCode === 403 && body.permission && PERMISSION_KEYS[body.permission]) {
    return PERMISSION_KEYS[body.permission] ?? null;
  }
  if (answer.statusCode === 409 && body.error === 'time_tracking_disabled') {
    return ['originalEstimate'];
  }
  return null;
}

/** The create body of a copy of `source`, with everything it could take. */
async function copyBody(
  deps: CloneDeps,
  workspaceId: number,
  params: CloneParams,
  source: TicketRow,
  first: boolean,
  parentId: number | null,
  user: SessionUser,
  authz: AuthzContext,
): Promise<Record<string, unknown>> {
  const { db } = deps;
  const sameTrack = source.track_id === params.track;
  const body: Record<string, unknown> = {
    track: params.track,
    ticketTypeId: source.ticket_type_id,
    summary: first && params.summary !== undefined ? params.summary : source.summary,
  };
  if (parentId !== null) body.parent = parentId;
  if (source.description !== null) body.description = source.description;
  if (source.environment !== null) body.environment = source.environment;
  if (source.assignee_id !== null) body.assigneeId = source.assignee_id;
  // The original's requester for those who may name one; the person cloning otherwise, as for
  // any ticket they create (not a value left out).
  if (
    source.requester_id !== null &&
    source.requester_id !== user.id &&
    (await authz.can('modify_requester', params.track))
  ) {
    body.requesterId = source.requester_id;
  }
  if (source.start_date !== null) body.startDate = source.start_date;
  if (source.due_date !== null) body.dueDate = source.due_date;
  if (source.priority_id !== null) body.priorityId = source.priority_id;
  if (source.labels.length > 0) body.labels = source.labels;
  if (source.original_estimate !== null) body.originalEstimate = source.original_estimate;
  if (sameTrack) {
    // Releases and areas belong to the track: copied there only, and only those still open.
    const releaseIds = [...source.target_releases, ...source.found_releases].map((r) => r.id);
    const open = new Set(
      releaseIds.length === 0
        ? []
        : (
            await db
              .selectFrom('release')
              .select('id')
              .where('id', 'in', releaseIds)
              .where('archived_at', 'is', null)
              .execute()
          ).map((r) => r.id),
    );
    const target = source.target_releases.filter((r) => open.has(r.id)).map((r) => r.id);
    const found = source.found_releases.filter((r) => open.has(r.id)).map((r) => r.id);
    if (target.length > 0) body.targetReleaseIds = target;
    if (found.length > 0) body.foundInReleaseIds = found;
    const areaIds = source.areas.map((a) => a.id);
    const areas =
      areaIds.length === 0
        ? []
        : (
            await db
              .selectFrom('area')
              .select('id')
              .where('id', 'in', areaIds)
              .where('archived_at', 'is', null)
              .execute()
          ).map((a) => a.id);
    if (areas.length > 0) body.areaIds = areas;
    // The original's level, unless it is the one a new ticket takes anyway: a copy is never
    // seen by more people than its original in the same track.
    const visibility = await trackVisibility(db, workspaceId, params.track);
    if (source.visibility_level_id !== visibility.defaultLevelId) {
      body.visibilityLevelId = source.visibility_level_id;
    }
  }
  // Custom values as the API reads them; formulas are computed and read-only text is the
  // integration's own, and a release or area field belongs to the original's track.
  const catalog = await deps.catalogs.get(workspaceId);
  const values = (await customFieldViews(db, workspaceId, catalog, [source])).get(source.id) ?? {};
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const type = catalog.fields.get(Number(key))?.type;
    if (type === undefined || type === 'formula' || type === 'read-only-text') continue;
    if (!sameTrack && (type === 'release' || type === 'area')) continue;
    if (value === null) continue;
    fields[key] = value;
  }
  if (Object.keys(fields).length > 0) body.fields = fields;
  return body;
}

/**
 * Creates the copy through the create route, leaving out what the route refuses when it may be
 * left out. The keys left out go into `left`.
 */
async function createCopy(
  deps: CloneDeps,
  caller: (body: unknown) => Caller,
  body: Record<string, unknown>,
  left: string[],
): Promise<{ id: number } | { refused: Answer }> {
  let answer: Answer = { statusCode: 500, payload: { error: 'internal' } };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    answer = await callRoute(deps.create, caller(body));
    if (answer.statusCode === 201) {
      return { id: (answer.payload as { ticket: { id: number } }).ticket.id };
    }
    const keys = refusedKeys(answer);
    if (!keys || keys.length === 0 || keys.some((k) => KEPT.has(k))) return { refused: answer };
    let dropped = false;
    for (const key of keys) {
      const fields = body.fields as Record<string, unknown> | undefined;
      const custom = key.startsWith('fields.') ? key.slice('fields.'.length) : null;
      if (custom !== null && fields && custom in fields) {
        delete fields[custom];
        if (Object.keys(fields).length === 0) delete body.fields;
      } else if (custom === null && key in body) {
        delete body[key];
      } else {
        continue;
      }
      dropped = true;
      left.push(key);
    }
    // A refusal naming only what the copy does not carry (a required field the original
    // lacks) cannot be helped by leaving more out.
    if (!dropped) return { refused: answer };
  }
  return { refused: answer };
}

async function finishItem(
  db: Kysely<Database>,
  operationId: string,
  position: number,
  outcome: { statusCode: number; error: unknown } | { result: CloneResult },
): Promise<void> {
  const failed = 'error' in outcome;
  await db
    .updateTable('bulk_item')
    .set({
      outcome: failed ? 'failed' : 'done',
      status_code: failed ? outcome.statusCode : 201,
      error: failed ? storedError(outcome.error) : null,
      ...(failed ? {} : { result: JSON.stringify(outcome.result) }),
      finished_at: new Date(),
    })
    .where('operation_id', '=', operationId)
    .where('position', '=', position)
    .where('outcome', 'is', null)
    .execute();
}

/** Copies one item's ticket and records the item's outcome. */
export async function cloneItem(
  deps: CloneDeps,
  op: Operation,
  item: CloneItem,
  user: SessionUser,
  authz: AuthzContext,
): Promise<void> {
  const { db } = deps;
  const ws = op.workspace_id;
  const params = op.params as unknown as CloneParams;
  const fail = (statusCode: number, error: unknown) =>
    finishItem(db, op.id, item.position, { statusCode, error });
  const source = item.ticket_id === null ? undefined : await loadTicket(db, ws, item.ticket_id);
  if (!source || source.deleted_at || !(await authz.seesTicket(source))) {
    return fail(404, { error: 'not_found' });
  }
  const left = [...((item.result as { left?: string[] } | null)?.left ?? [])];
  let copyId = item.result_ticket_id;
  if (copyId === null) {
    // The first copy sits where its original does; the others under their parent's copy.
    let parentId: number | null = null;
    if (item.position === 0) {
      const parent =
        source.parent_id === null ? undefined : await loadTicket(db, ws, source.parent_id);
      if (parent && !parent.deleted_at && (await authz.seesTicket(parent))) parentId = parent.id;
    } else {
      const parent = await db
        .selectFrom('bulk_item')
        .select('result_ticket_id')
        .where('operation_id', '=', op.id)
        .where('ticket_id', '=', source.parent_id)
        .where('outcome', '=', 'done')
        .executeTakeFirst();
      if (!parent?.result_ticket_id) return fail(409, { error: 'parent_not_cloned' });
      parentId = parent.result_ticket_id;
    }
    const body = await copyBody(
      deps,
      ws,
      params,
      source,
      item.position === 0,
      parentId,
      user,
      authz,
    );
    const made = await createCopy(
      deps,
      (b) => ({ workspaceId: ws, user, authz, apiToken: null, params: {}, query: {}, body: b }),
      body,
      left,
    );
    if ('refused' in made) return fail(made.refused.statusCode, made.refused.payload);
    copyId = made.id;
    await db
      .updateTable('bulk_item')
      .set({ result_ticket_id: copyId, result: JSON.stringify({ left }) })
      .where('operation_id', '=', op.id)
      .where('position', '=', item.position)
      .execute();
  }
  const copy = await loadTicket(db, ws, copyId);
  if (!copy || copy.deleted_at) return fail(404, { error: 'copy_gone' });
  await copyRest(deps, op, item.position, params, user, authz, source, copy, left);
}

interface LinkToCopy {
  typeId: number;
  direction: 'outward' | 'inward';
  other: TicketRow;
}

/** Copies the links, web links and attachments, adds the Copies link, and finishes the item. */
async function copyRest(
  deps: CloneDeps,
  op: Operation,
  position: number,
  params: CloneParams,
  user: SessionUser,
  authz: AuthzContext,
  source: TicketRow,
  copy: TicketRow,
  left: string[],
): Promise<void> {
  const { db, stores } = deps;
  const ws = op.workspace_id;
  const linksOn = await linksEnabled(db, ws);
  const mayLink = params.links && linksOn && (await authz.canTicket('link_tickets', copy));
  const store = stores.active;
  const mayAttach =
    params.attachments && store !== null && (await authz.canTicket('create_attachments', copy));

  // The original's links, each to the other end's copy when that was copied first.
  const links: LinkToCopy[] = [];
  let webLinks: {
    url: string;
    title: string;
    summary: string;
    icon_url: string | null;
    relationship: string;
    global_id: string | null;
  }[] = [];
  if (params.links) {
    const rows = await db
      .selectFrom('ticket_link as l')
      .innerJoin('link_type as lt', 'lt.id', 'l.link_type_id')
      .select(['l.link_type_id', 'l.source_id', 'l.target_id', 'lt.is_copy'])
      .where((eb) => eb.or([eb('l.source_id', '=', source.id), eb('l.target_id', '=', source.id)]))
      .orderBy('l.id')
      .execute();
    const theirs = rows
      .filter((r) => !r.is_copy)
      .map((r) => ({
        typeId: r.link_type_id,
        direction: r.source_id === source.id ? ('outward' as const) : ('inward' as const),
        otherId: r.source_id === source.id ? r.target_id : r.source_id,
      }));
    webLinks = await db
      .selectFrom('ticket_web_link')
      .select(['url', 'title', 'summary', 'icon_url', 'relationship', 'global_id'])
      .where('ticket_id', '=', source.id)
      .orderBy('id')
      .execute();
    if (!mayLink) {
      if (theirs.length > 0 || webLinks.length > 0) left.push('links');
      webLinks = [];
    } else if (theirs.length > 0) {
      const otherIds = [...new Set(theirs.map((l) => l.otherId))];
      const copied = new Map(
        (
          await db
            .selectFrom('bulk_item')
            .select(['ticket_id', 'result_ticket_id', 'outcome'])
            .where('operation_id', '=', op.id)
            .where('ticket_id', 'in', otherIds)
            .execute()
        ).map((r) => [r.ticket_id as number, r]),
      );
      const ends = theirs.map((l) => {
        const item = copied.get(l.otherId);
        if (!item) return { ...l, endId: l.otherId };
        // Both ends are being copied: the second to be made links the two copies.
        return { ...l, endId: item.outcome === 'done' ? item.result_ticket_id : null };
      });
      const endIds = ends.flatMap((e) => (e.endId === null ? [] : [e.endId]));
      const rowsById = await loadTickets(db, ws, endIds);
      const visible = await authz.visibleTickets([...rowsById.keys()]);
      for (const e of ends) {
        const other = e.endId === null ? undefined : rowsById.get(e.endId);
        if (!other || other.deleted_at || !visible.has(other.id) || other.id === copy.id) continue;
        links.push({ typeId: e.typeId, direction: e.direction, other });
      }
    }
  }

  // The attachments' bytes, copied before the transaction that keeps them.
  const files: {
    from: { id: number; name: string; declared: string; sniffed: string | null; sha256: string };
    scan: string;
    key: string;
    stored: PutResult;
  }[] = [];
  if (params.attachments) {
    const rows = await db
      .selectFrom('attachment')
      .select([
        'id',
        'name',
        'declared_type',
        'sniffed_type',
        'size',
        'sha256',
        'storage',
        'storage_key',
        'scan_state',
      ])
      .where('ticket_id', '=', source.id)
      .where('scan_state', 'in', ['clean', 'pending'])
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    if (rows.length > 0 && !mayAttach) left.push('attachments');
    if (rows.length > 0 && mayAttach && store) {
      for (const a of rows) {
        const from = stores.stores[a.storage] as ObjectStore | undefined;
        if (!from) continue;
        const key = newObjectKey(ws);
        await registerUpload(db, ws, store.kind, key);
        try {
          const stored = await store.put(key, await from.read(a.storage_key), {
            maxBytes: Number(a.size),
            contentType: a.declared_type,
          });
          files.push({
            from: {
              id: a.id,
              name: a.name,
              declared: a.declared_type,
              sniffed: a.sniffed_type,
              sha256: a.sha256,
            },
            scan: a.scan_state,
            key,
            stored,
          });
        } catch {
          // A file the store cannot read stays behind; the copy goes on without it.
          await dropUpload(db, stores, store.kind, key);
        }
      }
      if (files.length < rows.length) left.push('attachments');
    }
  }

  const keyOf = (row: TicketRow) => ticketKey(row.track_key, row.number);
  const sourceKey = keyOf(source);
  const copyKey = keyOf(copy);
  try {
    const done = await db.transaction().execute(async (trx) => {
      const pending = await trx
        .selectFrom('bulk_item')
        .select('outcome')
        .where('operation_id', '=', op.id)
        .where('position', '=', position)
        .forUpdate()
        .executeTakeFirst();
      if (!pending || pending.outcome !== null) return false;
      const live = await trx
        .selectFrom('ticket')
        .select(['id', 'version'])
        .where('id', 'in', [copy.id, source.id, ...links.map((l) => l.other.id)])
        .where('deleted_at', 'is', null)
        .orderBy('id')
        .forShare()
        .execute();
      const alive = new Set(live.map((r) => r.id));
      if (!alive.has(copy.id)) return 'gone' as const;
      const changes: FieldChange[] = [];
      const linkTypes = new Map(
        (
          await trx
            .selectFrom('link_type')
            .select(['id', 'outward', 'inward', 'is_copy'])
            .where('workspace_id', '=', ws)
            .forKeyShare()
            .execute()
        ).map((t) => [t.id, t]),
      );
      const addLink = async (
        typeId: number,
        sourceId: number,
        targetId: number,
        source: TicketRow,
        target: TicketRow,
      ) => {
        const type = linkTypes.get(typeId);
        if (!type) return null;
        const added = await trx
          .insertInto('ticket_link')
          .values({
            workspace_id: ws,
            link_type_id: typeId,
            source_id: sourceId,
            target_id: targetId,
            created_by: user.id,
          })
          .onConflict((oc) => oc.doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!added) return null;
        changes.push(
          linkChange(
            source.id,
            { typeId, direction: 'outward', phrase: type.outward, otherId: target.id },
            keyOf(target),
            true,
          ),
          linkChange(
            target.id,
            { typeId, direction: 'inward', phrase: type.inward, otherId: source.id },
            keyOf(source),
            true,
          ),
        );
        return added.id;
      };
      // The copy copies its original (CORE-023 (1)), while links are on in the workspace.
      const copyType = [...linkTypes.values()].find((t) => t.is_copy);
      let copyLinkId: number | null = null;
      if (linksOn && copyType && alive.has(source.id)) {
        copyLinkId = await addLink(copyType.id, copy.id, source.id, copy, source);
      }
      let linked = 0;
      for (const l of links) {
        if (!alive.has(l.other.id)) continue;
        const id =
          l.direction === 'outward'
            ? await addLink(l.typeId, copy.id, l.other.id, copy, l.other)
            : await addLink(l.typeId, l.other.id, copy.id, l.other, copy);
        if (id !== null) linked += 1;
      }
      for (const w of webLinks) {
        await trx
          .insertInto('ticket_web_link')
          .values({ workspace_id: ws, ticket_id: copy.id, ...w, created_by: user.id })
          .onConflict((oc) => oc.doNothing())
          .execute();
        changes.push({
          ticketId: copy.id,
          field: 'webLink',
          from: null,
          to: w.url,
          fromDisplay: null,
          toDisplay: w.title,
        });
      }
      let attached = 0;
      const scanning = stores.scanner !== null;
      for (const f of files) {
        if (!(await keepUpload(trx, store?.kind ?? 'local', f.key))) continue;
        // Bytes the original's scan found clean stay clean; anything else is scanned as new.
        const clean = f.scan === 'clean' && f.stored.sha256 === f.from.sha256;
        const scan = clean || !scanning ? 'clean' : 'pending';
        const thumbnail = thumbnailable(f.from.sniffed);
        const row = await trx
          .insertInto('attachment')
          .values({
            workspace_id: ws,
            ticket_id: copy.id,
            name: f.from.name,
            declared_type: f.from.declared,
            sniffed_type: f.from.sniffed,
            size: f.stored.size,
            sha256: f.stored.sha256,
            storage: store?.kind ?? 'local',
            storage_key: f.key,
            scan_state: scan,
            scanned_at: scan === 'clean' ? new Date() : null,
            thumbnail_state: thumbnail ? 'pending' : 'none',
            author_id: user.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (scan === 'pending' || thumbnail) await queueProcessing(trx, ws, row.id);
        changes.push(attachmentChange(copy.id, { id: row.id, name: f.from.name }, true));
        attached += 1;
      }
      if (changes.length > 0) {
        // Every ticket that gained a link or a file has a new version.
        const touched = [...new Set(changes.map((c) => c.ticketId))];
        await sql`UPDATE ticket SET version = version + 1, updated_at = now()
                   WHERE id = ANY(${touched}::int[])`.execute(trx);
        await recordChanges(trx, ws, user.id, changes);
      }
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        {
          type: 'ticket.cloned',
          subjectId: copy.id,
          payload: {
            key: copyKey,
            source: { id: source.id, key: sourceKey },
            operationId: Number(op.id),
            copyLinkId,
            links: linked,
            webLinks: webLinks.length,
            attachments: attached,
          },
        },
      );
      const result: CloneResult = {
        key: copyKey,
        attachments: attached,
        links: linked,
        webLinks: webLinks.length,
        left: [...new Set(left)],
      };
      await trx
        .updateTable('bulk_item')
        .set({
          outcome: 'done',
          status_code: 201,
          error: null,
          result: JSON.stringify(result),
          finished_at: new Date(),
        })
        .where('operation_id', '=', op.id)
        .where('position', '=', position)
        .execute();
      return true;
    });
    if (done !== true) {
      for (const f of files) await dropUpload(db, stores, store?.kind ?? 'local', f.key);
      if (done === 'gone')
        await finishItem(db, op.id, position, { statusCode: 404, error: { error: 'copy_gone' } });
    }
  } catch (error) {
    for (const f of files) await dropUpload(db, stores, store?.kind ?? 'local', f.key);
    throw error;
  }
}
