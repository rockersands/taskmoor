import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { useMigratedDatabase } from './testing';

/**
 * The authorization epoch (ADR-012) moves on every change to groups, memberships and nesting;
 * since migration 0021 once per statement on those tables, so bulk writes (a directory sync,
 * M1-082) stay linear.
 */
describe('authorization epoch on group changes', () => {
  const database = useMigratedDatabase();

  const epoch = async () =>
    Number(
      (
        await database.db
          .selectFrom('authz_epoch')
          .select('epoch')
          .where('workspace_id', '=', 1)
          .executeTakeFirstOrThrow()
      ).epoch,
    );

  it('[IAM-012] every insert, update and delete of groups, members and nesting moves the epoch', async () => {
    const db = database.db;
    const user = await db
      .insertInto('app_user')
      .values({ workspace_id: 1, email: 'epoch@example.com', name: 'Epoch', password_hash: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    const steps: (() => Promise<unknown>)[] = [
      () => db.insertInto('user_group').values({ workspace_id: 1, name: 'Epoch parent' }).execute(),
      () => db.insertInto('user_group').values({ workspace_id: 1, name: 'Epoch child' }).execute(),
      () =>
        db
          .updateTable('user_group')
          .set({ description: 'x' })
          .where('name', '=', 'Epoch child')
          .execute(),
      () =>
        sql`INSERT INTO group_member (workspace_id, group_id, user_id)
            SELECT 1, id, ${user.id} FROM user_group WHERE name = 'Epoch child'`.execute(db),
      () =>
        sql`INSERT INTO group_nesting (workspace_id, parent_id, child_id)
            SELECT 1, p.id, c.id FROM user_group p, user_group c
             WHERE p.name = 'Epoch parent' AND c.name = 'Epoch child'`.execute(db),
      () => db.deleteFrom('group_nesting').where('workspace_id', '=', 1).execute(),
      () => db.deleteFrom('group_member').where('user_id', '=', user.id).execute(),
      () => db.deleteFrom('user_group').where('name', '=', 'Epoch parent').execute(),
    ];
    for (const step of steps) {
      const before = await epoch();
      await step();
      expect(await epoch()).toBeGreaterThan(before);
    }
  });

  it('[IAM-005] a statement that adds thousands of members moves the epoch once', async () => {
    const db = database.db;
    const group = await db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'Epoch bulk' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`INSERT INTO app_user (workspace_id, email, name)
      SELECT 1, 'bulk' || i || '@example.com', 'Bulk ' || i FROM generate_series(1, 5000) i`.execute(
      db,
    );
    const before = await epoch();
    await sql`INSERT INTO group_member (workspace_id, group_id, user_id)
      SELECT 1, ${group.id}, id FROM app_user WHERE email LIKE 'bulk%'`.execute(db);
    expect(await epoch()).toBe(before + 1);
    // A statement that changes nothing moves nothing.
    await db.deleteFrom('group_member').where('group_id', '=', -1).execute();
    expect(await epoch()).toBe(before + 1);
  });
});
