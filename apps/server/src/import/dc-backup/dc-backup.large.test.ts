import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultOptions, generateDcBackup } from './generate';
import { validateDcBackup } from './validate';

/**
 * M1-087's done-when at full size: a 1,000,000-issue synthetic backup is written with bounded
 * memory and validates against the format and its manifest. Run with
 *   TASKMOOR_LARGE_DC_BACKUP=1 pnpm verify --only=tests -- apps/server/src/import/dc-backup/dc-backup.large.test.ts
 * (`TASKMOOR_LARGE_DC_BACKUP_ISSUES` sets another size; `TASKMOOR_LARGE_DC_BACKUP_DIR` keeps the
 * ZIP and its manifest in that folder for the importer's runs, M1-091;
 * `TASKMOOR_LARGE_DC_BACKUP_REPORT` names a file the measurements are appended to). Measured: see
 * `docs/specs/02d-dc-backup-format.md`, "Measured".
 */
const ISSUES = Number(process.env.TASKMOOR_LARGE_DC_BACKUP_ISSUES ?? 1_000_000);
const KEEP = process.env.TASKMOOR_LARGE_DC_BACKUP_DIR;
const dir = KEEP ?? join(tmpdir(), `taskmoor-dc-backup-large-${process.pid}`);
const MB = 1_048_576;

describe.skipIf(!process.env.TASKMOOR_LARGE_DC_BACKUP)(
  `a ${ISSUES.toLocaleString('en')}-issue backup (M1-087)`,
  () => {
    afterAll(async () => {
      if (!KEEP) await rm(dir, { recursive: true, force: true });
    });

    it('[IMP-001] is written with bounded memory and validates', async () => {
      await mkdir(dir, { recursive: true });
      const zipPath = join(dir, `dc-backup-${ISSUES}-seed1.zip`);
      let heap = 0;
      const sample = setInterval(() => {
        heap = Math.max(heap, process.memoryUsage().heapUsed);
      }, 250);
      const started = Date.now();
      const { manifest } = await generateDcBackup(defaultOptions(ISSUES, 1), zipPath);
      const generated = Date.now() - started;
      const generateHeap = heap;
      heap = 0;
      const report = await validateDcBackup(zipPath, manifest);
      const validated = Date.now() - started - generated;
      clearInterval(sample);
      const zipped = (await stat(zipPath)).size;
      const rows = Object.values(manifest.entities).reduce((a, b) => a + b, 0);
      const line = JSON.stringify({
        issues: ISSUES,
        rows,
        zipMB: +(zipped / MB).toFixed(1),
        entitiesMB: +(manifest.files.entities.bytes / MB).toFixed(1),
        attachments: manifest.attachments.files,
        attachmentsMB: +(manifest.attachments.bytes / MB).toFixed(1),
        generateSeconds: +(generated / 1000).toFixed(1),
        validateSeconds: +(validated / 1000).toFixed(1),
        generateHeapMB: +(generateHeap / MB).toFixed(0),
        validateHeapMB: +(heap / MB).toFixed(0),
        maxRssMB: +((process.resourceUsage().maxRSS * 1024) / MB).toFixed(0),
      });
      process.stdout.write(`${line}\n`);
      const reportFile = process.env.TASKMOOR_LARGE_DC_BACKUP_REPORT;
      if (reportFile) await appendFile(reportFile, `${line}\n`);
      expect(report.problems).toEqual([]);
      expect(manifest.entities.Issue).toBe(ISSUES);
      // Memory stays far below the data: the live heap is a small fraction of entities.xml.
      expect(generateHeap).toBeLessThan(512 * MB);
      expect(heap).toBeLessThan(768 * MB);
    }, 3_600_000);
  },
);
