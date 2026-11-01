import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { defaultOptions, generateDcBackup } from '../import/dc-backup/generate';
import { saveImportFile, UploadRefused, uploadName } from '../import/files';
import { registerImportJobs } from '../import/jobs';
import { craftZip } from '../testing/zip';

let address = 0;
const nextAddress = () => `100.97.${Math.floor(++address / 250) % 250}.${(address % 250) + 1}`;

/**
 * What the import wizard needs of the server (M1-097; IMP-007, IMP-013): the imports folder's
 * files with what each looks like, uploads into it (refused outside plain names, over an
 * existing file, for anyone but a site administrator), and people of a Data Center backup
 * mapped to existing people by the wizard's `map` rows, everyone else by address.
 */
describe('the import wizard routes (M1-097)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  let dir = '';
  const cookies: Record<string, string> = {};
  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: cookies[who] ?? '' },
    });
  const upload = (who: string, name: string, body: Buffer, type = 'application/octet-stream') =>
    as(who, {
      method: 'POST',
      url: `/api/v1/admin/imports/files?name=${encodeURIComponent(name)}`,
      headers: { 'content-type': type },
      payload: body,
    });
  const drain = async () => {
    for (let i = 0; i < 2000; i++) if ((await runner.runOnce()) === 0) return;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'taskmoor-import-wizard-'));
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      importDir: join(dir, 'imports'),
    });
    runner = new JobRunner(database.db, 'import-wizard-test');
    registerImportJobs(runner, database.db, new FieldCatalogs(database.db), { batch: 100 });
    const password = randomBytes(18).toString('base64url');
    for (const [who, admin] of [
      ['admin', true],
      ['member', false],
    ] as const) {
      await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${who}@example.org`,
          name: who,
          password_hash: await hashPassword(password),
          is_site_admin: admin,
        })
        .execute();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${who}@example.org`, password },
        remoteAddress: nextAddress(),
      });
      const set = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
      cookies[who] =
        (set.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '').split(';')[0] ?? '';
    }
  }, 120_000);
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('[IMP-013] lists the imports folder and takes uploads into it', async () => {
    const empty = await as('admin', { method: 'GET', url: '/api/v1/admin/imports/files' });
    expect(empty.json()).toMatchObject({ folder: true, files: [] });

    const csv = await upload('admin', 'backlog.csv', Buffer.from('Summary\nFirst\n'));
    expect(csv.statusCode, csv.body).toBe(201);
    expect(csv.json().file).toEqual({ name: 'backlog.csv', size: 14, kind: 'csv' });
    const backup = craftZip([
      { name: 'entities.xml', data: Buffer.from('<entity-engine-xml/>') },
      { name: 'activeobjects.xml', data: Buffer.from('<backup/>') },
    ]);
    const zip = await upload('admin', 'jira backup.zip', backup);
    expect(zip.statusCode, zip.body).toBe(201);
    expect(zip.json().file.kind).toBe('dc-backup');
    // A file copied into the folder by hand is listed too, and what an import writes beside a
    // backup is not.
    await writeFile(join(dir, 'imports', 'notes.txt'), 'hello');
    await writeFile(join(dir, 'imports', 'jira backup.zip.staged'), '');
    const listed = (
      await as('admin', { method: 'GET', url: '/api/v1/admin/imports/files' })
    ).json();
    expect(
      listed.files.map((f: { name: string; kind: string | null }) => [f.name, f.kind]),
    ).toEqual([
      ['backlog.csv', 'csv'],
      ['jira backup.zip', 'dc-backup'],
      ['notes.txt', null],
    ]);
    expect(await readFile(join(dir, 'imports', 'backlog.csv'), 'utf8')).toBe('Summary\nFirst\n');

    // Refusals.
    expect((await upload('admin', 'backlog.csv', Buffer.from('x'))).json().error).toBe(
      'file_exists',
    );
    for (const name of ['../escape.csv', 'run.exe', '.hidden.csv', 'a/b.csv']) {
      const res = await upload('admin', name, Buffer.from('x'));
      expect([res.statusCode, res.json().error], name).toEqual([400, 'invalid_name']);
    }
    expect((await upload('admin', 'plain.csv', Buffer.from('x'), 'text/csv')).statusCode).toBe(415);
    expect((await upload('member', 'mine.csv', Buffer.from('x'))).statusCode).toBe(403);
    expect(
      (await as('member', { method: 'GET', url: '/api/v1/admin/imports/files' })).statusCode,
    ).toBe(403);
    expect(uploadName('Backup 2026-10-31.ZIP')).toBe('Backup 2026-10-31.ZIP');
    await expect(
      saveImportFile(join(dir, 'imports'), 'big.csv', Readable.from([Buffer.alloc(64)]), 32),
    ).rejects.toThrow(UploadRefused);
    const after = (await as('admin', { method: 'GET', url: '/api/v1/admin/imports/files' })).json();
    expect(after.files.map((f: { name: string }) => f.name)).not.toContain('big.csv');
  });

  it('[IMP-007] maps a Data Center person to an existing one, everyone else by address', async () => {
    await generateDcBackup(defaultOptions(40, 97), join(dir, 'imports', 'small.zip'));
    const run = async (people?: unknown) => {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/admin/imports',
        payload: {
          dryRun: true,
          source: {
            format: 'dc-backup',
            path: 'small.zip',
            scope: 'configuration',
            ...(people ? { people } : {}),
          },
        },
      });
      expect(res.statusCode, res.body).toBe(202);
      await drain();
      const id = res.json().importRun.id;
      const records = (
        await as('admin', {
          method: 'GET',
          url: `/api/v1/admin/imports/${id}/records?kind=user&limit=1000`,
        })
      ).json().records as { sourceId: string; outcome: string; warnings: unknown[] }[];
      return new Map(records.map((r) => [r.sourceId, r]));
    };
    const plain = await run();
    const someone = [...plain.values()].find((r) => r.outcome === 'created');
    expect(someone).toBeDefined();
    const mapped = await run({
      mode: 'map',
      rows: [{ source: someone?.sourceId, target: 'admin@example.org' }],
    });
    expect(mapped.get(someone?.sourceId as string)?.outcome).toBe('linked');
    // Everyone else as before.
    for (const [id, r] of plain) {
      if (id !== someone?.sourceId) expect(mapped.get(id)?.outcome, id).toBe(r.outcome);
    }
    // A row naming someone the target lacks: a placeholder, reported.
    const missing = await run({
      mode: 'map',
      rows: [{ source: someone?.sourceId, target: 'nobody@example.org' }],
    });
    expect(missing.get(someone?.sourceId as string)?.warnings).toContainEqual({
      code: 'person_unmapped',
      detail: 'existing',
    });
  }, 300_000);
});
