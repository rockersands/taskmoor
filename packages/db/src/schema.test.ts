import { stableJson } from '@taskmoor/testkit';
import { describe, expect, it } from 'vitest';
import { snapshotSchema } from './snapshot';
import { useMigratedDatabase } from './testing';

describe('migrated schema', () => {
  const database = useMigratedDatabase();

  // Any schema change shows up as a diff in __golden__/schema.json, so it gets reviewed.
  // After an intended change, run pnpm verify --update and commit the new file.
  it('matches the reviewed snapshot', async () => {
    await expect(stableJson(await snapshotSchema(database.db))).toMatchFileSnapshot(
      './__golden__/schema.json',
    );
  });
});
