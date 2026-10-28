import { type Kysely, sql } from 'kysely';

/**
 * Formula fields (M1-013; CORE-011; spec 01a section 1.4; ADR-009 "Implementation (M1-013)").
 *
 * - `field.type` takes `formula`. A formula field's `config` holds its expression, stored with
 *   fields by id (`{cf[12]} * 2`, `{due}`) so renames never break it, and its output (number,
 *   currency, percentage, date, duration or text) with the number display settings.
 * - Its values are computed by the application and kept like any other custom value: in
 *   `ticket.fields` and in the side table of its output (ADR-008), so formulas are searched and
 *   sorted as numbers, dates or text. Nothing is copied here: no release has formula fields
 *   before this one.
 */
const TYPES = [
  'text',
  'paragraph',
  'number',
  'date',
  'datetime',
  'select',
  'cascading-select',
  'user',
  'group',
  'labels',
  'url',
  'read-only-text',
  'release',
  'area',
  'formula',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  const list = sql.join(TYPES.map((v) => sql.lit(v)));
  await sql`ALTER TABLE field DROP CONSTRAINT field_type_check`.execute(db);
  await sql`ALTER TABLE field ADD CONSTRAINT field_type_check CHECK (type IN (${list}))`.execute(
    db,
  );
}
