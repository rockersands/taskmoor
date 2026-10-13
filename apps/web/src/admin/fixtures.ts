import type { Session } from '../session/SessionProvider';
import type { SystemInfo } from './SystemPage';

/** Synthetic status of a healthy instance, for stories and tests. */
export const HEALTHY: SystemInfo = {
  version: '0.4.0',
  roles: ['api', 'worker', 'realtime', 'web'],
  startedAt: '2026-10-10T08:00:00.000Z',
  uptimeSeconds: 2 * 86_400 + 3 * 3600 + 25 * 60,
  runtime: { node: 'v22.20.0', platform: 'linux', arch: 'x64', memoryRssBytes: 187_400_000 },
  database: {
    reachable: true,
    version: '16.14',
    sizeBytes: 4_812_000_000,
    migrations: { applied: 2, pending: [], unknown: [] },
    pool: { total: 4, idle: 3, waiting: 0, max: 10 },
  },
  disk: { path: '/data', freeBytes: 182_300_000_000, totalBytes: 250_000_000_000 },
  backup: { lastAt: '2026-10-12T02:00:00.000Z', ageSeconds: 6 * 3600 },
};

/** An instance that needs attention: database down, a pending migration, no backup. */
export const NEEDS_ATTENTION: SystemInfo = {
  ...HEALTHY,
  database: {
    reachable: false,
    version: null,
    sizeBytes: null,
    migrations: null,
    pool: { total: 0, idle: 0, waiting: 5, max: 10 },
  },
  backup: null,
};

export const STALE_BACKUP: SystemInfo = {
  ...HEALTHY,
  database: {
    ...HEALTHY.database,
    migrations: { applied: 2, pending: ['0003_tracks'], unknown: [] },
  },
  backup: { lastAt: '2026-10-09T02:00:00.000Z', ageSeconds: 3 * 86_400 },
};

export const ADMIN: Session = {
  status: 'signed-in',
  user: {
    id: 1,
    name: 'Ada',
    email: 'ada@example.com',
    isSiteAdmin: true,
    timeZone: null,
    locale: null,
  },
};

export const MEMBER: Session = {
  status: 'signed-in',
  user: {
    id: 2,
    name: 'Bo',
    email: 'bo@example.com',
    isSiteAdmin: false,
    timeZone: null,
    locale: null,
  },
};
