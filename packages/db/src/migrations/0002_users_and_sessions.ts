import { type Kysely, sql } from 'kysely';

/** The first admin and sign-in sessions (M0-027). Identity grows in M1 (ADR-019). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('app_user')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('email', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('password_hash', 'text')
    .addColumn('is_site_admin', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('deactivated_at', 'timestamptz')
    .execute();

  await db.schema
    .createTable('session')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'integer', (col) =>
      col.notNull().references('app_user.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('last_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('session_user_id_idx').on('session').column('user_id').execute();
  await db.schema
    .createIndex('session_expires_at_idx')
    .on('session')
    .column('expires_at')
    .execute();
}
