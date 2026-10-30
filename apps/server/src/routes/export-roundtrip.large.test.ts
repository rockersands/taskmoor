import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { LocalStore } from '@taskmoor/storage';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { type AttachmentStores, storesOf } from '../attachments/stores';
import { SESSION_COOKIE } from '../auth';
import type { Manifest } from '../export/format';
import { folderSink } from '../export/sinks';
import { exportWorkspace, translationOf } from '../export/write';
import { FieldCatalogs } from '../fields/catalog';
import { verifyFieldValues } from '../fields/storage';
import { CSV_SOURCE } from '../import/csv';
import { IMPORT_FORMATS } from '../import/jobs';
import { fidelityReport } from '../import/report';
import { createRun, runImport } from '../import/run';
import { EXPORT_SOURCE } from '../import/taskmoor';
import { multipartFile } from '../testing/multipart';

/**
 * The full export's done-when (M1-098; IMP-014): a workspace of 100,000 tickets (custom values,
 * subtickets, releases, areas, followers, history with starting values and transitions,
 * comments with history, links, time entries and files) is exported, imported into a newly
 * migrated database through the importer framework, and exported again with ids translated back
 * through the import's external ids. Lossless means every file of the two exports has the
 * same SHA-256, and the attachments' checksums match too. The test also samples the live heap
 * while the export runs: it grows by far less than the files' size. Run with
 *   TASKMOOR_LARGE_ROUNDTRIP=1 pnpm verify --only=tests -- apps/server/src/routes/export-roundtrip.large.test.ts
 * (`TASKMOOR_LARGE_ROUNDTRIP_TICKETS` sets another size). Measured: see the progress row of
 * M1-098 and ADR-061.
 */
const TICKETS = Number(process.env.TASKMOOR_LARGE_ROUNDTRIP_TICKETS ?? 100_000);
const FILES = 100;
const PASSWORD = randomBytes(18).toString('base64url');

function collector(): () => void {
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}

describe.skipIf(!process.env.TASKMOOR_LARGE_ROUNDTRIP)(
  'a 100,000-ticket round trip (M1-098)',
  () => {
    const source = useMigratedDatabase();
    const target = useMigratedDatabase();
    let app: FastifyInstance;
    let dir = '';
    let sourceStores: AttachmentStores;
    let targetStores: AttachmentStores;
    let cookie = '';

    const admin = async (options: InjectOptions, status = 200) => {
      const res = await app.inject({ ...options, headers: { ...(options.headers ?? {}), cookie } });
      expect(res.statusCode, `${options.url} ${res.body}`).toBe(status);
      return res.json();
    };

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'taskmoor-roundtrip-'));
      sourceStores = storesOf(await LocalStore.open(join(dir, 'files-source')));
      targetStores = storesOf(await LocalStore.open(join(dir, 'files-target')));
      app = await buildApp({
        db: source.db,
        version: 'test',
        roles: ['api'],
        attachments: sourceStores,
      });
      const hash = await hashPassword(PASSWORD);
      await source.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: 'admin@example.com',
          name: 'Admin',
          password_hash: hash,
          is_site_admin: true,
        })
        .execute();
      await sql`
      INSERT INTO app_user (workspace_id, email, name, time_zone)
      SELECT 1, 'person' || g || '@example.com', 'Person ' || g, 'Europe/Madrid'
        FROM generate_series(1, 20) g`.execute(source.db);
      const session = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: 'admin@example.com', password: PASSWORD },
      });
      cookie =
        [session.headers['set-cookie'] ?? []]
          .flat()
          .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
          ?.split(';')[0] ?? '';

      // Configuration through the API.
      const track = (
        await admin(
          {
            method: 'POST',
            url: '/api/v1/tracks',
            payload: { key: 'BIG', name: 'Big', mode: 'shared' },
          },
          201,
        )
      ).track.id as number;
      const release = (
        await admin(
          { method: 'POST', url: `/api/v1/tracks/${track}/releases`, payload: { name: '1.0' } },
          201,
        )
      ).release.id as number;
      const area = (
        await admin(
          { method: 'POST', url: `/api/v1/tracks/${track}/areas`, payload: { name: 'API' } },
          201,
        )
      ).area.id as number;
      const severity = (
        await admin(
          {
            method: 'POST',
            url: '/api/v1/fields',
            payload: {
              name: 'Severity',
              type: 'select',
              context: { options: [{ value: 'S1' }, { value: 'S2' }] },
            },
          },
          201,
        )
      ).field;
      const points = (
        await admin(
          { method: 'POST', url: '/api/v1/fields', payload: { name: 'Points', type: 'number' } },
          201,
        )
      ).field.id as number;
      const reviewer = (
        await admin(
          { method: 'POST', url: '/api/v1/fields', payload: { name: 'Reviewer', type: 'user' } },
          201,
        )
      ).field.id as number;
      const topics = (
        await admin(
          { method: 'POST', url: '/api/v1/fields', payload: { name: 'Topics', type: 'labels' } },
          201,
        )
      ).field.id as number;
      const [s1, s2] = (severity.contexts[0].options as { id: number }[]).map((o) => o.id);
      const first = (
        await admin(
          {
            method: 'POST',
            url: '/api/v1/tickets',
            payload: { track: 'BIG', summary: 'Template' },
          },
          201,
        )
      ).ticket.id as number;

      // 100,000 tickets in SQL: values spread over statuses, people, priorities and fields.
      await sql`
      WITH s AS (SELECT array_agg(id ORDER BY sort_order) AS a FROM status
                  WHERE name IN ('New', 'Active', 'In Review', 'Closed')),
           u AS (SELECT array_agg(id ORDER BY id) AS a FROM app_user WHERE email LIKE 'person%'),
           p AS (SELECT array_agg(id ORDER BY sort_order) AS a FROM priority)
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          description, creator_id, assignee_id, priority_id, rank, fields, labels,
                          created_at, updated_at, due_date, original_estimate)
      SELECT k.workspace_id, k.track_id, k.number + g, k.ticket_type_id, s.a[1 + g % 4],
             'Ticket ' || g || ', "quoted" ✓',
             CASE WHEN g % 3 = 0 THEN jsonb_build_object('type', 'doc', 'content',
               jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content',
                 jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'About ' || g),
                   jsonb_build_object('type', 'mention', 'attrs',
                     jsonb_build_object('id', u.a[1 + g % 20]::text, 'label', 'P')))))) END,
             u.a[1 + g % 20], CASE WHEN g % 2 = 0 THEN u.a[1 + (g / 2) % 20] END,
             p.a[1 + g % array_length(p.a, 1)],
             k.rank || lpad(g::text, 6, '0') || '1',
             jsonb_build_object(${String(severity.id)}::text, CASE WHEN g % 2 = 0 THEN ${s1}::int ELSE ${s2}::int END,
                                ${String(points)}::text, g % 13,
                                ${String(reviewer)}::text, u.a[1 + g % 20],
                                ${String(topics)}::text, jsonb_build_array('t' || g % 5)),
             ARRAY['big', 'l' || (g % 7)],
             now() - make_interval(secs => ${TICKETS} - g),
             now() - make_interval(secs => (${TICKETS} - g) / 2),
             CASE WHEN g % 5 = 0 THEN date '2027-01-01' + g % 300 END,
             CASE WHEN g % 4 = 0 THEN 3600 * (g % 9) END
        FROM ticket k, s, u, p, generate_series(1, ${TICKETS - 1}) AS g
       WHERE k.id = ${first}`.execute(source.db);
      // Every tenth ticket a subticket of the one before it.
      await sql`
      UPDATE ticket c
         SET parent_id = p.id,
             ticket_type_id = (SELECT t.id FROM ticket_type t JOIN hierarchy_level l ON l.id = t.level_id
                                WHERE l.kind = 'subticket' ORDER BY t.id LIMIT 1)
        FROM ticket p
       WHERE c.track_id = ${track} AND p.track_id = ${track} AND c.number % 10 = 0
         AND p.number = c.number - 1`.execute(source.db);
      await sql`UPDATE ticket_counter SET last_number = ${TICKETS} WHERE track_id = ${track}`.execute(
        source.db,
      );
      await sql`
      INSERT INTO ticket_release (workspace_id, ticket_id, release_id, role)
      SELECT 1, id, ${release}, 'target' FROM ticket WHERE track_id = ${track} AND number % 3 = 0`.execute(
        source.db,
      );
      await sql`
      INSERT INTO ticket_area (workspace_id, ticket_id, area_id)
      SELECT 1, id, ${area} FROM ticket WHERE track_id = ${track} AND number % 4 = 0`.execute(
        source.db,
      );
      await sql`
      INSERT INTO ticket_follower (workspace_id, ticket_id, user_id)
      SELECT 1, id, creator_id FROM ticket
       WHERE track_id = ${track} AND number % 5 = 0 AND creator_id IS NOT NULL`.execute(source.db);

      // History: each ticket's starting values, and a status change for those not New.
      await sql`
      WITH t AS (
        SELECT k.id, k.created_at, k.creator_id, k.summary, k.status_id, k.ticket_type_id,
               k.track_id, k.number, k.rank, nextval('ticket_change_set_seq') AS cs,
               (SELECT id FROM status WHERE name = 'New') AS first_status
          FROM ticket k WHERE k.track_id = ${track} AND k.id <> ${first}
      )
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field,
                                 from_value, to_value, from_display, to_display)
      SELECT 1, t.id, t.cs, t.created_at, t.creator_id, f.field, NULL, f.value, NULL, f.display
        FROM t, LATERAL (VALUES
          ('track', t.track_id::text, 'BIG'),
          ('key', 'BIG-' || t.number, NULL),
          ('type', t.ticket_type_id::text, NULL),
          ('status', t.first_status::text, 'New'),
          ('summary', t.summary, NULL),
          ('rank', t.rank, NULL)) AS f (field, value, display)`.execute(source.db);
      await sql`
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field,
                                 from_value, to_value, from_display, to_display)
      SELECT 1, k.id, nextval('ticket_change_set_seq'), k.created_at + interval '1 hour',
             k.assignee_id, 'status', n.id::text, k.status_id::text, 'New', s.name
        FROM ticket k JOIN status s ON s.id = k.status_id,
             (SELECT id FROM status WHERE name = 'New') n
       WHERE k.track_id = ${track} AND k.id <> ${first} AND k.status_id <> n.id`.execute(source.db);

      // Comments on every second ticket, each with its history entry.
      await sql`
      INSERT INTO ticket_comment (workspace_id, ticket_id, author_id, body, created_at, updated_at)
      SELECT 1, id, creator_id,
             jsonb_build_object('type', 'doc', 'content', jsonb_build_array(
               jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
                 jsonb_build_object('type', 'text', 'text', 'Comment on ' || number))))),
             created_at + interval '2 hours', created_at + interval '2 hours'
        FROM ticket WHERE track_id = ${track} AND number % 2 = 0`.execute(source.db);
      await sql`
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field,
                                 from_value, to_value)
      SELECT 1, ticket_id, nextval('ticket_change_set_seq'), created_at, author_id, 'comment',
             NULL, id::text
        FROM ticket_comment WHERE workspace_id = 1`.execute(source.db);
      // Links and time entries on every tenth ticket.
      await sql`
      INSERT INTO ticket_link (workspace_id, link_type_id, source_id, target_id, created_by, created_at)
      SELECT 1, (SELECT id FROM link_type ORDER BY id LIMIT 1), a.id, b.id, a.creator_id, a.created_at
        FROM ticket a JOIN ticket b ON b.track_id = a.track_id AND b.number = a.number + 1
       WHERE a.track_id = ${track} AND a.number % 10 = 1`.execute(source.db);
      await sql`
      INSERT INTO time_entry (workspace_id, ticket_id, author_id, started_at, duration, description,
                              created_by, created_at)
      SELECT 1, id, creator_id, created_at, 1800, 'Work on ' || number, creator_id, created_at
        FROM ticket WHERE track_id = ${track} AND number % 10 = 3 AND creator_id IS NOT NULL`.execute(
        source.db,
      );
      await sql`
      UPDATE ticket k SET time_spent = 1800
       WHERE track_id = ${track} AND number % 10 = 3 AND creator_id IS NOT NULL`.execute(source.db);
      // Files through the API.
      for (let i = 0; i < FILES; i++) {
        await admin(
          {
            method: 'POST',
            url: `/api/v1/tickets/BIG-${1 + i * 7}/attachments`,
            ...multipartFile(
              `file-${i}.bin`,
              'application/octet-stream',
              randomBytes(1000 + i * 997),
            ),
          },
          201,
        );
      }
      await sql`ANALYZE`.execute(source.db);
    }, 1_800_000);

    afterAll(async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('[IMP-014][IMP-009][IMP-010] exports, imports into a new database and exports the same files again', async () => {
      const gc = collector();
      gc();
      const heapBefore = process.memoryUsage().heapUsed;
      let heapPeak = heapBefore;
      const sampler = setInterval(() => {
        gc();
        heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
      }, 500);
      const out = join(dir, 'export');
      const exported = await exportWorkspace(source.db, {
        workspaceId: 1,
        sink: folderSink(out),
        stores: sourceStores,
        catalogs: new FieldCatalogs(source.db),
      });
      clearInterval(sampler);
      const manifest = exported.manifest;
      const bytes = manifest.files.reduce((n, f) => n + f.bytes, 0) + manifest.attachments.bytes;
      const counts = Object.fromEntries(manifest.files.map((f) => [f.kind, f.records]));
      expect(counts.ticket).toBe(TICKETS);
      expect(manifest.attachments.files).toBe(FILES);

      const started = performance.now();
      const run = await createRun(target.db, {
        workspaceId: 1,
        userId: null,
        importSource: EXPORT_SOURCE,
        system: manifest.system,
        name: 'round trip',
        source: { format: EXPORT_SOURCE, path: out },
        dryRun: false,
      });
      const deps = {
        db: target.db,
        catalogs: new FieldCatalogs(target.db),
        formats: IMPORT_FORMATS,
        stores: targetStores,
      };
      expect(await runImport(deps, run.id, { until: Date.now() + 3_600_000 })).toBe('finished');
      const importMs = performance.now() - started;
      const row = await target.db
        .selectFrom('import_run')
        .selectAll()
        .where('id', '=', run.id)
        .executeTakeFirstOrThrow();
      expect(row.status, row.last_error ?? '').toBe('done');
      const report = fidelityReport.parse(row.report);
      expect(report.totals.failed, JSON.stringify(report.failures.slice(0, 5))).toBe(0);
      expect(report.totals.fidelity).toBe(1);
      expect(report.sampleSummary.mismatched).toBe(0);

      const translation = await translationOf(target.db, 1, EXPORT_SOURCE, manifest.system);
      const again = await exportWorkspace(target.db, {
        workspaceId: 1,
        sink: folderSink(join(dir, 'again')),
        stores: targetStores,
        catalogs: new FieldCatalogs(target.db),
        translate: translation,
      });
      const differ = (a: Manifest, b: Manifest) =>
        a.files
          .filter((f) => b.files.find((g) => g.name === f.name)?.sha256 !== f.sha256)
          .map((f) => f.name);
      const different = differ(manifest, again.manifest);
      let detail = '';
      for (const name of different) {
        const x = (await readFile(join(out, name), 'utf8')).split('\n');
        const y = (await readFile(join(dir, 'again', name), 'utf8')).split('\n');
        const i = x.findIndex((line, n) => line !== y[n]);
        detail += `${name} line ${i + 1}\n  ${x[i]}\n  ${y[i]}\n`;
      }
      expect(different, detail).toEqual([]);
      expect(again.manifest.attachments.sha256).toBe(manifest.attachments.sha256);
      // The side tables of custom values agree with the imported tickets.
      const catalog = await new FieldCatalogs(target.db).get(1);
      let after: number | undefined;
      for (;;) {
        const sides = await verifyFieldValues(target.db, catalog, 1, {
          limit: 10_000,
          ...(after === undefined ? {} : { after }),
        });
        expect(sides.mismatched).toEqual([]);
        if (sides.next === null) break;
        after = sides.next;
      }

      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      const line = `M1-098 round trip of ${TICKETS} tickets (${Object.values(counts).reduce((a, b) => a + b, 0)} records, ${mb(bytes)} MB): export ${(exported.ms / 1000).toFixed(1)} s (live heap growth ${mb(heapPeak - heapBefore)} MB), import ${(importMs / 1000).toFixed(1)} s in ${row.batches} batches, export again ${(again.ms / 1000).toFixed(1)} s; ${manifest.files.length} files and ${FILES} attachments identical by SHA-256`;
      process.stdout.write(`${line}\n`);
      if (process.env.TASKMOOR_LARGE_ROUNDTRIP_REPORT) {
        appendFileSync(process.env.TASKMOOR_LARGE_ROUNDTRIP_REPORT, `${line}\n`);
      }
      // Streamed: the live heap never holds the export.
      expect(heapPeak - heapBefore).toBeLessThan(bytes);
    }, 7_200_000);

    it('[IMP-012] imports 100,000 CSV rows with a parent column, children before parents, into the right hierarchy', async () => {
      // Every tenth row is a parent; its nine children come before it in the file.
      const lines = ['Key,Type,Summary,Parent,Labels'];
      for (let block = 0; block < TICKETS / 10; block++) {
        const parent = block * 10 + 10;
        for (let n = block * 10 + 1; n < parent; n++) {
          lines.push(`CSVH-${n},Subticket,"Child ${n}, of ${parent}",CSVH-${parent},csv l${n % 7}`);
        }
        lines.push(`CSVH-${parent},Feature,Parent ${parent},,csv`);
      }
      const path = join(dir, 'rows.csv');
      await writeFile(path, `${lines.join('\r\n')}\r\n`);
      await target.db
        .insertInto('track')
        .values({
          workspace_id: 1,
          key: 'CSVH',
          name: 'From a file',
          owner_id: null,
          access_policy_id: (
            await target.db
              .selectFrom('access_policy')
              .select('id')
              .where('is_default', '=', true)
              .executeTakeFirstOrThrow()
          ).id,
          type_set_id: (
            await target.db
              .selectFrom('type_set_default')
              .select('type_set_id')
              .where('track_type', '=', 'software')
              .executeTakeFirstOrThrow()
          ).type_set_id,
        })
        .execute();
      const started = performance.now();
      const run = await createRun(target.db, {
        workspaceId: 1,
        userId: null,
        importSource: CSV_SOURCE,
        system: 'rows',
        name: 'csv',
        source: {
          format: CSV_SOURCE,
          path,
          system: 'rows',
          mapping: {
            track: 'CSVH',
            columns: [
              { column: 'Key', to: 'key' },
              { column: 'Type', to: 'type' },
              { column: 'Summary', to: 'summary' },
              { column: 'Parent', to: 'parent' },
              { column: 'Labels', to: 'labels' },
            ],
          },
        },
        dryRun: false,
      });
      const deps = {
        db: target.db,
        catalogs: new FieldCatalogs(target.db),
        formats: IMPORT_FORMATS,
        stores: targetStores,
      };
      expect(await runImport(deps, run.id, { until: Date.now() + 3_600_000 })).toBe('finished');
      const ms = performance.now() - started;
      const row = await target.db
        .selectFrom('import_run')
        .selectAll()
        .where('id', '=', run.id)
        .executeTakeFirstOrThrow();
      expect(row.status, row.last_error ?? '').toBe('done');
      const report = fidelityReport.parse(row.report);
      expect(report.totals.failed, JSON.stringify(report.failures.slice(0, 5))).toBe(0);
      // Every child names the parent its row named.
      const { rows } = await sql<{ tickets: number; wrong: number }>`
      SELECT count(*)::int AS tickets,
             count(*) FILTER (WHERE (k.number % 10 = 0 AND k.parent_id IS NOT NULL)
                OR (k.number % 10 <> 0 AND (p.number IS DISTINCT FROM (k.number / 10) * 10 + 10)))::int AS wrong
        FROM ticket k JOIN track t ON t.id = k.track_id
        LEFT JOIN ticket p ON p.id = k.parent_id
       WHERE t.key = 'CSVH'`.execute(target.db);
      expect(rows[0]).toEqual({ tickets: TICKETS, wrong: 0 });
      const line = `M1-098 CSV import of ${TICKETS} rows with a parent column: ${(ms / 1000).toFixed(1)} s in ${row.batches} batches, hierarchy correct for every row`;
      process.stdout.write(`${line}\n`);
      if (process.env.TASKMOOR_LARGE_ROUNDTRIP_REPORT) {
        appendFileSync(process.env.TASKMOOR_LARGE_ROUNDTRIP_REPORT, `${line}\n`);
      }
    }, 7_200_000);
  },
);
