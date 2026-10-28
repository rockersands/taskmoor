import { stableJson } from '@taskmoor/testkit';
import { describe, expect, it } from 'vitest';
import { EXPECTED_SCHEMA } from './expected-schema';
import { compareSchema, snapshotSchema } from './snapshot';
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

describe('schema comparison', () => {
  const database = useMigratedDatabase();

  it('[OPS-006] reports what is missing or changed and what is extra', () => {
    const expected = {
      a: { columns: ['id integer not null', 'name text'], indexes: ['CREATE INDEX a_idx'] },
      b: { columns: ['id integer'], indexes: [] },
    };
    expect(compareSchema(expected, expected)).toEqual({ missing: [], extra: [] });
    const actual = {
      a: {
        columns: ['id integer not null', 'name text not null'],
        indexes: ['CREATE INDEX a_idx'],
      },
      c: { columns: ['id integer'], indexes: [] },
    };
    expect(compareSchema(actual, expected)).toEqual({
      missing: ['a: name text', 'table b'],
      extra: ['a: name text not null', 'table c'],
    });
  });

  it('[OPS-006] ships the reviewed schema for the upgrade to verify against', async () => {
    expect(compareSchema(await snapshotSchema(database.db), EXPECTED_SCHEMA)).toEqual({
      missing: [],
      extra: [],
    });
  });
});
