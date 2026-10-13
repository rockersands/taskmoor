import type { Migration } from 'kysely';
import * as m0001 from './0001_foundation';
import * as m0002 from './0002_users_and_sessions';
import * as m0003 from './0003_identity';
import * as m0004 from './0004_authorization';
import * as m0005 from './0005_events';

/**
 * Every migration, in order. Migrations are forward-only: never edit or remove one that has
 * shipped; add a new one instead (expand, migrate data, then contract in a later release).
 * A test fails if a file in this folder is missing from the list.
 */
export const migrations: Record<string, Migration> = {
  '0001_foundation': m0001,
  '0002_users_and_sessions': m0002,
  '0003_identity': m0003,
  '0004_authorization': m0004,
  '0005_events': m0005,
};
