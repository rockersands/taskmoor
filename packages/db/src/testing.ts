import { type TemplateSpec, useTestDatabase } from '@tracksmith/testkit/pg';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';
import { createDb } from './client';
import { migrateToLatest, migrationsFingerprint } from './migrate';
import type { Database } from './schema';

/** A database with every migration applied. Rebuilt automatically when migrations change. */
export const migratedTemplate: TemplateSpec = {
  name: `tpl_${migrationsFingerprint().slice(0, 16)}`,
  build: async (url) => {
    const db = createDb({ connectionString: url, maxConnections: 1 });
    try {
      await migrateToLatest(db);
    } finally {
      await db.destroy();
    }
  },
};

export interface MigratedTestDatabase {
  readonly db: Kysely<Database>;
  readonly url: string;
  readonly name: string;
}

/**
 * Gives the calling test file its own fully migrated database and a Kysely client for it.
 * Values can be read inside tests and hooks, not at module load.
 */
export function useMigratedDatabase(): MigratedTestDatabase {
  const database = useTestDatabase({ template: migratedTemplate });
  let db: Kysely<Database> | undefined;

  beforeAll(() => {
    db = createDb({ connectionString: database.url, maxConnections: 5 });
  });
  // Registered after useTestDatabase's hook, so it runs first: the pool closes before the drop.
  afterAll(async () => {
    await db?.destroy();
  });

  return {
    get db() {
      if (!db)
        throw new Error('useMigratedDatabase().db is only available inside tests and hooks.');
      return db;
    },
    get url() {
      return database.url;
    },
    get name() {
      return database.name;
    },
  };
}
