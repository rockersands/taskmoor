import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword, pepperFromSecret, pepperRing } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import { SESSION_COOKIE } from '../../auth';
import { JobRunner } from '../../events/queue';
import { FieldCatalogs } from '../../fields/catalog';
import { contentSnapshot } from '../../testing/compat-compare';
import { buildCompatSource, type CompatSource, SOURCE_URL } from '../../testing/compat-source';
import { importFormats, registerImportJobs } from '../jobs';
import { type FidelityReport, fidelityReport } from '../report';
import { recorder, writeRecording } from './replay';

/** Set to record the replay fixtures again from the populated source (then review the diff). */
const RECORD = process.env.TASKMOOR_RECORD_CLOUD_FIXTURES === '1';
export const FIXTURE = join(__dirname, '__fixtures__', 'compat-source.json');

let address = 0;
const nextAddress = () => `100.94.${Math.floor(++address / 250) % 250}.${(address % 250) + 1}`;

/**
 * The Cloud REST importer against Taskmoor's own Jira-compatible API (M1-095; IMP-002; ADR-094):
 * a populated source app in process, read with a token made for the run, imported into a fresh
 * target, which then holds the same tickets, fields, comments, time, history, boards and sprints
 * as the source. The exchanges are what the replay fixtures hold
 * (`TASKMOOR_RECORD_CLOUD_FIXTURES=1` writes them again).
 */
describe('Cloud REST import from a compatible server (M1-095)', () => {
  const sourceDb = useMigratedDatabase();
  const targetDb = useMigratedDatabase();
  let source: CompatSource;
  let target: FastifyInstance;
  let runner: JobRunner;
  let cookie = '';
  const tape = { current: null as ReturnType<typeof recorder> | null };

  const asAdmin = async (options: InjectOptions) => {
    const res = await target.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie },
    });
    let body: unknown = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };
  async function drain() {
    for (let i = 0; i < 2000; i++) {
      if ((await runner.runOnce()) === 0) return;
    }
  }

  beforeAll(async () => {
    source = await buildCompatSource(sourceDb.db);
    const peppers = pepperRing(pepperFromSecret(randomBytes(32)));
    target = await buildApp({ db: targetDb.db, version: 'test', roles: ['api'], peppers });
    runner = new JobRunner(targetDb.db, 'cloud-import-test');
    registerImportJobs(runner, targetDb.db, new FieldCatalogs(targetDb.db), {
      batch: 20,
      formats: importFormats({
        peppers,
        transport: () => {
          tape.current = recorder(source.transport);
          return tape.current.transport;
        },
        client: { sleep: async () => {} },
        detailChunk: 7,
      }),
    });
    const password = randomBytes(18).toString('base64url');
    await targetDb.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'root@example.org',
        name: 'Target admin',
        password_hash: await hashPassword(password),
        is_site_admin: true,
      })
      .execute();
    const res = await target.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'root@example.org', password },
      remoteAddress: nextAddress(),
    });
    const set = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    cookie = (set.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '').split(';')[0] ?? '';
  }, 180_000);

  afterAll(async () => {
    await source?.app.close();
    await target?.close();
  });

  it('[IMP-002] imports a compatible server and the target holds what the source holds', async () => {
    const started = await asAdmin({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: {
        name: 'From the compatible source',
        source: {
          format: 'cloud-rest',
          baseUrl: SOURCE_URL,
          email: source.email,
          token: source.token,
          pageSize: 5,
        },
      },
    });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const runId = (started.body as { importRun: { id: number } }).importRun.id;
    // The run's stored settings hold the token sealed, never as given.
    const row = await targetDb.db
      .selectFrom('import_run')
      .select('source')
      .where('id', '=', String(runId))
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row.source)).not.toContain(source.token);
    expect(JSON.stringify(row.source)).toMatch(/"token":"enc1:/);

    await drain();
    const view = (await asAdmin({ method: 'GET', url: `/api/v1/admin/imports/${runId}` })).body as {
      importRun: { status: string; lastError: string | null };
    };
    expect(view.importRun.status, view.importRun.lastError ?? '').toBe('done');
    const report = fidelityReport.parse(
      (
        (await asAdmin({ method: 'GET', url: `/api/v1/admin/imports/${runId}/report` })).body as {
          report: FidelityReport;
        }
      ).report,
    );
    const failed = report.entities.filter((e) => e.outcomes.failed > 0);
    expect(failed, JSON.stringify(report.failures ?? [], null, 1)).toEqual([]);

    const tracks = ['ALP', 'BET'];
    const want = await contentSnapshot(source.admin, tracks);
    const got = await contentSnapshot(asAdmin, tracks);
    // Not an empty comparison: the source has all of these.
    const all = Object.values(want.tickets);
    expect(all).toHaveLength(22);
    expect(all.flatMap((t) => t.comments)).toHaveLength(11);
    expect(all.flatMap((t) => t.timeEntries)).toHaveLength(7);
    expect(all.flatMap((t) => t.history).length).toBeGreaterThan(15);
    expect(all.filter((t) => Object.keys(t.fields).length > 0).length).toBeGreaterThan(10);
    expect(
      want.boards.map((b) => b.sprints.map((s: { tickets: string[] }) => s.tickets.length)),
    ).toEqual([[4, 3], []]);
    expect(Object.keys(got.tickets)).toEqual(Object.keys(want.tickets));
    for (const key of Object.keys(want.tickets)) {
      expect(got.tickets[key], key).toEqual(want.tickets[key]);
    }
    expect(got.boards).toEqual(want.boards);

    if (RECORD && tape.current) writeRecording(FIXTURE, SOURCE_URL, tape.current.exchanges());
  }, 300_000);
});
