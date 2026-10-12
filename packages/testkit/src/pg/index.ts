import { afterAll, beforeAll, inject } from 'vitest';
import {
  type CreatedDatabase,
  createDatabase,
  ensureTemplate,
  type TemplateSpec,
} from './databases';
import { ADMIN_URL_ENV } from './env';

export {
  type CreatedDatabase,
  cleanupLeftovers,
  createDatabase,
  databaseUrl,
  ensureTemplate,
  type TemplateSpec,
  withAdminClient,
} from './databases';

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
}

/** URL of the run's maintenance database, provided by the root global setup. */
export function testPgAdminUrl(): string {
  let url: string | undefined;
  try {
    url = inject('taskmoorPgAdminUrl');
  } catch {
    // inject() only works inside a Vitest worker; fall back to the environment.
  }
  url ??= process.env[ADMIN_URL_ENV];
  if (!url) {
    throw new Error(
      'No test Postgres. Run tests through the root Vitest config (pnpm test or pnpm verify), ' +
        'or set TASKMOOR_TEST_DATABASE_URL.',
    );
  }
  return url;
}

/**
 * Gives the calling test file its own database, created before its tests and dropped after.
 * With a template the database starts as a copy of it (for example, fully migrated).
 *
 * The returned values can be read inside tests and hooks, not at module load.
 */
export function useTestDatabase(options: { template?: TemplateSpec } = {}): TestDatabase {
  let created: CreatedDatabase | undefined;

  beforeAll(async () => {
    const adminUrl = testPgAdminUrl();
    const { template } = options;
    if (template) await ensureTemplate(adminUrl, template);
    created = await createDatabase(adminUrl, template ? { template: template.name } : {});
  }, 120_000);

  // Dropping waits for a checkpoint, which is slow while a benchmark saturates the disk.
  afterAll(async () => {
    await created?.drop();
  }, 120_000);

  const current = (): CreatedDatabase => {
    if (!created) {
      throw new Error('useTestDatabase() values are only available inside tests and hooks.');
    }
    return created;
  };

  return {
    get name() {
      return current().name;
    },
    get url() {
      return current().url;
    },
  };
}
