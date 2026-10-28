import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';
import type { FieldChange } from '../tickets/history';
import { type MediaKind, servedAs } from './sniff';

/**
 * Attachment rows and settings (CORE-021): how the API shows them and the workspace's maximum
 * file size.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** 1 GiB, the spec's default; administrators may set any size above zero (no ceiling). */
export const DEFAULT_MAX_FILE_SIZE = 1024 * 1024 * 1024;

export async function maxFileSize(db: Db, workspaceId: number): Promise<number> {
  const row = await db
    .selectFrom('attachment_setting')
    .select('max_file_size')
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  return row ? Number(row.max_file_size) : DEFAULT_MAX_FILE_SIZE;
}

export async function setMaxFileSize(
  trx: Transaction<Database>,
  workspaceId: number,
  bytes: number,
): Promise<void> {
  await trx
    .insertInto('attachment_setting')
    .values({ workspace_id: workspaceId, max_file_size: bytes, updated_at: new Date() })
    .onConflict((oc) =>
      oc.column('workspace_id').doUpdateSet({ max_file_size: bytes, updated_at: new Date() }),
    )
    .execute();
}

export function attachmentQuery(db: Db) {
  return db
    .selectFrom('attachment as a')
    .leftJoin('app_user as u', 'u.id', 'a.author_id')
    .select([
      'a.id',
      'a.workspace_id',
      'a.ticket_id',
      'a.name',
      'a.declared_type',
      'a.sniffed_type',
      'a.size',
      'a.sha256',
      'a.storage',
      'a.storage_key',
      'a.scan_state',
      'a.scan_detail',
      'a.thumbnail_state',
      'a.thumbnail_key',
      'a.width',
      'a.height',
      'a.author_id',
      'u.name as author_name',
      'a.created_at',
    ]);
}
export type AttachmentRow = Awaited<
  ReturnType<ReturnType<typeof attachmentQuery>['executeTakeFirstOrThrow']>
>;

export interface AttachmentView {
  id: number;
  name: string;
  size: number;
  /** The type it is served with (what its bytes allow), and the one the uploader declared. */
  contentType: string;
  declaredType: string;
  kind: MediaKind;
  sha256: string;
  author: { id: number; name: string } | null;
  createdAt: string;
  /** Only `clean` files download. */
  scan: 'pending' | 'clean' | 'infected' | 'failed';
  thumbnail: boolean;
  width: number | null;
  height: number | null;
  /** Whether the viewer may delete it (own or all attachments). */
  canDelete: boolean;
}

export function attachmentView(row: AttachmentRow, canDelete: boolean): AttachmentView {
  const served = servedAs(row.sniffed_type, row.declared_type, row.name);
  return {
    id: row.id,
    name: row.name,
    size: Number(row.size),
    contentType: served.contentType,
    declaredType: row.declared_type,
    kind: served.kind,
    sha256: row.sha256,
    author: row.author_id === null ? null : { id: row.author_id, name: row.author_name ?? '' },
    createdAt: row.created_at.toISOString(),
    scan: row.scan_state,
    thumbnail: row.thumbnail_state === 'ready',
    width: row.width,
    height: row.height,
    canDelete,
  };
}

/** The history row of an attachment added or removed: its id, and its name for display. */
export function attachmentChange(
  ticketId: number,
  attachment: { id: number; name: string },
  added: boolean,
): FieldChange {
  const value = String(attachment.id);
  return {
    ticketId,
    field: 'attachment',
    from: added ? null : value,
    to: added ? value : null,
    fromDisplay: added ? null : attachment.name,
    toDisplay: added ? attachment.name : null,
  };
}
