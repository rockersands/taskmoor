import type { Session } from '../session/SessionProvider';
import type { BackupRun, SystemInfo } from './SystemPage';
import type { TrashedTicket, TrashedTrack } from './TrashPage';

const run = (
  fields: Partial<BackupRun> & Pick<BackupRun, 'kind' | 'state' | 'startedAt'>,
): BackupRun => ({
  id: '1',
  finishedAt: fields.startedAt,
  path: null,
  sizeBytes: null,
  details: {},
  error: null,
  pruned: false,
  ...fields,
});

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
  backups: {
    schedule: { enabled: true, time: '02:30', keep: 14, verify: true },
    nextAt: '2026-10-13T02:30:00.000Z',
    running: null,
    lastSuccess: run({
      kind: 'scheduled',
      state: 'succeeded',
      startedAt: '2026-10-12T02:30:00.000Z',
      path: '/data/backups/scheduled-2026-10-12T02-30-00',
      sizeBytes: 912_400_000,
    }),
    lastFailure: run({
      kind: 'scheduled',
      state: 'failed',
      startedAt: '2026-10-09T02:30:00.000Z',
      error: 'pg_dump: could not connect to the server',
    }),
    lastDrill: run({
      kind: 'drill',
      state: 'succeeded',
      startedAt: '2026-10-11T02:41:00.000Z',
      details: { seconds: { verify: 3.1, restore: 412.5, check: 9.8, total: 425.4 } },
    }),
    kept: 14,
  },
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
  backups: null,
};

export const STALE_BACKUP: SystemInfo = {
  ...HEALTHY,
  database: {
    ...HEALTHY.database,
    migrations: { applied: 2, pending: ['0003_tracks'], unknown: [] },
  },
  backup: { lastAt: '2026-10-09T02:00:00.000Z', ageSeconds: 3 * 86_400 },
  backups: {
    schedule: { enabled: true, time: '02:30', keep: 14, verify: true },
    nextAt: '2026-10-13T02:30:00.000Z',
    running: null,
    lastSuccess: run({
      kind: 'manual',
      state: 'succeeded',
      startedAt: '2026-10-09T02:00:00.000Z',
      sizeBytes: 901_000_000,
    }),
    lastFailure: run({
      kind: 'scheduled',
      state: 'failed',
      startedAt: '2026-10-12T02:30:00.000Z',
      error: 'No space left on device',
    }),
    lastDrill: run({
      kind: 'drill',
      state: 'failed',
      startedAt: '2026-10-11T02:41:00.000Z',
      error: '1 table(s) restored with other row counts',
    }),
    kept: 3,
  },
};

/**
 * Every worker has scheduled backups turned off (TASKMOOR_BACKUP_DIR=off, as the demo runs), and
 * a run from before workers declined the job failed for it (S3-AC-1). Such a run kept no reason
 * and its message was the same for `off` and for no directory, so the server labels it
 * `could-not-keep`.
 */
export const NO_BACKUP_WORKER: SystemInfo = {
  ...HEALTHY,
  backup: null,
  backups: {
    schedule: { enabled: true, time: '02:30', keep: 14, verify: true },
    nextAt: null,
    workers: 'off',
    running: null,
    lastSuccess: null,
    lastFailure: run({
      kind: 'scheduled',
      state: 'failed',
      startedAt: '2026-10-12T02:30:00.000Z',
      details: { reason: 'could-not-keep' },
      error:
        'this worker has no backup directory: set TASKMOOR_DATA or TASKMOOR_BACKUP_DIR, or turn scheduled backups off',
    }),
    lastDrill: null,
    kept: 0,
  },
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

/** Synthetic trash (M1-101): a feature with a subticket that went along, and a lone bug. */
export const TRASHED_TICKETS: TrashedTicket[] = [
  {
    id: 41,
    key: 'SHOP-41',
    summary: 'Checkout redesign',
    track: { id: 3, key: 'SHOP', name: 'Shop' },
    trash: {
      deletedAt: '2026-10-20T09:15:00.000Z',
      deletedBy: { id: 1, name: 'Ada' },
      purgeAfter: '2026-11-19T09:15:00.000Z',
      deletedWith: null,
    },
  },
  {
    id: 42,
    key: 'SHOP-42',
    summary: 'Move the pay button',
    track: { id: 3, key: 'SHOP', name: 'Shop' },
    trash: {
      deletedAt: '2026-10-20T09:15:00.000Z',
      deletedBy: { id: 1, name: 'Ada' },
      purgeAfter: '2026-11-19T09:15:00.000Z',
      deletedWith: { id: 41, key: 'SHOP-41' },
    },
  },
  {
    id: 7,
    key: 'OPS-7',
    summary: 'Rotate the staging certificates before they expire next month',
    track: { id: 5, key: 'OPS', name: 'Operations' },
    trash: {
      deletedAt: '2026-10-02T16:40:00.000Z',
      deletedBy: null,
      purgeAfter: '2026-11-01T16:40:00.000Z',
      deletedWith: null,
    },
  },
];

export const TRASHED_TRACKS: TrashedTrack[] = [
  {
    id: 9,
    key: 'LEGACY',
    name: 'Legacy portal',
    ticketCount: 1284,
    trash: {
      deletedAt: '2026-10-25T11:00:00.000Z',
      deletedBy: { id: 1, name: 'Ada' },
      purgeAfter: '2026-11-24T11:00:00.000Z',
      purging: false,
    },
  },
  {
    id: 4,
    key: 'TRIAL',
    name: 'Trial',
    ticketCount: 0,
    trash: {
      deletedAt: '2026-09-20T08:00:00.000Z',
      deletedBy: { id: 1, name: 'Ada' },
      purgeAfter: '2026-10-20T08:00:00.000Z',
      purging: true,
    },
  },
];

/**
 * Runs tracks and is no administrator: sees the tracks they run (IAM-030, ADR-114), and the own
 * sets of those with their own configuration (T-163a).
 */
export const TRACK_ADMIN: Session = {
  status: 'signed-in',
  user: {
    id: 4,
    name: 'Tam',
    email: 'tam@example.com',
    isSiteAdmin: false,
    isConfigAdmin: false,
    managesTracks: true,
    timeZone: null,
    locale: null,
  },
};

/** Holds Change configuration only: sees the setup pages (ADR-114). */
export const CONFIG_ADMIN: Session = {
  status: 'signed-in',
  user: {
    id: 3,
    name: 'Cam',
    email: 'cam@example.com',
    isSiteAdmin: false,
    isConfigAdmin: true,
    timeZone: null,
    locale: null,
  },
};
