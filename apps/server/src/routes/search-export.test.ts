import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { EXPORT_PAGE } from './search-export';

/** Generated per run: no credential is kept in the repository. */
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.79.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (
      list.find(
        (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
      ) ?? ''
    ).split(';')[0] ?? ''
  );
}

/** RFC 4180 records, for checking what the export wrote. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows;
}

const PEOPLE = ['admin', 'alice'] as const;
type Person = (typeof PEOPLE)[number];

/**
 * Exporting search results (M1-042; QRY-015, QRY-008): CSV and JSON of what the search finds,
 * in its order, a keyset page at a time; visibility exactly as the search route; CSV quoting
 * and the formula guard; the columns the results list shows; refusals.
 */
describe('search export (M1-042)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const fields: Record<string, number> = {};
  const keys: Record<string, string> = {};

  const as = (who: Person | null, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: who ? users[who].cookie : '' },
    });
  const exported = (who: Person | null, query: Record<string, string>) =>
    as(who, { method: 'GET', url: `/api/v1/search/export?${new URLSearchParams(query)}` });

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: name === 'admin',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      users[name] = { id: row.id, cookie: sessionCookie(res.headers['set-cookie']) };
    }
    const tracks: Record<string, number> = {};
    for (const [key, mode] of [
      ['EXP', 'shared'],
      ['HID', 'local'],
    ] as const) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name: key, mode },
      });
      expect(res.statusCode, res.body).toBe(201);
      tracks[key] = res.json().track.id as number;
    }
    const members = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: tracks.EXP as number,
        role_id: members.id,
        user_id: users.alice.id,
      })
      .execute();
    for (const [name, type, trackId] of [
      ['Customer', 'text', undefined],
      ['Points', 'number', undefined],
      ['Hidden note', 'text', tracks.HID],
    ] as const) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/fields',
        payload: { name, type, ...(trackId ? { trackId } : {}) },
      });
      expect(res.statusCode, res.body).toBe(201);
      fields[name] = res.json().field.id as number;
    }
    const make = async (name: string, track: string, extra: Record<string, unknown> = {}) => {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/tickets',
        payload: { track, summary: name, ...extra },
      });
      expect(res.statusCode, res.body).toBe(201);
      keys[name] = res.json().ticket.key as string;
    };
    await make('=HYPERLINK("http://example.test")', 'EXP', {
      fields: { [fields.Customer as number]: '+1 555 0100', [fields.Points as number]: -3 },
      labels: ['urgent', 'web'],
      assigneeId: users.alice.id,
    });
    await make('Commas, "quotes" and more', 'EXP', {
      fields: { [fields.Customer as number]: '@team' },
      description: {
        type: 'doc',
        content: ['First line', 'second line'].map((text) => ({
          type: 'paragraph',
          content: [{ type: 'text', text }],
        })),
      },
    });
    await make('-minus first', 'EXP');
    await make('Plain words', 'EXP', { fields: { [fields.Points as number]: 8 } });
    await make('Secret ticket', 'HID', { fields: { [fields['Hidden note'] as number]: 'x' } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('[QRY-015] writes the asked columns as CSV, quoted, with formulas defused', async () => {
    const res = await exported('alice', {
      q: 'track = EXP ORDER BY key ASC',
      format: 'csv',
      columns: `key,summary,assignee,labels,description,cf[${fields.Customer}],cf[${fields.Points}]`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="tickets-.*\.csv"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(parseCsv(res.body)).toEqual([
      ['key', 'summary', 'assignee', 'labels', 'description', 'Customer', 'Points'],
      [
        keys['=HYPERLINK("http://example.test")'],
        `'=HYPERLINK("http://example.test")`,
        'alice',
        'urgent; web',
        '',
        `'+1 555 0100`,
        '-3',
      ],
      [
        keys['Commas, "quotes" and more'],
        'Commas, "quotes" and more',
        '',
        '',
        'First line\nsecond line',
        `'@team`,
        '',
      ],
      [keys['-minus first'], `'-minus first`, '', '', '', '', ''],
      [keys['Plain words'], 'Plain words', '', '', '', '', '8'],
    ]);
    // The raw text: quotes doubled, the line break kept inside the quoted cell.
    expect(res.body).toContain('"Commas, ""quotes"" and more"');
    expect(res.body).toContain('"First line\nsecond line"');
  });

  it('[QRY-015] [QRY-008] exports exactly what the search shows the person', async () => {
    for (const who of ['alice', 'admin'] as const) {
      const search = await as(who, {
        method: 'GET',
        url: `/api/v1/search?q=${encodeURIComponent('ORDER BY key ASC')}&limit=200&fields=summary`,
      });
      const res = await exported(who, { q: 'ORDER BY key ASC', columns: 'summary' });
      expect(res.statusCode).toBe(200);
      const rows = parseCsv(res.body).slice(1);
      expect(rows).toEqual(
        (search.json().tickets as { key: string; summary: string }[]).map((t) => [
          t.key,
          /^[=+\-@]/.test(t.summary) ? `'${t.summary}` : t.summary,
        ]),
      );
      expect(rows.some(([key]) => key === keys['Secret ticket'])).toBe(who === 'admin');
    }
  });

  it('[QRY-015] streams JSON as an array of tickets as the search shows them', async () => {
    const res = await exported('alice', {
      q: 'track = EXP AND Points IS NOT EMPTY ORDER BY Points DESC',
      format: 'json',
      columns: `summary,status,cf[${fields.Points}]`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    const tickets = res.json() as {
      key: string;
      summary: string;
      status: { name: string };
      fields: Record<string, unknown>;
    }[];
    expect(tickets.map((t) => [t.summary, t.fields[String(fields.Points)]])).toEqual([
      ['Plain words', 8],
      ['=HYPERLINK("http://example.test")', -3],
    ]);
    expect(Object.keys(tickets[0] ?? {}).sort()).toEqual(
      ['fields', 'id', 'key', 'status', 'summary'].sort(),
    );
    // Nothing found is an empty array, not an empty body.
    const none = await exported('alice', { q: 'summary ~ "nothingmatches"', format: 'json' });
    expect(none.json()).toEqual([]);
  });

  it('[QRY-015] pages through more tickets than one page, each once and in order', async () => {
    const template = await database.db
      .selectFrom('ticket')
      .select(['id', 'track_id', 'number'])
      .where('summary', '=', 'Plain words')
      .executeTakeFirstOrThrow();
    const copies = EXPORT_PAGE * 2 + 37;
    await sql`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, rank, fields, labels)
      SELECT k.workspace_id, k.track_id, 1000 + g, k.ticket_type_id, k.status_id,
             'Copy ' || g, k.creator_id, k.rank || lpad(g::text, 6, '0'), k.fields, k.labels
        FROM ticket k, generate_series(1, ${copies}) AS g
       WHERE k.id = ${template.id}`.execute(database.db);
    // The four tickets made before come first.
    const res = await exported('alice', {
      q: 'track = EXP ORDER BY created ASC',
      columns: 'summary',
    });
    expect(res.statusCode).toBe(200);
    const rows = parseCsv(res.body).slice(5);
    expect(rows).toHaveLength(copies);
    expect(new Set(rows.map(([key]) => key)).size).toBe(copies);
    // Equal creation times fall back to the id, which follows the copy number here.
    expect(rows.map(([, summary]) => summary)).toEqual(
      Array.from({ length: copies }, (_, i) => `Copy ${i + 1}`),
    );
    const json = await exported('alice', {
      q: 'track = EXP ORDER BY created ASC',
      format: 'json',
      columns: '',
    });
    expect((json.json() as unknown[]).length).toBe(copies + 4);
  });

  it('[QRY-015] refuses unknown or hidden columns, bad queries and strangers', async () => {
    const unknown = await exported('alice', { q: '', columns: 'summary,nosuch' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ message: 'Unknown column "nosuch"' });
    // A local field of a track Alice cannot see is no column of hers, though the admin's.
    const column = `cf[${fields['Hidden note']}]`;
    expect((await exported('alice', { q: '', columns: column })).statusCode).toBe(400);
    const admin = await exported('admin', { q: 'track = HID', columns: column });
    expect(parseCsv(admin.body)).toEqual([
      ['key', 'Hidden note'],
      [keys['Secret ticket'], 'x'],
    ]);
    const query = await exported('alice', { q: 'nosuchfield = 1' });
    expect(query.statusCode).toBe(400);
    expect(query.json()).toMatchObject({ error: 'invalid_query' });
    expect((await exported('alice', { q: '', format: 'xml' })).statusCode).toBe(400);
    expect((await exported(null, { q: '' })).statusCode).toBe(401);
  });
});
