import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

/** Every workspace package, as apps/<name> or packages/<name>. */
function workspacePackages(): string[] {
  return ['apps', 'packages'].flatMap((dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${dir}/${e.name}`),
  );
}

/** The Dockerfile's instructions as Docker reads them: comments left out, continuations joined. */
function instructions(): string[] {
  const out: string[] = [];
  let current = '';
  for (const line of DOCKERFILE.split(/\r?\n/)) {
    if (current === '' && (line.trim() === '' || line.trimStart().startsWith('#'))) continue;
    if (line.endsWith('\\')) {
      current += line.slice(0, -1);
      continue;
    }
    out.push(current + line);
    current = '';
  }
  return out;
}

/** The index of the first instruction that matches. */
const indexOf = (pattern: RegExp) => instructions().findIndex((i) => pattern.test(i));

/** The step that fetches pnpm, as the shell script a RUN hands to /bin/sh (its flags left out). */
function pnpmFetchScript(): string {
  const step = instructions().find((i) => /^RUN\b/.test(i) && /corepack install\b/.test(i));
  if (!step) throw new Error('no RUN step runs `corepack install`');
  return step.replace(/^RUN\s+(--\S+\s+)*/, '');
}

describe('Dockerfile', () => {
  // The install layer copies manifests one by one so it caches across source changes; a package
  // missing from the list installs without its dependencies and the bundle step fails.
  it('[OPS-001] copies the manifest of every workspace package before installing', () => {
    const missing = workspacePackages().filter(
      (p) => !DOCKERFILE.includes(`COPY ${p}/package.json ${p}/`),
    );
    expect(missing).toEqual([]);
  });
});

// Corepack fetched pnpm inside the dependency install, with no retry and no time limit: on a
// slow link that step stalled and the build had to be restarted by hand, and a dropped
// connection failed it (T-236, found by T-023).
describe('the image build fetching pnpm', () => {
  it('[OPS-001] fetches pnpm in a step of its own, after package.json and before any install', () => {
    const fetch = indexOf(/^RUN\b.*corepack install\b/);
    expect(fetch).toBeGreaterThan(-1);
    expect(indexOf(/^COPY package\.json\b/)).toBeLessThan(fetch);
    expect(fetch).toBeLessThan(indexOf(/\bpnpm install\b/));
  });

  it('[NFR-008] keeps pnpm pinned and checked, and fetched nowhere else', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      packageManager?: string;
    };
    // An exact version (a hash may follow), which `corepack install` without a name reads.
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+(\+sha(256|512)\.[0-9a-f]+)?$/);
    expect(pnpmFetchScript()).toMatch(/corepack install(\s*;|\s*$)/);
    // Nothing turns off corepack's signature check or TLS, or asks for a version of its own.
    expect(DOCKERFILE).not.toMatch(
      /COREPACK_INTEGRITY_KEYS|COREPACK_ENABLE_STRICT|NODE_TLS_REJECT_UNAUTHORIZED|strict-ssl|corepack prepare|corepack use|pnpm@/,
    );
    expect(DOCKERFILE).toContain('pnpm install --frozen-lockfile');
    // After the fetch, corepack may not reach the network: a later step cannot stall on it.
    const offline = indexOf(/^ENV\s+COREPACK_ENABLE_NETWORK=0\b/);
    expect(offline).toBeGreaterThan(indexOf(/^RUN\b.*corepack install\b/));
    expect(offline).toBeLessThan(indexOf(/\bpnpm install\b/));
  });

  it('[OPS-001] stops each attempt after a bounded time, five minutes unless raised', () => {
    const limit = DOCKERFILE.match(/^ARG PNPM_FETCH_TIMEOUT=(\d+)$/m)?.[1];
    expect(Number(limit)).toBe(300);
    expect(pnpmFetchScript()).toContain('timeout "$PNPM_FETCH_TIMEOUT" corepack install');
  });

  // The manual once said a failed download "is tried again, up to four times": five attempts to
  // a reader, where the build makes four in all.
  it('[OPS-001] is described in the manual with the number of attempts the build makes', () => {
    const attempts = Number(pnpmFetchScript().match(/"\$attempt" -ge (\d+)/)?.[1]);
    const words = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
    expect(words[attempts]).toBeDefined();
    const manual = readFileSync(join(ROOT, 'docs/manual/admin/install.md'), 'utf8')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    expect(manual).toContain(`in up to ${words[attempts]} attempts`);
    expect(manual).not.toMatch(/tried again,? up to \w+ times/);
  });
});

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0 && existsSync('/bin/sleep');
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Stand-ins for corepack, timeout and sleep. Each call of corepack takes the next word of
 * COREPACK_PLAN: `fail` exits 1 as a dropped connection does, `stall` waits as a download that
 * never finishes does, `ok` succeeds. `timeout` stops its command after the seconds it is given;
 * `sleep` returns at once. Every call is written to CALLS.
 */
function fakeBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'taskmoor-pnpm-fetch-'));
  dirs.push(bin);
  const scripts: Record<string, string[]> = {
    corepack: [
      'n=$(grep -c "^corepack" "$CALLS" 2>/dev/null)',
      '[ -n "$n" ] || n=0',
      'n=$((n + 1))',
      'echo "corepack $*" >> "$CALLS"',
      'step=$(echo "$COREPACK_PLAN" | awk -v n="$n" \'{ print $n }\')',
      'case "$step" in ok) exit 0 ;; stall) exec /bin/sleep 30 ;; *) exit 1 ;; esac',
    ],
    timeout: [
      'limit=$1; shift',
      'echo "timeout $limit" >> "$CALLS"',
      '"$@" &',
      'pid=$!',
      '( /bin/sleep "$limit"; kill "$pid" ) >/dev/null 2>&1 &',
      'watch=$!',
      'wait "$pid"; status=$?',
      'kill "$watch" 2>/dev/null',
      'exit "$status"',
    ],
    sleep: ['echo "sleep $*" >> "$CALLS"'],
  };
  for (const [name, lines] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${lines.join('\n')}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

/** The Dockerfile's own pnpm step, run with the stand-ins and a one-second limit per attempt. */
function fetchPnpm(plan: string) {
  const bin = fakeBin();
  const calls = join(bin, 'calls');
  const result = spawnSync('sh', ['-c', pnpmFetchScript()], {
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      CALLS: calls,
      COREPACK_PLAN: plan,
      PNPM_FETCH_TIMEOUT: '1',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const log = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
  return {
    status: result.status,
    stderr: result.stderr,
    attempts: log.filter((l) => l.startsWith('corepack')).length,
    log,
  };
}

// The image builds on Linux with BusyBox's sh; this runs the same POSIX script on the host's sh.
// Git's sh on Windows is left out: the stand-in for timeout needs real background processes.
describe.skipIf(!hasSh || process.platform === 'win32')('the image’s pnpm step, run', () => {
  it('[OPS-001] tries a dropped download again until one succeeds', () => {
    const run = fetchPnpm('fail fail ok');
    expect(run.status).toBe(0);
    expect(run.log).toEqual([
      'timeout 1',
      'corepack install',
      'sleep 15',
      'timeout 1',
      'corepack install',
      'sleep 30',
      'timeout 1',
      'corepack install',
    ]);
  });

  it('[OPS-001] stops a stalled download and tries again, instead of hanging', () => {
    // Left alone, the stalled attempt would end by itself after 30 s and count as the only one.
    const run = fetchPnpm('stall ok');
    expect(run.status).toBe(0);
    expect(run.attempts).toBe(2);
    expect(run.log.slice(0, 3)).toEqual(['timeout 1', 'corepack install', 'sleep 15']);
  });

  it('[OPS-001] gives up with a reason after a bounded number of attempts', () => {
    const run = fetchPnpm('fail fail fail fail fail fail fail fail');
    expect(run.status).not.toBe(0);
    expect(run.attempts).toBe(4);
    expect(run.stderr).toContain('pnpm: no download after 4 attempts');
  });
});
