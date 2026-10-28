import { type Kysely, sql } from 'kysely';

/**
 * Per-field edit permissions (M1-029): a field rule may name the roles and groups that alone
 * may set the field, as a list of `{"roleId": n}` and `{"groupId": n}`. Null, as before, lets
 * everyone with the track permission set it. Per-status locks (WF-007) need no column: they
 * live in the workflow definition (`statusPermissions`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE field_rule
      ADD COLUMN editable_by jsonb
        CHECK (editable_by IS NULL OR jsonb_typeof(editable_by) = 'array')`.execute(db);
}
