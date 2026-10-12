import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * A database that new test databases are cloned from. `build` runs once per distinct `name`
 * (for example after migrations change), then every test file gets a cheap copy.
 */
export interface TemplateSpec {
  /** Database name; include a content hash so a changed build gets a fresh template. */
  name: string;
  /** Fills the template. It must close every connection it opens before returning. */
  build: (url: string) => Promise<void>;
}

export interface CreatedDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

const OBJECT_IN_USE = '55006';

/** Returns a connection URL for another database on the same server. */
export function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Runs `fn` with a short-lived client on the maintenance database. */
export async function withAdminClient<T>(
  adminUrl: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Makes sure the template exists and is complete. Safe to call from many test files at once:
 * an advisory lock lets one caller build it while the others wait.
 */
export async function ensureTemplate(adminUrl: string, spec: TemplateSpec): Promise<void> {
  await withAdminClient(adminUrl, async (client) => {
    const ident = client.escapeIdentifier(spec.name);
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [spec.name]);
    try {
      const { rows } = await client.query<{ datistemplate: boolean }>(
        'SELECT datistemplate FROM pg_database WHERE datname = $1',
        [spec.name],
      );
      if (rows[0]?.datistemplate) return;
      // A half-built template from an interrupted run is rebuilt from scratch.
      if (rows.length > 0) await client.query(`DROP DATABASE ${ident} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${ident}`);
      try {
        await spec.build(databaseUrl(adminUrl, spec.name));
      } catch (error) {
        await client.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
        throw error;
      }
      await client.query(`ALTER DATABASE ${ident} WITH IS_TEMPLATE true`);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [spec.name]);
    }
  });
}

/** Creates an empty database, or a copy of `template`, with a unique name. */
export async function createDatabase(
  adminUrl: string,
  options: { template?: string } = {},
): Promise<CreatedDatabase> {
  const name = `t_${process.pid}_${randomBytes(4).toString('hex')}`;
  await withAdminClient(adminUrl, async (client) => {
    const ident = client.escapeIdentifier(name);
    const from = options.template ? ` TEMPLATE ${client.escapeIdentifier(options.template)}` : '';
    for (let attempt = 0; ; attempt++) {
      try {
        await client.query(`CREATE DATABASE ${ident}${from}`);
        return;
      } catch (error) {
        // Cloning fails while anyone else is connected to the template; that is brief, so retry.
        if ((error as { code?: string }).code !== OBJECT_IN_USE || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  });
  return {
    name,
    url: databaseUrl(adminUrl, name),
    drop: () =>
      withAdminClient(adminUrl, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`);
      }),
  };
}

/**
 * Removes databases left behind by interrupted runs and keeps only the newest templates.
 * Called once at the start of a run, before any test file creates a database.
 */
export async function cleanupLeftovers(adminUrl: string, keepTemplates = 3): Promise<void> {
  await withAdminClient(adminUrl, async (client) => {
    const { rows } = await client.query<{ datname: string; datistemplate: boolean }>(
      `SELECT datname, datistemplate FROM pg_database
        WHERE datname LIKE 't\\_%' OR datname LIKE 'tpl\\_%'
        ORDER BY oid DESC`,
    );
    let templatesSeen = 0;
    for (const row of rows) {
      const isTemplate = row.datname.startsWith('tpl_');
      if (isTemplate && row.datistemplate && templatesSeen++ < keepTemplates) continue;
      const ident = client.escapeIdentifier(row.datname);
      if (row.datistemplate) await client.query(`ALTER DATABASE ${ident} WITH IS_TEMPLATE false`);
      await client.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
    }
  });
}
