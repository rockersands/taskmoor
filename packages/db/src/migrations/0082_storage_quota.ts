import { type Kysely, sql } from 'kysely';

/**
 * Storage quotas for attachments (M1-118; CORE-021; ASVS 12.1.3; ADR-110): a workspace total and
 * a limit per person, in bytes, beside the maximum file size. Null is no quota, the default
 * (CORE-021: storage is not capped unless an administrator asks). The index lets a person's
 * usage, and the workspace's, be summed from the index alone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE attachment_setting
    ADD COLUMN workspace_quota bigint CHECK (workspace_quota > 0),
    ADD COLUMN person_quota bigint CHECK (person_quota > 0)`.execute(db);
  await sql`CREATE INDEX attachment_author_size_idx ON attachment (workspace_id, author_id)
    INCLUDE (size)`.execute(db);
}
