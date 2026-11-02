import { Readable } from 'node:stream';
import fastifyMultipart from '@fastify/multipart';
import type { Database } from '@taskmoor/db';
import {
  type ByteRange,
  isTooLarge,
  newObjectKey,
  ObjectNotFoundError,
  type ObjectStore,
  type PutResult,
} from '@taskmoor/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { dropUpload, keepUpload, registerUpload, sweepStorage } from '../attachments/cleanup';
import { contentDisposition, safeFilename } from '../attachments/filename';
import { queueProcessing } from '../attachments/jobs';
import {
  holdQuota,
  type QuotaRefusal,
  quotaRefusal,
  quotaRoom,
  setStorageQuota,
  storageQuota,
  storageUsage,
  topUploader,
} from '../attachments/quota';
import {
  type AttachmentRow,
  attachmentChange,
  attachmentQuery,
  attachmentView,
  maxFileSize,
  setMaxFileSize,
} from '../attachments/records';
import { normalizeType, SNIFF_BYTES, servedAs, sniff, thumbnailable } from '../attachments/sniff';
import type { AttachmentStores } from '../attachments/stores';
import { archive, listZip, openZipEntry, ZipError } from '../attachments/zip';
import { requireSiteAdmin, requireUser } from '../auth';
import type { TrackPermission } from '../authz/permissions';
import { emit, withEvent } from '../events/bus';
import { recordChanges } from '../tickets/history';
import { ticketKey } from '../tickets/model';
import { loadTicket, resolveTicket, type TicketRow } from '../tickets/store';
import { type Lock, lockedBody, statusGate, statusLock } from '../workflows/locks';

/**
 * Attachments (M1-016; CORE-021, CORE-022, CORE-025 (3); ADR-040).
 *
 * - Anyone who may browse a ticket lists, previews and downloads its attachments; uploading
 *   needs "Create attachments"; deleting one's own needs "Delete own attachments" (or "all"),
 *   anyone else's "Delete all attachments" (CORE-021 (3)). A track in the archive allows
 *   reading only; a ticket in the trash shows nothing, and its attachments come back with it.
 * - Upload: `multipart/form-data` with one file part, streamed to the store while it is
 *   counted, hashed and its first bytes sniffed; a file over the workspace's limit (default
 *   1 GiB, no ceiling) is refused with 413 `file_too_large` as soon as it passes the limit
 *   (at once when Content-Length says so), and nothing is kept. Storage quotas, a workspace
 *   total and a limit per person, are off unless a site administrator sets them (M1-118;
 *   ASVS 12.1.3; `attachments/quota.ts`); an upload past one is refused with 413
 *   `storage_quota_exceeded` and the numbers.
 * - Download: only files the scan found clean. Local files stream through here with
 *   `X-Content-Type-Options: nosniff`, a sandboxing CSP and RFC 6266 file names, inline only
 *   for images, PDF, video and text (served as plain text), as a download otherwise; ranges
 *   and ETags are honoured. Files in S3 are never streamed for a download: the answer is a 302
 *   to a presigned URL that lives five minutes, made after the browse check (CORE-021 (2)).
 * - ZIP files list their entries and stream one entry at a time, read by ranges; all of a
 *   ticket's files download as one streamed ZIP.
 * - Adding and removing are ticket history (`attachment`, display the file name) and new
 *   ticket versions; each emits one event. Deleted files leave the store after commit, through
 *   `storage_cleanup` (also when the trash purge deletes their ticket).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const ticketParams = z.object({ id: z.string().min(1).max(300) });
const attachmentParams = z.object({ id: z.string().min(1).max(300), attachmentId: id });
const entryParams = attachmentParams.extend({ index: z.coerce.number().int().min(0).max(MAX_INT) });
const contentQuery = z
  .object({ disposition: z.enum(['inline', 'attachment']).optional() })
  .strict();
const bytes = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const settingsBody = z
  .object({
    maxFileSize: bytes.optional(),
    /** Storage quotas in bytes (ASVS 12.1.3); null takes one off. */
    workspaceQuota: bytes.nullable().optional(),
    personQuota: bytes.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0);

/** Room for the multipart framing around a file when comparing Content-Length to the limit. */
const MULTIPART_OVERHEAD = 64 * 1024;
/** How much of a text file the preview shows. */
const TEXT_PREVIEW_BYTES = 256 * 1024;

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const forbidden = (reply: FastifyReply, permission: TrackPermission) =>
  reply.code(403).send({ error: 'forbidden', permission });
const unavailable = (reply: FastifyReply) => reply.code(503).send({ error: 'storage_unavailable' });

/** The 413 of an upload past a storage quota; the connection closes as for a large file. */
function overQuota(reply: FastifyReply, refusal: QuotaRefusal) {
  return reply.code(413).header('connection', 'close').send(refusal);
}

/** The 413 of a file over the limit; the connection closes so the rest is not read. */
function tooLarge(reply: FastifyReply, maxFileSize: number) {
  return reply
    .code(413)
    .header('connection', 'close')
    .send({ error: 'file_too_large', maxFileSize });
}

async function readText(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    length += (chunk as Buffer).length;
    if (length >= limit) break;
  }
  (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  return Buffer.concat(chunks).subarray(0, limit);
}

/** One `bytes=` range of a file of `size` bytes; null when absent or not satisfiable. */
function requestedRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, a = '', b = ''] = match;
  if (a === '' && b === '') return null;
  if (size === 0) return 'unsatisfiable';
  if (a === '') {
    const n = Number(b);
    return n === 0 ? 'unsatisfiable' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  return start >= size || start > end ? 'unsatisfiable' : { start, end };
}

/** Headers that keep a served file from acting as a page of this origin. */
function guard(reply: FastifyReply, inline: boolean, contentType: string): void {
  reply
    .header('x-content-type-options', 'nosniff')
    .header('cross-origin-resource-policy', 'same-origin')
    .header('referrer-policy', 'no-referrer')
    .header(
      'content-security-policy',
      // Chrome's PDF viewer does not run in a sandboxed document.
      inline && contentType === 'application/pdf'
        ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'"
        : "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    );
}

export async function registerAttachmentRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  stores: AttachmentStores,
): Promise<void> {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  /** The route's ticket: outside the trash and browsable; for writes, in a live track. */
  async function routeTicket(
    request: FastifyRequest,
    reply: FastifyReply,
    writing: boolean,
  ): Promise<TicketRow | null> {
    const params = ticketParams.safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    const found = await resolveTicket(db, request.workspaceId, params.data.id);
    const row = found ? await loadTicket(db, request.workspaceId, found.id) : undefined;
    if (!row || row.deleted_at || !(await request.authz.seesTicket(row))) {
      await notFound(reply);
      return null;
    }
    if (writing && row.track_archived_at) {
      await reply.code(409).send({ error: 'track_archived' });
      return null;
    }
    return row;
  }

  /** The lock of a status that reserves attaching (and removing files) to some (WF-007). */
  async function attachLock(request: FastifyRequest, ticket: TicketRow): Promise<Lock | null> {
    const allowed = (await statusGate(db, request, ticket.track_id, ticket.ticket_type_id)).check(
      ticket.status_id,
      'attach',
    );
    return allowed ? statusLock(db, request.workspaceId, ticket.status_id, allowed) : null;
  }

  /** The route's attachment on its ticket, or the refusal. */
  async function routeAttachment(
    request: FastifyRequest,
    reply: FastifyReply,
    writing = false,
  ): Promise<{ ticket: TicketRow; row: AttachmentRow } | null> {
    const params = attachmentParams.safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    const ticket = await routeTicket(request, reply, writing);
    if (!ticket) return null;
    const row = await attachmentQuery(db)
      .where('a.id', '=', params.data.attachmentId)
      .where('a.ticket_id', '=', ticket.id)
      .executeTakeFirst();
    if (!row) {
      await notFound(reply);
      return null;
    }
    return { ticket, row };
  }

  /** Whether the file may be served, by its scan; answers the refusal otherwise. */
  async function servable(reply: FastifyReply, row: AttachmentRow): Promise<ObjectStore | null> {
    if (row.scan_state !== 'clean') {
      await reply.code(409).send({ error: `scan_${row.scan_state}` });
      return null;
    }
    const store = stores.stores[row.storage];
    if (!store) {
      await unavailable(reply);
      return null;
    }
    return store;
  }

  /** What the viewer may delete in a track: their own, everyone's, or nothing. */
  async function deleteRights(request: FastifyRequest, ticket: TicketRow) {
    if (ticket.track_archived_at) return { own: false, all: false };
    const held = await request.authz.ticket(ticket);
    const all = held.has('delete_all_attachments');
    return { own: all || held.has('delete_own_attachments'), all };
  }
  const mayDelete = (
    rights: { own: boolean; all: boolean },
    row: AttachmentRow,
    userId: number | undefined,
  ) => rights.all || (rights.own && row.author_id !== null && row.author_id === userId);

  /** Streams a local object, or redirects to a signed URL for one in S3. */
  async function sendObject(
    request: FastifyRequest,
    reply: FastifyReply,
    store: ObjectStore,
    object: {
      key: string;
      size: number;
      etag: string;
      contentType: string;
      inline: boolean;
      name: string;
    },
  ) {
    const disposition = contentDisposition(object.inline ? 'inline' : 'attachment', object.name);
    const signed = await store.signedUrl(object.key, {
      expiresIn: stores.urlTtl,
      contentType: object.contentType,
      contentDisposition: disposition,
    });
    if (signed !== null) {
      return reply
        .code(302)
        .header('location', signed)
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .send();
    }
    guard(reply, object.inline, object.contentType);
    const etag = `"${object.etag}"`;
    reply
      .header('content-type', object.contentType)
      .header('content-disposition', disposition)
      .header('cache-control', 'private, no-cache')
      .header('etag', etag)
      .header('accept-ranges', 'bytes');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    const range = requestedRange(request.headers.range, object.size);
    if (range === 'unsatisfiable') {
      return reply.code(416).header('content-range', `bytes */${object.size}`).send();
    }
    const length = range ? range.end - range.start + 1 : object.size;
    if (range) {
      reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${object.size}`);
    }
    reply.header('content-length', String(length));
    // Fastify's HEAD handling keeps the headers of a stream and drains it: an empty one, so the
    // file is not read.
    if (request.method === 'HEAD') return reply.send(Readable.from([]));
    let stream: NodeJS.ReadableStream;
    try {
      stream = await store.read(object.key, range ?? undefined);
    } catch (error) {
      // The row is there but the file is not (a database restored without its files).
      if (error instanceof ObjectNotFoundError) {
        for (const name of ['content-range', 'content-length', 'content-disposition', 'etag']) {
          reply.removeHeader(name);
        }
        return reply
          .code(404)
          .header('content-type', 'application/json; charset=utf-8')
          .send({ error: 'file_missing' });
      }
      throw error;
    }
    return reply.send(stream);
  }

  await app.register(async (scope) => {
    // Multipart parsing for the upload route only; one part, no fields.
    await scope.register(fastifyMultipart, {
      limits: {
        files: 1,
        fields: 0,
        parts: 1,
        headerPairs: 20,
        fieldNameSize: 100,
        fileSize: Number.MAX_SAFE_INTEGER,
      },
    });

    scope.get('/api/v1/tickets/:id/attachments', async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return reply;
      const ticket = await routeTicket(request, reply, false);
      if (!ticket) return reply;
      const [rows, rights, canCreate, limit, lock] = await Promise.all([
        attachmentQuery(db)
          .where('a.ticket_id', '=', ticket.id)
          .orderBy('a.created_at')
          .orderBy('a.id')
          .execute(),
        deleteRights(request, ticket),
        request.authz.canTicket('create_attachments', ticket),
        maxFileSize(db, request.workspaceId),
        attachLock(request, ticket),
      ]);
      return {
        attachments: rows.map((r) => attachmentView(r, !lock && mayDelete(rights, r, user.id))),
        maxFileSize: limit,
        canCreate: canCreate && !lock && !ticket.track_archived_at && stores.active !== null,
        available: stores.active !== null,
        // Why the panel takes no files here, when a status reserves attaching (WF-007).
        locked: lock,
      };
    });

    scope.post('/api/v1/tickets/:id/attachments', async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return reply;
      const ticket = await routeTicket(request, reply, true);
      if (!ticket) return reply;
      if (!(await request.authz.canTicket('create_attachments', ticket))) {
        return forbidden(reply, 'create_attachments');
      }
      const lock = await attachLock(request, ticket);
      if (lock) return reply.code(403).send(lockedBody('attach', [lock]));
      const store = stores.active;
      if (!store) return unavailable(reply);
      const ws = request.workspaceId;
      const [max, quota] = await Promise.all([maxFileSize(db, ws), storageQuota(db, ws)]);
      // ASVS 12.1.3: the room the person's and the workspace's quotas leave.
      const room = await quotaRoom(db, ws, user.id, quota);
      if (room && room.available === 0) return overQuota(reply, quotaRefusal(room));
      // CORE-021 (1): a file the request's length already shows too large is refused at once.
      const length = Number(request.headers['content-length']);
      if (Number.isFinite(length) && length > max + MULTIPART_OVERHEAD) {
        return tooLarge(reply, max);
      }
      if (room && Number.isFinite(length) && length > room.available + MULTIPART_OVERHEAD) {
        return overQuota(reply, quotaRefusal(room));
      }
      // The stream stops at whichever comes first: the file size limit or the room left.
      const cap = room ? Math.min(max, room.available) : max;
      const capped = (r: FastifyReply) =>
        room && cap < max ? overQuota(r, quotaRefusal(room)) : tooLarge(r, max);
      if (!request.isMultipart()) return invalid(reply, 'multipart');
      let part: Awaited<ReturnType<FastifyRequest['file']>>;
      try {
        // Busboy cuts a file at its size limit and ends the stream as if it were complete
        // (the plugin's default is 1 MiB); one byte over our limit lets the meter refuse it.
        part = await request.file({
          limits: { fileSize: Math.min(cap + 1, Number.MAX_SAFE_INTEGER) },
        });
      } catch {
        return invalid(reply, 'multipart');
      }
      if (!part) return invalid(reply, 'file');
      const name = safeFilename(part.filename ?? '');
      const declared = normalizeType(part.mimetype);

      const key = newObjectKey(ws);
      await registerUpload(db, ws, store.kind, key);
      const head: Buffer[] = [];
      let headLength = 0;
      let stored: PutResult;
      try {
        stored = await store.put(key, part.file, {
          maxBytes: cap,
          contentType: declared,
          onChunk: (chunk) => {
            if (headLength >= SNIFF_BYTES) return;
            const piece = chunk.subarray(0, SNIFF_BYTES - headLength);
            head.push(piece);
            headLength += piece.length;
          },
        });
      } catch (error) {
        await dropUpload(db, stores, store.kind, key);
        if (isTooLarge(error)) return capped(reply);
        // The client went away: nobody is left to answer.
        if (request.raw.destroyed || request.raw.aborted) return reply;
        throw error;
      }
      if (part.file.truncated) {
        await dropUpload(db, stores, store.kind, key);
        return capped(reply);
      }
      const headBytes = Buffer.concat(head);
      const sniffed = sniff(headBytes, stored.size <= headBytes.length);
      const scanning = stores.scanner !== null;
      const thumbnail = thumbnailable(sniffed);

      let result: AttachmentRow | 'gone' | 'expired' | QuotaRefusal;
      try {
        result = await db.transaction().execute(async (trx) => {
          const current = await lockTicket(trx, ticket.id);
          if (!current) return 'gone' as const;
          // Another upload may have taken the room meanwhile.
          const over = await holdQuota(trx, ws, user.id, stored.size, quota);
          if (over) return over;
          if (!(await keepUpload(trx, store.kind, key))) return 'expired' as const;
          const created = await trx
            .insertInto('attachment')
            .values({
              workspace_id: ws,
              ticket_id: ticket.id,
              name,
              declared_type: declared,
              sniffed_type: sniffed,
              size: stored.size,
              sha256: stored.sha256,
              storage: store.kind,
              storage_key: key,
              scan_state: scanning ? 'pending' : 'clean',
              scanned_at: scanning ? null : new Date(),
              thumbnail_state: thumbnail ? 'pending' : 'none',
              author_id: user.id,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .updateTable('ticket')
            .set({ version: current.version + 1, updated_at: new Date() })
            .where('id', '=', ticket.id)
            .execute();
          await recordChanges(trx, ws, user.id, [
            attachmentChange(ticket.id, { id: created.id, name }, true),
          ]);
          await emit(trx, by(request), {
            type: 'attachment.created',
            subjectId: created.id,
            payload: {
              key: ticketKey(current.track_key, current.number),
              ticketId: ticket.id,
              name,
              size: stored.size,
              contentType: declared,
              sniffedType: sniffed,
              scan: scanning ? 'pending' : 'clean',
            },
          });
          if (scanning || thumbnail) await queueProcessing(trx, ws, created.id);
          return attachmentQuery(trx).where('a.id', '=', created.id).executeTakeFirstOrThrow();
        });
      } catch (error) {
        await dropUpload(db, stores, store.kind, key);
        throw error;
      }
      if (result === 'gone') {
        await dropUpload(db, stores, store.kind, key);
        return notFound(reply);
      }
      // The upload took longer than its grace and the sweep removed the file.
      if (result === 'expired') return reply.code(409).send({ error: 'upload_expired' });
      if ('error' in result) {
        await dropUpload(db, stores, store.kind, key);
        return overQuota(reply, result);
      }
      return reply.code(201).send({ attachment: attachmentView(result, true) });
    });

    // Download all as one ZIP (CORE-021): the clean files, read as the archive reaches them.
    scope.get('/api/v1/tickets/:id/attachments/archive', async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const ticket = await routeTicket(request, reply, false);
      if (!ticket) return reply;
      const rows = await attachmentQuery(db)
        .where('a.ticket_id', '=', ticket.id)
        .where('a.scan_state', '=', 'clean')
        .orderBy('a.created_at')
        .orderBy('a.id')
        .execute();
      const readable = rows.filter((r) => stores.stores[r.storage]);
      if (readable.length === 0) return notFound(reply);
      const key = ticketKey(ticket.track_key, ticket.number);
      const stream = archive(
        readable.map((r) => ({
          name: r.name,
          size: Number(r.size),
          contentType: servedAs(r.sniffed_type, r.declared_type, r.name).contentType,
          createdAt: r.created_at,
          open: () => (stores.stores[r.storage] as ObjectStore).read(r.storage_key),
        })),
      );
      guard(reply, false, 'application/zip');
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', contentDisposition('attachment', `${key}-attachments.zip`))
        .header('cache-control', 'private, no-store')
        .send(stream);
    });

    scope.get('/api/v1/tickets/:id/attachments/:attachmentId', async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return reply;
      const found = await routeAttachment(request, reply);
      if (!found) return reply;
      const rights = await deleteRights(request, found.ticket);
      return { attachment: attachmentView(found.row, mayDelete(rights, found.row, user.id)) };
    });

    scope.get('/api/v1/tickets/:id/attachments/:attachmentId/content', async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const query = contentQuery.safeParse(request.query);
      if (!query.success) return invalid(reply);
      const found = await routeAttachment(request, reply);
      if (!found) return reply;
      const { row } = found;
      const store = await servable(reply, row);
      if (!store) return reply;
      const served = servedAs(row.sniffed_type, row.declared_type, row.name);
      return sendObject(request, reply, store, {
        key: row.storage_key,
        size: Number(row.size),
        etag: row.sha256,
        contentType: served.contentType,
        inline: query.data.disposition === 'inline' && served.inline,
        name: row.name,
      });
    });

    scope.get('/api/v1/tickets/:id/attachments/:attachmentId/thumbnail', async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const found = await routeAttachment(request, reply);
      if (!found) return reply;
      const { row } = found;
      if (row.thumbnail_state !== 'ready' || !row.thumbnail_key) return notFound(reply);
      const store = await servable(reply, row);
      if (!store) return reply;
      const size = await store.size(row.thumbnail_key);
      if (size === null) return notFound(reply);
      const dot = row.name.lastIndexOf('.');
      const stem = dot > 0 ? row.name.slice(0, dot) : row.name;
      const png = row.sniffed_type === 'image/png';
      return sendObject(request, reply, store, {
        key: row.thumbnail_key,
        size,
        etag: `${row.sha256.slice(0, 32)}-thumb`,
        contentType: png ? 'image/png' : 'image/jpeg',
        inline: true,
        name: `${stem}-thumbnail.${png ? 'png' : 'jpg'}`,
      });
    });

    // The start of a text file, for the preview; read here so it works for either store.
    scope.get('/api/v1/tickets/:id/attachments/:attachmentId/text', async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const found = await routeAttachment(request, reply);
      if (!found) return reply;
      const { row } = found;
      if (servedAs(row.sniffed_type, row.declared_type, row.name).kind !== 'text') {
        return reply.code(409).send({ error: 'not_text' });
      }
      const store = await servable(reply, row);
      if (!store) return reply;
      const size = Number(row.size);
      const bytes =
        size === 0
          ? Buffer.alloc(0)
          : await readText(
              await store.read(row.storage_key, {
                start: 0,
                end: Math.min(size, TEXT_PREVIEW_BYTES) - 1,
              }),
              TEXT_PREVIEW_BYTES,
            );
      return {
        text: new TextDecoder('utf-8').decode(bytes),
        truncated: size > TEXT_PREVIEW_BYTES,
      };
    });

    // ZIP contents (CORE-021): the entries, then one entry at a time.
    scope.get('/api/v1/tickets/:id/attachments/:attachmentId/entries', async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const found = await routeAttachment(request, reply);
      if (!found) return reply;
      const { row } = found;
      if (servedAs(row.sniffed_type, row.declared_type, row.name).kind !== 'zip') {
        return reply.code(409).send({ error: 'not_zip' });
      }
      const store = await servable(reply, row);
      if (!store) return reply;
      try {
        return await listZip((range) => store.read(row.storage_key, range), Number(row.size));
      } catch (error) {
        if (error instanceof ZipError) return reply.code(422).send({ error: 'not_a_zip' });
        throw error;
      }
    });

    scope.get(
      '/api/v1/tickets/:id/attachments/:attachmentId/entries/:index/content',
      async (request, reply) => {
        if (!requireUser(request, reply)) return reply;
        const params = entryParams.safeParse(request.params);
        if (!params.success) return invalid(reply);
        const found = await routeAttachment(request, reply);
        if (!found) return reply;
        const { row } = found;
        if (servedAs(row.sniffed_type, row.declared_type, row.name).kind !== 'zip') {
          return reply.code(409).send({ error: 'not_zip' });
        }
        const store = await servable(reply, row);
        if (!store) return reply;
        const max = await maxFileSize(db, request.workspaceId);
        try {
          const opened = await openZipEntry(
            (range) => store.read(row.storage_key, range),
            Number(row.size),
            params.data.index,
            max,
          );
          guard(reply, false, 'application/octet-stream');
          return reply
            .header('content-type', 'application/octet-stream')
            .header('content-disposition', contentDisposition('attachment', opened.name))
            .header('content-length', String(opened.entry.size))
            .header('cache-control', 'private, no-store')
            .send(opened.stream);
        } catch (error) {
          if (!(error instanceof ZipError)) throw error;
          if (error.code === 'no_such_entry') return notFound(reply);
          if (error.code === 'too_large') {
            return reply.code(413).send({ error: 'entry_too_large', maxFileSize: max });
          }
          return reply.code(422).send({ error: `entry_${error.code}` });
        }
      },
    );

    scope.delete('/api/v1/tickets/:id/attachments/:attachmentId', async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return reply;
      const found = await routeAttachment(request, reply, true);
      if (!found) return reply;
      const { ticket, row } = found;
      const own = row.author_id !== null && row.author_id === user.id;
      const rights = await deleteRights(request, ticket);
      if (!mayDelete(rights, row, user.id)) {
        return forbidden(reply, own ? 'delete_own_attachments' : 'delete_all_attachments');
      }
      const lock = await attachLock(request, ticket);
      if (lock) return reply.code(403).send(lockedBody('attach', [lock]));
      const ws = request.workspaceId;
      const removed = await db.transaction().execute(async (trx) => {
        const current = await lockTicket(trx, ticket.id);
        if (!current) return null;
        const gone = await trx
          .deleteFrom('attachment')
          .where('id', '=', row.id)
          .where('ticket_id', '=', ticket.id)
          .returning(['id', 'name', 'size', 'storage', 'storage_key', 'thumbnail_key'])
          .executeTakeFirst();
        if (!gone) return null;
        await trx
          .updateTable('ticket')
          .set({ version: current.version + 1, updated_at: new Date() })
          .where('id', '=', ticket.id)
          .execute();
        await recordChanges(trx, ws, user.id, [attachmentChange(ticket.id, gone, false)]);
        await emit(trx, by(request), {
          type: 'attachment.deleted',
          subjectId: gone.id,
          payload: {
            key: ticketKey(current.track_key, current.number),
            ticketId: ticket.id,
            name: gone.name,
            size: Number(gone.size),
            own,
          },
        });
        return gone;
      });
      if (!removed) return notFound(reply);
      // The trigger queued its objects; delete them now, or the next sweep will.
      await sweepStorage(db, stores, {
        keys: [removed.storage_key, removed.thumbnail_key]
          .filter((k): k is string => k !== null)
          .map((k) => ({ storage: removed.storage, key: k })),
      }).catch((error: unknown) => request.log.warn({ error }, 'attachment cleanup deferred'));
      return reply.code(204).send();
    });

    // Settings (site administrators): the maximum file size, the storage quotas with the
    // usage they hold (ASVS 12.1.3), and what stores this process has.
    scope.get('/api/v1/admin/attachment-settings', async (request, reply) => {
      if (!(await requireSiteAdmin(request, reply))) return reply;
      return settingsView(request.workspaceId);
    });

    scope.put('/api/v1/admin/attachment-settings', async (request, reply) => {
      const admin = await requireSiteAdmin(request, reply);
      if (!admin) return reply;
      const parsed = settingsBody.safeParse(request.body);
      if (!parsed.success) return invalid(reply);
      const ws = request.workspaceId;
      const body = parsed.data;
      await withEvent(db, by(request), async (trx) => {
        const fromMax = await maxFileSize(trx, ws);
        const fromQuota = await storageQuota(trx, ws);
        const toMax = body.maxFileSize ?? fromMax;
        const toQuota = {
          workspace: body.workspaceQuota === undefined ? fromQuota.workspace : body.workspaceQuota,
          person: body.personQuota === undefined ? fromQuota.person : body.personQuota,
        };
        const changes: Record<string, { from: number | null; to: number | null }> = {};
        if (toMax !== fromMax) changes.maxFileSize = { from: fromMax, to: toMax };
        if (toQuota.workspace !== fromQuota.workspace) {
          changes.workspaceQuota = { from: fromQuota.workspace, to: toQuota.workspace };
        }
        if (toQuota.person !== fromQuota.person) {
          changes.personQuota = { from: fromQuota.person, to: toQuota.person };
        }
        if (Object.keys(changes).length === 0) return { result: null, event: null };
        if (changes.maxFileSize) await setMaxFileSize(trx, ws, toMax);
        if (changes.workspaceQuota || changes.personQuota) await setStorageQuota(trx, ws, toQuota);
        return {
          result: null,
          event: {
            type: 'attachment_settings.updated',
            subjectId: ws,
            payload: { changes },
          },
        };
      });
      return settingsView(ws);
    });
  });

  async function settingsView(ws: number) {
    const [max, quota, usage, top] = await Promise.all([
      maxFileSize(db, ws),
      storageQuota(db, ws),
      storageUsage(db, ws),
      topUploader(db, ws),
    ]);
    return {
      maxFileSize: max,
      workspaceQuota: quota.workspace,
      personQuota: quota.person,
      usage: { ...usage, topPerson: top },
      storage: stores.active?.kind ?? null,
      scanner: stores.scanner?.name ?? null,
      signedUrlSeconds: stores.urlTtl,
    };
  }

  /** Locks a ticket outside the trash for an attachment write; its version and key. */
  async function lockTicket(trx: Transaction<Database>, ticketId: number) {
    const locked = await trx
      .selectFrom('ticket')
      .select('id')
      .where('id', '=', ticketId)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) return null;
    return trx
      .selectFrom('ticket as k')
      .innerJoin('track as t', 't.id', 'k.track_id')
      .select(['k.version', 'k.number', 't.key as track_key'])
      .where('k.id', '=', ticketId)
      .executeTakeFirstOrThrow();
  }
}
