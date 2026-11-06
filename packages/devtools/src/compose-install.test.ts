import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The Compose kit's install.sh (OPS-001) with a stand-in for Docker: the port check and the
 * setup link it prints. The real install runs in tools/image/smoke-kits.sh and the air-gap test.
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
