import { createHash, randomUUID } from 'node:crypto';
import type { Database, JsonValue } from '@taskmoor/db';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import type { AttachmentStores } from '../attachments/stores';
import type { FieldCatalogs } from '../fields/catalog';
import { REFERENCE_OF } from '../fields/types';
import type { EntityKind } from '../import/model';
import {
  type IdMap,
  remapDefinition,
  remapDoc,
  remapFieldConfig,
  remapFieldName,
  remapFields,
  remapHistoryValue,
  remapStored,
} from '../import/remap';
import { canonicalJson } from '../tickets/model';
import {
  ATTACHMENTS_DIR,
  EXPORT_FILES,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  MANIFEST,
  type Manifest,
  manifestSchema,
} from './format';
import type { ExportSink, LineFile } from './sinks';

/**
 * Writes a workspace as Taskmoor's full export (M1-098; IMP-014; ADR-061): every kind of record
 * the format carries, read a keyset page at a time, written as canonical JSON lines to a sink
 * that waits when its reader is behind, so memory stays flat however large the workspace.
 * Attachments are copied from their store as they are, and the manifest goes last with every
 * file's count and checksum.
 *
 * `translate` writes ids as the source of an earlier import knew them, through that import's
 * external ids: exporting the target of an import of an export this way gives the same files
 * as the original export when nothing was lost, which is how the round trip is checked.
 */
type Db = Kysely<Database>;

/** Target ids back to the source's, per kind, from an import's external ids. */
export interface Translation {
  system: string;
  ids: Map<EntityKind, Map<string, string>>;
}

export interface ExportOptions {
  workspaceId: number;
  sink: ExportSink;
  /** Where attachment bytes are read; without stores, attachments are left out. */
  stores: AttachmentStores | null;
  catalogs: FieldCatalogs;
  /** Only these tracks (ids) and what belongs to them; configuration is exported whole. */
  tracks?: readonly number[] | null;
  translate?: Translation | null;
  /** Rows per page. */
  page?: number;
}

export interface ExportResult {
  manifest: Manifest;
  ms: number;
}

const PAGE = 1000;
const INSTANCE_KEY = 'export_system';

/** An instant as text with microseconds, so nothing is lost on the way. */
const ts = (column: string) =>
  sql<
    string | null
  >`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** This instance's name in exports: stable, so a re-import updates instead of duplicating. */
export async function exportSystem(db: Db, workspaceId: number): Promise<string> {
  const read = () =>
    db
      .selectFrom('instance_setting')
      .select('value')
      .where('key', '=', INSTANCE_KEY)
      .executeTakeFirst();
  let row = await read();
  if (!row) {
    await db
      .insertInto('instance_setting')
      .values({ key: INSTANCE_KEY, value: JSON.stringify({ id: randomUUID() }) })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
    row = await read();
  }
  const id = (row?.value as { id?: string } | undefined)?.id ?? 'unknown';
  const ws = await db
    .selectFrom('workspace')
    .select('key')
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow();
  return `taskmoor:${id}:${ws.key}`;
}

/** The translation of an import's targets back to its source's ids. */
export async function translationOf(
  db: Db,
  workspaceId: number,
  importSource: string,
  system: string,
): Promise<Translation> {
  const ids = new Map<EntityKind, Map<string, string>>();
  let after = { kind: '', id: '' };
  for (;;) {
    const rows = await db
      .selectFrom('import_external_id')
      .select(['entity_kind', 'source_id', 'target_id'])
      .where('workspace_id', '=', workspaceId)
      .where('import_source', '=', importSource)
      .where('source_system', '=', system)
      .where((eb) =>
        eb.or([
          eb('entity_kind', '>', after.kind),
          eb.and([eb('entity_kind', '=', after.kind), eb('source_id', '>', after.id)]),
        ]),
      )
      .orderBy('entity_kind')
      .orderBy('source_id')
      .limit(10_000)
      .execute();
    if (rows.length === 0) break;
    for (const r of rows) {
      const kind = r.entity_kind as EntityKind;
      const map = ids.get(kind) ?? new Map<string, string>();
      ids.set(kind, map);
      map.set(String(r.target_id), r.source_id);
    }
    const last = rows[rows.length - 1] as (typeof rows)[number];
    after = { kind: last.entity_kind, id: last.source_id };
  }
  return { system, ids };
}

/** Writes the export; the sink's `finish` is the caller's. */
export async function exportWorkspace(db: Db, options: ExportOptions): Promise<ExportResult> {
  const started = performance.now();
  const ws = options.workspaceId;
  const page = options.page ?? PAGE;
  const sink = options.sink;
  const translation = options.translate ?? null;
  const catalog = await options.catalogs.get(ws, db);

  /** An id as the export writes it: the source's, through the translation when there is one. */
  const idOf = (kind: EntityKind, id: number | string): string => {
    if (!translation) return String(id);
    return translation.ids.get(kind)?.get(String(id)) ?? `unmapped:${id}`;
  };
  const ref = (kind: EntityKind, id: number | string | null): string | null =>
    id === null ? null : idOf(kind, id);
  /** References sorted by the ids written, as sets are compared. */
  const refs = (kind: EntityKind, ids: readonly (number | string)[]): string[] =>
    ids.map((id) => idOf(kind, id)).sort(byId);
  const map: IdMap | null = translation
    ? {
        id: (kind, id) => translation.ids.get(kind)?.get(id) ?? null,
        field: (id) => catalog.fields.get(Number(id)),
      }
    : null;
  const stored = (value: JsonValue, walk: (v: JsonValue, m: IdMap) => JsonValue) =>
    map ? walk(value, map) : value;

  const tracks = await db
    .selectFrom('track')
    .select(['id', 'key'])
    .where('workspace_id', '=', ws)
    .where('deleted_at', 'is', null)
    .$if(options.tracks != null, (q) =>
      // No tracks chosen: configuration only (an empty list is not valid SQL).
      q.where('id', 'in', options.tracks?.length ? [...options.tracks] : [0]),
    )
    .orderBy('id')
    .execute();
  const trackIds = tracks.map((t) => t.id);
  const inTracks = (column: string): RawBuilder<boolean> =>
    trackIds.length === 0
      ? sql<boolean>`false`
      : sql<boolean>`${sql.ref(column)} = ANY(${trackIds}::int[])`;
  const trackSet = new Set(trackIds);

  const files: Manifest['files'] = [];
  const write = async (
    kind: EntityKind,
    fill: (out: { record: (r: Record<string, unknown>) => Promise<void> }) => Promise<void>,
  ) => {
    const name = EXPORT_FILES.find((f) => f.kind === kind)?.file as string;
    const file: LineFile = await sink.open(name);
    let records = 0;
    await fill({
      record: async (r) => {
        records += 1;
        await file.line(canonicalJson(r));
      },
    });
    const written = await file.close();
    files.push({ name, kind, records, ...written });
  };

  /** Pages of rows by id; `query(after)` gives the next page after an id. */
  async function paged<R extends { id: number }>(
    query: (after: number, limit: number) => Promise<R[]>,
    each: (rows: R[]) => Promise<void>,
  ) {
    let after = 0;
    for (;;) {
      const rows = await query(after, page);
      if (rows.length === 0) return;
      await each(rows);
      after = (rows[rows.length - 1] as R).id;
      if (rows.length < page) return;
    }
  }

  // --- People and configuration (small: read whole) ------------------------------------------

  await write('user', async (out) => {
    // Service accounts hold API tokens and stay with their instance.
    await paged(
      (after, limit) =>
        db
          .selectFrom('app_user')
          .select(['id', 'email', 'name', 'time_zone', 'locale'])
          .select(sql<boolean>`deactivated_at IS NULL`.as('active'))
          .where('workspace_id', '=', ws)
          .where('kind', '=', 'person')
          .where('id', '>', after)
          .orderBy('id')
          .limit(limit)
          .execute(),
      async (rows) => {
        for (const u of rows) {
          await out.record({
            id: idOf('user', u.id),
            email: u.email,
            name: u.name,
            active: u.active,
            timeZone: u.time_zone,
            locale: u.locale,
          });
        }
      },
    );
  });

  await write('group', async (out) => {
    const rows = await db
      .selectFrom('user_group as g')
      .select(['g.id', 'g.name', 'g.description'])
      .select(
        sql<number[]>`coalesce((SELECT array_agg(m.user_id) FROM group_member m
          JOIN app_user u ON u.id = m.user_id AND u.kind = 'person'
          WHERE m.group_id = g.id), '{}')`.as('members'),
      )
      .where('g.workspace_id', '=', ws)
      .orderBy('g.id')
      .execute();
    for (const g of rows) {
      await out.record({
        id: idOf('group', g.id),
        name: g.name,
        description: g.description,
        members: refs('user', g.members),
      });
    }
  });

  await write('role', async (out) => {
    const rows = await db
      .selectFrom('role')
      .select(['id', 'name', 'description'])
      .where('workspace_id', '=', ws)
      .orderBy('id')
      .execute();
    for (const r of rows) {
      await out.record({ id: idOf('role', r.id), name: r.name, description: r.description });
    }
  });

  await write('status', async (out) => {
    const rows = await db
      .selectFrom('status')
      .select(['id', 'name', 'description', 'stage'])
      .where('workspace_id', '=', ws)
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
    for (const s of rows) {
      await out.record({
        id: idOf('status', s.id),
        name: s.name,
        description: s.description,
        stage: s.stage,
      });
    }
  });

  await write('priority', async (out) => {
    const rows = await db
      .selectFrom('priority')
      .select(['id', 'name', 'description', 'icon', 'color'])
      .where('workspace_id', '=', ws)
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
    for (const p of rows) {
      await out.record({
        id: idOf('priority', p.id),
        name: p.name,
        description: p.description,
        icon: p.icon,
        color: p.color,
      });
    }
  });

  await write('close_reason', async (out) => {
    const rows = await db
      .selectFrom('close_reason')
      .select(['id', 'name', 'description'])
      .where('workspace_id', '=', ws)
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
    for (const c of rows) {
      await out.record({
        id: idOf('close_reason', c.id),
        name: c.name,
        description: c.description,
      });
    }
  });

  await write('ticket_type', async (out) => {
    const rows = await db
      .selectFrom('ticket_type as t')
      .innerJoin('hierarchy_level as l', 'l.id', 't.level_id')
      .select(['t.id', 't.name', 't.description', 't.icon', 't.color', 'l.kind as level'])
      .where('t.workspace_id', '=', ws)
      .orderBy('t.id')
      .execute();
    for (const t of rows) {
      await out.record({
        id: idOf('ticket_type', t.id),
        name: t.name,
        description: t.description,
        icon: t.icon,
        color: t.color,
        level: t.level,
      });
    }
  });

  await write('link_type', async (out) => {
    const rows = await db
      .selectFrom('link_type')
      .select(['id', 'name', 'outward', 'inward'])
      .where('workspace_id', '=', ws)
      .orderBy('id')
      .execute();
    for (const l of rows) {
      await out.record({
        id: idOf('link_type', l.id),
        name: l.name,
        outward: l.outward,
        inward: l.inward,
      });
    }
  });

  await write('track', async (out) => {
    const rows = await db
      .selectFrom('track as t')
      .leftJoin('ticket_counter as c', 'c.track_id', 't.id')
      .select([
        't.id',
        't.key',
        't.name',
        't.description',
        't.type',
        't.mode',
        't.owner_id',
        't.icon',
        't.color',
        sql<number>`coalesce(c.last_number, 0)`.as('last_number'),
      ])
      .where('t.workspace_id', '=', ws)
      .where(inTracks('t.id'))
      .orderBy('t.id')
      .execute();
    for (const t of rows) {
      await out.record({
        id: idOf('track', t.id),
        key: t.key,
        name: t.name,
        description: t.description,
        type: t.type,
        mode: t.mode,
        owner: ref('user', t.owner_id),
        icon: t.icon,
        color: t.color,
        lastNumber: t.last_number,
      });
    }
  });

  await write('release', async (out) => {
    const rows = await db
      .selectFrom('release')
      .select(['id', 'track_id', 'name', 'description', 'start_date', 'release_date'])
      .select([ts('shipped_at').as('shipped_at'), ts('archived_at').as('archived_at')])
      .where('workspace_id', '=', ws)
      .where(inTracks('track_id'))
      .orderBy('track_id')
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
    for (const r of rows) {
      await out.record({
        id: idOf('release', r.id),
        track: idOf('track', r.track_id),
        name: r.name,
        description: r.description,
        startDate: r.start_date,
        releaseDate: r.release_date,
        shippedAt: r.shipped_at,
        archivedAt: r.archived_at,
      });
    }
  });

  await write('area', async (out) => {
    const rows = await db
      .selectFrom('area')
      .select(['id', 'track_id', 'name', 'description', 'owner_id', 'default_assignee'])
      .select(ts('archived_at').as('archived_at'))
      .where('workspace_id', '=', ws)
      .where(inTracks('track_id'))
      .orderBy('track_id')
      .orderBy('id')
      .execute();
    for (const a of rows) {
      await out.record({
        id: idOf('area', a.id),
        track: idOf('track', a.track_id),
        name: a.name,
        description: a.description,
        owner: ref('user', a.owner_id),
        defaultAssignee: a.default_assignee,
        archivedAt: a.archived_at,
      });
    }
  });

  await write('field', async (out) => {
    const rows = await db
      .selectFrom('field')
      .select(['id', 'name', 'description', 'type', 'multiple', 'config', 'track_id'])
      .where('workspace_id', '=', ws)
      .where((eb) => eb.or([eb('track_id', 'is', null), inTracks('track_id')]))
      .orderBy('id')
      .execute();
    for (const f of rows) {
      await out.record({
        id: idOf('field', f.id),
        name: f.name,
        description: f.description,
        type: f.type,
        multiple: f.multiple,
        config: map ? remapFieldConfig(f.config, map) : f.config,
        track: ref('track', f.track_id),
      });
    }
  });

  /** Options that are (part of) their context's default. */
  const defaults = new Set<number>();
  await write('field_context', async (out) => {
    const rows = await db
      .selectFrom('field_context as c')
      .innerJoin('field as f', 'f.id', 'c.field_id')
      .select(['c.id', 'c.field_id', 'c.name', 'c.description', 'c.default_value', 'c.config'])
      .select(
        sql<{ track: number | null; type: number | null }[]>`coalesce((SELECT json_agg(
            json_build_object('track', s.track_id, 'type', s.ticket_type_id))
          FROM field_context_scope s WHERE s.context_id = c.id), '[]')`.as('scopes'),
      )
      .where('c.workspace_id', '=', ws)
      .where((eb) => eb.or([eb('f.track_id', 'is', null), inTracks('f.track_id')]))
      .orderBy('c.id')
      .execute();
    for (const c of rows) {
      // Scopes on tracks left out of the export are dropped; a context left with none of its
      // own tracks would apply everywhere, so it is left out.
      const scopes = c.scopes.filter((s) => s.track === null || trackSet.has(s.track));
      if (c.scopes.length > 0 && scopes.length === 0) continue;
      const shape = catalog.fields.get(c.field_id);
      // A default of options is written on the options (they come after their contexts).
      const ofOptions = shape !== undefined && REFERENCE_OF[shape.type] === 'option';
      if (ofOptions && c.default_value !== null) {
        const ids = Array.isArray(c.default_value) ? c.default_value : [c.default_value];
        for (const id of ids) defaults.add(Number(id));
      }
      await out.record({
        id: idOf('field_context', c.id),
        field: idOf('field', c.field_id),
        name: c.name,
        description: c.description,
        defaultValue:
          c.default_value === null || ofOptions
            ? null
            : !map || !shape
              ? c.default_value
              : (remapStored(shape, c.default_value, map) ?? null),
        config: c.config,
        scopes: scopes
          .map((s) => ({ track: ref('track', s.track), type: ref('ticket_type', s.type) }))
          .sort(
            (a, b) => byId(a.track ?? '0', b.track ?? '0') || byId(a.type ?? '0', b.type ?? '0'),
          ),
      });
    }
  });

  await write('field_option', async (out) => {
    const rows = await db
      .selectFrom('field_option as o')
      .innerJoin('field as f', 'f.id', 'o.field_id')
      .select(['o.id', 'o.context_id', 'o.parent_id', 'o.value', 'o.sort_order', 'o.disabled'])
      .where('o.workspace_id', '=', ws)
      .where((eb) => eb.or([eb('f.track_id', 'is', null), inTracks('f.track_id')]))
      // Parents before children: a child names its parent.
      .orderBy(sql`o.parent_id IS NOT NULL`)
      .orderBy('o.id')
      .execute();
    for (const o of rows) {
      await out.record({
        id: idOf('field_option', o.id),
        context: idOf('field_context', o.context_id),
        parent: ref('field_option', o.parent_id),
        value: o.value,
        sortOrder: o.sort_order,
        disabled: o.disabled,
        default: defaults.has(o.id),
      });
    }
  });

  await write('workflow', async (out) => {
    const rows = await db
      .selectFrom('workflow as w')
      .innerJoin('workflow_version as v', (j) =>
        j.onRef('v.workflow_id', '=', 'w.id').onRef('v.version', '=', 'w.published_version'),
      )
      .select(['w.id', 'w.name', 'w.description', 'w.is_default', 'v.definition'])
      .where('w.workspace_id', '=', ws)
      .where('w.owner_track_id', 'is', null)
      .orderBy('w.id')
      .execute();
    for (const w of rows) {
      await out.record({
        id: idOf('workflow', w.id),
        name: w.name,
        description: w.description,
        isDefault: w.is_default,
        definition: stored(w.definition, remapDefinition),
      });
    }
  });

  await write('workflow_map', async (out) => {
    const rows = await db
      .selectFrom('workflow_map as m')
      .select(['m.id', 'm.name', 'm.description', 'm.is_default', 'm.default_workflow_id'])
      .select(
        sql<{ type: number; workflow: number }[]>`coalesce((SELECT json_agg(json_build_object(
            'type', e.ticket_type_id, 'workflow', e.workflow_id))
          FROM workflow_map_entry e WHERE e.map_id = m.id), '[]')`.as('entries'),
      )
      .select(
        sql<number[]>`coalesce((SELECT array_agg(t.id) FROM track t
          WHERE t.workflow_map_id = m.id AND t.deleted_at IS NULL), '{}')`.as('tracks'),
      )
      .where('m.workspace_id', '=', ws)
      .where('m.owner_track_id', 'is', null)
      .orderBy('m.id')
      .execute();
    for (const m of rows) {
      await out.record({
        id: idOf('workflow_map', m.id),
        name: m.name,
        description: m.description,
        isDefault: m.is_default,
        defaultWorkflow: idOf('workflow', m.default_workflow_id),
        entries: m.entries
          .map((e) => ({
            type: idOf('ticket_type', e.type),
            workflow: idOf('workflow', e.workflow),
          }))
          .sort((a, b) => byId(a.type, b.type)),
        tracks: refs(
          'track',
          m.tracks.filter((t) => trackSet.has(t)),
        ),
      });
    }
  });

  // --- Tickets, a page at a time, parents before children ------------------------------------

  /** The exported tickets' ids in file order: higher hierarchy levels first, then by id. */
  async function ticketPages(each: (ids: number[]) => Promise<void>) {
    const ranks = await db
      .selectFrom('hierarchy_level')
      .select('rank')
      .distinct()
      .where('workspace_id', '=', ws)
      .orderBy('rank', 'desc')
      .execute();
    for (const { rank } of ranks) {
      await paged(
        (after, limit) =>
          db
            .selectFrom('ticket as k')
            .innerJoin('ticket_type as ty', 'ty.id', 'k.ticket_type_id')
            .innerJoin('hierarchy_level as l', 'l.id', 'ty.level_id')
            .select('k.id')
            .where('k.workspace_id', '=', ws)
            .where(inTracks('k.track_id'))
            .where('l.rank', '=', rank)
            .where('k.id', '>', after)
            .orderBy('k.id')
            .limit(limit)
            .execute(),
        (rows) => each(rows.map((r) => r.id)),
      );
    }
  }

  await write('ticket', async (out) => {
    await ticketPages(async (ids) => {
      const rows = await db
        .selectFrom('ticket as k')
        .select([
          'k.id',
          'k.track_id',
          'k.number',
          'k.ticket_type_id',
          'k.status_id',
          'k.parent_id',
          'k.summary',
          'k.description',
          'k.environment',
          'k.assignee_id',
          'k.requester_id',
          'k.creator_id',
          'k.priority_id',
          'k.close_reason_id',
          'k.labels',
          'k.start_date',
          'k.due_date',
          ts('k.created_at').as('created_at'),
          ts('k.updated_at').as('updated_at'),
          ts('k.closed_at').as('closed_at'),
          'k.original_estimate',
          'k.remaining_estimate',
          'k.time_spent',
          'k.rank',
          'k.fields',
          'k.visibility_level_id',
          ts('k.deleted_at').as('deleted_at'),
          'k.deleted_by',
          'k.trashed_with',
          sql<number[]>`coalesce((SELECT array_agg(release_id) FROM ticket_release
            WHERE ticket_id = k.id AND role = 'target'), '{}')`.as('target_releases'),
          sql<number[]>`coalesce((SELECT array_agg(release_id) FROM ticket_release
            WHERE ticket_id = k.id AND role = 'found'), '{}')`.as('found_releases'),
          sql<number[]>`coalesce((SELECT array_agg(area_id) FROM ticket_area
            WHERE ticket_id = k.id), '{}')`.as('areas'),
          sql<number[]>`coalesce((SELECT array_agg(user_id) FROM ticket_follower
            WHERE ticket_id = k.id), '{}')`.as('followers'),
          sql<number[]>`coalesce((SELECT array_agg(user_id) FROM ticket_vote
            WHERE ticket_id = k.id), '{}')`.as('voters'),
        ])
        .where('k.id', 'in', ids)
        .execute();
      const byTicket = new Map(rows.map((r) => [r.id, r]));
      for (const id of ids) {
        const k = byTicket.get(id);
        if (!k) continue;
        await out.record({
          id: idOf('ticket', k.id),
          track: idOf('track', k.track_id),
          number: k.number,
          type: idOf('ticket_type', k.ticket_type_id),
          status: idOf('status', k.status_id),
          parent: ref('ticket', k.parent_id),
          summary: k.summary,
          description: k.description === null ? null : stored(k.description, remapDoc),
          environment: k.environment === null ? null : stored(k.environment, remapDoc),
          assignee: ref('user', k.assignee_id),
          requester: ref('user', k.requester_id),
          creator: ref('user', k.creator_id),
          priority: ref('priority', k.priority_id),
          closeReason: ref('close_reason', k.close_reason_id),
          labels: k.labels,
          startDate: k.start_date,
          dueDate: k.due_date,
          createdAt: k.created_at,
          updatedAt: k.updated_at,
          closedAt: k.closed_at,
          originalEstimate: k.original_estimate,
          remainingEstimate: k.remaining_estimate,
          timeSpent: k.time_spent,
          rank: k.rank,
          fields: map ? remapFields(k.fields, map) : k.fields,
          targetReleases: refs('release', k.target_releases),
          foundInReleases: refs('release', k.found_releases),
          areas: refs('area', k.areas),
          followers: refs('user', k.followers),
          voters: refs('user', k.voters),
          // Visibility levels are not carried: the import refuses such a ticket (ADR-061).
          visibilityLevel: k.visibility_level_id === null ? null : String(k.visibility_level_id),
          deletedAt: k.deleted_at,
          deletedBy: ref('user', k.deleted_by),
          trashedWith: ref('ticket', k.trashed_with),
        });
      }
    });
  });

  /** Rows of a kind on exported tickets, by id. */
  const onTickets = (alias: string) => sql<boolean>`EXISTS (SELECT 1 FROM ticket t
    WHERE t.id = ${sql.ref(`${alias}.ticket_id`)} AND ${inTracks('t.track_id')})`;

  await write('comment', async (out) => {
    await paged(
      (after, limit) =>
        db
          .selectFrom('ticket_comment as c')
          .select([
            'c.id',
            'c.ticket_id',
            'c.author_id',
            'c.body',
            'c.visible_group_id',
            'c.visible_role_id',
            ts('c.created_at').as('created_at'),
            ts('c.updated_at').as('updated_at'),
            ts('c.edited_at').as('edited_at'),
            'c.edited_by',
            ts('c.deleted_at').as('deleted_at'),
            'c.deleted_by',
          ])
          .where('c.workspace_id', '=', ws)
          .where(onTickets('c'))
          .where('c.id', '>', after)
          .orderBy('c.id')
          .limit(limit)
          .execute(),
      async (rows) => {
        for (const c of rows) {
          await out.record({
            id: idOf('comment', c.id),
            ticket: idOf('ticket', c.ticket_id),
            author: ref('user', c.author_id),
            body: stored(c.body, remapDoc),
            visibleGroup: ref('group', c.visible_group_id),
            visibleRole: ref('role', c.visible_role_id),
            createdAt: c.created_at,
            updatedAt: c.updated_at,
            editedAt: c.edited_at,
            editedBy: ref('user', c.edited_by),
            deletedAt: c.deleted_at,
            deletedBy: ref('user', c.deleted_by),
          });
        }
      },
    );
  });

  await write('link', async (out) => {
    await paged(
      (after, limit) =>
        db
          .selectFrom('ticket_link as l')
          .innerJoin('link_type as t', 't.id', 'l.link_type_id')
          .innerJoin('ticket as s', 's.id', 'l.source_id')
          .innerJoin('ticket as d', 'd.id', 'l.target_id')
          .select([
            'l.id',
            'l.source_id',
            'l.target_id',
            't.name',
            't.outward',
            't.inward',
            'l.created_by',
            ts('l.created_at').as('created_at'),
          ])
          .where('l.workspace_id', '=', ws)
          .where(inTracks('s.track_id'))
          .where(inTracks('d.track_id'))
          .where('l.id', '>', after)
          .orderBy('l.id')
          .limit(limit)
          .execute(),
      async (rows) => {
        for (const l of rows) {
          await out.record({
            id: idOf('link', l.id),
            source: idOf('ticket', l.source_id),
            target: idOf('ticket', l.target_id),
            type: { name: l.name, outward: l.outward, inward: l.inward },
            creator: ref('user', l.created_by),
            createdAt: l.created_at,
          });
        }
      },
    );
  });

  await write('time_entry', async (out) => {
    await paged(
      (after, limit) =>
        db
          .selectFrom('time_entry as e')
          .select([
            'e.id',
            'e.ticket_id',
            'e.author_id',
            ts('e.started_at').as('started_at'),
            'e.duration',
            'e.description',
            'e.visible_group_id',
            'e.visible_role_id',
            'e.created_by',
            ts('e.created_at').as('created_at'),
            ts('e.updated_at').as('updated_at'),
          ])
          .where('e.workspace_id', '=', ws)
          .where(onTickets('e'))
          .where('e.id', '>', after)
          .orderBy('e.id')
          .limit(limit)
          .execute(),
      async (rows) => {
        for (const e of rows) {
          await out.record({
            id: idOf('time_entry', e.id),
            ticket: idOf('ticket', e.ticket_id),
            author: idOf('user', e.author_id),
            startedAt: e.started_at,
            seconds: e.duration,
            description: e.description,
            visibleGroup: ref('group', e.visible_group_id),
            visibleRole: ref('role', e.visible_role_id),
            createdBy: ref('user', e.created_by),
            createdAt: e.created_at,
            updatedAt: e.updated_at,
          });
        }
      },
    );
  });

  // Only files that passed the scan (or need none) leave: the others are never served either.
  const attachmentRows = (after: number, limit: number) =>
    db
      .selectFrom('attachment as a')
      .select([
        'a.id',
        'a.ticket_id',
        'a.name',
        'a.declared_type',
        'a.sniffed_type',
        'a.size',
        'a.sha256',
        'a.storage',
        'a.storage_key',
        'a.author_id',
        ts('a.created_at').as('created_at'),
        'a.width',
        'a.height',
      ])
      .where('a.workspace_id', '=', ws)
      .where('a.scan_state', '=', 'clean')
      .where(onTickets('a'))
      .where('a.id', '>', after)
      .orderBy('a.id')
      .limit(limit)
      .execute();
  const stores = options.stores;
  const readable = (storage: string) =>
    stores?.stores[storage as keyof AttachmentStores['stores']] ?? null;
  const fileName = (id: number) => `${ATTACHMENTS_DIR}/${idOf('attachment', id)}`;

  await write('attachment', async (out) => {
    await paged(attachmentRows, async (rows) => {
      for (const a of rows) {
        if (!readable(a.storage)) continue;
        await out.record({
          id: idOf('attachment', a.id),
          ticket: idOf('ticket', a.ticket_id),
          name: a.name,
          declaredType: a.declared_type,
          sniffedType: a.sniffed_type,
          size: Number(a.size),
          sha256: a.sha256,
          author: ref('user', a.author_id),
          createdAt: a.created_at,
          width: a.width,
          height: a.height,
          file: fileName(a.id),
        });
      }
    });
  });

  const copied: { name: string; sha256: string }[] = [];
  let attachmentBytes = 0;
  await paged(attachmentRows, async (rows) => {
    for (const a of rows) {
      const store = readable(a.storage);
      if (!store) continue;
      const written = await sink.copy(fileName(a.id), await store.read(a.storage_key));
      if (written.sha256 !== a.sha256) {
        throw new Error(`attachment ${a.id}: the stored file does not match its checksum`);
      }
      copied.push({ name: fileName(a.id), sha256: written.sha256 });
      attachmentBytes += written.bytes;
    }
  });

  await write('history', async (out) => {
    await ticketPages(async (ids) => {
      const rows = await db
        .selectFrom('ticket_change')
        .select([
          'id',
          'ticket_id',
          'change_set',
          ts('at').as('at'),
          'actor_id',
          'field',
          'from_value',
          'to_value',
          'from_display',
          'to_display',
          'transition_id',
        ])
        .where('ticket_id', 'in', ids)
        .orderBy('ticket_id')
        .orderBy('id')
        .execute();
      const byTicket = new Map<number, typeof rows>();
      for (const r of rows) {
        const list = byTicket.get(r.ticket_id);
        if (list) list.push(r);
        else byTicket.set(r.ticket_id, [r]);
      }
      for (const id of ids) {
        // A ticket's change sets in the order they were written.
        const sets = new Map<string, typeof rows>();
        for (const r of byTicket.get(id) ?? []) {
          const list = sets.get(r.change_set);
          if (list) list.push(r);
          else sets.set(r.change_set, [r]);
        }
        for (const [set, items] of sets) {
          const head = items[0] as (typeof rows)[number];
          await out.record({
            id: translation ? idOf('history', set) : `${set}-${id}`,
            ticket: idOf('ticket', id),
            at: head.at,
            actor: ref('user', head.actor_id),
            items: items.map((i) => ({
              field: map ? (remapFieldName(i.field, map) ?? `unmapped:${i.field}`) : i.field,
              from: map ? remapHistoryValue(i.field, i.from_value, map) : i.from_value,
              to: map ? remapHistoryValue(i.field, i.to_value, map) : i.to_value,
              fromDisplay: i.from_display,
              toDisplay: i.to_display,
              transition: i.transition_id,
            })),
          });
        }
      }
    });
  });

  const workspace = await db
    .selectFrom('workspace')
    .select('key')
    .where('id', '=', ws)
    .executeTakeFirstOrThrow();
  copied.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const manifest = manifestSchema.parse({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    system: translation?.system ?? (await exportSystem(db, ws)),
    workspace: workspace.key,
    exportedAt: new Date().toISOString(),
    tracks: options.tracks == null ? null : tracks.map((t) => t.key),
    files,
    attachments: {
      files: copied.length,
      bytes: attachmentBytes,
      sha256: createHash('sha256')
        .update(copied.map((c) => `${c.name} ${c.sha256}\n`).join(''))
        .digest('hex'),
    },
  });
  const file = await sink.open(MANIFEST);
  await file.line(JSON.stringify(manifest, null, 2));
  await file.close();
  return { manifest, ms: performance.now() - started };
}

/** Ids as text in numeric order (an unmapped id after the others). */
export function byId(a: string, b: string): number {
  const x = Number(a);
  const y = Number(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return a < b ? -1 : a > b ? 1 : 0;
  return x - y;
}
