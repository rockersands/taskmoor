import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Connection details for the Postgres server the test run uses. */
export interface PgServer {
  /** URL of the maintenance database (`postgres`), used to create and drop test databases. */
  adminUrl: string;
  /** Where the server came from: `embedded` (started here) or `external` (TRACKSMITH_TEST_DATABASE_URL). */
  kind: 'embedded' | 'external';
  stop(): Promise<void>;
}

interface Binaries {
  initdb: string;
  pg_ctl: string;
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CACHE_DIR = join(REPO_ROOT, '.cache', 'pg-test');

export interface EmbeddedOptions {
  /** Cluster name; its data lives in .cache/pg-test/<name> and is kept between runs. */
  name: string;
  /** Extra `-c key=value` server settings, applied after the defaults. */
  settings?: Record<string, string | number>;
}

const DEFAULT_SETTINGS: Record<string, string | number> = {
  listen_addresses: 'localhost',
  fsync: 'off',
  synchronous_commit: 'off',
  full_page_writes: 'off',
  max_connections: 300,
  shared_buffers: '128MB',
};

/**
 * Starts the Postgres server for a test run.
 *
 * - With TRACKSMITH_TEST_DATABASE_URL set (CI service containers), that server is used as is.
 * - Otherwise an embedded Postgres 16 runs from the npm binaries, so no Docker is needed.
 *   The cluster in .cache/pg-test/pg16 is kept between runs so startup takes about a second.
 *   If another run already holds that cluster, this run gets a throwaway cluster instead.
 */
export async function startTestPostgres(): Promise<PgServer> {
  const external = process.env.TRACKSMITH_TEST_DATABASE_URL;
  if (external) {
    return { adminUrl: external, kind: 'external', stop: async () => {} };
  }
  return startEmbeddedPostgres({ name: 'pg16' });
}

/** Starts (creating on first use) a named embedded Postgres 16 cluster. */
export async function startEmbeddedPostgres(options: EmbeddedOptions): Promise<PgServer> {
  const bins = await resolveBinaries();
  await mkdir(CACHE_DIR, { recursive: true });

  const lockFile = join(CACHE_DIR, `${options.name}.lock`);
  const ownsPersistent = await acquireLock(lockFile);
  const dataDir = join(
    CACHE_DIR,
    ownsPersistent ? options.name : `tmp-${options.name}-${process.pid}`,
  );
  const logFile = `${dataDir}.log`;

  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    await rm(dataDir, { recursive: true, force: true });
    await run(bins.initdb, [
      '-D',
      dataDir,
      '-U',
      'postgres',
      '--auth=trust',
      '--encoding=UTF8',
      '--locale=C',
      '--no-sync',
    ]);
  }

  // A crashed earlier run can leave its server running or a stale pid file behind.
  await stopIfRunning(bins, dataDir);

  const port = await freePort();
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const serverFlags = [
    `-p ${port}`,
    ...Object.entries(settings).map(([k, v]) => `-c ${k}=${v}`),
  ].join(' ');

  // The server outlives pg_ctl, so pg_ctl must not share pipes with this process: on Windows
  // the server would inherit them and the call would never return.
  const code = await runWithoutPipes(bins.pg_ctl, [
    'start',
    '-D',
    dataDir,
    '-w',
    '-t',
    '60',
    '-l',
    logFile,
    '-o',
    serverFlags,
  ]);
  if (code !== 0) {
    const log = await readFile(logFile, 'utf8').catch(() => '');
    if (ownsPersistent) await releaseLock(lockFile);
    throw new Error(
      `Embedded Postgres "${options.name}" failed to start (pg_ctl exit ${code}).
--- server log ---
${log.slice(-4000)}`,
    );
  }

  return {
    adminUrl: `postgres://postgres@localhost:${port}/postgres`,
    kind: 'embedded',
    stop: async () => {
      await run(bins.pg_ctl, ['stop', '-D', dataDir, '-m', 'fast', '-w', '-t', '120']).catch(
        () => {},
      );
      if (ownsPersistent) {
        await releaseLock(lockFile);
      } else {
        await rm(dataDir, { recursive: true, force: true });
        await rm(logFile, { force: true });
      }
    },
  };
}

async function resolveBinaries(): Promise<Binaries> {
  const platformPackage = `@embedded-postgres/${platformTag()}`;
  // The binary packages are optional dependencies of embedded-postgres, so resolve them from there.
  const fromEmbedded = createRequire(createRequire(import.meta.url).resolve('embedded-postgres'));
  const entry = fromEmbedded.resolve(platformPackage);
  const mod = (await import(pathToFileURL(entry).href)) as Partial<Binaries>;
  if (!mod.initdb || !mod.pg_ctl) {
    throw new Error(`${platformPackage} does not export initdb and pg_ctl paths.`);
  }
  return { initdb: mod.initdb, pg_ctl: mod.pg_ctl };
}

function platformTag(): string {
  const os = platform();
  const cpu = arch();
  if (os === 'win32' && cpu === 'x64') return 'windows-x64';
  if (os === 'darwin' && (cpu === 'arm64' || cpu === 'x64')) return `darwin-${cpu}`;
  if (os === 'linux' && (cpu === 'x64' || cpu === 'arm64')) return `linux-${cpu}`;
  throw new Error(
    `No embedded Postgres for ${os}-${cpu}. Set TRACKSMITH_TEST_DATABASE_URL to a Postgres 16+ server.`,
  );
}

async function stopIfRunning(bins: Binaries, dataDir: string): Promise<void> {
  const pidFile = join(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return;
  const running = await run(bins.pg_ctl, ['status', '-D', dataDir]).then(
    () => true,
    () => false,
  );
  if (running) {
    // A clean stop first: an immediate stop counts as a crash and empties UNLOGGED tables,
    // which is where the bench datasets live.
    const fast = await run(bins.pg_ctl, [
      'stop',
      '-D',
      dataDir,
      '-m',
      'fast',
      '-w',
      '-t',
      '300',
    ]).then(
      () => true,
      () => false,
    );
    if (!fast) {
      await run(bins.pg_ctl, ['stop', '-D', dataDir, '-m', 'immediate', '-w', '-t', '60']).catch(
        () => {},
      );
    }
  } else {
    await unlink(pidFile).catch(() => {});
  }
}

async function acquireLock(lockFile: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockFile, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return true;
    } catch {
      const owner = Number.parseInt(await readFile(lockFile, 'utf8').catch(() => ''), 10);
      if (Number.isInteger(owner) && owner !== process.pid && isAlive(owner)) return false;
      await unlink(lockFile).catch(() => {});
    }
  }
  return false;
}

async function releaseLock(lockFile: string): Promise<void> {
  await unlink(lockFile).catch(() => {});
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function runWithoutPipes(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not pick a free port.'));
      });
    });
  });
}
