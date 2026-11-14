// Starts and stops a private `pnpm demo` for the sweep (tools/sweep/routes.mjs). The demo prints
// one-time password links: its output passes through here, the site administrator's link is kept
// in memory for signing in (session.mjs), and only a redacted copy goes to the log under .cache.
// The data stays, so a later run reuses it; the demo's own Ctrl+C handling cannot run on Windows,
// where a process is simply ended, so the database is stopped here with its own tool.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { redact } from './redact.mjs';
import { adminLinkIn } from './session.mjs';

const run = promisify(execFile);

/**
 * Reads the demo's output as it comes, in pieces that may split a line: keeps the administrator's
 * link and passes each whole line on to `write`, redacted.
 */
export function demoOutput(write) {
  let rest = '';
  let previous = '';
  let link = null;
  const line = (text) => {
    // The link is printed on the line after the name it belongs to.
    link = adminLinkIn(`${previous}\n${text}`) ?? link;
    previous = text;
    write(`${redact(text, 2000)}\n`);
  };
  return {
    push(chunk) {
      const lines = (rest + String(chunk)).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const text of lines) line(text);
    },
    end() {
      if (rest) line(rest);
      rest = '';
    },
    link: () => link,
  };
}

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

/**
 * Starts the demo unless one answers already. Returns null if it was there, else what stops it
 * and the administrator's one-time link, which is never written anywhere.
 */
export async function startDemo({ root, url, logFile }) {
  if (await answers(url)) return null;
  mkdirSync(dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile, { flags: 'w', mode: 0o600 });
  const output = demoOutput((text) => log.write(text));
  const child = spawn(
    process.execPath,
    [
      join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(root, 'apps', 'server', 'src', 'demo', 'cli.ts'),
      '--port',
      new URL(url).port,
    ],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: platform() !== 'win32',
      windowsHide: true,
    },
  );
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));
  const stop = async () => {
    await stopDemo({ root, pid: child.pid });
    output.end();
    await new Promise((resolve) => log.end(resolve));
  };
  // A first start builds the frontend and adds the sample data: minutes, not seconds.
  const deadline = Date.now() + 10 * 60_000;
  while (!(await answers(url))) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`The demo stopped; see ${logFile}.`);
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`The demo did not answer in ten minutes; see ${logFile}.`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  // The links are printed just after the server answers.
  for (let waited = 0; !output.link() && waited < 15_000; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return { stop, link: output.link() };
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
