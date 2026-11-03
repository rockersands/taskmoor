import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { LocalStore } from '@taskmoor/storage';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { storesOf } from '../attachments/stores';
import { FieldCatalogs } from '../fields/catalog';
import { defaultOptions, generateDcBackup } from './dc-backup/generate';
import { stageDcBackup } from './dc-backup/stage';
import { buildWorld } from './dc-backup/world';
import { dcFidelity } from './dc-fidelity';
import { IMPORT_FORMATS } from './jobs';
import { fidelityReport } from './report';
import { createRun, runImport } from './run';

/**
 * M1-091's done-when at full size: a synthetic backup of a million issues (or
 * `TASKMOOR_LARGE_DC_IMPORT_ISSUES`) imports in full, with its time, its peak memory and its
 * entity fidelity measured. Not part of `pnpm verify`. Run with
 *   TASKMOOR_LARGE_DC_IMPORT=1 pnpm verify --only=tests -- apps/server/src/import/dc-import.large.test.ts
 * `TASKMOOR_LARGE_DC_IMPORT_DIR` keeps the backup, its stage and the files there (a ZIP already
 * there is reused); `TASKMOOR_LARGE_DC_IMPORT_REPORT` names a file the measurements are
 * appended to as one JSON line; `TASKMOOR_LARGE_DC_IMPORT_EVERY` checks one issue in that many
 * against the fixture (default: every issue up to 100,000, else one in 20). The import runs
 * as the job does, a batch of 250 records (`DEFAULT_BATCH`) at a time. Measured: ADR-092.
 */
const ISSUES = Number(process.env.TASKMOOR_LARGE_DC_IMPORT_ISSUES ?? 1_000_000);
const KEEP = process.env.TASKMOOR_LARGE_DC_IMPORT_DIR;
const EVERY = Number(process.env.TASKMOOR_LARGE_DC_IMPORT_EVERY ?? (ISSUES <= 100_000 ? 1 : 20));
const dir = KEEP ?? join(tmpdir(), `taskmoor-dc-import-large-${process.pid}`);
const MB = 1_048_576;

describe.skipIf(!process.env.TASKMOOR_LARGE_DC_IMPORT)(
  `a ${ISSUES.toLocaleString('en')}-issue backup import (M1-091)`,
  () => {
    const database = useMigratedDatabase();
    afterAll(async () => {
      if (!KEEP) await rm(dir, { recursive: true, force: true });
    });

    it('[IMP-001] [IMP-010] imports with 99.9% entity fidelity, its time and memory measured', async () => {
      await mkdir(dir, { recursive: true });
      const options = defaultOptions(ISSUES, 1);
      const zip = join(dir, `dc-backup-${ISSUES}-seed1.zip`);
      let heap = 0;
      const sample = setInterval(() => {
        heap = Math.max(heap, process.memoryUsage().heapUsed);
      }, 250);
      const t0 = Date.now();
      const exists = await stat(zip).then(
        () => true,
        () => false,
      );
      if (!exists) await generateDcBackup(options, zip);
      const t1 = Date.now();
      heap = 0;
      await stageDcBackup(zip);
      const t2 = Date.now();
      const stageHeap = heap;
      heap = 0;

      const db = database.db;
      const deps = {
        db,
        catalogs: new FieldCatalogs(db),
        formats: IMPORT_FORMATS,
        stores: storesOf(await LocalStore.open(join(dir, 'files'))),
      };
      const run = await createRun(db, {
        workspaceId: 1,
        userId: null,
        importSource: 'dc-backup',
        system: 'dc',
        name: 'Large',
        source: { format: 'dc-backup', path: zip },
        dryRun: false,
      });
      // Seconds per kind, as the job's parts run them.
      const perKind: Record<string, number> = {};
      let kind = '';
      let since = Date.now();
      const beforeRecord = (k: string) => {
        if (k === kind) return;
        const now = Date.now();
        if (kind) perKind[kind] = (perKind[kind] ?? 0) + (now - since) / 1000;
        kind = k;
        since = now;
      };
      while (
        (await runImport(deps, run.id, { until: Date.now() + 50_000, beforeRecord })) === 'more'
      );
      beforeRecord('');
      const t3 = Date.now();
      const importHeap = heap;
      const row = await db
        .selectFrom('import_run')
        .selectAll()
        .where('id', '=', run.id)
        .executeTakeFirstOrThrow();
      expect(row.status, row.last_error ?? '').toBe('done');
      const report = fidelityReport.parse(row.report);
      const fidelity = await dcFidelity(db, buildWorld(options), { every: EVERY });
      const t4 = Date.now();
      clearInterval(sample);
      const size = await sql<{
        bytes: string;
      }>`SELECT pg_database_size(current_database())::text AS bytes`.execute(db);
      // Why records failed, as the database is gone once this test ends.
      const failedReasons = await sql<{ kind: string; reason: string; count: string }>`
        SELECT entity_kind AS kind, left(error::text, 200) AS reason, count(*)::text AS count
          FROM import_record WHERE run_id = ${run.id} AND outcome = 'failed'
         GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 20`.execute(db);
      const line = JSON.stringify({
        issues: ISSUES,
        records: report.entities.reduce((n, e) => n + e.source, 0),
        generateSeconds: exists ? null : +((t1 - t0) / 1000).toFixed(1),
        stageSeconds: +((t2 - t1) / 1000).toFixed(1),
        importSeconds: +((t3 - t2) / 1000).toFixed(1),
        checkSeconds: +((t4 - t3) / 1000).toFixed(1),
        perKindSeconds: Object.fromEntries(
          Object.entries(perKind).map(([k, v]) => [k, +v.toFixed(1)]),
        ),
        stageHeapMB: +(stageHeap / MB).toFixed(0),
        importHeapMB: +(importHeap / MB).toFixed(0),
        maxRssMB: +((process.resourceUsage().maxRSS * 1024) / MB).toFixed(0),
        databaseMB: +(Number(size.rows[0]?.bytes ?? 0) / MB).toFixed(0),
        failed: report.totals.failed,
        failedReasons: failedReasons.rows,
        checkedEvery: EVERY,
        issuesChecked: fidelity.issuesChecked,
        fidelity: {
          expected: fidelity.expected,
          matched: fidelity.matched,
          rate: fidelity.rate,
          kinds: Object.fromEntries(fidelity.kinds.map((k) => [k.kind, [k.matched, k.expected]])),
        },
        examples: fidelity.kinds.flatMap((k) => k.examples.slice(0, 3)),
      });
      process.stdout.write(`${line}\n`);
      const reportFile = process.env.TASKMOOR_LARGE_DC_IMPORT_REPORT;
      if (reportFile) await appendFile(reportFile, `${line}\n`);
      for (const k of fidelity.kinds) {
        expect(k.matched / k.expected, k.kind).toBeGreaterThanOrEqual(0.999);
      }
      // Memory stays far below the data: the stage spills to files (IMP-001 (1)).
      expect(stageHeap).toBeLessThan(1024 * MB);
    }, 86_400_000);
  },
);
