import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { type CliIo, IMPORT_EXIT, importCommand } from './cli';
import { registerImportJobs } from './jobs';

let address = 0;
const nextAddress = () => `100.98.${Math.floor(++address / 250) % 250}.${(address % 250) + 1}`;

/**
 * The operator CLI's `import` command (M1-097; IMP-013): start, follow, report, status, list and
 * cancel through the API with an API token, and every documented exit code, each from the
 * situation it stands for. The server runs in process; waiting between polls runs the import
 * job one part at a time, as the worker would.
 */
describe('node cli.mjs import (M1-097)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  let dir = '';
  const tokens: Record<string, string> = {};

  /** The CLI's io against the app, with what it printed. */
  const io = (token: string, overrides: Partial<CliIo> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const value: CliIo = {
      request: async (method, path, body) => {
        const res = await app.inject({
          method: method as 'GET',
          url: `/api/v1${path}`,
          remoteAddress: nextAddress(),
          headers: {
            authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
        });
        const json = (res.headers['content-type'] ?? '').toString().includes('json');
        return { status: res.statusCode, body: json && res.body ? res.json() : res.body };
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      // Waiting lets the worker run the next part of the import.
      sleep: async () => {
        await runner.runOnce();
      },
      readFile: (path) => readFile(path, 'utf8'),
      writeFile: (path, data) => writeFile(path, data),
      env: {},
      ...overrides,
    };
    return { io: value, out, err };
  };
  const run = async (args: string[], who = 'admin', overrides: Partial<CliIo> = {}) => {
    const cli = io(tokens[who] ?? '', overrides);
    const code = await importCommand(args, cli.io);
    return { code, out: cli.out, err: cli.err };
  };
  const synthetic = async (tickets: number) => {
    const path = join(dir, `synthetic-${tickets}.json`);
    await writeFile(
      path,
      JSON.stringify({ format: 'synthetic', generate: { seed: 7, prefix: 'CLI', tickets } }),
    );
    return path;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'taskmoor-import-cli-'));
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      importDir: join(dir, 'imports'),
    });
    runner = new JobRunner(database.db, 'import-cli-test');
    // A part per batch, so a run is followed through several polls.
    registerImportJobs(runner, database.db, new FieldCatalogs(database.db), {
      batch: 10,
      partMs: 0,
    });
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
      const signIn = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${who}@example.org`, password },
        remoteAddress: nextAddress(),
      });
      const set = [signIn.headers['set-cookie']].flat().filter(Boolean) as string[];
      const cookie = (set.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '').split(';')[0];
      const made = await app.inject({
        method: 'POST',
        url: '/api/v1/account/tokens',
        remoteAddress: nextAddress(),
        headers: { cookie: cookie ?? '' },
        payload: {
          name: 'cli',
          scopes: admin ? ['read', 'write', 'admin'] : ['read', 'write'],
          expiresInDays: 1,
        },
      });
      expect(made.statusCode, made.body).toBe(201);
      tokens[who] = made.json().token;
    }
  }, 120_000);
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('[IMP-013] 0: starts a dry run, follows it to the end and prints its report', async () => {
    const res = await run(['start', '--source', await synthetic(6), '--dry-run', '--follow']);
    expect(res.err).toEqual([]);
    expect(res.code).toBe(IMPORT_EXIT.done);
    expect(res.out[0]).toMatch(/^import \d+ queued \(dry run\): synthetic from /);
    // Progress lines as the run went, then the summary, then the result as JSON.
    expect(res.out.filter((l) => / running \(dry run\): /.test(l)).length).toBeGreaterThan(1);
    expect(res.out).toContainEqual(expect.stringMatching(/^ {2}ticket: 6 read, 6 created$/));
    const last = JSON.parse(res.out[res.out.length - 1] as string);
    expect(last).toMatchObject({ status: 'done', exit: 0, failed: 0 });
    expect(last.target).toBeNull();
    // The same run's report again, as JSON and as a page.
    const page = join(dir, 'report.html');
    const again = await run(['report', String(last.id), '--json', '--html', page]);
    expect(again.code).toBe(IMPORT_EXIT.done);
    expect(JSON.parse(again.out[0] as string).run.id).toBe(last.id);
    expect(await readFile(page, 'utf8')).toMatch(/^<!doctype html>/);
    const listed = await run(['list']);
    expect(listed.out[0]).toMatch(new RegExp(`^${last.id}\\tdone \\(dry run\\)\\tsynthetic`));
  }, 120_000);

  it('[IMP-013] 2: done, but with more warnings than --max-warnings allows', async () => {
    const res = await run([
      'start',
      '--source',
      await synthetic(4),
      '--follow',
      '--max-warnings',
      '0',
    ]);
    const last = JSON.parse(res.out[res.out.length - 1] as string);
    expect(last.warnings).toBeGreaterThan(0);
    expect(res.code).toBe(IMPORT_EXIT.problems);
    expect(res.out).toContainEqual(expect.stringMatching(/^warnings: \d+ \(at most 0 wanted\)$/));
    // Within a looser limit the same run is done.
    const looser = await run(['report', String(last.id), '--max-warnings', String(last.warnings)]);
    expect(looser.code).toBe(IMPORT_EXIT.done);
  }, 120_000);

  it('[IMP-013] 1: a cancelled run; 75: its report before it finished', async () => {
    const started = await run(['start', '--source', await synthetic(5)]);
    expect(started.code).toBe(IMPORT_EXIT.done);
    const id = JSON.parse(started.out[1] as string).id as number;
    const early = await run(['report', String(id)]);
    expect(early.code).toBe(IMPORT_EXIT.notFinished);
    expect(early.err[0]).toMatch(/has not finished \(queued\)/);
    const status = await run(['status', String(id)]);
    expect(status.code).toBe(IMPORT_EXIT.done);
    expect(JSON.parse(status.out[1] as string).status).toBe('queued');
    expect((await run(['cancel', String(id)])).code).toBe(IMPORT_EXIT.done);
    const followed = await run(['follow', String(id)]);
    expect(followed.code).toBe(IMPORT_EXIT.failed);
    expect(JSON.parse(followed.out[followed.out.length - 1] as string).status).toBe('cancelled');
  }, 120_000);

  it('[IMP-013] 64: bad usage, before anything reaches the server', async () => {
    let called = false;
    const spy = {
      request: async () => {
        called = true;
        return { status: 500, body: null };
      },
    };
    for (const args of [
      [],
      ['bogus'],
      ['start'],
      ['start', '--dc-backup', 'a.zip', '--export', 'b.zip'],
      ['start', '--dc-backup', 'a.zip', '--scope', 'everything'],
      ['start', '--dc-backup', 'a.zip', '--max-warnings', 'many'],
      ['start', '--csv', 'a.csv'],
      ['start', '--cloud', 'https://example.test'],
      ['start', '--unknown'],
      ['follow'],
      ['report', 'x'],
    ]) {
      const res = await run(args, 'admin', spy);
      expect(res.code, args.join(' ')).toBe(IMPORT_EXIT.usage);
      expect(res.err.join('\n'), args.join(' ')).toMatch(/Usage: node cli.mjs import/);
    }
    expect(called).toBe(false);
    const help = await run(['help'], 'admin', spy);
    expect(help.code).toBe(IMPORT_EXIT.done);
    expect(help.out[0]).toMatch(/Exit: 0 done, 1 failed/);
  });

  it('[IMP-013] 65: the server refuses the source; 77: the token may not import; 69: no server', async () => {
    const outside = await run(['start', '--dc-backup', '../../etc/passwd']);
    expect(outside.code).toBe(IMPORT_EXIT.refused);
    expect(outside.err[0]).toMatch(/^import start: (not_found|outside_import_folder)/);
    const missing = await run(['report', '999999']);
    expect(missing.code).toBe(IMPORT_EXIT.refused);
    const member = await run(['start', '--source', await synthetic(2)], 'member');
    expect(member.code).toBe(IMPORT_EXIT.forbidden);
    expect(member.err[0]).toMatch(/admin scope/);
    const unreachable = await run(['list'], 'admin', {
      request: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      },
    });
    expect(unreachable.code).toBe(IMPORT_EXIT.unavailable);
    expect(unreachable.err[0]).toMatch(/cannot be reached/);
    const broken = await run(['list'], 'admin', {
      request: async () => ({ status: 503, body: { error: 'not_ready' } }),
    });
    expect(broken.code).toBe(IMPORT_EXIT.unavailable);
  });
});
