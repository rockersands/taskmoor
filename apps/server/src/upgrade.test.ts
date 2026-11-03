import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  compareSchema,
  createDb,
  type Database,
  EXPECTED_SCHEMA,
  knownMigrations,
  type MigrationSet,
  migrateTo,
  migrationStatus,
  migrations,
  type Release,
  snapshotSchema,
} from '@taskmoor/db';
import { seededRows, UPGRADE_SEEDS } from '@taskmoor/db/testing';
import { createDatabase, testPgAdminUrl } from '@taskmoor/testkit/pg';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BackupManifest, clientBinary, serverMajor, tableChecksums } from './backup';
import { pruneScheduledBackups } from './backups/schedule';
import {
  FAILED_MARKER,
  formatOutcome,
  touchedTables,
  type UpgradeOptions,
  upgrade,
} from './upgrade';

const run = promisify(execFile);

/**
 * The upgrade command (M1-102, OPS-006). Releases are modelled as points in today's migration
 * list, as the upgrade harness of M0-029 does: this build is "1.4.0", and the four releases
 * before it end at these migrations. Upgrading 1.1 to 1.4 crosses three minor versions.
 * Failures are injected with test-only migration sets passed to `upgrade()`; nothing of the
 * kind ships.
 */
const HISTORY: Release[] = [
  { version: '1.0.0', lastMigration: '0012_scim' },
  { version: '1.1.0', lastMigration: '0015_ticket_history' },
  { version: '1.2.0', lastMigration: '0020_saml' },
  { version: '1.3.0', lastMigration: '0023_time_tracking' },
];
const all = knownMigrations();
const v13 = '0023_time_tracking';

interface ReleaseDb {
  db: Kysely<Database>;
  url: string;
  dataDir: string;
  backupRoot: string;
  close: () => Promise<void>;
}

/** A database left at `start` by that release, with every seed up to it, and a data dir. */
async function releaseDatabase(start: string, set: MigrationSet = migrations): Promise<ReleaseDb> {
  const database = await createDatabase(testPgAdminUrl());
  const db = createDb({ connectionString: database.url, maxConnections: 4 });
  // Each seed right after its migration, as that release wrote it (a later migration can
  // change what an earlier seed's statements need, as 0055 did for users' workspace).
  for (const name of knownMigrations(set).filter((n) => n <= start)) {
    const seed = UPGRADE_SEEDS[name];
    if (!seed) continue;
    await migrateTo(db, name, { migrations: set });
    await seed.seed(db as never);
  }
  await migrateTo(db, start, { migrations: set });
  const dataDir = mkdtempSync(join(tmpdir(), 'taskmoor-upgrade-'));
  mkdirSync(join(dataDir, 'files'));
  writeFileSync(join(dataDir, 'files', 'attachment.txt'), 'kept\n');
  return {
    db,
    url: database.url,
    dataDir,
    backupRoot: join(dataDir, 'backups'),
    close: async () => {
      await db.destroy();
      await database.drop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function options(target: ReleaseDb, extra: Partial<UpgradeOptions> = {}): UpgradeOptions {
  return {
    databaseUrl: target.url,
    dataDir: target.dataDir,
    backupRoot: target.backupRoot,
    version: '1.4.0',
    releases: HISTORY,
    ...extra,
  };
}

async function backupLog(db: Kysely<Database>, id: string | null | undefined) {
  if (!id) return undefined;
  return db
    .selectFrom('backup_run')
    .select(['kind', 'state', 'path', 'details', 'pruned_at'])
    .where('id', '=', id)
    .executeTakeFirst();
}

/** What "exactly as before" compares: migrations, schema and every table's rows. */
async function state(db: Kysely<Database>) {
  return {
    applied: (await migrationStatus(db)).applied,
    schema: await snapshotSchema(db),
    rows: await tableChecksums(db),
  };
}

/** A migration that changes a lot and then fails partway (test-only). */
const failsPartway = {
  up: async (db: Kysely<unknown>) => {
    await sql`CREATE TABLE injected_child (ticket_id integer REFERENCES ticket (id))`.execute(db);
    await sql`INSERT INTO injected_child SELECT id FROM ticket`.execute(db);
    await sql`ALTER TABLE ticket ADD COLUMN injected integer NOT NULL DEFAULT 7`.execute(db);
    await sql`UPDATE ticket SET summary = 'overwritten'`.execute(db);
    await sql`SELECT 1 / 0`.execute(db);
  },
};

let pgDumpAvailable = false;
beforeAll(async () => {
  const probe = createDb({ connectionString: testPgAdminUrl(), maxConnections: 1 });
  try {
    const major = await serverMajor(probe);
    pgDumpAvailable = execFileSync(clientBinary('pg_dump', major), ['--version'], {
      encoding: 'utf8',
    }).includes(` ${major}.`);
  } catch {
    pgDumpAvailable = false;
  } finally {
    await probe.destroy();
  }
});

describe('upgrade across releases (OPS-006)', () => {
  const starts = HISTORY.slice(-3).reverse(); // 1.3, 1.2, 1.1: one, two and three versions back
  for (const release of starts) {
    it(`[OPS-006] upgrades ${release.version} to 1.4.0 in one run with no manual step, every seeded row intact`, async ({
      skip,
    }) => {
      if (!pgDumpAvailable) skip('no pg_dump for this server version');
      const target = await releaseDatabase(release.lastMigration);
      try {
        const lines: string[] = [];
        const report = await upgrade(target.db, options(target, { log: (l) => lines.push(l) }));
        expect(report.error).toBeNull();
        expect(report).toMatchObject({
          outcome: 'upgraded',
          from: { migration: release.lastMigration, release: release.version },
          to: { migration: all[all.length - 1] },
          applied: all.filter((n) => n > release.lastMigration),
          rollback: null,
          verification: { ok: true, missing: [], pending: [] },
        });
        expect(report.checks.filter((c) => c.state !== 'ok')).toEqual([]);
        expect(formatOutcome(report)).toMatch(/^Upgraded from \d\.\d\.0 \(/);

        // The reviewed schema, nothing pending, every row the old release held.
        expect((await migrationStatus(target.db)).pending).toEqual([]);
        expect(compareSchema(await snapshotSchema(target.db), EXPECTED_SCHEMA)).toEqual({
          missing: [],
          extra: [],
        });
        const seeded = await seededRows(
          target.db as never,
          all.filter((n) => n <= release.lastMigration),
        );
        for (const [table, n] of Object.entries(seeded)) expect(n, table).toBe(1);

        // The pre-upgrade backup: on disk with the old release's migrations, in the log.
        const path = report.backup?.path as string;
        expect(path.startsWith(join(target.backupRoot, 'pre-upgrade-'))).toBe(true);
        const manifest = JSON.parse(
          readFileSync(join(path, 'manifest.json'), 'utf8'),
        ) as BackupManifest;
        expect(manifest.migrations).toEqual(all.filter((n) => n <= release.lastMigration));
        expect(manifest.checksums).toHaveProperty(['files/attachment.txt']);
        expect(await backupLog(target.db, report.backup?.runId)).toMatchObject({
          kind: 'manual',
          state: 'succeeded',
          path,
          details: {
            purpose: 'pre-upgrade',
            upgrade: { outcome: 'upgraded', applied: report.applied.length },
          },
        });
        // Running it again finds nothing to do and takes no second backup.
        const again = await upgrade(target.db, options(target));
        expect(again).toMatchObject({ outcome: 'up-to-date', backup: null, applied: [] });
      } finally {
        await target.close();
      }
    }, 60_000);
  }

  it('[OPS-006] refuses a database four releases back before writing anything', async () => {
    const target = await releaseDatabase('0012_scim');
    try {
      const before = await state(target.db);
      const report = await upgrade(target.db, options(target));
      expect(report.outcome).toBe('blocked');
      expect(report.checks.find((c) => c.name === 'upgrade-path')).toMatchObject({
        state: 'block',
        detail: expect.stringMatching(/release 1\.0\.0 .*upgrade to 1\.1\.0 first/),
      });
      expect(report.backup).toBeNull();
      expect(existsSync(target.backupRoot)).toBe(false);
      expect(await state(target.db)).toEqual(before);
    } finally {
      await target.close();
    }
  });

  it('[OPS-006] (3) a dry run lists every pending migration with an estimate and changes nothing', async () => {
    const target = await releaseDatabase('0015_ticket_history');
    try {
      const before = await state(target.db);
      const lines: string[] = [];
      const report = await upgrade(
        target.db,
        options(target, { dryRun: true, log: (l) => lines.push(l) }),
      );
      expect(report.outcome).toBe('planned');
      expect(report.plan.map((p) => p.name)).toEqual(all.filter((n) => n > '0015_ticket_history'));
      const fields = report.plan.find((p) => p.name === '0018_ticket_fields');
      expect(fields?.tables.map((t) => t.table)).toEqual(
        expect.arrayContaining(['ticket', 'track']),
      );
      expect(fields?.estimateSeconds).toBe(0);
      const text = lines.join('\n');
      expect(text).toMatch(/Plan: \d+ migration\(s\) in one transaction/);
      expect(text).toMatch(/0018_ticket_fields +changes .*ticket.*: under 1 s/);
      expect(formatOutcome(report)).toMatch(/^Dry run: .*nothing was changed/);
      expect(existsSync(target.backupRoot)).toBe(false);
      expect(await state(target.db)).toEqual(before);
    } finally {
      await target.close();
    }
  });
});

describe('rollback on failure (OPS-006 (1))', () => {
  it('[OPS-006] (1) rolls an injected failure back by the transaction, keeps the backup and reports it', async ({
    skip,
  }) => {
    if (!pgDumpAvailable) skip('no pg_dump for this server version');
    const target = await releaseDatabase(v13);
    try {
      const before = await state(target.db);
      const lines: string[] = [];
      const report = await upgrade(
        target.db,
        options(target, {
          migrations: { ...migrations, '9001_injected_failure': failsPartway },
          log: (l) => lines.push(l),
        }),
      );
      expect(report).toMatchObject({
        outcome: 'rolled-back',
        rollback: 'transaction',
        failedMigration: '9001_injected_failure',
        applied: [],
      });
      expect(report.error).toMatch(/9001_injected_failure failed: division by zero/);
      expect(formatOutcome(report)).toMatch(
        /Upgrade FAILED in 9001_injected_failure: .*\nRolled back: the database is exactly as it was before \(1\.3\.0/,
      );
      // Exactly as before: the two real migrations before it are gone too.
      expect(await state(target.db)).toEqual(before);
      // The backup stays, and its log entry says what happened.
      const path = report.backup?.path as string;
      expect(existsSync(join(path, 'manifest.json'))).toBe(true);
      expect(await backupLog(target.db, report.backup?.runId)).toMatchObject({
        state: 'succeeded',
        details: {
          purpose: 'pre-upgrade',
          upgrade: { outcome: 'rolled-back', failedMigration: '9001_injected_failure' },
        },
      });
      expect(
        JSON.parse(readFileSync(join(target.backupRoot, FAILED_MARKER), 'utf8')),
      ).toMatchObject({ target: '9001_injected_failure', outcome: 'rolled-back' });
    } finally {
      await target.close();
    }
  }, 60_000);

  it('[OPS-006] (1) rolls back a failure at the end of a three-release upgrade without a backup', async () => {
    const target = await releaseDatabase('0015_ticket_history');
    try {
      const before = await state(target.db);
      const report = await upgrade(
        target.db,
        options(target, {
          migrations: { ...migrations, '9001_injected_failure': failsPartway },
          noBackup: true,
        }),
      );
      expect(report.checks.find((c) => c.name === 'backup')).toMatchObject({ state: 'warn' });
      expect(report).toMatchObject({
        outcome: 'rolled-back',
        rollback: 'transaction',
        backup: null,
      });
      expect(await state(target.db)).toEqual(before);
    } finally {
      await target.close();
    }
  });

  it('[OPS-006] (1) restores the backup when the failure follows a committed online migration', async ({
    skip,
  }) => {
    if (!pgDumpAvailable) skip('no pg_dump for this server version');
    const target = await releaseDatabase(v13);
    const set: MigrationSet = {
      ...migrations,
      '9001_online_index': {
        online: true,
        up: async (db) =>
          void (await sql`CREATE INDEX CONCURRENTLY injected_summary_idx ON ticket (summary)`.execute(
            db,
          )),
      },
      // Committed with its segment: new objects of every kind the restore must clear away.
      '9002_new_objects': {
        up: async (db) => {
          await sql`CREATE SCHEMA injected`.execute(db);
          await sql`CREATE TABLE injected.thing (id integer)`.execute(db);
          await sql`CREATE TYPE injected_mood AS ENUM ('calm', 'busy')`.execute(db);
          await sql`CREATE FUNCTION injected_fn(a integer) RETURNS integer LANGUAGE sql AS 'SELECT a'`.execute(
            db,
          );
          await sql`CREATE TABLE injected_child (ticket_id integer REFERENCES ticket (id), mood injected_mood)`.execute(
            db,
          );
          await sql`INSERT INTO injected_child SELECT id, 'calm' FROM ticket`.execute(db);
          await sql`UPDATE ticket SET summary = 'overwritten'`.execute(db);
        },
      },
      '9003_online_fails': {
        online: true,
        up: async (db) => {
          await sql`CREATE TABLE stuck (ticket_id integer REFERENCES ticket (id))`.execute(db);
          await sql`ALTER TABLE track ADD COLUMN injected integer`.execute(db);
          throw new Error('injected failure after commits');
        },
      },
    };
    try {
      const before = await state(target.db);
      const report = await upgrade(target.db, options(target, { migrations: set }));
      expect(report.error).toMatch(/9003_online_fails failed: injected failure after commits/);
      expect(report).toMatchObject({
        outcome: 'restored',
        rollback: 'restore',
        failedMigration: '9003_online_fails',
        applied: [],
      });
      expect(report.seconds.rollback).toBeGreaterThan(0);
      expect(await state(target.db)).toEqual(before);
      const { rows } = await sql<{ left: string | null }>`
        SELECT coalesce(to_regclass('stuck')::text, to_regclass('injected_child')::text,
                        to_regtype('injected_mood')::text, to_regprocedure('injected_fn(integer)')::text,
                        (SELECT nspname::text FROM pg_namespace WHERE nspname = 'injected')) AS left`.execute(
        target.db,
      );
      expect(rows[0]?.left).toBeNull();
      // The live backup log survives the restore and records the outcome.
      expect(await backupLog(target.db, report.backup?.runId)).toMatchObject({
        details: { upgrade: { outcome: 'restored', rollback: 'restore' } },
      });
      const seed = await target.db
        .selectFrom('backup_run')
        .select('id')
        .where('path', '=', '/data/backups/seed')
        .execute();
      expect(seed).toHaveLength(1);
    } finally {
      await target.close();
    }
  }, 60_000);

  it('[OPS-006] verifies the schema before the commit and rolls back when it differs', async () => {
    const target = await releaseDatabase(v13);
    try {
      const before = await state(target.db);
      const report = await upgrade(
        target.db,
        options(target, {
          noBackup: true,
          expectedSchema: { ...EXPECTED_SCHEMA, phantom: { columns: ['id integer'], indexes: [] } },
        }),
      );
      expect(report).toMatchObject({
        outcome: 'rolled-back',
        rollback: 'transaction',
        failedMigration: null,
        verification: { ok: false, missing: ['table phantom'] },
      });
      expect(report.error).toMatch(
        /differs from the reviewed one in 1 place\(s\), first: table phantom/,
      );
      expect(await state(target.db)).toEqual(before);
    } finally {
      await target.close();
    }
  });

  it('[OPS-006] does not retry a failed target when unattended, but does when run by hand', async () => {
    const target = await releaseDatabase(v13);
    mkdirSync(target.backupRoot);
    const failing = { ...migrations, '9001_injected_failure': failsPartway };
    try {
      const first = await upgrade(
        target.db,
        options(target, { migrations: failing, noBackup: true }),
      );
      expect(first.outcome).toBe('rolled-back');
      const unattended = await upgrade(
        target.db,
        options(target, { migrations: failing, noBackup: true, unattended: true }),
      );
      expect(unattended.outcome).toBe('blocked');
      expect(unattended.checks.find((c) => c.name === 'previous-attempt')?.detail).toMatch(
        /failed at .* and was rolled-back: .*division by zero.*retry by hand/,
      );
      // By hand it tries again (and fails again).
      const byHand = await upgrade(
        target.db,
        options(target, { migrations: failing, noBackup: true }),
      );
      expect(byHand.outcome).toBe('rolled-back');
      // A newer build is another target: tried at start, and its success clears the marker.
      const fixed = await upgrade(
        target.db,
        options(target, {
          migrations: { ...migrations, '9002_fixed': { up: async () => {} } },
          noBackup: true,
          unattended: true,
        }),
      );
      expect(fixed.outcome).toBe('upgraded');
      expect(existsSync(join(target.backupRoot, FAILED_MARKER))).toBe(false);
    } finally {
      await target.close();
    }
  });
});

describe('pre-flight (OPS-006)', () => {
  it('[OPS-006] blocks while another upgrade holds the lock', async () => {
    const target = await releaseDatabase(v13);
    const other = createDb({ connectionString: target.url, maxConnections: 1 });
    try {
      await other.connection().execute(async (conn) => {
        await sql`SELECT pg_advisory_lock(hashtext('taskmoor:upgrade'))`.execute(conn);
        const report = await upgrade(target.db, options(target, { noBackup: true }));
        expect(report.outcome).toBe('blocked');
        expect(report.checks.find((c) => c.name === 'upgrade-lock')).toMatchObject({
          state: 'block',
        });
        await sql`SELECT pg_advisory_unlock(hashtext('taskmoor:upgrade'))`.execute(conn);
      });
    } finally {
      await other.destroy();
      await target.close();
    }
  });

  it('[OPS-006] waits for a running backup and changes nothing when it does not finish', async () => {
    const target = await releaseDatabase(v13);
    try {
      await target.db.insertInto('backup_run').values({ kind: 'scheduled', path: null }).execute();
      const before = await state(target.db);
      const report = await upgrade(target.db, options(target, { backupWaitMs: 0 }));
      expect(report.checks.find((c) => c.name === 'backup')).toMatchObject({
        state: 'warn',
        detail: expect.stringMatching(
          /a scheduled backup started at .* is running; the upgrade waits/,
        ),
      });
      expect(report).toMatchObject({ outcome: 'failed', error: 'a backup is already running' });
      expect(formatOutcome(report)).toMatch(/Nothing was changed/);
      expect(await state(target.db)).toEqual(before);
    } finally {
      await target.close();
    }
  });

  it('[OPS-006] needs a backup directory with room, and a backup for online migrations', async () => {
    const target = await releaseDatabase(v13);
    const online: MigrationSet = {
      ...migrations,
      '9001_online': { online: true, up: async () => {} },
    };
    try {
      const nowhere = await upgrade(target.db, options(target, { backupRoot: null }));
      expect(nowhere.checks.find((c) => c.name === 'backup')).toMatchObject({
        state: 'block',
        detail: expect.stringMatching(/TASKMOOR_BACKUP_DIR, or pass --no-backup/),
      });
      const unsafe = await upgrade(
        target.db,
        options(target, { migrations: online, noBackup: true }),
      );
      expect(unsafe.checks.find((c) => c.name === 'backup')).toMatchObject({
        state: 'block',
        detail: expect.stringMatching(/9001_online.*can only be rolled back from a backup/),
      });
      // The last backup's size is the estimate: one no disk can hold blocks.
      await target.db
        .insertInto('backup_run')
        .values({
          kind: 'manual',
          state: 'succeeded',
          finished_at: new Date(),
          size_bytes: '1000000000000000000',
        })
        .execute();
      const full = await upgrade(target.db, options(target));
      expect(full.checks.find((c) => c.name === 'backup-space')).toMatchObject({ state: 'block' });
      for (const report of [nowhere, unsafe, full]) expect(report.outcome).toBe('blocked');
      expect((await migrationStatus(target.db)).applied.at(-1)).toBe(v13);
    } finally {
      await target.close();
    }
  });

  it('[OPS-006] warns about connected Taskmoor processes, and blocks them for online plans', async () => {
    const target = await releaseDatabase(v13);
    const app = createDb({
      connectionString: target.url,
      maxConnections: 1,
      applicationName: 'taskmoor-api',
    });
    try {
      await sql`SELECT 1`.execute(app);
      const plain = await upgrade(target.db, options(target, { noBackup: true, dryRun: true }));
      expect(plain.checks.find((c) => c.name === 'processes')).toMatchObject({
        state: 'warn',
        detail: expect.stringMatching(/^taskmoor-api \(1\) connected: they keep running the old/),
      });
      expect(plain.outcome).toBe('planned');
      const online = await upgrade(
        target.db,
        options(target, {
          dryRun: true,
          migrations: { ...migrations, '9001_online': { online: true, up: async () => {} } },
        }),
      );
      expect(online.checks.find((c) => c.name === 'processes')).toMatchObject({ state: 'block' });
      expect(online.outcome).toBe('blocked');
    } finally {
      await app.destroy();
      await target.close();
    }
  });

  it('[OPS-008] keeps the pre-upgrade backup when scheduled retention prunes', async ({ skip }) => {
    if (!pgDumpAvailable) skip('no pg_dump for this server version');
    const target = await releaseDatabase(v13);
    try {
      const report = await upgrade(target.db, options(target));
      expect(report.outcome).toBe('upgraded');
      // Three scheduled backups older than it, in the same directory.
      for (const day of [1, 2, 3]) {
        const dir = join(target.backupRoot, `scheduled-2026-01-0${day}`);
        mkdirSync(dir);
        writeFileSync(join(dir, 'manifest.json'), '{}');
        await target.db
          .insertInto('backup_run')
          .values({
            kind: 'scheduled',
            state: 'succeeded',
            started_at: new Date(`2026-01-0${day}T02:30:00Z`),
            finished_at: new Date(`2026-01-0${day}T02:31:00Z`),
            path: dir,
          })
          .execute();
      }
      // Keep one: the release's seeded scheduled run is the newest, so all three go.
      const pruned = await pruneScheduledBackups(target.db, 1, target.backupRoot);
      expect(pruned.map((p) => p.slice(target.backupRoot.length + 1)).sort()).toEqual([
        'scheduled-2026-01-01',
        'scheduled-2026-01-02',
        'scheduled-2026-01-03',
      ]);
      expect(existsSync(join(report.backup?.path as string, 'manifest.json'))).toBe(true);
      expect(await backupLog(target.db, report.backup?.runId)).toMatchObject({ pruned_at: null });
    } finally {
      await target.close();
    }
  }, 60_000);

  it('[OPS-006] treats an empty database as an install: migrations without a backup', async () => {
    const database = await createDatabase(testPgAdminUrl());
    const db = createDb({ connectionString: database.url, maxConnections: 4 });
    const root = mkdtempSync(join(tmpdir(), 'taskmoor-install-'));
    try {
      const report = await upgrade(db, {
        databaseUrl: database.url,
        backupRoot: join(root, 'backups'),
        version: 'test',
      });
      expect(report).toMatchObject({
        outcome: 'upgraded',
        from: { migration: null },
        applied: all,
        backup: null,
        verification: { ok: true },
      });
      expect(report.checks.find((c) => c.name === 'upgrade-path')?.detail).toMatch(/an install/);
    } finally {
      await db.destroy();
      await database.drop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('[OPS-006] empties a fresh database again when an install fails after an online step', async () => {
    const database = await createDatabase(testPgAdminUrl());
    const db = createDb({ connectionString: database.url, maxConnections: 4 });
    try {
      const report = await upgrade(db, {
        databaseUrl: database.url,
        backupRoot: null,
        version: 'test',
        migrations: {
          '0001_a': { up: async (db) => void (await sql`CREATE TABLE a (id int)`.execute(db)) },
          '0002_online': {
            online: true,
            up: async (db) => {
              await sql`CREATE TABLE b (a_id int)`.execute(db);
              throw new Error('injected');
            },
          },
        },
      });
      expect(report).toMatchObject({ outcome: 'restored', rollback: 'restore', backup: null });
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'`.execute(db);
      expect(rows[0]?.n).toBe(0);
    } finally {
      await db.destroy();
      await database.drop();
    }
  });

  it('[OPS-006] reads the tables a migration changes, for the estimates', () => {
    const tables = ['ticket', 'track', 'ticket_change', 'status'];
    expect(
      touchedTables(
        'await sql`ALTER TABLE ticket ADD COLUMN x int`; await sql`CREATE INDEX t_idx ON\n  track (id)`;' +
          " db.insertInto('ticket_change'); CREATE TABLE status_history (id int)",
        tables,
      ),
    ).toEqual(['ticket', 'ticket_change', 'track']);
    expect(touchedTables('CREATE TABLE fresh (id int REFERENCES ticket (id))', tables)).toEqual([]);
  });
});

describe('node cli.mjs upgrade', () => {
  let target: ReleaseDb;
  beforeAll(async () => {
    target = await releaseDatabase(all[all.length - 3] as string);
  });
  afterAll(async () => {
    await target.close();
  });

  it('[OPS-006] runs a dry run, the upgrade, then finds nothing to do, exiting 0 each time', async ({
    skip,
  }) => {
    if (!pgDumpAvailable) skip('no pg_dump for this server version');
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const env = {
      ...process.env,
      DATABASE_URL: target.url,
      TASKMOOR_DATA: target.dataDir,
      LOG_LEVEL: 'silent',
    };
    const report = (stdout: string) => JSON.parse(stdout.trim().split('\n').pop() ?? '{}');

    const dry = await run(process.execPath, [tsx, cli, 'upgrade', '--dry-run'], { env });
    expect(dry.stdout).toMatch(/ok {4}upgrade-path: /);
    expect(dry.stdout).toMatch(/Plan: 2 migration\(s\) in one transaction/);
    expect(dry.stdout).toMatch(/Dry run: 2 migration\(s\) from .* nothing was changed/);
    expect(report(dry.stdout)).toMatchObject({ outcome: 'planned' });

    const done = await run(process.execPath, [tsx, cli, 'upgrade'], { env });
    expect(done.stdout).toMatch(/backup complete/);
    expect(done.stdout).toMatch(/Upgraded from .* to .* in [\d.]+ s/);
    expect(done.stdout).not.toContain('postgres:postgres@');
    const upgraded = report(done.stdout);
    expect(upgraded).toMatchObject({ outcome: 'upgraded', applied: all.slice(-2) });
    expect(upgraded.backup.path.startsWith(join(target.dataDir, 'backups', 'pre-upgrade-'))).toBe(
      true,
    );

    const again = await run(process.execPath, [tsx, cli, 'upgrade', '--unattended'], { env });
    expect(again.stdout).toMatch(/Up to date at /);
  }, 90_000);
});
