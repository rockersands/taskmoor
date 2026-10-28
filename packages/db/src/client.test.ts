import { createDatabase, testPgAdminUrl } from '@taskmoor/testkit/pg';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDb } from './client';

describe('database client', () => {
  it('survives an idle connection the server ends, and reconnects for the next statement', async () => {
    const database = await createDatabase(testPgAdminUrl());
    const failures: string[] = [];
    const db = createDb({
      connectionString: database.url,
      maxConnections: 2,
      applicationName: 'client-test',
      onIdleError: (error) => failures.push(error.message),
    });
    try {
      await sql`SELECT 1`.execute(db);
      // End the pooled connection from another session, as a restart or an administrator would.
      const admin = createDb({
        connectionString: database.url,
        maxConnections: 1,
        applicationName: 'client-test-admin',
      });
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE application_name = 'client-test' AND pid <> pg_backend_pid()`.execute(admin);
      await admin.destroy();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(failures.length).toBeGreaterThan(0);
      const { rows } = await sql<{ n: number }>`SELECT 2 AS n`.execute(db);
      expect(rows[0]?.n).toBe(2);
    } finally {
      await db.destroy();
      await database.drop();
    }
  });
});
