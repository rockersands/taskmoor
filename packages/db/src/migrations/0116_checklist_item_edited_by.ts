import { type Kysely, sql } from 'kysely';

/**
 * Who wrote a checklist item's words as they read now (T-203; CORE-033; ADR-120). An item's
 * `created_by` is who added it; anyone who may edit the ticket can rewrite its words afterwards,
 * and a person's data download (IAM-008) must not hand them words someone else wrote. The routes
 * set `edited_by` whenever an item's words change, and only then: ticking an item, moving it or
 * renaming its list leaves the words as their writer left them. Null means the words are the
 * creator's.
 *
 * Items rewritten before this migration get the person who last rewrote them from the ticket's
 * `ticket.checklist_changed` events (`item_edited`, with the item's id). An edit made in the same
 * request as a change of state was recorded as `item_state` and cannot be told apart from a tick,
 * so those stay the creator's.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE ticket_checklist_item
      ADD COLUMN edited_by integer REFERENCES app_user (id)`.execute(db);
  // Whose words a person's data download lists, and the foreign key's lookup when a person goes.
  await sql`CREATE INDEX ticket_checklist_item_editor_idx ON ticket_checklist_item (edited_by)
    WHERE edited_by IS NOT NULL`.execute(db);
  await sql`
    UPDATE ticket_checklist_item i
       SET edited_by = last.actor_id
      FROM (
        SELECT DISTINCT ON (e.workspace_id, (e.payload ->> 'itemId'))
               e.workspace_id, (e.payload ->> 'itemId') AS item_id, e.actor_id
          FROM domain_event e
         WHERE e.type = 'ticket.checklist_changed'
           AND e.payload ->> 'change' = 'item_edited'
           AND e.actor_id IS NOT NULL
           AND jsonb_typeof(e.payload -> 'itemId') = 'number'
         ORDER BY e.workspace_id, (e.payload ->> 'itemId'), e.occurred_at DESC, e.id DESC
      ) last
     WHERE i.workspace_id = last.workspace_id
       AND i.id::text = last.item_id`.execute(db);
}
