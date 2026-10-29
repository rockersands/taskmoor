import type { Database, JsonValue } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { checksum, LOADERS } from './load';
import { ENTITY_KINDS } from './model';

/**
 * The fidelity report (M1-086; IMP-010): for each entity kind, how many records the source had
 * and what became of them, how many targets exist after the run, the ratio of the two, checksums
 * compared on a sample of records (the command with its references resolved against the target
 * row read back), every warning grouped by code, the kinds the framework does not import yet,
 * and the records that failed. A dry run has no targets: its counts say what would happen and
 * its samples carry the source side only.
 *
 * The schema below is the contract: `fidelityReport.parse` checks every report the runner
 * writes, and `fidelityReportJsonSchema` publishes it for other tools.
 */
const count = z.number().int().min(0);
const ratio = z.number().min(0).max(1);

export const REPORT_VERSION = 1;

export const outcomeCounts = z
  .object({
    created: count,
    updated: count,
    unchanged: count,
    linked: count,
    failed: count,
    skipped: count,
  })
  .strict();

export const fidelityReport = z
  .object({
    version: z.literal(REPORT_VERSION),
    run: z
      .object({
        id: z.number().int().positive(),
        importSource: z.string(),
        sourceSystem: z.string(),
        name: z.string(),
        dryRun: z.boolean(),
        status: z.enum(['done', 'cancelled', 'failed']),
        startedAt: z.iso.datetime().nullable(),
        finishedAt: z.iso.datetime(),
        batches: count,
      })
      .strict(),
    entities: z.array(
      z
        .object({
          kind: z.enum(ENTITY_KINDS),
          /** Records the source had of this kind (read by the run). */
          source: count,
          outcomes: outcomeCounts,
          /** Distinct targets that exist after the run; null for a dry run. */
          target: count.nullable(),
          /** Target over source records that were not skipped; null for a dry run. */
          fidelity: ratio.nullable(),
        })
        .strict(),
    ),
    totals: z
      .object({
        source: count,
        target: count.nullable(),
        failed: count,
        fidelity: ratio.nullable(),
      })
      .strict(),
    samples: z.array(
      z
        .object({
          kind: z.enum(ENTITY_KINDS),
          sourceId: z.string(),
          targetId: z.number().int().positive().nullable(),
          sourceChecksum: z.string().regex(/^[0-9a-f]{64}$/),
          targetChecksum: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .nullable(),
          /** Null when there is nothing to compare: a dry run, or a target gone since. */
          match: z.boolean().nullable(),
        })
        .strict(),
    ),
    sampleSummary: z.object({ compared: count, matched: count, mismatched: count }).strict(),
    warnings: z.array(
      z
        .object({
          kind: z.string(),
          code: z.string(),
          detail: z.string().nullable(),
          count: z.number().int().min(1),
          /** Up to five source ids it concerns. */
          examples: z.array(z.string()).max(5),
        })
        .strict(),
    ),
    unsupported: z.array(
      z.object({ kind: z.string(), count: z.number().int().min(1), reason: z.string() }).strict(),
    ),
    failures: z.array(
      z.object({ kind: z.string(), sourceId: z.string(), error: z.string() }).strict(),
    ),
    /** More failures than listed. */
    failuresTruncated: z.boolean(),
  })
  .strict();

export type FidelityReport = z.infer<typeof fidelityReport>;
export type OutcomeCounts = z.infer<typeof outcomeCounts>;

/** The report's JSON Schema (draft 2020-12), for tools outside Taskmoor. */
export const fidelityReportJsonSchema = () => z.toJSONSchema(fidelityReport);

const MAX_FAILURES = 100;

export interface Tally extends OutcomeCounts {
  read: number;
  sampled: number;
}

export interface WarningTally {
  kind: string;
  code: string;
  detail: string | null;
  count: number;
  examples: string[];
}

export const emptyTally = (): Tally => ({
  read: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  linked: 0,
  failed: 0,
  skipped: 0,
  sampled: 0,
});

type RunRow = {
  id: string;
  workspace_id: number;
  import_source: string;
  source_system: string;
  name: string;
  dry_run: boolean;
  started_at: Date | null;
  batches: number;
  tallies: Record<string, JsonValue>;
  warnings: Record<string, JsonValue>;
  unsupported: Record<string, JsonValue>;
};

/** Builds the report of a run from its tallies, its records and the target rows. */
export async function buildReport(
  db: Kysely<Database>,
  run: RunRow,
  status: 'done' | 'cancelled' | 'failed',
  finishedAt: Date,
): Promise<FidelityReport> {
  const tallies = run.tallies as unknown as Record<string, Tally>;
  const entities: FidelityReport['entities'] = [];
  for (const kind of ENTITY_KINDS) {
    const t = tallies[kind];
    if (!t) continue;
    let target: number | null = null;
    if (!run.dry_run) {
      const table = LOADERS[kind].table;
      const { rows } = await sql<{ n: number }>`
        SELECT count(DISTINCT r.target_id)::int AS n
          FROM import_record r
         WHERE r.run_id = ${Number(run.id)} AND r.entity_kind = ${kind}
           AND r.outcome IN ('created', 'updated', 'unchanged', 'linked')
           AND EXISTS (SELECT 1 FROM ${sql.table(table.name)} x
                        WHERE x.${sql.ref(table.id)} = r.target_id)`.execute(db);
      target = rows[0]?.n ?? 0;
    }
    const considered = t.read - t.skipped;
    entities.push({
      kind,
      source: t.read,
      outcomes: {
        created: t.created,
        updated: t.updated,
        unchanged: t.unchanged,
        linked: t.linked,
        failed: t.failed,
        skipped: t.skipped,
      },
      target,
      fidelity: target === null ? null : considered === 0 ? 1 : Math.min(1, target / considered),
    });
  }
  const sourceTotal = entities.reduce((n, e) => n + e.source, 0);
  const skippedTotal = entities.reduce((n, e) => n + e.outcomes.skipped, 0);
  const targetTotal = run.dry_run ? null : entities.reduce((n, e) => n + (e.target ?? 0), 0);

  const sampled = await db
    .selectFrom('import_record')
    .select(['entity_kind', 'source_id', 'target_id', 'checksum'])
    .where('run_id', '=', run.id)
    .where('sampled', '=', true)
    .orderBy('entity_kind')
    .orderBy('source_id')
    .execute();
  const samples: FidelityReport['samples'] = [];
  for (const kind of ENTITY_KINDS) {
    const mine = sampled.filter((s) => s.entity_kind === kind && s.checksum !== null);
    if (mine.length === 0) continue;
    const ids = mine.flatMap((s) => (s.target_id === null ? [] : [Number(s.target_id)]));
    const read =
      run.dry_run || ids.length === 0
        ? new Map<number, JsonValue>()
        : await LOADERS[kind].read(db, run.workspace_id, ids);
    for (const s of mine) {
      const targetId = s.target_id === null ? null : Number(s.target_id);
      const back = targetId === null ? undefined : read.get(targetId);
      const targetChecksum = back === undefined ? null : checksum(back);
      samples.push({
        kind,
        sourceId: s.source_id,
        targetId: targetId !== null && targetId > 0 ? targetId : null,
        sourceChecksum: s.checksum as string,
        targetChecksum,
        match: targetChecksum === null ? null : targetChecksum === s.checksum,
      });
    }
  }
  const compared = samples.filter((s) => s.match !== null);

  const failed = await db
    .selectFrom('import_record')
    .select(['entity_kind', 'source_id', 'error'])
    .where('run_id', '=', run.id)
    .where('outcome', '=', 'failed')
    .orderBy('entity_kind')
    .orderBy('source_id')
    .limit(MAX_FAILURES + 1)
    .execute();
  const failedTotal = entities.reduce((n, e) => n + e.outcomes.failed, 0);

  const report: FidelityReport = {
    version: REPORT_VERSION,
    run: {
      id: Number(run.id),
      importSource: run.import_source,
      sourceSystem: run.source_system,
      name: run.name,
      dryRun: run.dry_run,
      status,
      startedAt: run.started_at?.toISOString() ?? null,
      finishedAt: finishedAt.toISOString(),
      batches: run.batches,
    },
    entities,
    totals: {
      source: sourceTotal,
      target: targetTotal,
      failed: failedTotal,
      fidelity:
        targetTotal === null
          ? null
          : sourceTotal - skippedTotal === 0
            ? 1
            : Math.min(1, targetTotal / (sourceTotal - skippedTotal)),
    },
    samples,
    sampleSummary: {
      compared: compared.length,
      matched: compared.filter((s) => s.match).length,
      mismatched: compared.filter((s) => !s.match).length,
    },
    warnings: (Object.values(run.warnings) as unknown as WarningTally[])
      .map((w) => ({ ...w, examples: w.examples.slice(0, 5) }))
      .sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) ||
          a.code.localeCompare(b.code) ||
          (a.detail ?? '').localeCompare(b.detail ?? ''),
      ),
    unsupported: Object.entries(run.unsupported as Record<string, number>)
      .filter(([, n]) => n > 0)
      .map(([kind, n]) => ({ kind, count: n, reason: 'no_importer_for_kind' }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
    failures: failed.slice(0, MAX_FAILURES).map((f) => ({
      kind: f.entity_kind,
      sourceId: f.source_id,
      error: String((f.error as { error?: string } | null)?.error ?? 'failed'),
    })),
    failuresTruncated: failed.length > MAX_FAILURES,
  };
  return fidelityReport.parse(report);
}

const html = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** The report as a standalone HTML page (IMP-010 (2)): no script, no external resources. */
export function reportHtml(report: FidelityReport): string {
  const pct = (r: number | null) => (r === null ? '–' : `${(r * 100).toFixed(2)}%`);
  const rows = (cells: (string | number | null)[][]) =>
    cells
      .map((r) => `<tr>${r.map((c) => `<td>${html(String(c ?? '–'))}</td>`).join('')}</tr>`)
      .join('\n');
  const table = (head: string[], body: (string | number | null)[][]) =>
    `<table><thead><tr>${head.map((h) => `<th>${html(h)}</th>`).join('')}</tr></thead><tbody>${rows(body)}</tbody></table>`;
  const r = report.run;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Import ${r.id} fidelity report</title>
<style>body{font-family:system-ui,sans-serif;margin:1rem;max-width:72rem}table{border-collapse:collapse;margin-bottom:1.5rem}td,th{border:1px solid #999;padding:.25rem .5rem;text-align:left}</style>
</head><body>
<h1>Import ${r.id}: fidelity report</h1>
<p>${html(r.importSource)} from ${html(r.sourceSystem)}${r.dryRun ? ' (dry run)' : ''}, ${html(r.status)}, finished ${html(r.finishedAt)}. Fidelity ${pct(report.totals.fidelity)}.</p>
<h2>Entities</h2>
${table(
  [
    'Kind',
    'Source',
    'Created',
    'Updated',
    'Unchanged',
    'Linked',
    'Failed',
    'Skipped',
    'Target',
    'Fidelity',
  ],
  report.entities.map((e) => [
    e.kind,
    e.source,
    e.outcomes.created,
    e.outcomes.updated,
    e.outcomes.unchanged,
    e.outcomes.linked,
    e.outcomes.failed,
    e.outcomes.skipped,
    e.target,
    pct(e.fidelity),
  ]),
)}
<h2>Samples</h2>
<p>${report.sampleSummary.matched} of ${report.sampleSummary.compared} compared samples match.</p>
${table(
  ['Kind', 'Source id', 'Target id', 'Match'],
  report.samples.map((s) => [
    s.kind,
    s.sourceId,
    s.targetId,
    s.match === null ? '–' : s.match ? 'yes' : 'no',
  ]),
)}
<h2>Warnings</h2>
${table(
  ['Kind', 'Code', 'Detail', 'Count', 'Examples'],
  report.warnings.map((w) => [w.kind, w.code, w.detail, w.count, w.examples.join(', ')]),
)}
<h2>Not imported</h2>
${table(
  ['Kind', 'Count', 'Reason'],
  report.unsupported.map((u) => [u.kind, u.count, u.reason]),
)}
<h2>Failures</h2>
${table(
  ['Kind', 'Source id', 'Error'],
  report.failures.map((f) => [f.kind, f.sourceId, f.error]),
)}
</body></html>
`;
}
