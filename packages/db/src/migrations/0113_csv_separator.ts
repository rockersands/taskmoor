import { type Kysely, sql } from 'kysely';

/**
 * How a person's spreadsheet files are written (T-263; IAM-008, NFR-006; ADR-122 stage 8).
 *
 * - `user_preference.csv_separator`: `comma` (cells between commas, numbers as 1.5) or
 *   `semicolon` (semicolons, numbers as 1,5) for every CSV file the web app downloads for them.
 *   Null, the default, is automatic: the web app picks the style from the decimal mark of their
 *   "Language and region", else of the browser's language.
 *
 * It sits beside the other personal settings (CORE-019), so a person's erasure deletes it with
 * the row and their data download lists it. No rows are written: everyone starts automatic.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE user_preference
      ADD COLUMN csv_separator text CHECK (csv_separator IN ('comma', 'semicolon'))`.execute(db);
}
