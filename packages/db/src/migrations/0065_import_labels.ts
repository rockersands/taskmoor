import { type Kysely, sql } from 'kysely';

/**
 * Labels of imported records (M1-088; IMP-010; ADR-081): how people know a configuration object
 * in the source (a name, a key, an address), so the fidelity report's mapping can say which
 * status, priority or group an import created, linked by name, or left out and why. Null for
 * content (tickets, comments, history), which the report counts but does not list.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE import_record ADD COLUMN label text`.execute(db);
}
