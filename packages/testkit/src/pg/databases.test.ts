import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  ensureTemplate,
  testPgAdminUrl,
  useTestDatabase,
  withAdminClient,
} from '.';

async function query<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

describe('useTestDatabase', () => {
  const db = useTestDatabase();

  it('gives the file its own empty database on Postgres 16 or newer', async () => {
    const [row] = await query<{ version: number; db: string }>(
      db.url,
      `SELECT current_setting('server_version_num')::int AS version, current_database() AS db`,
    );
    expect(row?.version).toBeGreaterThanOrEqual(160000);
    expect(row?.db).toBe(db.name);
    expect(db.name).toMatch(/^t_\d+_[0-9a-f]{8}$/);
  });
});

describe('templates', () => {
  it('builds a template once and clones it into isolated databases', async () => {
    const adminUrl = testPgAdminUrl();
    let builds = 0;
    const template = {
      name: `tpl_testkit_${process.pid}_${Date.now()}`,
      build: async (url: string) => {
        builds++;
        await query(
          url,
          `CREATE TABLE note (id int PRIMARY KEY, body text); INSERT INTO note VALUES (1, 'seed')`,
        );
      },
    };

    await Promise.all([ensureTemplate(adminUrl, template), ensureTemplate(adminUrl, template)]);
    expect(builds).toBe(1);

    const [a, b] = await Promise.all([
      createDatabase(adminUrl, { template: template.name }),
      createDatabase(adminUrl, { template: template.name }),
    ]);
    try {
      await query(a.url, `INSERT INTO note VALUES (2, 'only in a')`);
      expect(await query(a.url, 'SELECT id FROM note ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }]);
      expect(await query(b.url, 'SELECT id FROM note ORDER BY id')).toEqual([{ id: 1 }]);
    } finally {
      await Promise.all([a.drop(), b.drop()]);
      await withAdminClient(adminUrl, async (client) => {
        const ident = client.escapeIdentifier(template.name);
        await client.query(`ALTER DATABASE ${ident} WITH IS_TEMPLATE false`);
        await client.query(`DROP DATABASE ${ident}`);
      });
    }
  });

  it('drops a template whose build fails, so the next run starts clean', async () => {
    const adminUrl = testPgAdminUrl();
    const name = `tpl_broken_${process.pid}_${Date.now()}`;
    await expect(
      ensureTemplate(adminUrl, {
        name,
        build: async () => {
          throw new Error('migration failed');
        },
      }),
    ).rejects.toThrow('migration failed');

    const rows = await withAdminClient(adminUrl, (client) =>
      client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]),
    );
    expect(rows.rowCount).toBe(0);
  });
});
