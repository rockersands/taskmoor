import { describe, expect, it } from 'vitest';
import { useMigratedDatabase } from './testing';

describe('instance_setting', () => {
  const database = useMigratedDatabase();

  it('stores JSON values, including arrays, and stamps updated_at', async () => {
    const value = { steps: ['admin', 'smtp'], done: false };
    await database.db
      .insertInto('instance_setting')
      .values({ key: 'setup', value: JSON.stringify(value) })
      .execute();

    const row = await database.db
      .selectFrom('instance_setting')
      .selectAll()
      .where('key', '=', 'setup')
      .executeTakeFirstOrThrow();

    expect(row.value).toEqual(value);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it('starts every test file from a clean copy of the migrated template', async () => {
    const rows = await database.db.selectFrom('instance_setting').select('key').execute();
    // The previous test in this file inserted one row; other files never see it.
    expect(rows.map((r) => r.key)).toEqual(['setup']);
  });
});
