import type { Database, JsonValue, RichTextField } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';
import type { Authorizer } from '../authz/authorizer';
import { emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import {
  type FormPlacement,
  formFields,
  layoutProblems,
  missingRequired,
  resolveLayout,
} from '../fields/layouts';
import { autoFollow } from '../tickets/followers';
import { recordChanges, ticketChanges } from '../tickets/history';
import { canonicalJson, ticketKey } from '../tickets/model';
import { docHash } from '../tickets/rich-text';
import { loadTicket, type TicketRow } from '../tickets/store';

/**
 * Where collaborative edits land (M1-017; NTF-008; ADR-014 "Implementation (M1-017)"): the
 * ticket's own column, through the same rules as an edit through the API (PATCH), and the
 * Yjs state beside it.
 */

export interface CollaborativeWrite {
  workspaceId: number;
  ticketId: number;
  field: RichTextField;
  /** The document as the schema keeps it (`checkRichText`); null for an empty one. */
  doc: JsonValue | null;
  /** Who made the last change being saved; history and the event name them. */
  actorId: number;
  /** Their address, for the event. */
  ip: string | null;
  /** The whole Yjs state holding `doc`. */
  state: Uint8Array;
}

export type WriteOutcome =
  /** Saved as a change of the ticket (history, version, one `ticket.updated` event). */
  | { status: 'written'; ticket: TicketRow }
  /** The ticket already held it; only the collaboration state was kept. */
  | { status: 'unchanged'; ticket: TicketRow }
  /** Gone, in the trash, or no longer visible to the person. */
  | { status: 'missing' }
  /** The person may no longer edit it (permission, archived track, layout or field rule). */
  | { status: 'refused'; ticket: TicketRow };

type Db = Kysely<Database> | Transaction<Database>;

class Rollback extends Error {
  constructor(readonly outcome: WriteOutcome) {
    super('rolled back');
  }
}

/**
 * Whether a person may edit a rich text field of a ticket now: they see it, hold "Edit
 * tickets" there (none in an archived track or the trash), and the edit form of its type shows
 * the field (field rules and layouts, M1-012).
 */
export async function mayEditText(
  authorizer: Authorizer,
  catalogs: FieldCatalogs,
  workspaceId: number,
  userId: number,
  row: TicketRow,
  field: RichTextField,
): Promise<'yes' | 'missing' | 'refused'> {
  if (row.deleted_at) return 'missing';
  const held = await authorizer.context(workspaceId, { userId }).ticket(row);
  if (!held.has('browse_track')) return 'missing';
  if (!held.has('edit_tickets')) return 'refused';
  const catalog = await catalogs.get(workspaceId);
  const at = placementOf(row);
  const form = formFields(resolveLayout(catalog, at, 'edit'));
  return layoutProblems(catalog, at, form.shown, [field]) ? 'refused' : 'yes';
}

const placementOf = (row: TicketRow): FormPlacement => ({
  trackId: row.track_id,
  ticketTypeId: row.ticket_type_id,
  ruleSetId: row.rule_set_id,
  layoutSetId: row.layout_set_id,
});

/**
 * Saves a field's collaborative document: a change of the ticket when it differs from what the
 * ticket holds, checked as an edit through the API would be, and the Yjs state either way.
 * Lookups through the pool happen before the transaction (see the ticket routes).
 */
export async function writeCollaborativeText(
  db: Kysely<Database>,
  authorizer: Authorizer,
  catalogs: FieldCatalogs,
  write: CollaborativeWrite,
): Promise<WriteOutcome> {
  const ws = write.workspaceId;
  const seen = await loadTicket(db, ws, write.ticketId);
  if (!seen) return { status: 'missing' };
  const allowed = await mayEditText(authorizer, catalogs, ws, write.actorId, seen, write.field);
  if (allowed === 'missing') return { status: 'missing' };
  if (allowed === 'refused') return { status: 'refused', ticket: seen };
  const catalog = await catalogs.get(ws);
  try {
    return await db.transaction().execute(async (trx): Promise<WriteOutcome> => {
      const locked = await trx
        .selectFrom('ticket')
        .select('id')
        .where('id', '=', write.ticketId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      const current = locked ? await loadTicket(trx, ws, write.ticketId) : undefined;
      if (!current) return { status: 'missing' };
      // Permissions were read for where the ticket was; a move or a new level meanwhile is
      // checked again by the next save.
      if (
        current.track_id !== seen.track_id ||
        current.visibility_level_id !== seen.visibility_level_id ||
        current.ticket_type_id !== seen.ticket_type_id
      ) {
        return { status: 'refused', ticket: current };
      }
      if (canonicalJson(current[write.field]) === canonicalJson(write.doc)) {
        await saveState(trx, write);
        return { status: 'unchanged', ticket: current };
      }
      await trx
        .updateTable('ticket')
        .set({
          [write.field]: write.doc === null ? null : JSON.stringify(write.doc),
          version: current.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', write.ticketId)
        .execute();
      await emit(
        trx,
        { workspaceId: ws, actorId: write.actorId, ip: write.ip },
        {
          type: 'ticket.updated',
          subjectId: write.ticketId,
          payload: {
            key: ticketKey(current.track_key, current.number),
            changes: { [write.field]: { from: current[write.field], to: write.doc } },
          },
        },
      );
      await autoFollow(trx, ws, write.ticketId, write.actorId);
      const updated = (await loadTicket(trx, ws, write.ticketId)) as TicketRow;
      // A required field may not be emptied (CORE-013 (1)).
      const form = formFields(resolveLayout(catalog, placementOf(updated), 'edit'));
      if (missingRequired(updated, form.required, [write.field])) {
        throw new Rollback({ status: 'refused', ticket: current });
      }
      // Last write wins: the text it replaced stays in the history (NTF-008 (3)).
      await recordChanges(trx, ws, write.actorId, ticketChanges(current, updated));
      await saveState(trx, write);
      return { status: 'written', ticket: updated };
    });
  } catch (error) {
    if (error instanceof Rollback) return error.outcome;
    throw error;
  }
}

async function saveState(trx: Transaction<Database>, write: CollaborativeWrite): Promise<void> {
  const row = {
    ticket_id: write.ticketId,
    workspace_id: write.workspaceId,
    field: write.field,
    state: Buffer.from(write.state),
    doc_sha256: docHash(write.doc),
    updated_at: new Date(),
  };
  await trx
    .insertInto('ticket_text_state')
    .values(row)
    .onConflict((oc) =>
      oc.columns(['ticket_id', 'field']).doUpdateSet({
        state: row.state,
        doc_sha256: row.doc_sha256,
        updated_at: row.updated_at,
      }),
    )
    .execute();
}

/** A field's stored collaboration state, when it still holds what the ticket holds. */
export async function loadState(
  db: Db,
  ticketId: number,
  field: RichTextField,
  doc: JsonValue | null,
): Promise<Uint8Array | null> {
  const row = await db
    .selectFrom('ticket_text_state')
    .select(['state', 'doc_sha256'])
    .where('ticket_id', '=', ticketId)
    .where('field', '=', field)
    .executeTakeFirst();
  return row && row.doc_sha256 === docHash(doc) ? new Uint8Array(row.state) : null;
}
