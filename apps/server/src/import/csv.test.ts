import { isUtf8 } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { fc } from '@taskmoor/testkit/property';
import { csvField, csvLine, detectDelimiter } from '@taskmoor/webconfig';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import {
  CsvSource,
  cellText,
  csvSource,
  dayOf,
  decodeCsv,
  fromDecimalComma,
  instantOf,
  records,
  secondsOf,
} from './csv';
import { registerImportJobs } from './jobs';
import { type FidelityReport, fidelityReport } from './report';

/**
 * Windows-1252 at 0x80 to 0x9F, as the WHATWG Encoding Standard's index has it; the five bytes it
 * leaves undefined decode to the C1 control of the same number.
 */
const CP1252_80_9F = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';

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
          // Either style, its separator found from the header (T-263).
          for (const style of ['comma', 'semicolon'] as const) {
            const text = full.map((r) => csvLine(r, style)).join('');
            const delimiter = detectDelimiter(Buffer.from(text, 'utf8'));
            if (width > 1) expect(delimiter).toBe(style === 'comma' ? ',' : ';');
            const back = rows(text, delimiter).map((r) => r.map(cellText));
            expect(back).toEqual(full);
          }
          expect(full.map((r) => `${r.map((c) => csvField(c)).join(',')}\r\n`).join('')).toBe(
            full.map((r) => csvLine(r)).join(''),
          );
        },
      ),
    );
  });

  it('[IMP-012] takes back the guard an export put on a full-width formula mark', () => {
    for (const text of ['＝1+1', '＋1', '－1', '＠team', '=1+1']) {
      expect(cellText(csvField(text))).toBe(text);
    }
    // An apostrophe someone typed before anything else is theirs.
    expect(cellText("'＿x")).toBe("'＿x");
  });

  it('[IMP-012] finds the separator from the header when the mapping leaves it out (T-263)', () => {
    const open = (text: string, delimiter?: ',' | ';' | '\t' | '|') =>
      new CsvSource(
        csvSource.parse({
          format: 'csv',
          data: text,
          mapping: {
            track: 'CSV',
            columns: [{ column: 'Resumen', to: 'summary' }],
            ...(delimiter ? { delimiter } : {}),
          },
        }),
      );
    expect(open('Clave;Resumen;Estado\r\nA-1;"x, y";Nuevo').delimiter).toBe(';');
    expect(open('Clave\tResumen\nA-1\tx').delimiter).toBe('\t');
    expect(open('Clave|Resumen\nA-1|x').delimiter).toBe('|');
    expect(open('Clave,Resumen\nA-1;x;y;z').delimiter).toBe(',');
    // A tie goes to the comma.
    expect(open('Resumen,a;b\nx').delimiter).toBe(',');
    // An explicit separator wins over what the header shows.
    expect(open('Clave;Resumen\nA-1;x', ',').delimiter).toBe(',');
    expect(() => open('Clave;Resumen\nA-1;x', ',').check()).toThrow('no column "Resumen"');
  });

  it('[IMP-012] finds the same separator and the same offsets in every job part of a run', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(',', ';', '\t', '|'),
        fc.array(fc.array(fc.string({ unit: 'binary' }), { minLength: 2, maxLength: 4 }), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.boolean(),
        (delimiter, table, latin) => {
          const text = table.map((r) => r.join(delimiter)).join('\r\n');
          const raw = latin ? Buffer.from(text, 'latin1') : Buffer.from(text, 'utf8');
          const first = decodeCsv(raw);
          const again = decodeCsv(Buffer.from(raw));
          expect(again.encoding).toBe(first.encoding);
          expect(again.bytes.equals(first.bytes)).toBe(true);
          const d = detectDelimiter(first.bytes);
          expect(detectDelimiter(again.bytes)).toBe(d);
          const offsets = (b: Buffer) => [...records(b, d)].map((r) => [r.start, r.end]);
          expect(offsets(again.bytes)).toEqual(offsets(first.bytes));
          // What comes out is always UTF-8, so a second reading changes nothing.
          expect(decodeCsv(first.bytes).bytes.equals(first.bytes)).toBe(true);
        },
      ),
    );
  });

  it('[IMP-012] keeps UTF-8 as it is, with or without a byte-order mark (T-263)', () => {
    for (const text of ['Clave;Título\r\nA-1;Árbol', '﻿Clave;Título\r\nA-1;Árbol', 'Key\n1']) {
      const raw = Buffer.from(text, 'utf8');
      const read = decodeCsv(raw);
      expect(read.encoding).toBe('utf-8');
      expect(read.bytes).toBe(raw);
    }
  });

  it('[IMP-012] reads a file that is not UTF-8 as Windows-1252, every byte as browsers do (T-263)', () => {
    // Bytes 0x80 to 0xFF after an ASCII letter are not UTF-8. Node 22's own TextDecoder reads
    // 0x80 to 0x9F of 'windows-1252' as Latin-1 controls, so the expected text is spelled out.
    const high = Buffer.from([0x78, ...Array.from({ length: 128 }, (_, i) => 0x80 + i)]);
    const read = decodeCsv(high);
    expect(read.encoding).toBe('windows-1252');
    expect(read.bytes.toString('utf8')).toBe(`x${CP1252_80_9F}${high.toString('latin1', 33)}`);
    expect(read.bytes.toString('utf8').slice(1, 33)).toBe(CP1252_80_9F);
    // What Spanish Excel's plain "CSV" saves: semicolons and the legacy code page.
    const excel = Buffer.from([
      0x44, 0x65, 0x73, 0x63, 0x72, 0x69, 0x70, 0x63, 0x69, 0xf3, 0x6e, 0x3b, 0x80, 0x0d, 0x0a,
    ]);
    expect(decodeCsv(excel).bytes.toString('utf8')).toBe('Descripción;€\r\n');
    // A UTF-8 mark followed by bytes that are not UTF-8: the rest is read the old way.
    const marked = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0x41, 0xe9])]);
    expect(decodeCsv(marked).bytes.toString('utf8')).toBe('Aé');
  });

  it('[IMP-012] reads UTF-16 that starts with its byte-order mark (T-263)', () => {
    const text = 'Clave\tTítulo\r\nA-1\t€ y ñ\r\n';
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(decodeCsv(le)).toMatchObject({ encoding: 'utf-16le' });
    expect(decodeCsv(le).bytes.toString('utf8')).toBe(text);
    const be = Buffer.from(Buffer.from(text, 'utf16le')).swap16();
    const marked = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    expect(decodeCsv(marked)).toMatchObject({ encoding: 'utf-16be' });
    expect(decodeCsv(marked).bytes.toString('utf8')).toBe(text);
    // An odd last byte is dropped, not read past.
    expect(decodeCsv(Buffer.concat([marked, Buffer.from([0x41])])).bytes.toString('utf8')).toBe(
      text,
    );
  });

  it('[IMP-012] reads Windows-1252 text back as it was written, whenever its bytes are not UTF-8', () => {
    const encoder = new Map(
      Array.from({ length: 256 }, (_, b) => [
        b >= 0x80 && b <= 0x9f ? (CP1252_80_9F[b - 0x80] as string) : String.fromCharCode(b),
        b,
      ]),
    );
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...'aZ09 ;,"\r\nñÑáéíóúÁÉÍÓÚüÜ¿¡€œŒšŠžŽŸ‘’“”–—…ªº°'), {
          maxLength: 60,
        }),
        (chars) => {
          const text = chars.join('');
          const bytes = Buffer.from(chars.map((c) => encoder.get(c) as number));
          fc.pre(!isUtf8(bytes));
          const read = decodeCsv(bytes);
          expect(read.encoding).toBe('windows-1252');
          expect(read.bytes.toString('utf8')).toBe(text);
        },
      ),
    );
  });

  it('[IMP-012] reads a decimal comma in a semicolon file, and refuses what could be either mark (T-263)', () => {
    const cases: [string, string | null][] = [
      ['2,5', '2.5'],
      ['-0,25', '-0.25'],
      [',5', '.5'],
      ['1.234,5', '1234.5'],
      ['1.234.567,89', '1234567.89'],
      ['1234,5', '1234.5'],
      ['1,5e3', '1.5e3'],
      [' 7,0 ', '7.0'],
      // One group of three after a dot: a thousands dot or a decimal point.
      ['1.234', null],
      ['-12.500', null],
      // Unmistakable without a comma: a decimal point, or groups of thousands.
      ['2.5', '2.5'],
      ['0.125', '0.125'],
      ['1.2345', '1.2345'],
      ['1.234.567', '1234567'],
      ['42', '42'],
      // Text a number field refuses on its own.
      ['12.34,5', '12.34,5'],
      ['2,', '2,'],
      ['lots', 'lots'],
    ];
    for (const [text, read] of cases) expect(fromDecimalComma(text), text).toBe(read);
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
    points = (await post('/api/v1/fields', { name: 'Pts', type: 'number' })).field.id;
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
      { column: 'Type', to: 'type' },
      { column: 'Summary', to: 'summary' },
      { column: 'Description', to: 'description' },
      { column: 'Status', to: 'status' },
      { column: 'Assignee', to: 'assignee' },
      { column: 'Parent', to: 'parent' },
      { column: 'Labels', to: 'labels' },
      { column: 'Fix version', to: 'targetRelease' },
      { column: 'Severity', to: 'field', field: severity },
      { column: 'Pts', to: 'field', field: points },
      { column: 'Topics', to: 'field', field: topics },
      { column: 'Created', to: 'createdAt' },
      { column: 'Notes', to: 'ignore' },
    ],
    people: { 'Dana Doe': 'dana@example.com' },
  });
  // The child comes before its parent in the file; one label column repeats.
  const file = (summary2 = 'Child of the first') =>
    [
      'Key,Type,Summary,Description,Status,Assignee,Parent,Labels,Labels,Fix version,Severity,Pts,Topics,Created,Notes',
      `CSV-2,Subticket,"${summary2}",,Active,Dana Doe,CSV-1,one,two,1.0; 2.0,S2,3,x y,2026-01-02 10:00,ignored`,
      'CSV-1,,"First, with a comma","Some **bold** text",New,dana@example.com,,,,2.0,S1,5,,2026-01-01,',
      'CSV-7,,A gap in numbers,,New,ghost@example.com,,,,,S9,lots,,yesterday,',
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
      `unknown_value:cf[${severity}]`,
      `value_invalid:cf[${points}]`,
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

  it('[IMP-012] drops a parent that does not sit on a higher level, with a warning', async () => {
    const { id } = await run({
      source: {
        format: 'csv',
        system: 'levels',
        data: 'Id,Summary,Parent\nA,Same level parent,\nB,Same level child,A\n',
        mapping: {
          track: 'CSV',
          columns: [
            { column: 'Id', to: 'id' },
            { column: 'Summary', to: 'summary' },
            { column: 'Parent', to: 'parent' },
          ],
        },
      },
    });
    const child = await database.db
      .selectFrom('ticket')
      .select('parent_id')
      .where('summary', '=', 'Same level child')
      .executeTakeFirstOrThrow();
    expect(child.parent_id).toBeNull();
    const found = await problems(id, '?outcome=warned');
    expect(found.find((p) => p.sourceId === 'B')?.warnings).toEqual([
      { code: 'parent_wrong_level' },
    ]);
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

  it('[IMP-012] keeps an archived release in a custom release field, as in the system one (T-282)', async () => {
    const admin = async (method: 'POST', url: string, payload?: Record<string, unknown>) => {
      const res = await as('admin', { method, url, ...(payload ? { payload } : {}) });
      expect(res.statusCode, res.body).toBeLessThan(300);
      return res.json();
    };
    const track = await database.db
      .selectFrom('track')
      .select('id')
      .where('key', '=', 'CSV')
      .executeTakeFirstOrThrow();
    const old = (await admin('POST', `/api/v1/tracks/${track.id}/releases`, { name: '0.9' }))
      .release;
    await admin('POST', `/api/v1/releases/${old.id}/archive`);
    const shippedIn = (
      await admin('POST', '/api/v1/fields', { name: 'Shipped in', type: 'release' })
    ).field.id as number;
    const { id } = await run({
      source: {
        format: 'csv',
        system: 'archived-release',
        data: 'Summary,Fix version,Shipped in\nOld work,0.9,0.9\n',
        mapping: {
          track: 'CSV',
          columns: [
            { column: 'Summary', to: 'summary' },
            { column: 'Fix version', to: 'targetRelease' },
            { column: 'Shipped in', to: 'field', field: shippedIn },
          ],
        },
      },
    });
    const made = await database.db
      .selectFrom('ticket')
      .select(['id', 'fields'])
      .where('summary', '=', 'Old work')
      .executeTakeFirstOrThrow();
    expect(made.fields).toMatchObject({ [shippedIn]: old.id });
    const target = await database.db
      .selectFrom('ticket_release')
      .select('release_id')
      .where('ticket_id', '=', made.id)
      .execute();
    expect(target.map((r) => r.release_id)).toEqual([old.id]);
    expect(await problems(id, '?outcome=warned')).toEqual([]);
  });

  it('[IMP-012][CORE-015] gives no imported ticket an archived release as a field default (T-282)', async () => {
    const admin = async (url: string, payload: Record<string, unknown> = {}) => {
      const res = await as('admin', { method: 'POST', url, payload });
      expect(res.statusCode, res.body).toBeLessThan(300);
      return res.json();
    };
    const track = await database.db
      .selectFrom('track')
      .select('id')
      .where('key', '=', 'CSV')
      .executeTakeFirstOrThrow();
    const gone = (await admin(`/api/v1/tracks/${track.id}/releases`, { name: '0.8' })).release;
    const deliveredIn = (await admin('/api/v1/fields', { name: 'Delivered in', type: 'release' }))
      .field.id as number;
    // A default set before the release was archived (the API offers none for a release field;
    // a configuration import may carry one).
    await database.db
      .updateTable('field_context')
      .set({ default_value: JSON.stringify(gone.id) })
      .where('field_id', '=', deliveredIn)
      .execute();
    await admin(`/api/v1/releases/${gone.id}/archive`);
    await run({
      source: {
        format: 'csv',
        system: 'archived-default',
        data: 'Summary\nNo delivery column\n',
        mapping: { track: 'CSV', columns: [{ column: 'Summary', to: 'summary' }] },
      },
    });
    const made = await database.db
      .selectFrom('ticket')
      .select('fields')
      .where('summary', '=', 'No delivery column')
      .executeTakeFirstOrThrow();
    expect(made.fields).not.toHaveProperty(String(deliveredIn));
  });

  it('[IMP-012] [NFR-006] imports what Spanish Excel saves as plain CSV: semicolons, Windows-1252 with a note, decimal commas (T-263)', async () => {
    // Semicolons, the legacy code page and no byte-order mark; the mapping names no separator.
    const text = [
      'Resumen;Descripción;Pts',
      'Árbol de navegación;Señal "rápida";2,5',
      'Mil y pico;;1.234,5',
      'Dudoso;;1.234',
      '',
    ].join('\r\n');
    await mkdir(join(importDir, 'in'), { recursive: true });
    await writeFile(join(importDir, 'in', 'excel.csv'), Buffer.from(text, 'latin1'));
    const mapping = {
      track: 'CSV',
      columns: [
        { column: 'Resumen', to: 'summary' },
        { column: 'Descripción', to: 'description' },
        { column: 'Pts', to: 'field', field: points },
      ],
    };
    const { id, report } = await run({
      source: { format: 'csv', system: 'excel-es', path: 'in/excel.csv', mapping },
    });
    expect(report.totals.failed, JSON.stringify(report.failures)).toBe(0);
    expect(report.warnings).toContainEqual({
      kind: 'source',
      code: 'read_as_windows_1252',
      detail: null,
      count: 2,
      // The line and its word as data; the report says "line" in the reader's language.
      examples: ['1: Descripción', '2: Árbol'],
    });
    const made = await database.db
      .selectFrom('ticket')
      .select(['summary', 'description', 'fields'])
      .where('summary', 'in', ['Árbol de navegación', 'Mil y pico', 'Dudoso'])
      .orderBy('id')
      .execute();
    expect(made.map((m) => m.summary)).toEqual(['Árbol de navegación', 'Mil y pico', 'Dudoso']);
    expect(JSON.stringify(made[0]?.description)).toContain('Señal \\"rápida\\"');
    expect(made[0]?.fields).toMatchObject({ [points]: 2.5 });
    expect(made[1]?.fields).toMatchObject({ [points]: 1234.5 });
    // "1.234" could be a thousands dot or a decimal point: left out, and said so.
    expect(made[2]?.fields).not.toHaveProperty(String(points));
    const found = await problems(id, '?kind=ticket');
    expect(found.find((p) => p.sourceId === 'line:4')?.warnings).toEqual([
      { code: 'value_invalid', detail: `cf[${points}]` },
    ]);
    // The stored run keeps no separator, so every later part finds the same one again.
    const stored = await database.db
      .selectFrom('import_run')
      .select('source')
      .where('id', '=', String(id))
      .executeTakeFirstOrThrow();
    expect((stored.source as { mapping: Record<string, unknown> }).mapping).not.toHaveProperty(
      'delimiter',
    );
  });

  it('[IMP-012] keeps the separator a mapping names, and reads a UTF-8 file without a note (T-263)', async () => {
    const mapping = (delimiter?: string) => ({
      track: 'CSV',
      columns: [
        { column: 'Resumen', to: 'summary' },
        { column: 'Pts', to: 'field', field: points },
      ],
      ...(delimiter ? { delimiter } : {}),
    });
    const data = 'Resumen;Pts\r\nCon marca y UTF-8;3,25\r\n';
    const refused = await as('admin', {
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: { dryRun: true, source: { format: 'csv', data, mapping: mapping(',') } },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'invalid_source', line: 1 });
    const { report } = await run({
      source: { format: 'csv', system: 'utf8-es', data: `﻿${data}`, mapping: mapping(';') },
    });
    expect(report.warnings.filter((w) => w.kind === 'source')).toEqual([]);
    const made = await database.db
      .selectFrom('ticket')
      .select('fields')
      .where('summary', '=', 'Con marca y UTF-8')
      .executeTakeFirstOrThrow();
    expect(made.fields).toMatchObject({ [points]: 3.25 });
  });
});
