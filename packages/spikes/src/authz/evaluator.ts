import type pg from 'pg';
import type { AuthzModel } from './model';

/**
 * The in-process candidate (ADR-012): permission data in ordinary tables, one SQL statement per
 * (user, space) that returns every permission the user holds there, and a per-process cache of
 * those sets. The search pre-filter asks the same tables for every space where the user holds
 * a permission.
 */
export const AUTHZ_SQL = `
DROP SCHEMA IF EXISTS authz CASCADE;
CREATE SCHEMA authz;
CREATE TABLE authz.membership (user_id int NOT NULL, group_id int NOT NULL, PRIMARY KEY (user_id, group_id));
CREATE INDEX ON authz.membership (group_id);
CREATE TABLE authz.space (id int PRIMARY KEY, policy_id int NOT NULL, lead_id int NOT NULL);
CREATE INDEX ON authz.space (policy_id);
CREATE INDEX ON authz.space (lead_id);
CREATE TABLE authz.grant (
  policy_id int NOT NULL, permission text NOT NULL, grantee_kind text NOT NULL, grantee_id int NOT NULL,
  PRIMARY KEY (policy_id, permission, grantee_kind, grantee_id));
CREATE INDEX ON authz.grant (permission, grantee_kind, grantee_id);
CREATE TABLE authz.role_actor (
  space_id int NOT NULL, role_id int NOT NULL, actor_kind text NOT NULL, actor_id int NOT NULL,
  PRIMARY KEY (space_id, role_id, actor_kind, actor_id));
CREATE INDEX ON authz.role_actor (actor_kind, actor_id);`;

const CHUNK = 20_000;

export async function loadAuthz(pool: pg.Pool, model: AuthzModel): Promise<void> {
  await pool.query(AUTHZ_SQL);
  const columns = <T>(rows: readonly T[], pick: (row: T) => unknown[]): unknown[][] => {
    const first = rows[0];
    if (!first) return [];
    const width = pick(first).length;
    const out: unknown[][] = Array.from({ length: width }, () => []);
    for (const row of rows) {
      const values = pick(row);
      for (let i = 0; i < width; i++) out[i]?.push(values[i]);
    }
    return out;
  };
  const insert = async <T>(sql: string, rows: readonly T[], pick: (row: T) => unknown[]) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await pool.query(sql, columns(rows.slice(i, i + CHUNK), pick));
    }
  };
  await insert(
    'INSERT INTO authz.membership SELECT * FROM unnest($1::int[], $2::int[])',
    model.memberships,
    (m) => [m[0], m[1]],
  );
  await insert(
    'INSERT INTO authz.space SELECT * FROM unnest($1::int[], $2::int[], $3::int[])',
    model.spaces,
    (s) => [s.id, s.policyId, s.leadId],
  );
  await insert(
    'INSERT INTO authz.grant SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::int[])',
    model.grants,
    (g) => [g.policyId, g.permission, g.kind, g.id],
  );
  await insert(
    'INSERT INTO authz.role_actor SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::int[])',
    model.roleActors,
    (a) => [a.spaceId, a.roleId, a.kind, a.id],
  );
  await pool.query('ANALYZE authz.membership, authz.space, authz.grant, authz.role_actor');
}

const GRANTEE_MATCH = `(
  gr.grantee_kind IN ('anyone', 'authenticated')
  OR (gr.grantee_kind = 'user' AND gr.grantee_id = $1)
  OR (gr.grantee_kind = 'group' AND gr.grantee_id IN (SELECT group_id FROM g))
  OR (gr.grantee_kind = 'lead' AND s.lead_id = $1)`;

export const PERMISSIONS_SQL = `
WITH g AS (SELECT group_id FROM authz.membership WHERE user_id = $1),
     r AS (SELECT role_id FROM authz.role_actor ra WHERE ra.space_id = $2
             AND ((ra.actor_kind = 'user' AND ra.actor_id = $1)
                  OR (ra.actor_kind = 'group' AND ra.actor_id IN (SELECT group_id FROM g))))
SELECT DISTINCT gr.permission
FROM authz.space s JOIN authz.grant gr ON gr.policy_id = s.policy_id
WHERE s.id = $2 AND ${GRANTEE_MATCH}
  OR (gr.grantee_kind = 'role' AND gr.grantee_id IN (SELECT role_id FROM r)))`;

/**
 * Three set-based legs, each driven from an index: spaces whose policy grants the permission
 * to the user, a group of theirs, anyone or any signed-in user; spaces where the user acts in
 * a role the policy grants; and spaces the user leads under a policy that grants the lead.
 */
export const ALLOWED_SPACES_SQL = `
WITH g AS (SELECT group_id FROM authz.membership WHERE user_id = $1)
SELECT DISTINCT id FROM (
  SELECT s.id
    FROM authz.grant gr JOIN authz.space s ON s.policy_id = gr.policy_id
   WHERE gr.permission = $2
     AND (gr.grantee_kind IN ('anyone', 'authenticated')
          OR (gr.grantee_kind = 'user' AND gr.grantee_id = $1)
          OR (gr.grantee_kind = 'group' AND gr.grantee_id IN (SELECT group_id FROM g)))
  UNION ALL
  SELECT s.id
    FROM authz.role_actor ra
    JOIN authz.space s ON s.id = ra.space_id
    JOIN authz.grant gr ON gr.policy_id = s.policy_id AND gr.permission = $2
         AND gr.grantee_kind = 'role' AND gr.grantee_id = ra.role_id
   WHERE (ra.actor_kind = 'user' AND ra.actor_id = $1)
      OR (ra.actor_kind = 'group' AND ra.actor_id IN (SELECT group_id FROM g))
  UNION ALL
  SELECT s.id
    FROM authz.space s
    JOIN authz.grant gr ON gr.policy_id = s.policy_id AND gr.permission = $2
         AND gr.grantee_kind = 'lead'
   WHERE s.lead_id = $1
) allowed
ORDER BY id`;

/** Every permission `userId` holds in `spaceId`: one round trip. */
export async function permissionsFor(
  client: pg.ClientBase,
  userId: number,
  spaceId: number,
): Promise<Set<string>> {
  const { rows } = await client.query<{ permission: string }>(PERMISSIONS_SQL, [userId, spaceId]);
  return new Set(rows.map((r) => r.permission));
}

/** Spaces where `userId` holds `permission`: the search pre-filter (QRY-008). */
export async function allowedSpaces(
  client: pg.ClientBase,
  userId: number,
  permission: string,
): Promise<number[]> {
  const { rows } = await client.query<{ id: number }>(ALLOWED_SPACES_SQL, [userId, permission]);
  return rows.map((r) => r.id);
}

/**
 * Per-process cache of permission sets keyed by (user, space). The product invalidates entries
 * from the change log (any change to memberships, policies or role actors bumps the affected
 * spaces); the spike measures hit and miss latency.
 */
export class PermissionCache {
  private readonly entries = new Map<string, Set<string>>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly client: pg.ClientBase,
    private readonly maxEntries = 100_000,
  ) {}

  async check(userId: number, spaceId: number, permission: string): Promise<boolean> {
    const key = `${userId}:${spaceId}`;
    let set = this.entries.get(key);
    if (set) {
      this.hits++;
      // Re-insert so the Map's order is least recently used first.
      this.entries.delete(key);
      this.entries.set(key, set);
    } else {
      this.misses++;
      set = await permissionsFor(this.client, userId, spaceId);
      this.entries.set(key, set);
      if (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    return set.has(permission);
  }

  invalidate(userId: number, spaceId: number): void {
    this.entries.delete(`${userId}:${spaceId}`);
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
