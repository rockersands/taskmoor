import { type Kysely, sql } from 'kysely';

/**
 * Who wrote a checklist item's words as they read now (T-203; CORE-033; ADR-120). An item's
 * `created_by` is who added it; anyone who may edit the ticket can rewrite its words afterwards,
 * and a person's data download (IAM-008) must not hand them words someone else wrote. The routes
 * set `edited_by` whenever an item's words change, and only then: ticking an item, moving it or
 * renaming its list leaves the words as their writer left them. Null means the words are the
 * creator's.
 *
 * Items rewritten before this migration get the person who last wrote their present words from
 * the ticket's history: every change of an item's words wrote a `checklistItem` row with the old
 * and the new words and who changed them, also when the same request ticked the item (its event
 * then says `item_state`, so the events alone miss it). The history row names no item, so the
 * item is the one on that ticket whose words the row wrote, rewritten after the item was added.
 * When the last such writer is the creator, or nobody, the words stay the creator's.
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
        SELECT DISTINCT ON (it.id) it.id, c.actor_id
          FROM ticket_checklist_item it
          JOIN ticket_checklist l ON l.id = it.checklist_id
          JOIN ticket_change c
            ON c.ticket_id = l.ticket_id
           AND c.field = 'checklistItem'
           AND c.from_value IS NOT NULL
           AND c.to_value = it.text
           AND c.at >= it.created_at
         ORDER BY it.id, c.at DESC, c.id DESC
      ) last
     WHERE i.id = last.id
       AND last.actor_id IS NOT NULL
       AND last.actor_id IS DISTINCT FROM i.created_by`.execute(db);
}
