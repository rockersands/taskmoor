import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';

/**
 * Which workspace a request belongs to (ADR-006). Every install starts with one workspace,
 * "default", and serves only that one today; routing by host name comes when an install hosts
 * several. Every query filters by the id this returns.
 */
const cache = new WeakMap<Kysely<Database>, Promise<number>>();

export function defaultWorkspaceId(db: Kysely<Database>): Promise<number> {
  let id = cache.get(db);
  if (!id) {
    id = db
      .selectFrom('workspace')
      .select('id')
      .where('key', '=', 'default')
      .executeTakeFirstOrThrow()
      .then((row) => row.id);
    // A failed lookup (database not migrated yet) must not stick.
    id.catch(() => cache.delete(db));
    cache.set(db, id);
  }
  return id;
}
