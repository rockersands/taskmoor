import { type Kysely, sql } from 'kysely';

/**
 * Each person's appearance (M1-122, ADR-036): `system` follows the device's light or dark
 * setting, anything else names a skin. Skins are not listed here: the API checks the name
 * against the skins the frontend ships, so adding a skin needs no migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE app_user ADD COLUMN appearance text NOT NULL DEFAULT 'system'`.execute(db);
}
