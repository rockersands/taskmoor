import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { fc } from '@taskmoor/testkit/property';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { csvField } from '../audit/query';
import { SESSION_COOKIE } from '../auth';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { cellText, dayOf, instantOf, records, secondsOf } from './csv';
import { registerImportJobs } from './jobs';
import { type FidelityReport, fidelityReport } from './report';

const rows = (text: string, delimiter = ',') =>
  [...records(Buffer.from(text, 'utf8'), delimiter)].map((r) => r.fields);

describe('reading CSV (M1-098)', () => {
  it('[IMP-012] reads quotes, doubled quotes, line breaks in quotes, CRLF and a byte order mark', () => {
    const text = '﻿Key,Summary\r\nA-1,"Say ""hi"", then\r\nleave"\r\n\r\nA-2,plain,\nA-3,"last"';
    expect(rows(text)).toEqual([
      ['Key', 'Summary'],
      ['A-1', 'Say "hi", then\r\nleave'],
      ['A-2', 'plain', ''],
      ['A-3', 'last'],
    ]);
    const lines = [...records(Buffer.from(text), ',')].map((r) => r.line);
    expect(lines).toEqual([1, 2, 5, 6]);
    expect(rows('a;b\n1;"2;3"', ';')).toEqual([
      ['a', 'b'],
      ['1', '2;3'],
    ]);
  });

  it('[IMP-012] reads back every cell the export writes (formula guard included)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.string({ unit: 'binary' }), { minLength: 1, maxLength: 5 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (table) => {
          const width = Math.max(...table.map((r) => r.length));
          const full = table.map((r) => [...r, ...Array(width - r.length).fill('')]);
          // A row of empty cells reads as a blank line only when it has one column.
          fc.pre(full.every((r) => r.length > 1 || r[0] !== ''));
          const text = full.map((r) => `${r.map(csvField).join(',')}\r\n`).join('');
          const back = rows(text).map((r) => r.map(cellText));
          expect(back).toEqual(full);
        },
      ),
    );
  });

  it('[IMP-012] reads dates, instants and durations', () => {
    expect(dayOf('2026-02-28')).toBe('2026-02-28');
    expect(dayOf('2026-02-30')).toBeNull();
    expect(dayOf('2026-03-01T10:00:00Z')).toBe('2026-03-01');
    expect(instantOf('2026-03-01')).toBe('2026-03-01T00:00:00.000Z');
    expect(instantOf('2026-03-01 09:30')).toBe('2026-03-01T09:30:00.000Z');
    expect(instantOf('2026-03-01T09:30:00+02:00')).toBe('2026-03-01T07:30:00.000Z');
    expect(instantOf('yesterday')).toBeNull();
    expect(secondsOf('5400')).toBe(5400);
    expect(secondsOf('1h 30m')).toBe(5400);
    expect(secondsOf('soon')).toBeNull();
  });
});

// Made at run time: tests keep no credentials in the repository.
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.77.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

interface Problem {
  kind: string;
  sourceId: string;
  outcome: string;
  error: string | null;
  warnings: { code: string; detail?: string }[];
}

/**
 * CSV import end to end (M1-098; IMP-012): a dry run lists every row's problems and writes
 * nothing; the run creates tickets with keys, hierarchy, people, custom values, labels and
 * releases; importing the file again with changes updates; a key the target already has is
 * updated, its unmapped fields kept; a mapping is reused from an earlier run; files on the
 * server are read only inside the imports folder.
 */
describe('CSV import (M1-098)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  let importDir = '';
  const users: Record<string, { id: number; cookie: string }> = {};
  let severity = 0;
  let points = 0;
  let topics = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  async function drain() {
    for (let i = 0; i < 500; i++) if ((await runner.runOnce()) === 0) return;
  }
  async function run(body: Record<string, unknown>) {
    const res = await as('admin', { method: 'POST', url: '/api/v1/admin/imports', payload: body });
    expect(res.statusCode, res.body).toBe(202);
    const id = res.json().importRun.id as number;
    await drain();
    const view = (await as('admin', { method: 'GET', url: `/api/v1/admin/imports/${id}` })).json()
      .importRun;
    expect(view.status, view.lastError ?? '').toBe('done');
    const report = await as('admin', { method: 'GET', url: `/api/v1/admin/imports/${id}/report` });
    return { id, report: fidelityReport.parse(report.json().report) as FidelityReport };
  }
  async function problems(id: number, query = ''): Promise<Problem[]> {
    const res = await as('admin', {
      method: 'GET',
      url: `/api/v1/admin/imports/${id}/problems${query}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().problems;
  }
  const ticket = (key: string) =>
    database.db
      .selectFrom('ticket as k')
      .innerJoin('track as t', 't.id', 'k.track_id')
      .innerJoin('status as s', 's.id', 'k.status_id')
      .select([
        'k.id',
        'k.summary',
        'k.description',
        'k.parent_id',
        'k.assignee_id',
        'k.labels',
        'k.fields',
        'k.created_at',
        's.name as status',
      ])
      .where('t.key', '=', key.split('-')[0] as string)
      .where('k.number', '=', Number(key.split('-')[1]))
      .executeTakeFirst();

  beforeAll(async () => {
    importDir = await mkdtemp(join(tmpdir(), 'taskmoor-csv-'));
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], importDir });
    runner = new JobRunner(database.db, 'csv-test');
    registerImportJobs(runner, database.db, new FieldCatalogs(database.db), { batch: 3 });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['dana', false],
    ] as const) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name: name === 'dana' ? 'Dana Doe' : 'Admin',
          password_hash: hash,
          is_site_admin: admin,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      const cookie = (
        [res.headers['set-cookie'] ?? []]
          .flat()
          .find(
            (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
          ) ?? ''
      ).split(';')[0] as string;
      users[name] = { id: row.id, cookie };
    }
    const post = async (url: string, payload: Record<string, unknown>) => {
      const res = await as('admin', { method: 'POST', url, payload });
      expect(res.statusCode, res.body).toBe(201);
      return res.json();
    };
    const track = (await post('/api/v1/tracks', { key: 'CSV', name: 'From files', mode: 'shared' }))
      .track.id;
    const members = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    await as('admin', {
      method: 'PUT',
      url: `/api/v1/tracks/${track}/roles/${members.id}/users/${users.dana?.id}`,
    });
    await post(`/api/v1/tracks/${track}/releases`, { name: '1.0' });
    severity = (
      await post('/api/v1/fields', {
        name: 'Severity',
        type: 'select',
        context: { options: [{ value: 'S1' }, { value: 'S2' }] },
      })
    ).field.id;
    points = (await post('/api/v1/fields', { name: 'Points', type: 'number' })).field.id;
    topics = (await post('/api/v1/fields', { name: 'Topics', type: 'labels' })).field.id;
  });

  afterAll(async () => {
    await app.close();
    await rm(importDir, { recursive: true, force: true });
  });

  const mapping = () => ({
    track: 'CSV',
    columns: [
      { column: 'Key', to: 'key' },
      { column: 'Summary', to: 'summary' },
      { column: 'Description', to: 'description' },
      { column: 'Status', to: 'status' },
      { column: 'Assignee', to: 'assignee' },
      { column: 'Parent', to: 'parent' },
      { column: 'Labels', to: 'labels' },
      { column: 'Fix version', to: 'targetRelease' },
      { column: 'Severity', to: 'field', field: severity },
      { column: 'Points', to: 'field', field: points },
      { column: 'Topics', to: 'field', field: topics },
      { column: 'Created', to: 'createdAt' },
      { column: 'Notes', to: 'ignore' },
    ],
    people: { 'Dana Doe': 'dana@example.com' },
  });
  // The child comes before its parent in the file; one label column repeats.
  const file = (summary2 = 'Child of the first') =>
    [
      'Key,Summary,Description,Status,Assignee,Parent,Labels,Labels,Fix version,Severity,Points,Topics,Created,Notes',
      `CSV-2,"${summary2}",,Active,Dana Doe,CSV-1,one,two,1.0; 2.0,S2,3,x y,2026-01-02 10:00,ignored`,
      'CSV-1,"First, with a comma","Some **bold** text",New,dana@example.com,,,,2.0,S1,5,,2026-01-01,',
      'CSV-7,A gap in numbers,,New,ghost@example.com,,,,,S9,lots,,yesterday,',
    ].join('\r\n');

  it('[IMP-012][IMP-009] a dry run lists every row problem and writes nothing', async () => {
    const before = await database.db.selectFrom('ticket').select('id').execute();
    const { id, report } = await run({
      dryRun: true,
      source: { format: 'csv', data: file(), mapping: mapping() },
    });
    expect(report.run.dryRun).toBe(true);
    const tickets = report.entities.find((e) => e.kind === 'ticket');
    expect(tickets?.source).toBe(3);
    expect(tickets?.outcomes.created).toBe(3);
    const found = await problems(id, '?kind=ticket');
    const gap = found.find((p) => p.sourceId === 'CSV-7');
    expect(gap?.warnings.map((w) => `${w.code}:${w.detail ?? ''}`).sort()).toEqual([
      'invalid_value:createdAt',
      'unknown_value:cf[' + severity + ']',
      'value_invalid:cf[' + points + ']',
    ]);
    expect((await database.db.selectFrom('ticket').select('id').execute()).length).toBe(
      before.length,
    );
  });

  it('[IMP-012] imports rows with keys, a parent column, people, custom values and releases', async () => {
    const { report } = await run({ source: { format: 'csv', data: file(), mapping: mapping() } });
    expect(report.totals.failed, JSON.stringify(report.failures)).toBe(0);
    const first = await ticket('CSV-1');
    const second = await ticket('CSV-2');
    expect(first?.summary).toBe('First, with a comma');
    expect(second?.parent_id).toBe(first?.id);
    expect(second?.assignee_id).toBe(users.dana?.id);
    expect(second?.status).toBe('Active');
    expect(second?.labels).toEqual(['one', 'two']);
    expect(second?.created_at.toISOString()).toBe('2026-01-02T10:00:00.000Z');
    const options = await database.db
      .selectFrom('field_option')
      .select(['id', 'value'])
      .where('field_id', '=', severity)
      .execute();
    expect(second?.fields).toMatchObject({
      [severity]: options.find((o) => o.value === 'S2')?.id,
      [points]: 3,
      [topics]: ['x', 'y'],
    });
    const releases = await database.db
      .selectFrom('ticket_release as r')
      .innerJoin('release as l', 'l.id', 'r.release_id')
      .select('l.name')
      .where('r.ticket_id', '=', second?.id as number)
      .orderBy('l.name')
      .execute();
    expect(releases.map((r) => r.name)).toEqual(['1.0', '2.0']);
    // A number the file skipped stays free; the counter moves past the highest.
    const gap = await ticket('CSV-7');
    expect(gap).toBeDefined();
    const counter = await database.db
      .selectFrom('ticket_counter as c')
      .innerJoin('track as t', 't.id', 'c.track_id')
      .select('c.last_number')
      .where('t.key', '=', 'CSV')
      .executeTakeFirstOrThrow();
    expect(counter.last_number).toBe(7);
    // A person the file names who is not here yet: deactivated, so attribution stays.
    const ghost = await database.db
      .selectFrom('app_user')
      .select(['deactivated_at', 'password_hash'])
      .where('email', '=', 'ghost@example.com')
      .executeTakeFirstOrThrow();
    expect(ghost.deactivated_at).not.toBeNull();
    expect(ghost.password_hash).toBeNull();
    // The new values are history too.
    const history = await database.db
      .selectFrom('ticket_change')
      .select('field')
      .where('ticket_id', '=', second?.id as number)
      .execute();
    expect(history.map((h) => h.field)).toEqual(
      expect.arrayContaining(['key', 'summary', 'parent', `cf[${severity}]`]),
    );
  });

  it('[IMP-012][IMP-009] importing the file again with changes updates and never duplicates', async () => {
    const count = async () =>
      (await database.db.selectFrom('ticket').select('id').execute()).length;
    const before = await count();
    const { report } = await run({
      source: { format: 'csv', data: file('Child, renamed'), mapping: mapping() },
    });
    const tickets = report.entities.find((e) => e.kind === 'ticket');
    expect(tickets?.outcomes).toMatchObject({ created: 0, updated: 1, unchanged: 2 });
    expect(await count()).toBe(before);
    expect((await ticket('CSV-2'))?.summary).toBe('Child, renamed');
  });

  it('[IMP-012] updates a ticket the target already has by its key, keeping unmapped fields', async () => {
    const made = await as('admin', {
      method: 'POST',
      url: '/api/v1/tickets?format=markdown',
      payload: { track: 'CSV', summary: 'Made here', description: 'Keep me' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const key = made.json().ticket.key as string;
    const { report, id } = await run({
      source: {
        format: 'csv',
        system: 'other-file',
        data: `Key,Summary\n${key},Renamed from a file\n`,
        mapping: {
          track: 'CSV',
          columns: [
            { column: 'Key', to: 'key' },
            { column: 'Summary', to: 'summary' },
          ],
        },
      },
    });
    expect(report.entities.find((e) => e.kind === 'ticket')?.outcomes.updated).toBe(1);
    const after = await ticket(key);
    expect(after?.summary).toBe('Renamed from a file');
    expect(JSON.stringify(after?.description)).toContain('Keep me');
    // The same mapping again, taken from that run.
    const again = await as('admin', {
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: {
        dryRun: true,
        source: {
          format: 'csv',
          system: 'other-file',
          data: `Key,Summary\n${key},Again\n`,
          mappingFrom: id,
        },
      },
    });
    expect(again.statusCode, again.body).toBe(202);
  });

  it('[IMP-012] reads files on the server only inside the imports folder', async () => {
    await mkdir(join(importDir, 'in'), { recursive: true });
    await writeFile(join(importDir, 'in', 'rows.csv'), 'Summary\nFrom a path\n');
    const source = (path: string) => ({
      dryRun: true,
      source: {
        format: 'csv',
        path,
        mapping: { track: 'CSV', columns: [{ column: 'Summary', to: 'summary' }] },
      },
    });
    const ok = await as('admin', {
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: source('in/rows.csv'),
    });
    expect(ok.statusCode, ok.body).toBe(202);
    for (const path of ['../rows.csv', '/etc/passwd', 'in/missing.csv']) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/admin/imports',
        payload: source(path),
      });
      expect(res.statusCode, path).toBe(400);
      expect(['outside_import_folder', 'not_found']).toContain(res.json().error);
    }
    const header = await as('admin', {
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: {
        source: {
          format: 'csv',
          data: 'Title\nx\n',
          mapping: { track: 'CSV', columns: [{ column: 'Summary', to: 'summary' }] },
        },
      },
    });
    expect(header.statusCode).toBe(400);
    expect(header.json()).toMatchObject({ error: 'invalid_source', line: 1 });
    const member = await as('dana', {
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: source('in/rows.csv'),
    });
    expect(member.statusCode).toBe(403);
  });
});
