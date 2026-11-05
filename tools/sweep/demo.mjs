// Starts and stops a private `pnpm demo` for the sweep (tools/sweep/routes.mjs). Its output, with
// the one-time links, goes only to a log file under .cache, ignored by git. The data stays, so a
// later run reuses it; the demo's own Ctrl+C handling cannot run on Windows, where a process is
// simply ended, so the database is stopped here with its own tool.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

function pgCtl(root) {
  const tag = platform() === 'win32' ? `windows-${arch()}` : `${platform()}-${arch()}`;
  const store = join(root, 'node_modules', '.pnpm');
  const name = readdirSync(store).find((d) => d.startsWith(`@embedded-postgres+${tag}@`));
  if (!name) return null;
  const bin = join(store, name, 'node_modules', '@embedded-postgres', tag, 'native', 'bin');
  return join(bin, platform() === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
}

const answers = (url) =>
  fetch(`${url}/ready`).then(
    (r) => r.ok,
    () => false,
  );

/** Starts the demo unless one answers already. Returns what stops it, or null if it was there. */
export async function startDemo({ root, url, logFile }) {
  if (await answers(url)) return null;
  mkdirSync(dirname(logFile), { recursive: true });
  const log = openSync(logFile, 'w');
  const child = spawn(
    process.execPath,
    [
      join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(root, 'apps', 'server', 'src', 'demo', 'cli.ts'),
      '--port',
      new URL(url).port,
    ],
    { cwd: root, stdio: ['ignore', log, log], detached: platform() !== 'win32', windowsHide: true },
  );
  const stop = () => stopDemo({ root, pid: child.pid });
  // A first start builds the frontend and adds the sample data: minutes, not seconds.
  const deadline = Date.now() + 10 * 60_000;
  while (!(await answers(url))) {
    if (child.exitCode !== null) throw new Error(`The demo stopped; see ${logFile}.`);
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`The demo did not answer in ten minutes; see ${logFile}.`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  // The links are printed just after the server answers.
  await new Promise((r) => setTimeout(r, 1500));
  return stop;
}

/** Ends the demo's processes, then stops its database cleanly. */
export async function stopDemo({ root, pid }) {
  if (platform() === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  const cluster = join(root, '.cache', 'pg-test', 'demo');
  const tool = pgCtl(root);
  if (tool && existsSync(join(cluster, 'postmaster.pid'))) {
    await run(tool, ['stop', '-D', cluster, '-m', 'fast', '-w', '-t', '60']).catch(() => {});
  }
  rmSync(`${cluster}.lock`, { force: true });
}
