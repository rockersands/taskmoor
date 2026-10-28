import { Readable } from 'node:stream';
import type { Database } from '@taskmoor/db';
import { newObjectKey } from '@taskmoor/storage';
import type { Kysely, Transaction } from 'kysely';
import { emit } from '../events/bus';
import { enqueue, type JobRunner } from '../events/queue';
import { ticketKey } from '../tickets/model';
import {
  dropUpload,
  keepUpload,
  registerUpload,
  SWEEP_TASK,
  sweepStorage,
  UPLOAD_GRACE_MS,
} from './cleanup';
import { attachmentQuery } from './records';
import type { AttachmentStores } from './stores';
import { MAX_THUMBNAIL_SOURCE_BYTES, makeThumbnail, ThumbnailError } from './thumbnail';

/**
 * The worker's part of attachments (ADR-040): scanning a new file when a scanner is configured,
 * then making the thumbnail of a PNG or JPEG; and the storage sweep. One job per attachment,
 * keyed by its id; a scanner that stays unreachable through every retry leaves the file
 * `failed` (never served), with an audited `attachment.quarantined`, as an infected file does.
 */
export const PROCESS_TASK = 'attachment.process';
const PROCESS_ATTEMPTS = 12;

export async function queueProcessing(
  trx: Kysely<Database> | Transaction<Database>,
  workspaceId: number,
  attachmentId: number,
): Promise<void> {
  await enqueue(trx, [
    {
      workspaceId,
      task: PROCESS_TASK,
      payload: { attachmentId },
      key: `${PROCESS_TASK}:${attachmentId}`,
      maxAttempts: PROCESS_ATTEMPTS,
    },
  ]);
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function ticketKeyOf(db: Kysely<Database>, ticketId: number): Promise<string> {
  const row = await db
    .selectFrom('ticket as k')
    .innerJoin('track as t', 't.id', 'k.track_id')
    .select(['t.key', 'k.number'])
    .where('k.id', '=', ticketId)
    .executeTakeFirst();
  return row ? ticketKey(row.key, row.number) : String(ticketId);
}

/** Scans and makes the thumbnail of one attachment, as far as each is still pending. */
export async function processAttachment(
  db: Kysely<Database>,
  stores: AttachmentStores,
  attachmentId: number,
  options: { lastAttempt?: boolean } = {},
): Promise<void> {
  let row = await attachmentQuery(db).where('a.id', '=', attachmentId).executeTakeFirst();
  if (!row) return;
  const store = stores.stores[row.storage];
  if (!store) throw new Error(`no ${row.storage} store in this process`);

  if (row.scan_state === 'pending') {
    let verdict: { state: 'clean' | 'infected' | 'failed'; detail: string | null };
    if (!stores.scanner) {
      verdict = { state: 'clean', detail: null };
    } else {
      try {
        const result = await stores.scanner.scan(await store.read(row.storage_key));
        verdict =
          result.result === 'clean'
            ? { state: 'clean', detail: null }
            : { state: 'infected', detail: result.signature };
      } catch (error) {
        if (!options.lastAttempt) throw error;
        verdict = { state: 'failed', detail: String((error as Error).message).slice(0, 500) };
      }
    }
    const scanned = row;
    const key = verdict.state === 'clean' ? '' : await ticketKeyOf(db, scanned.ticket_id);
    await db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('attachment')
        .set({
          scan_state: verdict.state,
          scan_detail: verdict.detail,
          scanned_at: new Date(),
          ...(verdict.state === 'clean' ? {} : { thumbnail_state: 'none' as const }),
        })
        .where('id', '=', scanned.id)
        .where('scan_state', '=', 'pending')
        .returning('id')
        .executeTakeFirst();
      if (!updated || verdict.state === 'clean') return;
      await emit(
        trx,
        { workspaceId: scanned.workspace_id, actorId: null, ip: null },
        {
          type: 'attachment.quarantined',
          subjectId: scanned.id,
          payload: {
            key,
            ticketId: scanned.ticket_id,
            name: scanned.name,
            result: verdict.state,
            detail: verdict.detail,
          },
        },
      );
    });
    row = await attachmentQuery(db).where('a.id', '=', attachmentId).executeTakeFirst();
    if (!row) return;
  }

  if (row.thumbnail_state !== 'pending' || row.scan_state !== 'clean') return;
  const markFailed = () =>
    db
      .updateTable('attachment')
      .set({ thumbnail_state: 'failed' })
      .where('id', '=', attachmentId)
      .where('thumbnail_state', '=', 'pending')
      .execute();
  if (Number(row.size) > MAX_THUMBNAIL_SOURCE_BYTES || !row.sniffed_type) {
    await markFailed();
    return;
  }
  let thumbnail: ReturnType<typeof makeThumbnail>;
  try {
    thumbnail = makeThumbnail(await readAll(await store.read(row.storage_key)), row.sniffed_type);
  } catch (error) {
    if (error instanceof ThumbnailError) {
      await markFailed();
      return;
    }
    throw error;
  }
  const key = newObjectKey(row.workspace_id);
  await registerUpload(db, row.workspace_id, store.kind, key);
  try {
    await store.put(key, Readable.from([thumbnail.data]), {
      maxBytes: thumbnail.data.length,
      contentType: thumbnail.contentType,
    });
  } catch (error) {
    await dropUpload(db, stores, store.kind, key);
    throw error;
  }
  const kept = await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('attachment')
      .set({
        thumbnail_state: 'ready',
        thumbnail_key: key,
        width: thumbnail.sourceWidth,
        height: thumbnail.sourceHeight,
      })
      .where('id', '=', attachmentId)
      .where('thumbnail_state', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    return updated ? keepUpload(trx, store.kind, key) : false;
  });
  if (!kept) await dropUpload(db, stores, store.kind, key);
}

export function registerAttachmentJobs(
  runner: JobRunner,
  db: Kysely<Database>,
  stores: AttachmentStores,
): void {
  runner.handle(PROCESS_TASK, async (job) => {
    const attachmentId = Number((job.payload as { attachmentId?: unknown }).attachmentId);
    if (!Number.isSafeInteger(attachmentId)) return;
    await processAttachment(db, stores, attachmentId, {
      lastAttempt: job.attempts >= job.maxAttempts,
    });
  });
  runner.handle(SWEEP_TASK, async () => {
    for (;;) {
      const report = await sweepStorage(db, stores, { limit: 500 });
      if (report.deleted + report.failed < 500) break;
    }
    const abandoned = new Date(Date.now() - UPLOAD_GRACE_MS);
    for (const store of Object.values(stores.stores)) await store?.sweepIncomplete(abandoned);
  });
}
