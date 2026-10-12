import { existsSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Database, migrationStatus, poolStats } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';

/** What the admin status page shows (OPS-010, M1-103). Never includes settings or secrets. */
export interface SystemInfo {
  version: string;
  roles: string[];
  startedAt: string;
  uptimeSeconds: number;
  runtime: { node: string; platform: string; arch: string; memoryRssBytes: number };
  database: {
    reachable: boolean;
    version: string | null;
    sizeBytes: number | null;
    migrations: { applied: number; pending: string[]; unknown: string[] } | null;
    pool: { total: number; idle: number; waiting: number; max: number } | null;
  };
  disk: { path: string; freeBytes: number; totalBytes: number } | null;
  backup: { lastAt: string; ageSeconds: number } | null;
}

export interface SystemInfoOptions {
  version: string;
  roles: readonly string[];
  startedAt: Date;
  dataDir?: string;
}

export async function systemInfo(
  db: Kysely<Database>,
  options: SystemInfoOptions,
  now = new Date(),
): Promise<SystemInfo> {
  let database: SystemInfo['database'] = {
    reachable: false,
    version: null,
    sizeBytes: null,
    migrations: null,
    pool: poolStats(db) ?? null,
  };
  try {
    const { rows } = await sql<{ version: string; size: string }>`
      SELECT current_setting('server_version') AS version,
             pg_database_size(current_database()) AS size`.execute(db);
    const status = await migrationStatus(db);
    database = {
      ...database,
      reachable: true,
      version: rows[0]?.version ?? null,
      sizeBytes: Number(rows[0]?.size ?? 0),
      migrations: {
        applied: status.applied.length,
        pending: status.pending,
        unknown: status.unknown,
      },
    };
  } catch {
    // An unreachable database is a state to show, not an error of this page.
  }
  let disk: SystemInfo['disk'] = null;
  let backup: SystemInfo['backup'] = null;
  if (options.dataDir && existsSync(options.dataDir)) {
    const stat = statfsSync(options.dataDir);
    disk = {
      path: options.dataDir,
      freeBytes: Number(stat.bavail) * Number(stat.bsize),
      totalBytes: Number(stat.blocks) * Number(stat.bsize),
    };
    const marker = join(options.dataDir, 'backups', 'last');
    if (existsSync(marker)) {
      const at = statSync(marker).mtime;
      backup = {
        lastAt: at.toISOString(),
        ageSeconds: Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000)),
      };
    }
  }
  return {
    version: options.version,
    roles: [...options.roles],
    startedAt: options.startedAt.toISOString(),
    uptimeSeconds: Math.round((now.getTime() - options.startedAt.getTime()) / 1000),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      memoryRssBytes: process.memoryUsage().rss,
    },
    database,
    disk,
    backup,
  };
}

/** `GET /api/v1/admin/system`: site administrators only. */
export function registerAdminRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: SystemInfoOptions,
): void {
  app.get('/api/v1/admin/system', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'not_signed_in' });
    if (!request.user.isSiteAdmin) return reply.code(403).send({ error: 'forbidden' });
    return systemInfo(db, options);
  });
}
