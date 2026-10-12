import type { Migration } from 'kysely';
import * as m0001 from './0001_foundation';

/**
 * Every migration, in order. Migrations are forward-only: never edit or remove one that has
 * shipped; add a new one instead (expand, migrate data, then contract in a later release).
 * A test fails if a file in this folder is missing from the list.
 */
export const migrations: Record<string, Migration> = {
  '0001_foundation': m0001,
};
