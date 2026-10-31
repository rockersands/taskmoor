import { createHash } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { AttachmentStores } from '../attachments/stores';
import { emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import {
  checksum,
  type LoadContext,
  type Loader,
  PENDING,
  PlanFailure,
  Resolver,
  refsOf,
  targetIdMap,
} from './load';
import { LOADERS } from './loaders';
import {
  type Command,
  ENTITY_KINDS,
  type ImportFormat,
  type ImportSource,
  isEntityKind,
  type Mapped,
  type Warning,
} from './model';
import {
  buildReport,
  emptyTally,
  labelOf,
  MAPPED_KINDS,
  type Tally,
  type UnsupportedTally,
  unsupportedCount,
  type WarningTally,
} from './report';

/**
 * Runs an import (M1-086; IMP-009, ADR-048) a batch at a time. Each batch is one transaction:
 * it locks the run, reads the checkpoint, extracts the next page of the current kind, maps and
 * loads it record by record (each in a savepoint, so one bad record fails alone), writes the
 * records' outcomes, their external ids and the new checkpoint and tallies, and commits. A
 * worker that dies mid-batch loses only that batch's uncommitted work, and the next run of the
 * job starts again from the checkpoint, so the result is the same as an uninterrupted run
 * (IMP-009 (1)). External ids make a second run update what changed instead of duplicating
 * (IMP-009 (2)). A dry run does everything but the product writes.
 */
export interface ImportDeps {
  db: Kysely<Database>;
  catalogs: FieldCatalogs;
  formats: Readonly<Record<string, ImportFormat>>;
  /** Where imported attachments go; without it, attachment records fail. */
  stores?: AttachmentStores | null;
}

export interface RunOptions {
  /** Stop taking new batches after this time (ms since the epoch). */
  until: number;
  /** Records per batch. */
  batch?: number;
  /**
   * Called before each record is loaded with its kind and its ordinal within the kind; a throw
   * aborts the batch as a crash would. Tests kill imports with it.
   */
  beforeRecord?: (kind: string, ordinal: number) => void;
}

/** Records per batch: large enough that a batch's own reads and writes cost little (M1-091). */
export const DEFAULT_BATCH = 250;
/** Warnings kept with one record. */
const MAX_RECORD_WARNINGS = 20;
/** Records of a kind always sampled, and the most a kind samples. */
const SAMPLE_FIRST = 10;
const SAMPLE_MAX = 50;

type RunRow = NonNullable<Awaited<ReturnType<typeof loadRun>>>;
type Checkpoint = { kind?: string; after?: string | null; done?: boolean };

const loadRun = (db: Kysely<Database> | Transaction<Database>, runId: string) =>
  db.selectFrom('import_run').selectAll().where('id', '=', runId).executeTakeFirst();

/** The kinds of a source in the order they run: the framework's first, others after. */
export function kindOrder(kinds: readonly string[]): string[] {
  const present = new Set(kinds);
  return [
    ...ENTITY_KINDS.filter((k) => present.has(k)),
    ...[...present].filter((k) => !isEntityKind(k)).sort(),
  ];
}

/** Whether a record is in the report's sample: the first few, then about one in sixteen. */
function sampled(kind: string, sourceId: string, tally: Tally): boolean {
  if (tally.sampled >= SAMPLE_MAX) return false;
  if (tally.read <= SAMPLE_FIRST) return true;
  const byte = createHash('sha256').update(`${kind}\u0000${sourceId}`).digest()[0] as number;
  return byte < 16;
}

function mapSafely(
  format: ImportFormat,
  item: { kind: string; id: string; data: Record<string, unknown> },
): Mapped {
  try {
    return format.map(item);
  } catch {
    return { fail: 'map_error' };
  }
}

/** A database error's code and message, kept short for the report. */
function errorText(error: unknown): string {
  if (error instanceof PlanFailure) return error.message;
  const code = (error as { code?: string }).code;
  return `error:${code ?? 'internal'}`;
}

/** Inserts a run; the route and tests queue its job. */
export async function createRun(
  db: Kysely<Database> | Transaction<Database>,
  values: {
    workspaceId: number;
    userId: number | null;
    importSource: string;
    system: string;
    name: string;
    source: unknown;
    dryRun: boolean;
  },
) {
  return db
    .insertInto('import_run')
    .values({
      workspace_id: values.workspaceId,
      user_id: values.userId,
      import_source: values.importSource,
      source_system: values.system,
      name: values.name,
      source: JSON.stringify(values.source),
      dry_run: values.dryRun,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

type Step = 'continue' | 'complete' | 'cancelled' | 'stop';

async function step(
  trx: Transaction<Database>,
  deps: ImportDeps,
  runId: string,
  source: ImportSource,
  format: ImportFormat,
  kinds: readonly string[],
  options: RunOptions,
): Promise<Step> {
  const run = await trx
    .selectFrom('import_run')
    .selectAll()
    .where('id', '=', runId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (run.status !== 'running') return 'stop';
  if (run.cancel_requested) return 'cancelled';
  const checkpoint = run.checkpoint as Checkpoint;
  if (checkpoint.done) return 'complete';
  const save = async (next: Checkpoint, changes: Record<string, unknown> = {}) => {
    await trx
      .updateTable('import_run')
      .set({ checkpoint: JSON.stringify(next), updated_at: new Date(), ...changes })
      .where('id', '=', runId)
      .execute();
  };
  const warnings = run.warnings as unknown as Record<string, WarningTally>;
  const unsupported = run.unsupported as Record<string, UnsupportedTally>;
  const startOf = (k: string | undefined): Checkpoint =>
    k === undefined ? { done: true } : { kind: k, after: null };

  // The source's own notes (characters it removed, say) join the warnings once, first.
  if (checkpoint.kind === undefined && source.notes) {
    for (const note of await source.notes()) {
      if (note.count <= 0) continue;
      const key = `source|${note.code}|${note.detail ?? ''}`;
      const entry = warnings[key] ?? {
        kind: 'source',
        code: note.code,
        detail: note.detail ?? null,
        count: 0,
        examples: [],
      };
      warnings[key] = entry;
      entry.count += note.count;
      for (const e of note.examples) {
        if (entry.examples.length < 5 && !entry.examples.includes(e)) entry.examples.push(e);
      }
    }
    await save(startOf(kinds[0]), { warnings: JSON.stringify(warnings) });
    return 'continue';
  }
  if (kinds.length === 0) return 'complete';
  const index = checkpoint.kind === undefined ? 0 : kinds.indexOf(checkpoint.kind);
  if (index < 0) throw new Error(`the source no longer has kind ${checkpoint.kind}`);
  const kind = kinds[index] as string;
  const after = checkpoint.after ?? null;

  // Kinds without a loader are counted, never dropped silently: by the source when it can,
  // with its reason, or else a page at a time below.
  if (!isEntityKind(kind) && after === null && source.unsupported) {
    const counted = await source.unsupported(kind);
    if (counted !== null) {
      if (counted.count > 0) unsupported[kind] = { count: counted.count, reason: counted.reason };
      await save(startOf(kinds[index + 1]), { unsupported: JSON.stringify(unsupported) });
      return 'continue';
    }
  }
  const items = await source.read(kind, after, options.batch ?? DEFAULT_BATCH);
  if (items.length === 0) {
    await save(startOf(kinds[index + 1]));
    return 'continue';
  }
  const last = (items[items.length - 1] as { cursor: string }).cursor;
  const batches = run.batches + 1;

  if (!isEntityKind(kind)) {
    unsupported[kind] = unsupportedCount(unsupported[kind] ?? 0) + items.length;
    await save({ kind, after: last }, { unsupported: JSON.stringify(unsupported), batches });
    return 'continue';
  }

  const tallies = run.tallies as unknown as Record<string, Tally>;
  const tally = tallies[kind] ?? emptyTally();
  tallies[kind] = tally;
  let current = '';
  /** The current record's own warnings, kept with it: a dry run lists problems per record. */
  let mine: Warning[] = [];
  const warn = (w: Warning) => {
    if (mine.length < MAX_RECORD_WARNINGS) mine.push(w);
    const key = `${kind}|${w.code}|${w.detail ?? ''}`;
    const entry = warnings[key] ?? {
      kind,
      code: w.code,
      detail: w.detail ?? null,
      count: 0,
      examples: [],
    };
    warnings[key] = entry;
    entry.count += 1;
    if (entry.examples.length < 5 && !entry.examples.includes(current))
      entry.examples.push(current);
  };

  const mapped = items.map((item) => ({ item, result: mapSafely(format, item) }));
  const scope = {
    workspaceId: run.workspace_id,
    importSource: run.import_source,
    system: run.source_system,
    runId,
    dryRun: run.dry_run,
  };
  const resolver = new Resolver(trx, scope);
  await resolver.preload(
    mapped.flatMap((m) => ('command' in m.result ? refsOf(m.result.command) : [])),
  );
  // What earlier runs imported of these records, and whether the first one linked them to an
  // object the target already had: such objects belong to the target and are never updated.
  const { rows: known } = await sql<{
    source_id: string;
    target_id: string;
    checksum: string;
    linked: boolean;
  }>`
    SELECT e.source_id, e.target_id, e.checksum, coalesce(r.outcome = 'linked', false) AS linked
      FROM import_external_id e
      LEFT JOIN import_record r
        ON r.run_id = e.first_run_id AND r.entity_kind = e.entity_kind
       AND r.source_id = e.source_id
     WHERE e.workspace_id = ${scope.workspaceId} AND e.import_source = ${scope.importSource}
       AND e.source_system = ${scope.system} AND e.entity_kind = ${kind}
       AND e.source_id = ANY(${items.map((i) => i.id)}::text[])`.execute(trx);
  const existing = new Map(known.map((k) => [k.source_id, k]));

  const catalog = await deps.catalogs.get(run.workspace_id, trx);
  const ctx: LoadContext = {
    trx,
    db: deps.db,
    workspaceId: run.workspace_id,
    system: run.source_system,
    importSource: run.import_source,
    dryRun: run.dry_run,
    verbatim: format.verbatim === true,
    now: new Date().toISOString(),
    refs: resolver,
    catalog,
    remap: targetIdMap(resolver, catalog, warn),
    source,
    stores: deps.stores ?? null,
    warn,
    warned: (code, detail) => warnings[`${kind}|${code}|${detail ?? ''}`] !== undefined,
    touched: new Set(),
    cache: new Map(),
  };
  const loader = LOADERS[kind] as unknown as Loader<Command>;
  // Ids inside stored values (`remap.ts`) are looked up for the whole batch at once.
  await loader.prepare?.(
    ctx,
    mapped.flatMap((m) =>
      'command' in m.result && m.result.command.kind === kind ? [m.result.command] : [],
    ),
  );
  const records: {
    source_id: string;
    outcome: 'created' | 'updated' | 'unchanged' | 'linked' | 'failed' | 'skipped';
    target_id: string | null;
    checksum: string | null;
    sampled: boolean;
    error: string | null;
    label: string | null;
  }[] = [];
  const mappedKind = MAPPED_KINDS.includes(kind);
  const externals: { source_id: string; target_id: number; checksum: string }[] = [];

  for (const { item, result } of mapped) {
    options.beforeRecord?.(kind, tally.read);
    tally.read += 1;
    current = item.id;
    mine = [];
    for (const w of result.warnings ?? []) warn(w);
    if ('skip' in result || 'fail' in result) {
      const failed = 'fail' in result;
      tally[failed ? 'failed' : 'skipped'] += 1;
      records.push({
        source_id: item.id,
        outcome: failed ? 'failed' : 'skipped',
        target_id: null,
        checksum: null,
        sampled: false,
        error: JSON.stringify({
          error: failed ? result.fail : result.skip,
          ...(mine.length > 0 ? { warnings: mine } : {}),
        }),
        label: mappedKind ? labelOf(item, null) : null,
      });
      continue;
    }
    const command = result.command;
    const sum = checksum(command);
    const known = existing.get(item.id);
    const knownId = known ? Number(known.target_id) : null;
    await sql`SAVEPOINT import_record`.execute(trx);
    try {
      if (command.kind !== kind) throw new PlanFailure('kind_mismatch');
      const plan = await loader.plan(ctx, command, knownId, item.id);
      let outcome: 'created' | 'updated' | 'unchanged' | 'linked';
      let targetId: number | null = plan.targetId;
      if (known && known.checksum === sum) {
        outcome = 'unchanged';
      } else if (known?.linked) {
        // A person matched by email, a group or status by name: the source's changes stay out.
        outcome = 'linked';
      } else {
        if (known && kind === 'history') warn({ code: 'history_changed' });
        if (!ctx.dryRun) targetId = await loader.apply(ctx, command, plan);
        outcome = known
          ? 'updated'
          : plan.action === 'link'
            ? 'linked'
            : plan.action === 'create'
              ? 'created'
              : 'updated';
      }
      resolver.set({ kind, id: item.id }, targetId ?? PENDING);
      if (!ctx.dryRun && targetId !== null) {
        externals.push({ source_id: item.id, target_id: targetId, checksum: sum });
      }
      const inSample = sampled(kind, item.id, tally);
      if (inSample) tally.sampled += 1;
      tally[outcome] += 1;
      records.push({
        source_id: item.id,
        outcome,
        target_id: targetId === null || targetId === PENDING ? null : String(targetId),
        checksum: inSample ? checksum(plan.fingerprint) : null,
        sampled: inSample,
        error: mine.length > 0 ? JSON.stringify({ warnings: mine }) : null,
        label: mappedKind ? labelOf(item, command) : null,
      });
      await sql`RELEASE SAVEPOINT import_record`.execute(trx);
    } catch (error) {
      await sql`ROLLBACK TO SAVEPOINT import_record`.execute(trx);
      tally.failed += 1;
      records.push({
        source_id: item.id,
        outcome: 'failed',
        target_id: null,
        checksum: null,
        sampled: false,
        error: JSON.stringify({
          error: errorText(error),
          ...(mine.length > 0 ? { warnings: mine } : {}),
        }),
        label: mappedKind ? labelOf(item, command) : null,
      });
    }
  }
  if (!ctx.dryRun) await loader.finish?.(ctx);

  await trx
    .insertInto('import_record')
    .values(
      records.map((r) => ({
        run_id: runId,
        workspace_id: run.workspace_id,
        entity_kind: kind,
        ...r,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['run_id', 'entity_kind', 'source_id']).doUpdateSet((eb) => ({
        outcome: eb.ref('excluded.outcome'),
        target_id: eb.ref('excluded.target_id'),
        checksum: eb.ref('excluded.checksum'),
        sampled: eb.ref('excluded.sampled'),
        error: eb.ref('excluded.error'),
        label: eb.ref('excluded.label'),
      })),
    )
    .execute();
  if (externals.length > 0) {
    await sql`
      INSERT INTO import_external_id (workspace_id, import_source, source_system, entity_kind,
          source_id, target_id, checksum, first_run_id, last_run_id)
      SELECT ${scope.workspaceId}, ${scope.importSource}, ${scope.system}, ${kind}, e.source_id,
             e.target_id, e.checksum, ${Number(runId)}, ${Number(runId)}
        FROM unnest(${externals.map((e) => e.source_id)}::text[],
                    ${externals.map((e) => e.target_id)}::bigint[],
                    ${externals.map((e) => e.checksum)}::text[]) AS e (source_id, target_id, checksum)
      ON CONFLICT (workspace_id, import_source, source_system, entity_kind, source_id) DO UPDATE
        SET target_id = EXCLUDED.target_id, checksum = EXCLUDED.checksum,
            last_run_id = EXCLUDED.last_run_id, updated_at = now()`.execute(trx);
  }
  await save(
    { kind, after: last },
    {
      tallies: JSON.stringify(tallies),
      warnings: JSON.stringify(warnings),
      batches,
    },
  );
  return 'continue';
}

/** Ends a run: builds its report and emits `import_run.finished`, once. */
export async function finishRun(
  db: Kysely<Database>,
  runId: string,
  status: 'done' | 'cancelled' | 'failed',
  error: string | null = null,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const run = await trx
      .selectFrom('import_run')
      .selectAll()
      .where('id', '=', runId)
      .forUpdate()
      .executeTakeFirst();
    if (!run || run.status === 'done' || run.status === 'cancelled' || run.status === 'failed') {
      return;
    }
    const finishedAt = new Date();
    const report = await buildReport(trx, run, status, finishedAt);
    await trx
      .updateTable('import_run')
      .set({
        status,
        report: JSON.stringify(report),
        finished_at: finishedAt,
        updated_at: finishedAt,
        last_error: error,
      })
      .where('id', '=', runId)
      .execute();
    await emit(
      trx,
      { workspaceId: run.workspace_id, actorId: null },
      {
        type: 'import_run.finished',
        subjectId: Number(run.id),
        payload: {
          importSource: run.import_source,
          sourceSystem: run.source_system,
          dryRun: run.dry_run,
          status,
          requestedBy: run.user_id,
          source: report.totals.source,
          target: report.totals.target,
          failed: report.totals.failed,
          warnings: report.warnings.reduce((n, w) => n + w.count, 0),
          unsupported: report.unsupported.reduce((n, u) => n + u.count, 0),
          fidelity: report.totals.fidelity,
        },
      },
    );
  });
}

/**
 * Runs batches until the import ends or `until` passes ('more': the job queues the next part).
 * An error in a batch rolls that batch back and propagates; the job retries from the checkpoint.
 */
export async function runImport(
  deps: ImportDeps,
  runId: string,
  options: RunOptions,
): Promise<'finished' | 'more'> {
  const { db } = deps;
  const run = await loadRun(db, runId);
  if (!run || run.status === 'done' || run.status === 'cancelled' || run.status === 'failed') {
    return 'finished';
  }
  if (run.status === 'queued') {
    await db
      .updateTable('import_run')
      .set({ status: 'running', started_at: new Date(), updated_at: new Date() })
      .where('id', '=', runId)
      .where('status', '=', 'queued')
      .execute();
  }
  const format = deps.formats[run.import_source];
  if (!format) {
    await finishRun(db, runId, 'failed', 'unknown_import_source');
    return 'finished';
  }
  let source: ImportSource;
  try {
    source = format.open(run.source, { db, runId, workspaceId: run.workspace_id });
  } catch {
    await finishRun(db, runId, 'failed', 'source_unreadable');
    return 'finished';
  }
  if (source.prepare) {
    // A remote source fetches into its stage first, a part at a time (M1-095).
    if (run.cancel_requested) {
      await finishRun(db, runId, 'cancelled');
      return 'finished';
    }
    if ((await source.prepare(options.until)) === 'more') return 'more';
  }
  const kinds = kindOrder(await source.kinds());
  for (;;) {
    const outcome = await db
      .transaction()
      .execute((trx) => step(trx, deps, runId, source, format, kinds, options));
    if (outcome === 'stop') return 'finished';
    if (outcome === 'complete' || outcome === 'cancelled') {
      await finishRun(db, runId, outcome === 'complete' ? 'done' : 'cancelled');
      return 'finished';
    }
    if (Date.now() >= options.until) return 'more';
  }
}

/** A run's progress as the API shows it. */
export function runView(row: RunRow) {
  const tallies = row.tallies as unknown as Record<string, Tally>;
  const checkpoint = row.checkpoint as Checkpoint;
  return {
    id: Number(row.id),
    importSource: row.import_source,
    sourceSystem: row.source_system,
    name: row.name,
    dryRun: row.dry_run,
    status: row.status,
    cancelRequested: row.cancel_requested,
    currentKind: checkpoint.done ? null : (checkpoint.kind ?? null),
    batches: row.batches,
    progress: ENTITY_KINDS.filter((k) => tallies[k]).map((k) => {
      const t = tallies[k] as Tally;
      return {
        kind: k,
        read: t.read,
        created: t.created,
        updated: t.updated,
        unchanged: t.unchanged,
        linked: t.linked,
        failed: t.failed,
        skipped: t.skipped,
      };
    }),
    unsupported: Object.fromEntries(
      Object.entries(row.unsupported as Record<string, UnsupportedTally>).map(([k, t]) => [
        k,
        unsupportedCount(t),
      ]),
    ),
    warnings: Object.values(row.warnings as unknown as Record<string, WarningTally>).reduce(
      (n, w) => n + w.count,
      0,
    ),
    lastError: row.last_error,
    userId: row.user_id,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}
