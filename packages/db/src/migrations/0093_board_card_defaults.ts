import { type Kysely, sql } from 'kysely';

/**
 * A board's new default cards (the user's decision; AGL-006): title, priority and type icons,
 * assignee, and the points where there are any. A board that never changed its cards follows.
 *
 * The old default is the only sign a board has: nothing records whether someone chose its fields.
 * So a board whose card fields are exactly the old `assignee, priority`, in that order, counts as
 * untouched and gets the new fields; any other list was someone's choice and stays. When the rest
 * of its card rules are the old default too (colour by type, days in column on), they follow as
 * well: no colour strip and no days marker. A colour or a days setting someone changed stays.
 *
 * Someone who deliberately chose the same two fields cannot be told apart, and gets the new ones;
 * both of theirs are still on the card. No version or `updated_at`: nobody changed the board.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE board
       SET card_rules = CASE
         WHEN card_rules->>'colourBy' = 'type'
              AND COALESCE(card_rules->'colours', '[]'::jsonb) = '[]'::jsonb
              AND card_rules->'daysInColumn' = 'true'::jsonb
         THEN card_rules || '{"colourBy": "none", "daysInColumn": false}'::jsonb
         ELSE card_rules
       END || '{"fields": ["priority", "assignee", "points"]}'::jsonb
     WHERE card_rules->'fields' = '["assignee", "priority"]'::jsonb`.execute(db);
}
