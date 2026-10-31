import type { JsonValue } from '@taskmoor/db';
import { newObjectKey } from '@taskmoor/storage';
import { keepUpload, registerUpload } from '../attachments/cleanup';
import { queueProcessing } from '../attachments/jobs';
import { attachmentChange } from '../attachments/records';
import { thumbnailable } from '../attachments/sniff';
import {
  deferChanges,
  existingTarget,
  flushChanges,
  type Loader,
  optional,
  PlanFailure,
  real,
  required,
} from './load';
import type { AttachmentCommand } from './model';

/**
 * Attachments (M1-098; IMP-014): the bytes come from the source (`ImportSource.openFile`), go
 * to the server's active store under a new random key (ADR-040) and must hash to the SHA-256
 * the record gives, or the record fails. The object is registered for cleanup on its own
 * before its first byte, and taken out of the cleanup in the batch's transaction, so a batch
 * that rolls back leaves no file behind for long (the sweep removes it). Files are scanned and
 * get thumbnails as uploads do. An attachment never changes: a re-run leaves it.
 */
const attachmentPrint = (a: {
  ticket: number | null;
  name: string;
  size: number;
  sha256: string;
}): JsonValue => ({ ticket: real(a.ticket), name: a.name, size: a.size, sha256: a.sha256 });

export const attachments: Loader<AttachmentCommand> = {
  table: { name: 'attachment', id: 'id' },
  async plan(ctx, cmd, existing) {
    const ticket = required(ctx, cmd.ticket, 'ticket');
    const author = optional(ctx, cmd.author, 'author');
    const fingerprint = attachmentPrint({ ...cmd, ticket });
    if (existing !== null) {
      await existingTarget(ctx, 'attachment', existing);
      return { action: 'link', targetId: existing, fingerprint };
    }
    const size = (await ctx.source.fileSize?.(cmd.file)) ?? null;
    if (size === null) throw new PlanFailure('file_missing');
    if (size !== cmd.size) throw new PlanFailure('file_size_differs');
    if (!ctx.stores?.active) throw new PlanFailure('no_storage');
    return { action: 'create', targetId: null, fingerprint, data: { ticket, author } };
  },
  async apply(ctx, cmd, plan) {
    if (plan.action !== 'create') return plan.targetId as number;
    const { ticket, author } = plan.data as { ticket: number; author: number | null };
    const stores = ctx.stores;
    const store = stores?.active;
    if (!stores || !store || !ctx.source.openFile) throw new PlanFailure('no_storage');
    const key = newObjectKey(ctx.workspaceId);
    await registerUpload(ctx.db, ctx.workspaceId, store.kind, key);
    const stored = await store.put(key, await ctx.source.openFile(cmd.file), {
      maxBytes: cmd.size,
      contentType: cmd.declaredType,
    });
    if (stored.sha256 !== cmd.sha256 || stored.size !== cmd.size) {
      throw new PlanFailure('checksum_mismatch');
    }
    await keepUpload(ctx.trx, store.kind, key);
    const scanning = stores.scanner !== null;
    const thumbnail = thumbnailable(cmd.sniffedType);
    const row = await ctx.trx
      .insertInto('attachment')
      .values({
        workspace_id: ctx.workspaceId,
        ticket_id: ticket,
        name: cmd.name,
        declared_type: cmd.declaredType,
        sniffed_type: cmd.sniffedType,
        size: cmd.size,
        sha256: cmd.sha256,
        storage: store.kind,
        storage_key: key,
        scan_state: scanning ? 'pending' : 'clean',
        scanned_at: scanning ? null : new Date(),
        thumbnail_state: thumbnail ? 'pending' : 'none',
        width: cmd.width,
        height: cmd.height,
        author_id: author,
        created_at: cmd.createdAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (scanning || thumbnail) await queueProcessing(ctx.trx, ctx.workspaceId, row.id);
    // A verbatim source's history has the entry for the new file.
    if (!ctx.verbatim) {
      deferChanges(ctx, author, cmd.createdAt, [
        attachmentChange(ticket, { id: row.id, name: cmd.name }, true),
      ]);
    }
    return row.id;
  },
  async finish(ctx) {
    await flushChanges(ctx);
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('attachment')
      .select(['id', 'ticket_id', 'name', 'size', 'sha256'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        attachmentPrint({
          ticket: r.ticket_id,
          name: r.name,
          size: Number(r.size),
          sha256: r.sha256,
        }),
      ]),
    );
  },
};
