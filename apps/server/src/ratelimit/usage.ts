import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';

/**
 * API usage per client (M1-066; API-010 (2)): each API process counts requests, errors (status
 * 400 and above) and refusals per client and minute in memory, and adds them to `api_usage`
 * every few seconds, so a request never waits for a write. The usage dashboard reads the sums.
 */
export type ClientKind = 'token' | 'user' | 'address';

export interface ApiClient {
  kind: ClientKind;
  /** A token or user id as text, or the address. */
  id: string;
}

interface Counts {
  workspaceId: number;
  kind: ClientKind;
  client: string;
  minute: Date;
  requests: number;
  errors: number;
  throttled: number;
}

/** Usage is kept this long: the dashboard shows the last hour and the last day. */
export const USAGE_RETENTION_DAYS = 8;

const MINUTE_MS = 60_000;

export class UsageRecorder {
  private pending = new Map<string, Counts>();
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  record(workspaceId: number, client: ApiClient, status: number, throttled: boolean): void {
    const minute = new Date(Math.floor(this.now() / MINUTE_MS) * MINUTE_MS);
    const key = `${workspaceId}|${client.kind}|${client.id}|${minute.getTime()}`;
    let counts = this.pending.get(key);
    if (!counts) {
      counts = {
        workspaceId,
        kind: client.kind,
        client: client.id,
        minute,
        requests: 0,
        errors: 0,
        throttled: 0,
      };
      this.pending.set(key, counts);
    }
    counts.requests += 1;
    if (status >= 400) counts.errors += 1;
    if (throttled) counts.throttled += 1;
  }

  /** Adds what was counted since the last flush; one at a time. */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
    if (this.pending.size === 0) return;
    const rows = [...this.pending.values()];
    this.pending = new Map();
    this.flushing = (async () => {
      try {
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          await this.db
            .insertInto('api_usage')
            .values(
              chunk.map((r) => ({
                workspace_id: r.workspaceId,
                client_kind: r.kind,
                client: r.client,
                minute: r.minute,
                requests: r.requests,
                errors: r.errors,
                throttled: r.throttled,
              })),
            )
            .onConflict((oc) =>
              oc.columns(['workspace_id', 'minute', 'client_kind', 'client']).doUpdateSet({
                requests: sql`api_usage.requests + excluded.requests`,
                errors: sql`api_usage.errors + excluded.errors`,
                throttled: sql`api_usage.throttled + excluded.throttled`,
              }),
            )
            .execute();
        }
      } catch {
        // Usage is a convenience: a failed write loses those counts and nothing else.
      } finally {
        this.flushing = null;
      }
    })();
    await this.flushing;
  }
}

/** Removes usage older than the dashboard reads (the housekeeping loop calls it). */
export async function trimApiUsage(db: Kysely<Database>, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - USAGE_RETENTION_DAYS * 24 * 60 * MINUTE_MS);
  const result = await db.deleteFrom('api_usage').where('minute', '<', before).executeTakeFirst();
  return Number(result.numDeletedRows);
}

export interface UsageRow {
  client: {
    kind: ClientKind;
    id: string;
    name: string;
    owner: { id: number; name: string } | null;
  };
  requests: number;
  errors: number;
  throttled: number;
}

/**
 * The 20 clients with the most requests over the last hour or day, with names: a token by its
 * name and owner, a person by name, an address as itself.
 */
export async function topClients(
  db: Kysely<Database>,
  workspaceId: number,
  window: 'hour' | 'day',
  now = new Date(),
  limit = 20,
): Promise<UsageRow[]> {
  const since = new Date(now.getTime() - (window === 'hour' ? 60 : 24 * 60) * MINUTE_MS);
  const rows = await db
    .selectFrom('api_usage')
    .select([
      'client_kind',
      'client',
      sql<string>`sum(requests)`.as('requests'),
      sql<string>`sum(errors)`.as('errors'),
      sql<string>`sum(throttled)`.as('throttled'),
    ])
    .where('workspace_id', '=', workspaceId)
    .where('minute', '>=', since)
    .groupBy(['client_kind', 'client'])
    .orderBy(sql`sum(requests)`, 'desc')
    .orderBy('client_kind')
    .orderBy('client')
    .limit(limit)
    .execute();
  const ids = (kind: ClientKind) =>
    rows.filter((r) => r.client_kind === kind).map((r) => Number(r.client));
  const tokenIds = ids('token');
  const tokens =
    tokenIds.length === 0
      ? []
      : await db
          .selectFrom('api_token as t')
          .innerJoin('app_user as u', 'u.id', 't.user_id')
          .select(['t.id', 't.name', 'u.id as owner_id', 'u.name as owner_name'])
          .where('t.id', 'in', tokenIds)
          .execute();
  const userIds = ids('user');
  const users =
    userIds.length === 0
      ? []
      : await db.selectFrom('app_user').select(['id', 'name']).where('id', 'in', userIds).execute();
  const tokenOf = new Map(tokens.map((t) => [t.id, t]));
  const userOf = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => {
    const counts = {
      requests: Number(r.requests),
      errors: Number(r.errors),
      throttled: Number(r.throttled),
    };
    if (r.client_kind === 'token') {
      const t = tokenOf.get(Number(r.client));
      return {
        client: {
          kind: 'token' as const,
          id: r.client,
          name: t?.name ?? '',
          owner: t ? { id: t.owner_id, name: t.owner_name } : null,
        },
        ...counts,
      };
    }
    if (r.client_kind === 'user') {
      return {
        client: {
          kind: 'user' as const,
          id: r.client,
          name: userOf.get(Number(r.client))?.name ?? '',
          owner: null,
        },
        ...counts,
      };
    }
    return {
      client: { kind: 'address' as const, id: r.client, name: r.client, owner: null },
      ...counts,
    };
  });
}
