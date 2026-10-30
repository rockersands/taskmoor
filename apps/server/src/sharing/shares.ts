import type { Database, SavedSearchShareScope } from '@taskmoor/db';
import type { FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { shareReaches } from '../search/saved';

/**
 * Shares of saved searches (M1-063; ADR-053) and dashboards (M1-064; ADR-060): one row per
 * scope (a person, a group, a track with an optional role, every signed-in person, the public),
 * no row for private. Both kinds keep them in a table of the same shape; this module reads,
 * checks and writes either.
 */
type Db = Kysely<Database> | Transaction<Database>;

const MAX_INT = 2_147_483_647;
const idNum = z.number().int().positive().max(MAX_INT);

export const shareInput = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('user'), userId: idNum }).strict(),
  z.object({ scope: z.literal('group'), groupId: idNum }).strict(),
  z
    .object({ scope: z.literal('track'), trackId: idNum, roleId: idNum.nullable().optional() })
    .strict(),
  z.object({ scope: z.literal('any_user') }).strict(),
  z.object({ scope: z.literal('public') }).strict(),
]);
export type ShareInput = z.infer<typeof shareInput>;

/** A share as the API shows and compares it. */
export interface ShareView {
  scope: SavedSearchShareScope;
  userId?: number;
  userName?: string;
  groupId?: number;
  groupName?: string;
  trackId?: number;
  trackKey?: string;
  roleId?: number | null;
  roleName?: string | null;
}

export const shareKey = (s: ShareInput | ShareView) =>
  s.scope === 'user'
    ? `user:${s.userId}`
    : s.scope === 'group'
      ? `group:${s.groupId}`
      : s.scope === 'track'
        ? `track:${s.trackId}:${s.roleId ?? '*'}`
        : s.scope;

/** Where a kind keeps its shares. */
export interface ShareTable {
  table: 'saved_search_share' | 'dashboard_share';
  /** The column naming what is shared. */
  owner: 'saved_search_id' | 'dashboard_id';
}

export const SAVED_SEARCH_SHARES: ShareTable = {
  table: 'saved_search_share',
  owner: 'saved_search_id',
};
export const DASHBOARD_SHARES: ShareTable = { table: 'dashboard_share', owner: 'dashboard_id' };

/** Whether a share of the thing with id `idSql` reaches the person (null: anonymous). */
export function sharedWith(
  t: ShareTable,
  idSql: RawBuilder<number>,
  ws: number,
  userId: number | null,
): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${sql.table(t.table)} sh
     WHERE sh.${sql.ref(t.owner)} = ${idSql} AND ${shareReaches(ws, userId)})`;
}

export async function sharesOf(
  db: Db,
  t: ShareTable,
  ids: readonly number[],
): Promise<Map<number, ShareView[]>> {
  const out = new Map<number, ShareView[]>();
  if (ids.length === 0) return out;
  const { rows } = await sql<{
    owner: number;
    scope: SavedSearchShareScope;
    user_id: number | null;
    user_name: string | null;
    group_id: number | null;
    group_name: string | null;
    track_id: number | null;
    track_key: string | null;
    role_id: number | null;
    role_name: string | null;
  }>`
    SELECT sh.${sql.ref(t.owner)} AS owner, sh.scope, sh.user_id, u.name AS user_name,
           sh.group_id, g.name AS group_name, sh.track_id, tr.key AS track_key, sh.role_id,
           r.name AS role_name
      FROM ${sql.table(t.table)} sh
      LEFT JOIN app_user u ON u.id = sh.user_id
      LEFT JOIN user_group g ON g.id = sh.group_id
      LEFT JOIN track tr ON tr.id = sh.track_id
      LEFT JOIN role r ON r.id = sh.role_id
     WHERE sh.${sql.ref(t.owner)} = ANY(${[...ids]}::int[])
     ORDER BY sh.id`.execute(db);
  for (const s of rows) {
    const view: ShareView =
      s.scope === 'user'
        ? { scope: s.scope, userId: s.user_id as number, userName: s.user_name ?? '' }
        : s.scope === 'group'
          ? { scope: s.scope, groupId: s.group_id as number, groupName: s.group_name ?? '' }
          : s.scope === 'track'
            ? {
                scope: s.scope,
                trackId: s.track_id as number,
                trackKey: s.track_key ?? '',
                roleId: s.role_id,
                roleName: s.role_name,
              }
            : { scope: s.scope };
    const list = out.get(s.owner) ?? [];
    list.push(view);
    out.set(s.owner, list);
  }
  return out;
}

/**
 * Checks shares: what they name exists, and the person may share at all ("Share dashboards and
 * saved searches"). A track share needs the sharer to browse the track, so sharing never
 * confirms that a hidden track exists.
 */
export async function checkShares(
  db: Db,
  request: FastifyRequest,
  shares: readonly ShareInput[],
): Promise<{ fields: Record<string, string>; forbidden: boolean }> {
  const fields: Record<string, string> = {};
  if (shares.length === 0) return { fields, forbidden: false };
  if (!(await request.authz.hasGlobal('share_saved_searches'))) {
    return { fields, forbidden: true };
  }
  const ws = request.workspaceId;
  for (const [i, s] of shares.entries()) {
    if (s.scope === 'user') {
      const u = await db
        .selectFrom('app_user')
        .select('id')
        .where('id', '=', s.userId)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      if (!u) fields[`shares.${i}.userId`] = 'not_found';
    } else if (s.scope === 'group') {
      const g = await db
        .selectFrom('user_group')
        .select('id')
        .where('id', '=', s.groupId)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      if (!g) fields[`shares.${i}.groupId`] = 'not_found';
    } else if (s.scope === 'track') {
      const held = await request.authz.track(s.trackId);
      if (!held.has('browse_track')) fields[`shares.${i}.trackId`] = 'not_found';
      if (s.roleId !== undefined && s.roleId !== null) {
        const r = await db
          .selectFrom('role')
          .select('id')
          .where('id', '=', s.roleId)
          .where('workspace_id', '=', ws)
          .executeTakeFirst();
        if (!r) fields[`shares.${i}.roleId`] = 'not_found';
      }
    }
  }
  const keys = shares.map(shareKey);
  if (new Set(keys).size !== keys.length) fields.shares = 'duplicate';
  return { fields, forbidden: false };
}

/** Replaces the shares of one thing. */
export async function writeShares(
  trx: Db,
  t: ShareTable,
  ws: number,
  id: number,
  shares: readonly ShareInput[],
): Promise<void> {
  await sql`DELETE FROM ${sql.table(t.table)} WHERE ${sql.ref(t.owner)} = ${id}::int`.execute(trx);
  for (const s of shares) {
    await sql`
      INSERT INTO ${sql.table(t.table)}
        (workspace_id, ${sql.ref(t.owner)}, scope, user_id, group_id, track_id, role_id)
      VALUES (${ws}::int, ${id}::int, ${s.scope},
              ${s.scope === 'user' ? s.userId : null}::int,
              ${s.scope === 'group' ? s.groupId : null}::int,
              ${s.scope === 'track' ? s.trackId : null}::int,
              ${s.scope === 'track' ? (s.roleId ?? null) : null}::int)`.execute(trx);
  }
}
