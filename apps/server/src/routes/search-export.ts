import { Readable } from 'node:stream';
import type { Database } from '@taskmoor/db';
import {
  CSV_CONTENT_TYPE,
  CSV_SEPARATORS,
  type CsvSeparator,
  csvLine,
  withBom,
} from '@taskmoor/webconfig';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import type { FieldCatalogs } from '../fields/catalog';
import { plainText } from '../fields/types';
import { viewerDay } from '../reports/zone';
import type { Cursor } from '../search/compile';
import { DEFAULT_QUERY_TIMEOUT_MS, prepareSearch, readOnly } from '../search/run';
import { countBulkExport } from '../security/alerts';
import type { TicketView } from '../tickets/store';
import {
  project,
  projection,
  searchPerson,
  searchRefusal,
  searchScope,
  searchViews,
} from './search';

/**
 * Exporting search results (M1-042; QRY-015):
 * `GET /api/v1/search/export?q=&format=&columns=&separator=` streams every ticket a query finds,
 * as CSV or as a JSON array, in the query's order.
 *
 * - The statement is the search route's (`prepareSearch`, with the person's time zone and
 *   session as `searchPerson` gives them): the person's permission filter is part of it,
 *   and each page of tickets is read again under the same filter, so an export never holds
 *   a ticket the search would not show (QRY-008).
 * - Rows go out a keyset page at a time (`EXPORT_PAGE` ids, each page its own read-only
 *   statement under the search timeout); the response is a stream that asks for the next page
 *   only when the client has taken the last one, so the whole result is never in memory.
 * - `columns` lists the columns to export, as the results list names them (`key`, `summary`,
 *   `status`, `cf[10]`, ...), in their order; the key always comes first. CSV writes one cell
 *   per column as text (lists joined by "; ") by the rule every CSV export shares
 *   (`@taskmoor/webconfig` `csv.ts`): RFC 4180 quoting, a leading apostrophe on text a
 *   spreadsheet would run as a formula, and a UTF-8 byte-order mark before the header, once
 *   (T-252). `separator` picks the style (T-263): `comma`, the default, with numbers as 1.5, or
 *   `semicolon`, with numbers as 1,5, as a spreadsheet set up for a decimal comma opens it. JSON
 *   writes the tickets as the search route shows them, keeping those columns.
 *
 * It reads only: no event, and an API token needs the read scope.
 */
export const EXPORT_PAGE = 500;

/** Columns the results list shows and the export writes, besides custom fields (`cf[N]`). */
export const EXPORT_COLUMNS = [
  'key',
  'summary',
  'track',
  'ticketType',
  'parent',
  'status',
  'assignee',
  'requester',
  'creator',
  'priority',
  'closeReason',
  'visibilityLevel',
  'labels',
  'targetReleases',
  'foundInReleases',
  'areas',
  'startDate',
  'dueDate',
  'closedAt',
  'createdAt',
  'updatedAt',
  'description',
  'environment',
  'followerCount',
  'voteCount',
] as const;
type SystemColumn = (typeof EXPORT_COLUMNS)[number];
const SYSTEM = new Set<string>(EXPORT_COLUMNS);

/** The columns when none are asked for: those the results list starts with. */
export const DEFAULT_EXPORT_COLUMNS = [
  'key',
  'summary',
  'status',
  'assignee',
  'priority',
  'updatedAt',
];

const exportInput = z
  .object({
    q: z.string().max(100_000).default(''),
    format: z.enum(['csv', 'json']).default('csv'),
    columns: z.string().max(4000).optional(),
    /** How a CSV file separates its cells and writes numbers (T-263). */
    separator: z.enum(CSV_SEPARATORS).default('comma'),
  })
  .strict();

type Column = { kind: 'system'; id: SystemColumn } | { kind: 'custom'; id: string; field: number };

/** The columns asked for, the key first and each once, or the first one that is unknown. */
function readColumns(text: string | undefined): Column[] | string {
  const names = (text ?? DEFAULT_EXPORT_COLUMNS.join(','))
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  const out: Column[] = [{ kind: 'system', id: 'key' }];
  const seen = new Set(['key']);
  for (const name of names) {
    const custom = /^cf\[(\d{1,10})\]$/.exec(name);
    if (!custom && !SYSTEM.has(name)) return name;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(
      custom
        ? { kind: 'custom', id: name, field: Number(custom[1]) }
        : { kind: 'system', id: name as SystemColumn },
    );
  }
  return out;
}

const named = (v: { name: string } | null | undefined) => v?.name ?? null;
const list = (values: { name: string }[] | string[]) =>
  values.map((v) => (typeof v === 'string' ? v : v.name)).join('; ');

/** A custom value as REST shows it, as one line of text. */
function customText(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => customText(v) ?? '').join('; ');
  const v = value as { type?: unknown; name?: unknown; value?: unknown; child?: unknown };
  if (v.type === 'doc') return plainText(v);
  const own = typeof v.name === 'string' ? v.name : typeof v.value === 'string' ? v.value : null;
  if ('child' in v) {
    const child = customText(v.child);
    return child === null ? own : `${own ?? ''} / ${child}`;
  }
  return own ?? JSON.stringify(value);
}

function systemText(view: TicketView, column: SystemColumn): string | number | null {
  switch (column) {
    case 'key':
      return view.key;
    case 'summary':
      return view.summary;
    case 'track':
      return view.track.key;
    case 'ticketType':
    case 'status':
    case 'assignee':
    case 'requester':
    case 'creator':
    case 'priority':
    case 'closeReason':
    case 'visibilityLevel':
      return named(view[column]);
    case 'parent':
      return view.parent?.key ?? null;
    case 'labels':
    case 'targetReleases':
    case 'foundInReleases':
    case 'areas':
      return list(view[column] as { name: string }[] | string[]);
    case 'description':
    case 'environment':
      return view[column] === null ? null : plainText(view[column]);
    default:
      return view[column] as string | number | null;
  }
}

/** One CSV line of a ticket. */
function csvRow(view: TicketView, columns: readonly Column[], separator: CsvSeparator): string {
  const cells = columns.map((c) =>
    c.kind === 'system'
      ? systemText(view, c.id)
      : customText((view.fields as Record<string, unknown>)[String(c.field)]),
  );
  return csvLine(cells, separator);
}

/** What one export streams, for the search's route and a plan's (PLN-014). */
export interface TicketExport {
  /** The query; null finds nothing, and the file holds the header row alone. */
  q: string | null;
  format: 'csv' | 'json';
  /** The columns as the results list names them; none for the default. */
  columns: string | undefined;
  /** How a CSV file separates its cells and writes numbers (T-263). */
  separator: CsvSeparator;
  /** The file's name before its day: already safe in a header. */
  file: string;
  timeoutMs: number;
}

/**
 * Sends the tickets a query finds as a stream, as the person making the request may see them.
 * Refusals go out as answers: an unknown or hidden column, a query that does not read.
 */
export async function sendTicketExport(
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  request: FastifyRequest,
  reply: FastifyReply,
  { q, format, columns: asked, separator, file, timeoutMs }: TicketExport,
) {
  const columns = readColumns(asked);
  if (typeof columns === 'string') {
    return reply
      .code(400)
      .send({ error: 'invalid_request', message: `Unknown column "${columns}"` });
  }
  const chosen: readonly Column[] = columns;
  const { ws, filter, catalog, catalogue } = await searchScope(db, catalogs, request, false);
  // Custom columns are the fields the person's queries may name: shared ones and the local
  // fields of tracks they see. Another name would tell them of a field they cannot see.
  const visibleFields = new Map(catalogue.customs.map((f) => [f.id, f.name]));
  const hidden = columns.find((c) => c.kind === 'custom' && !visibleFields.has(c.field));
  if (hidden) {
    return reply
      .code(400)
      .send({ error: 'invalid_request', message: `Unknown column "${hidden.id}"` });
  }
  let compiled: Awaited<ReturnType<typeof prepareSearch>>['compiled'] | null = null;
  if (q !== null) {
    try {
      ({ compiled } = await prepareSearch({
        db,
        workspaceId: ws,
        catalog,
        catalogue,
        filter,
        q,
        ...searchPerson(request),
      }));
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  }
  const query = filter.tracks !== 'all' && filter.tracks.length === 0 ? null : compiled;
  // A bulk export by this person (ASVS 11.1.7; ADR-109): counted for the alert rule.
  await countBulkExport(db, ws, request.user?.id as number);
  const shape = projection(columns.filter((c) => c.id !== 'key').map((c) => c.id));
  const header = columns.map((c) =>
    c.kind === 'system' ? c.id : (visibleFields.get(c.field) ?? c.id),
  );

  async function* chunks(): AsyncGenerator<string> {
    // A CSV file starts with the byte-order mark, once (T-252), then the header.
    let buffer = format === 'csv' ? withBom(csvLine(header, separator)) : '[';
    let rows = 0;
    let after: Cursor | undefined;
    while (query) {
      const page = await readOnly(
        db,
        timeoutMs,
        async (trx) => (await query.page(EXPORT_PAGE, after).execute(trx)).rows,
      );
      const views = await searchViews(
        db,
        catalogs,
        request,
        page.map((r) => r.id),
        filter.sql,
      );
      for (const view of views) {
        if (format === 'csv') buffer += csvRow(view, chosen, separator);
        else {
          const shown = typeof shape === 'object' ? project(view, shape) : view;
          buffer += `${rows === 0 ? '\n' : ',\n'}${JSON.stringify(shown)}`;
        }
        rows += 1;
      }
      yield buffer;
      buffer = '';
      const last = page[page.length - 1];
      if (page.length < EXPORT_PAGE || !last) break;
      after = { values: query.keys.map((_, i) => last[`c${i}`] ?? null), id: last.id };
    }
    if (format === 'json') buffer += rows === 0 ? ']\n' : '\n]\n';
    if (buffer) yield buffer;
  }

  // The file is named after the day it is on the person's own clock (T-280).
  const day = viewerDay(request);
  return reply
    .header('content-type', format === 'csv' ? CSV_CONTENT_TYPE : 'application/json; charset=utf-8')
    .header('content-disposition', `attachment; filename="${file}-${day}.${format}"`)
    .header('cache-control', 'no-store')
    .send(Readable.from(chunks()));
}

export function registerSearchExportRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  options: { timeoutMs?: number } = {},
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  app.get('/api/v1/search/export', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = exportInput.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { q, format, columns, separator } = parsed.data;
    return sendTicketExport(db, catalogs, request, reply, {
      q,
      format,
      columns,
      separator,
      file: 'tickets',
      timeoutMs,
    });
  });
}
