import type { TestProject } from 'vitest/node';
import { cleanupLeftovers } from './databases';
import { ADMIN_URL_ENV } from './env';
import { startTestPostgres } from './server';

/**
 * Vitest global setup: one Postgres server for the whole run, shared by every project.
 * Set TASKMOOR_TEST_PG=off to skip it when running only tests that never touch a database.
 */
export default async function setup(
  project: TestProject,
): Promise<(() => Promise<void>) | undefined> {
  if (process.env.TASKMOOR_TEST_PG === 'off') return undefined;

  const server = await startTestPostgres();
  // External servers can be shared by parallel CI jobs, so only clean up our own cluster.
  if (server.kind === 'embedded') await cleanupLeftovers(server.adminUrl);

  process.env[ADMIN_URL_ENV] = server.adminUrl;
  project.provide('taskmoorPgAdminUrl', server.adminUrl);

  return async () => {
    await server.stop();
  };
}
