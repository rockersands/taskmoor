import { BlockList, isIP } from 'node:net';
import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';

/**
 * IP allowlists (M1-085; IAM-015; ADR-078). When a workspace's list is on, every request to
 * the API and to the served web app must come from an address in it, unless the person making
 * it belongs to an exempt group. Addresses and ranges are IPv4 or IPv6, single or CIDR, with
 * no cap on how many. The list is read at most every 30 seconds per process (at once after a
 * change through it) and matched in memory with Node's BlockList.
 */
export interface AllowlistEntry {
  id: number;
  range: string;
  note: string;
}

export interface Allowlist {
  enabled: boolean;
  exemptGroupIds: number[];
  entries: AllowlistEntry[];
}

/** A range as typed: an address, or an address with a prefix length, IPv4 or IPv6. */
export function parseRange(
  text: string,
): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [rawAddress = '', prefixText, extra] = text.trim().split('/');
  if (extra !== undefined) return null;
  // An IPv4-mapped IPv6 address is the IPv4 address it maps.
  const address = rawAddress.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  const version = isIP(address);
  if (version === 0) return null;
  const max = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > max ||
    !/^\d+$/.test(prefixText ?? `${max}`)
  ) {
    return null;
  }
  return { address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' };
}

/** A matcher for the list's ranges. */
export function matcher(entries: readonly { range: string }[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const entry of entries) {
    const range = parseRange(entry.range);
    if (range) list.addSubnet(range.address, range.prefix, range.family);
  }
  return (ip: string) => {
    const address = ip.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
    const version = isIP(address);
    if (version === 0) return false;
    return list.check(address, version === 4 ? 'ipv4' : 'ipv6');
  };
}

type Db = Pick<Kysely<Database>, 'selectFrom'>;

export async function readAllowlist(db: Db, workspaceId: number): Promise<Allowlist> {
  const [row, entries] = await Promise.all([
    db
      .selectFrom('ip_allowlist')
      .select(['enabled', 'exempt_group_ids'])
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst(),
    db
      .selectFrom('ip_allowlist_entry')
      .select(['id', 'range', 'note'])
      .where('workspace_id', '=', workspaceId)
      .orderBy('range')
      .execute(),
  ]);
  return {
    enabled: row?.enabled ?? false,
    exemptGroupIds: row?.exempt_group_ids ?? [],
    entries: entries.map((e) => ({ id: e.id, range: e.range, note: e.note })),
  };
}

interface Compiled {
  list: Allowlist;
  allows: (ip: string) => boolean;
  until: number;
}

/** Each workspace's list, compiled, read at most every `ttlMs` per process. */
export class Allowlists {
  private readonly cache = new Map<number, Compiled>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 30_000,
  ) {}

  async get(workspaceId: number): Promise<Compiled> {
    const hit = this.cache.get(workspaceId);
    if (hit && hit.until > Date.now()) return hit;
    return this.set(workspaceId, await readAllowlist(this.db, workspaceId));
  }

  set(workspaceId: number, list: Allowlist): Compiled {
    const compiled = { list, allows: matcher(list.entries), until: Date.now() + this.ttlMs };
    this.cache.set(workspaceId, compiled);
    return compiled;
  }
}
