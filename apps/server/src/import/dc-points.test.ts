import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import type { BoardFilter } from '../boards/model';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { mapBoard, translateQuery } from './dc-agile';
import {
  ACTIVE_OBJECTS_FILE,
  AO_NAMESPACE,
  AO_ROOT,
  AO_TABLES,
  ENTITIES_FILE,
  XSI_NAMESPACE,
} from './dc-backup/format';
import { registerImportJobs } from './jobs';
import { type FidelityReport, fidelityReport } from './report';

// Made at run time: tests keep no credentials in the repository.
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.95.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

const TEXT_FIELD = 'com.atlassian.jira.plugin.system.customfieldtypes:textfield';
const NUMBER_FIELD = 'com.atlassian.jira.plugin.system.customfieldtypes:float';

async function zipOf(entries: Record<string, string>, path: string): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const [name, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), name);
  zip.end();
  const parts: Buffer[] = [];
  for await (const chunk of zip.outputStream) parts.push(chunk as Buffer);
  await writeFile(path, Buffer.concat(parts));
}

const xmlText = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** The agile plugin's tables with the given rows, as the active-objects file holds them. */
function activeObjects(rows: Record<string, (string | number | boolean | null)[][]>): string {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<${AO_ROOT} xmlns="${AO_NAMESPACE}" xmlns:xsi="${XSI_NAMESPACE}">`,
  ];
  for (const [table, columns] of Object.entries(AO_TABLES)) {
    out.push(`<table name="${table}">`);
    for (const c of columns) {
      out.push(
        `<column name="${c.name}" primaryKey="${!!c.primaryKey}" autoIncrement="${!!c.autoIncrement}" sqlType="${c.sqlType}" precision="${c.precision ?? 0}"/>`,
      );
    }
    out.push('</table>');
  }
  for (const [table, columns] of Object.entries(AO_TABLES)) {
    out.push(`<data tableName="${table}">`);
    for (const c of columns) out.push(`<column name="${c.name}"/>`);
    for (const row of rows[table] ?? []) {
      const values = row.map((v, k) => {
        const type = (columns[k] as { type: string }).type;
        return v === null
          ? `<${type} xsi:nil="true"/>`
          : `<${type}>${typeof v === 'string' ? xmlText(v) : String(v)}</${type}>`;
      });
      out.push(`<row>${values.join('')}</row>`);
    }
    out.push('</data>');
  }
  out.push(`</${AO_ROOT}>`);
  return `${out.join('\n')}\n`;
}

/** A hand-written backup's custom fields, its board's queries and its saved filters. */
interface Backup {
  /** Id, name and type key. */
  fields: [string, string, string][];
  /** The board's filter, for the track with the given key. */
  filter: (key: string) => string;
  subQuery: string;
  /** Name and query. */
  quickFilters: [string, string][];
  /** Name and query, besides the board's filter. */
  savedFilters: [string, string][];
}

/** A backup whose Points field (10100) has the given type, named by name and by id. */
const pointsBackup = (type: string): Backup => ({
  fields: [['10100', 'Points', type]],
  filter: (key) => `project = ${key} AND Points is not EMPTY ORDER BY Rank ASC`,
  subQuery: 'Points is not EMPTY OR fixVersion is EMPTY',
  quickFilters: [
    ['Pointed', 'points IS NOT EMPTY'],
    ['Pointed by id', 'cf[10100] IS NOT EMPTY'],
  ],
  savedFilters: [
    ['Pointed by name', '"Points" is not EMPTY ORDER BY Points DESC'],
    ['Pointed by id', 'cf[10100] is not EMPTY'],
  ],
});

/**
 * A backup's custom field whose name the target already gives a field of another kind: the
 * Points every workspace starts with (migration 0095). It arrives as "Points (imported)"
 * (M1-089, T-129a), and every query of the backup that names it, by id or by name, reads that
 * field, never the seeded one (T-195): saved filters, a board's filter, its sub-query and its
 * quick filters.
 */
describe('Data Center backup import: queries naming a field that arrived under another name', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  let importDir = '';
  let cookie = '';

  const as = (options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie },
    });

  /** The report of a run over a hand-written backup with the given fields, queries and filters. */
  async function runBackup(file: string, key: string, backup: Backup, dryRun: boolean) {
    const customFields = backup.fields.map(
      ([id, name, type]) =>
        `<CustomField id="${id}" cfname="${xmlText(name)}" customfieldtypekey="${type}"/>`,
    );
    const filters = backup.savedFilters.map(
      ([name, query], i) =>
        `<SearchRequest id="${i + 2}" name="${xmlText(name)}" author="ana" request="${xmlText(query)}"/>`,
    );
    const entities = `<?xml version="1.0" encoding="UTF-8"?>
<entity-engine-xml>
  <ApplicationUser id="1" userKey="ana" lowerUserName="ana"/>
  ${customFields.join('\n  ')}
  <Directory id="1" directoryName="Local" active="1" directoryPosition="0"/>
  <Project id="10" name="Points ${key}" key="${key}" lead="ana" counter="0" projecttype="software"/>
  <SearchRequest id="1" name="Board filter" author="ana" request="${xmlText(backup.filter(key))}"/>
  ${filters.join('\n  ')}
  <Status id="1" sequence="1" name="To do" statuscategory="2"/>
  <User id="1" directoryId="1" userName="ana" lowerUserName="ana" active="1" displayName="Ana" emailAddress="ana@${key.toLowerCase()}.test"/>
</entity-engine-xml>
`;
    const ao = activeObjects({
      AO_60DB71_RAPIDVIEW: [[1, `Board ${key}`, 'ana', 1, false]],
      AO_60DB71_COLUMN: [[1, 'To do', 0, 1, null, null]],
      AO_60DB71_COLUMNSTATUS: [[1, 1, 0, '1']],
      AO_60DB71_QUICKFILTER: backup.quickFilters.map(([name, query], i) => [
        i + 1,
        name,
        query,
        '',
        i,
        1,
      ]),
      AO_60DB71_SUBQUERY: [[1, backup.subQuery, 1]],
    });
    await zipOf({ [ENTITIES_FILE]: entities, [ACTIVE_OBJECTS_FILE]: ao }, join(importDir, file));
    const started = await as({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: {
        name: file,
        dryRun,
        source: { format: 'dc-backup', path: file, system: key.toLowerCase(), scope: 'all' },
      },
    });
    expect(started.statusCode, started.body).toBe(202);
    const run = started.json().importRun as { id: number };
    for (let i = 0; i < 200; i++) {
      if ((await runner.runOnce()) === 0) break;
    }
    const view = (await as({ method: 'GET', url: `/api/v1/admin/imports/${run.id}` })).json()
      .importRun as { status: string; lastError: string | null };
    expect(view.status, view.lastError ?? '').toBe('done');
    return fidelityReport.parse(
      (await as({ method: 'GET', url: `/api/v1/admin/imports/${run.id}/report` })).json().report,
    );
  }

  /** Imports a hand-written backup with the given custom fields, board queries and filters. */
  async function importBackup(file: string, key: string, backup: Backup) {
    const report = await runBackup(file, key, backup, false);
    // The target field each of the backup's custom fields became, by the backup's id.
    const imported = await database.db
      .selectFrom('import_external_id')
      .select(['source_id', 'target_id'])
      .where('source_system', '=', key.toLowerCase())
      .where('entity_kind', '=', 'field')
      .execute();
    const fields = Object.fromEntries(imported.map((f) => [f.source_id, Number(f.target_id)]));
    const board = await database.db
      .selectFrom('board')
      .innerJoin('track', 'track.id', 'board.location_track_id')
      .select(['board.filter_query', 'board.sub_filter_query', 'board.board_filters'])
      .where('track.key', '=', key)
      .executeTakeFirstOrThrow();
    const saved = await database.db
      .selectFrom('saved_search')
      .innerJoin('app_user', 'app_user.id', 'saved_search.owner_id')
      .select(['saved_search.name', 'saved_search.query', 'saved_search.import_problem'])
      .where('app_user.email', '=', `ana@${key.toLowerCase()}.test`)
      .orderBy('saved_search.name')
      .execute();
    return { report, fields, field: fields['10100'] ?? 0, board, saved };
  }

  /** The board queries the run left out, mapper's and loader's (the mapping lists no boards). */
  const boardWarnings = (report: FidelityReport) =>
    report.warnings
      .filter((w) => w.kind === 'board' && w.code.endsWith('_not_imported'))
      .map((w) => `${w.code}: ${w.detail}`);

  beforeAll(async () => {
    importDir = await mkdtemp(join(tmpdir(), 'taskmoor-dc-points-'));
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], importDir });
    runner = new JobRunner(database.db, 'dc-points-test');
    registerImportJobs(runner, database.db, new FieldCatalogs(database.db), { batch: 100 });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'Admin',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    cookie =
      [res.headers['set-cookie'] ?? []]
        .flat()
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
        ?.split(';')[0] ?? '';
  });
  afterAll(async () => {
    await app.close();
    await rm(importDir, { recursive: true, force: true });
  });

  it('[IMP-006] [IMP-005] reads "Points (imported)", not the seeded Points, wherever a query names it', async () => {
    const seeded = await database.db
      .selectFrom('field')
      .select('id')
      .where('name', '=', 'Points')
      .where('track_id', 'is', null)
      .executeTakeFirstOrThrow();
    const { report, field, board, saved } = await importBackup(
      'text.zip',
      'TXT',
      pointsBackup(TEXT_FIELD),
    );
    const imported = await database.db
      .selectFrom('field')
      .select(['name', 'type'])
      .where('id', '=', field)
      .executeTakeFirstOrThrow();
    expect(imported).toEqual({ name: 'Points (imported)', type: 'text' });
    expect(field).not.toBe(seeded.id);

    // Saved filters, by name and by id.
    expect(saved.map((s) => [s.name, s.query, s.import_problem])).toEqual([
      ['Board filter', `track = TXT AND cf[${field}] IS NOT EMPTY`, null],
      ['Pointed by id', `cf[${field}] IS NOT EMPTY`, null],
      ['Pointed by name', `cf[${field}] IS NOT EMPTY ORDER BY cf[${field}] DESC`, null],
    ]);
    // The board's filter, its sub-query and its quick filters, whatever case they name it in.
    expect(boardWarnings(report)).toEqual([]);
    expect(board.filter_query).toBe(`track = TXT AND cf[${field}] IS NOT EMPTY`);
    expect(board.sub_filter_query).toBe(`cf[${field}] IS NOT EMPTY OR targetRelease IS EMPTY`);
    const filters = board.board_filters as unknown as BoardFilter[];
    expect(filters.map((f) => [f.name, f.query])).toEqual([
      ['Pointed', `cf[${field}] IS NOT EMPTY`],
      ['Pointed by id', `cf[${field}] IS NOT EMPTY`],
    ]);
    const all = JSON.stringify({ board, saved });
    expect(all).not.toContain(`cf[${seeded.id}]`);
    expect(all).not.toMatch(/\bPoints\b/);
  });

  it("[IMP-006] names a board query's custom fields by the backup's ids, system fields first", () => {
    const named = { points: ['10100'], status: ['10200'], twice: ['10300', '10301'] };
    expect(translateQuery('Points > 3 AND status = Done ORDER BY Points', named)).toEqual({
      query: 'cf[10100] > 3 AND status = Done',
      fields: ['10100'],
    });
    // A name no custom field of the backup has is left for the board loader to check.
    expect(translateQuery('Mood ~ calm', named)).toEqual({ query: 'Mood ~ calm', fields: [] });
    // Several custom fields of one name: the name stays, with their ids, for the loader, which
    // knows whether the import made them one field.
    expect(translateQuery('Twice IS EMPTY AND Points = 1', named)).toEqual({
      query: 'Twice IS EMPTY AND cf[10100] = 1',
      fields: ['10100'],
      shared: { twice: ['10300', '10301'] },
    });
    const mapped = mapBoard({
      id: '1',
      name: 'Board',
      scrum: false,
      filter: { id: '9', name: 'f', query: 'project = PTS AND Points > 3' },
      filterId: '9',
      projects: ['10'],
      unknownProjects: [],
      subQuery: null,
      columns: [],
      quickFilters: [{ id: '1', name: 'Both', query: 'Twice IS EMPTY', description: '' }],
      fieldsNamed: named,
    });
    expect(mapped).toMatchObject({
      command: {
        query: 'track = PTS AND cf[10100] > 3',
        boardFilters: [{ name: 'Both', query: 'Twice IS EMPTY' }],
        fields: [{ kind: 'field', id: '10100' }],
        sharedNames: [
          {
            name: 'twice',
            fields: [
              { kind: 'field', id: '10300' },
              { kind: 'field', id: '10301' },
            ],
          },
        ],
      },
      warnings: [{ code: 'board_without_columns' }],
    });
    // A board whose queries name no shared name says nothing of it.
    expect(
      mapBoard({
        id: '2',
        name: 'Board',
        scrum: false,
        filter: { id: '9', name: 'f', query: 'project = PTS AND Points > 3' },
        filterId: '9',
        projects: ['10'],
        unknownProjects: [],
        subQuery: null,
        columns: [],
        quickFilters: [],
        fieldsNamed: named,
      }),
    ).not.toHaveProperty('command.sharedNames');
  });

  /**
   * Two custom fields of the backup called "Squad": a board's queries that name it by name read
   * the one field the import made of them both, as they read it in the source; when the import
   * made two fields of them, which one a query read cannot be told, and the query is left out.
   */
  const squadBackup = (first: string, second: string): Backup => ({
    fields: [
      ['10200', 'Squad', first],
      ['10201', 'Squad', second],
    ],
    filter: (key) => `project = ${key} AND Squad is not EMPTY`,
    subQuery: 'squad IS EMPTY OR fixVersion is EMPTY',
    quickFilters: [
      ['Squadded', 'Squad IS NOT EMPTY'],
      ['Second by id', 'cf[10201] IS EMPTY'],
    ],
    savedFilters: [],
  });

  it('[IMP-006] [IMP-005] keeps board queries naming a name two fields shared when they became one field', async () => {
    const { report, fields, board } = await importBackup(
      'squad-one.zip',
      'SQO',
      squadBackup(TEXT_FIELD, TEXT_FIELD),
    );
    const squad = fields['10200'];
    expect(squad).toBeDefined();
    expect(fields['10201']).toBe(squad);
    expect(boardWarnings(report)).toEqual([]);
    expect(board.filter_query).toBe(`track = SQO AND cf[${squad}] IS NOT EMPTY`);
    expect(board.sub_filter_query).toBe(`cf[${squad}] IS EMPTY OR targetRelease IS EMPTY`);
    const filters = board.board_filters as unknown as BoardFilter[];
    expect(filters.map((f) => [f.name, f.query])).toEqual([
      ['Squadded', `cf[${squad}] IS NOT EMPTY`],
      ['Second by id', `cf[${squad}] IS EMPTY`],
    ]);
  });

  it('[IMP-006] leaves out board queries naming a name two fields shared when they became two', async () => {
    const { report, fields, board } = await importBackup(
      'squad-two.zip',
      'SQT',
      squadBackup(TEXT_FIELD, NUMBER_FIELD),
    );
    const [text, number] = [fields['10200'], fields['10201']];
    expect(text).toBeDefined();
    expect(number).toBeDefined();
    expect(number).not.toBe(text);
    expect(boardWarnings(report).sort()).toEqual([
      'board_filter_not_imported: Squadded: query_names_ambiguous_field (Squad)',
      'board_query_not_imported: query_names_ambiguous_field (Squad)',
      'board_sub_query_not_imported: query_names_ambiguous_field (squad)',
    ]);
    // The board shows its track; what names the field by id is kept.
    expect(board.filter_query).toBe('track = SQT');
    expect(board.sub_filter_query).toBeNull();
    const filters = board.board_filters as unknown as BoardFilter[];
    expect(filters.map((f) => [f.name, f.query])).toEqual([
      ['Second by id', `cf[${number}] IS EMPTY`],
    ]);
  });

  it("[IMP-006] [IMP-005] reads the seeded Points when the backup's field joined it", async () => {
    const { field, board, saved } = await importBackup(
      'number.zip',
      'NUM',
      pointsBackup(NUMBER_FIELD),
    );
    const linked = await database.db
      .selectFrom('field')
      .select(['name', 'type'])
      .where('id', '=', field)
      .executeTakeFirstOrThrow();
    expect(linked).toEqual({ name: 'Points', type: 'number' });
    expect(saved.find((s) => s.name === 'Pointed by name')?.query).toBe(
      `cf[${field}] IS NOT EMPTY ORDER BY cf[${field}] DESC`,
    );
    expect(board.filter_query).toBe(`track = NUM AND cf[${field}] IS NOT EMPTY`);
    const filters = board.board_filters as unknown as BoardFilter[];
    expect(filters.map((f) => f.query)).toEqual([
      `cf[${field}] IS NOT EMPTY`,
      `cf[${field}] IS NOT EMPTY`,
    ]);
  });
  /**
   * A dry run makes no field, so it cannot look up what the backup's fields of one name became;
   * it says what the real run would do from what it plans: a field that exists beside one it
   * would make are two fields, and fields it would make are one when they have one shape.
   */
  it('[IMP-006] [IMP-005] a dry run leaves out the board queries the real run leaves out', async () => {
    // "Points" twice: a number, which joins the seeded Points, and text, which arrives as
    // "Points (imported)".
    const mixed: Backup = {
      ...pointsBackup(NUMBER_FIELD),
      fields: [
        ['10100', 'Points', NUMBER_FIELD],
        ['10101', 'Points', TEXT_FIELD],
      ],
      quickFilters: [['Pointed', 'points IS NOT EMPTY']],
      savedFilters: [],
    };
    // Each query names the field as it is written there.
    const ambiguous = [
      'board_filter_not_imported: Pointed: query_names_ambiguous_field (points)',
      'board_query_not_imported: query_names_ambiguous_field (Points)',
      'board_sub_query_not_imported: query_names_ambiguous_field (Points)',
    ];
    const dry = await runBackup('mixed-dry.zip', 'MXD', mixed, true);
    expect(dry.run.dryRun).toBe(true);
    expect(boardWarnings(dry).sort()).toEqual(ambiguous);
    const real = await importBackup('mixed.zip', 'MXD', mixed);
    expect(real.fields['10100']).not.toBe(real.fields['10101']);
    expect(boardWarnings(real.report).sort()).toEqual(ambiguous);

    // Two "Squad" fields the run would make: two fields when their types differ, one when not.
    const two = await runBackup(
      'squad-two-dry.zip',
      'SQD',
      squadBackup(TEXT_FIELD, NUMBER_FIELD),
      true,
    );
    expect(boardWarnings(two).sort()).toEqual([
      'board_filter_not_imported: Squadded: query_names_ambiguous_field (Squad)',
      'board_query_not_imported: query_names_ambiguous_field (Squad)',
      'board_sub_query_not_imported: query_names_ambiguous_field (squad)',
    ]);
    const one = await runBackup(
      'squad-one-dry.zip',
      'SQE',
      squadBackup(TEXT_FIELD, TEXT_FIELD),
      true,
    );
    expect(boardWarnings(one)).toEqual([]);
  });
});
