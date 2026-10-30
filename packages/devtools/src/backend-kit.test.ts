import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backendKit,
  buildKits,
  generateSecrets,
  systemRandom,
  validateInputs,
} from '@taskmoor/builder-core';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The backend kit's preflight (M1-110; OPS-015): `install.sh --preflight` on this machine, with
 * a stand-in for Docker, so missing Docker, a taken port and a name that does not resolve are
 * each caught before anything starts. The full install runs in tools/image/smoke-backend-kit.sh.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function kitDir(backendUrl: string, env: Record<string, string> = {}): Promise<string> {
  const form = validateInputs({ backendUrl, frontendUrl: `${backendUrl}/` });
  if (!form.ok) throw new Error(JSON.stringify(form.problems));
  const kits = await buildKits(
    form.inputs,
    await generateSecrets(systemRandom),
    {},
    {
      backendVersion: '1.4.2',
      kitVersion: '1.4.2',
    },
  );
  const dir = mkdtempSync(join(tmpdir(), 'taskmoor-kit-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(backendKit(kits, form.inputs))) {
    writeFileSync(join(dir, path), text);
  }
  const extra = Object.entries(env)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
  if (extra) writeFileSync(join(dir, '.env'), extra, { flag: 'a' });
  return dir;
}

/** A PATH whose docker does what the case needs; none at all for a machine without Docker. */
function fakeDocker(kind: 'working' | 'absent' | 'stopped'): string {
  const bin = mkdtempSync(join(tmpdir(), 'taskmoor-bin-'));
  dirs.push(bin);
  if (kind !== 'absent') {
    const script = join(bin, 'docker');
    writeFileSync(
      script,
      `#!/bin/sh\ncase "$1 $2" in\n  "compose version") exit 0 ;;\n  "compose ps") exit 0 ;;\n  "info "*) exit ${kind === 'stopped' ? 1 : 0} ;;\nesac\nexit 0\n`,
    );
    chmodSync(script, 0o755);
  }
  mkdirSync(join(bin, 'empty'), { recursive: true });
  return bin;
}

function preflight(dir: string, bin: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', ['install.sh', '--preflight'], {
      cwd: dir,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir },
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

describe('the backend kit preflight (M1-110)', () => {
  it('[OPS-015] passes on a machine with Docker, free ports and a name that resolves', async () => {
    const dir = await kitDir('https://localhost', {
      TASKMOOR_HTTP_PORT: '1',
      TASKMOOR_HTTPS_PORT: '2',
    });
    const result = preflight(dir, fakeDocker('working'));
    expect(result.out).toContain('preflight passed');
    expect(result.code).toBe(0);
  });

  it('[OPS-015] catches a machine without Docker, or with Docker stopped', async () => {
    const dir = await kitDir('https://localhost');
    expect(preflight(dir, fakeDocker('absent'))).toMatchObject({ code: 1 });
    expect(preflight(dir, fakeDocker('absent')).out).toContain('Docker is not installed');
    expect(preflight(dir, fakeDocker('stopped')).out).toContain(
      'Docker is installed but not running',
    );
  });

  it('[OPS-015] catches a port something else holds', async () => {
    const { server, port } = await listen();
    try {
      const dir = await kitDir('https://localhost', {
        TASKMOOR_HTTP_PORT: String(port),
        TASKMOOR_HTTPS_PORT: '2',
      });
      const result = preflight(dir, fakeDocker('working'));
      expect(result.code).toBe(1);
      expect(result.out).toContain(`port ${port} is in use`);
    } finally {
      server.close();
    }
  });

  it('[OPS-015] catches a name with no DNS record yet', async () => {
    const dir = await kitDir('https://api.taskmoor.invalid', {
      TASKMOOR_HTTP_PORT: '1',
      TASKMOOR_HTTPS_PORT: '2',
    });
    const result = preflight(dir, fakeDocker('working'));
    expect(result.code).toBe(1);
    expect(result.out).toContain('api.taskmoor.invalid does not resolve');
  });
});
