import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The Compose kit's install.sh and install.ps1 (OPS-001) with a stand-in for Docker: the port
 * check and the setup link they print. The real install runs in tools/image/smoke-kits.sh and the air-gap test.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * A docker whose Compose starts at once, is ready at once, logs the setup link in
 * $FAKE_LINK, and has a running Taskmoor container only when $FAKE_RUNNING is set (a real
 * `docker compose ps -q` answers nothing, with success, when none runs).
 */
function fakeDocker(): string {
  const bin = temp('taskmoor-bin-');
  const script = join(bin, 'docker');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      '[ "$1" = compose ] || exit 0',
      'shift',
      'for a in "$@"; do',
      '  case "$a" in',
      '    ps) [ -n "$FAKE_RUNNING" ] && echo 0123456789ab; exit 0 ;;',
      `    logs) printf '{"msg":"first-run setup","link":"%s"}\\n' "$FAKE_LINK"; exit 0 ;;`,
      '  esac',
      'done',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return bin;
}

function install(env: Record<string, string>, dotEnv = ''): { code: number; out: string } {
  const kit = temp('taskmoor-compose-');
  copyFileSync(join(ROOT, 'deploy/compose/install.sh'), join(kit, 'install.sh'));
  writeFileSync(join(kit, '.env'), `POSTGRES_PASSWORD=x\n${dotEnv}`);
  try {
    const out = execFileSync('bash', ['install.sh'], {
      cwd: kit,
      env: {
        PATH: `${fakeDocker()}${delimiter}${process.env.PATH ?? ''}`,
        HOME: kit,
        // Sockets on Windows need it, and the port check opens one.
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        ...env,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

const listen = (): Promise<{ server: Server; port: number }> =>
  new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });

/** A port nothing listens on: one the system just handed out and took back. */
async function freePort(): Promise<number> {
  const { server, port } = await listen();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const TOKEN = 'abcDEF123_-';

describe('the Compose kit install.sh (OPS-001)', () => {
  // T-023: with TASKMOOR_PORT moved off 8080 the air-gap install printed a link to 8080, the
  // port inside the container, so it led nowhere.
  it('[OPS-001] prints the setup link on the published port when no PUBLIC_URL is set', async () => {
    const port = await freePort();
    const result = install({
      TASKMOOR_PORT: String(port),
      FAKE_LINK: `http://localhost:8080/#/setup?token=${TOKEN}`,
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Taskmoor is running on port ${port}.`);
    expect(result.out).toContain(`  http://localhost:${port}/#/setup?token=${TOKEN}`);
    expect(result.out).not.toContain('localhost:8080');
  });

  it('[OPS-001] leaves the link as the backend made it from PUBLIC_URL', async () => {
    const port = await freePort();
    const link = `https://tracker.example.com/#/setup?token=${TOKEN}`;
    const inEnv = install(
      { TASKMOOR_PORT: String(port), FAKE_LINK: link },
      'PUBLIC_URL=https://tracker.example.com\n',
    );
    expect(inEnv.out).toContain(`  ${link}`);
    // Set to the container's own address on purpose, it is kept too.
    const own = `http://localhost:8080/#/setup?token=${TOKEN}`;
    const given = install({
      TASKMOOR_PORT: String(port),
      PUBLIC_URL: 'http://localhost:8080',
      FAKE_LINK: own,
    });
    expect(given.out).toContain(`  ${own}`);
  });

  // T-023: on a Mac the check never saw a taken port (no ss, and netstat's other format), and
  // nowhere did it stop, since `docker compose ps -q` succeeds when nothing runs.
  it('[OPS-001] stops before starting anything when another program holds the port', async () => {
    const { server, port } = await listen();
    try {
      const result = install({ TASKMOOR_PORT: String(port), FAKE_LINK: '' });
      expect(result.code).toBe(1);
      expect(result.out).toContain(`port ${port} is in use; set TASKMOOR_PORT in .env`);
      expect(result.out).not.toContain('starting Taskmoor');
    } finally {
      server.close();
    }
  });

  it('[OPS-001] goes on when the port is its own running Taskmoor, as on a second run', async () => {
    const { server, port } = await listen();
    try {
      const result = install({ TASKMOOR_PORT: String(port), FAKE_RUNNING: '1', FAKE_LINK: '' });
      expect(result.code).toBe(0);
      expect(result.out).toContain(
        `Setup is already complete; sign in at http://127.0.0.1:${port}/`,
      );
    } finally {
      server.close();
    }
  });
});

/**
 * Windows PowerShell on Windows; elsewhere PowerShell 7 (`pwsh`) where it is installed. Without
 * either (most Macs and Linux machines) the install.ps1 cases are skipped.
 */
const powershell =
  process.platform === 'win32'
    ? 'powershell.exe'
    : spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0
      ? 'pwsh'
      : undefined;

/**
 * The stand-in Docker for install.ps1: Compose starts at once and logs the setup link in
 * %FAKE_LINK%. A batch file on Windows (PowerShell finds commands by their extension there),
 * the shell script of install.sh's cases elsewhere.
 */
function fakeDockerForPowerShell(): string {
  if (process.platform !== 'win32') return fakeDocker();
  const bin = temp('taskmoor-bin-');
  writeFileSync(
    join(bin, 'docker.cmd'),
    [
      '@echo off',
      'if not "%1"=="compose" exit /b 0',
      'for %%a in (%*) do if "%%a"=="logs" (echo {"msg":"first-run setup","link":"%FAKE_LINK%"}& exit /b 0)',
      'exit /b 0',
      '',
    ].join('\r\n'),
  );
  return bin;
}

/** A backend stand-in that is ready at once, on a port of its own; install.ps1 asks the host. */
const readyBackend = (): Promise<{ close: () => void; port: number }> =>
  new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      res.writeHead(req.url === '/ready' ? 200 : 404).end();
    }).listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        close: () => server.close(),
        port: typeof address === 'object' && address ? address.port : 0,
      });
    });
  });

/** Runs install.ps1 without blocking, so the backend stand-in in this process can answer it. */
function installPs1(
  env: Record<string, string>,
  dotEnv = '',
): Promise<{ code: number; out: string }> {
  const kit = temp('taskmoor-compose-');
  copyFileSync(join(ROOT, 'deploy/compose/install.ps1'), join(kit, 'install.ps1'));
  writeFileSync(join(kit, '.env'), `POSTGRES_PASSWORD=x\n${dotEnv}`);
  // This machine's own environment (PowerShell needs much of it), without what the script reads.
  const base: Record<string, string | undefined> = { ...process.env };
  const pathKey = Object.keys(base).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const path = base[pathKey] ?? '';
  for (const k of Object.keys(base)) {
    if (['PATH', 'DATABASE_URL', 'PUBLIC_URL', 'TASKMOOR_PORT'].includes(k.toUpperCase())) {
      delete base[k];
    }
  }
  return new Promise((resolve) => {
    execFile(
      powershell as string,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'install.ps1'],
      {
        cwd: kit,
        env: { ...base, PATH: `${fakeDockerForPowerShell()}${delimiter}${path}`, ...env },
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

describe.skipIf(!powershell)('the Compose kit install.ps1 (OPS-001)', () => {
  // T-235: the Windows script printed a link to 8080, the port inside the container, whatever
  // TASKMOOR_PORT published, as install.sh did before T-023.
  it('[OPS-001] prints the setup link on the published port when no PUBLIC_URL is set', async () => {
    const backend = await readyBackend();
    try {
      const result = await installPs1({
        TASKMOOR_PORT: String(backend.port),
        FAKE_LINK: `http://localhost:8080/#/setup?token=${TOKEN}`,
      });
      expect(result.out).toContain(`Taskmoor is running on port ${backend.port}.`);
      expect(result.out).toContain(`  http://localhost:${backend.port}/#/setup?token=${TOKEN}`);
      expect(result.out).not.toContain('localhost:8080');
      expect(result.code).toBe(0);
    } finally {
      backend.close();
    }
  });

  it('[OPS-001] leaves the link as the backend made it from PUBLIC_URL', async () => {
    const backend = await readyBackend();
    try {
      const link = `https://tracker.example.com/#/setup?token=${TOKEN}`;
      const inEnv = await installPs1(
        { TASKMOOR_PORT: String(backend.port), FAKE_LINK: link },
        'PUBLIC_URL=https://tracker.example.com\n',
      );
      expect(inEnv.out).toContain(`  ${link}`);
      // Set to the container's own address on purpose, it is kept too.
      const own = `http://localhost:8080/#/setup?token=${TOKEN}`;
      const given = await installPs1({
        TASKMOOR_PORT: String(backend.port),
        PUBLIC_URL: 'http://localhost:8080',
        FAKE_LINK: own,
      });
      expect(given.out).toContain(`  ${own}`);
    } finally {
      backend.close();
    }
  });
});
