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

/** The RUN step that matches, as the shell script it hands to /bin/sh (its flags left out). */
function runScript(pattern: RegExp, what: string): string {
  const step = instructions().find((i) => /^RUN\b/.test(i) && pattern.test(i));
  if (!step) throw new Error(`no RUN step runs \`${what}\``);
  return step.replace(/^RUN\s+(--\S+\s+)*/, '');
}

/** The step that fetches pnpm. */
const pnpmFetchScript = () => runScript(/corepack install\b/, 'corepack install');

/** The dependency install step. */
const installScript = () => runScript(/\bpnpm install\b/, 'pnpm install');

/** The install step's RUN flags, such as its mounts. */
function installFlags(): string[] {
  const step = instructions().find((i) => /^RUN\b/.test(i) && /\bpnpm install\b/.test(i)) ?? '';
  return (
    step
      .match(/^RUN\s+((--\S+\s+)*)/)?.[1]
      ?.trim()
      .split(/\s+/) ?? []
  );
}

/** An ARG's default in the Dockerfile. */
const argDefault = (name: string) => DOCKERFILE.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1];

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

// The dependency install had pnpm's defaults and no limit: on a slow link one build took 51
// minutes, with quiet stretches of 16 to 18, and another made no progress for over an hour and
// was stopped by hand (T-247, found by T-023).
describe('the image build installing dependencies', () => {
  const INSTALL_ARGS = [
    'PNPM_INSTALL_TIMEOUT',
    'PNPM_INSTALL_FETCH_TIMEOUT',
    'PNPM_INSTALL_FETCH_RETRIES',
    'PNPM_INSTALL_NETWORK_CONCURRENCY',
  ];

  it('[OPS-001] bounds the step to an hour unless raised, and pnpm’s downloads in it', () => {
    expect(Object.fromEntries(INSTALL_ARGS.map((a) => [a, argDefault(a)]))).toEqual({
      PNPM_INSTALL_TIMEOUT: '3600',
      PNPM_INSTALL_FETCH_TIMEOUT: '60',
      PNPM_INSTALL_FETCH_RETRIES: '5',
      PNPM_INSTALL_NETWORK_CONCURRENCY: '8',
    });
    expect(installScript()).toMatch(
      /timeout "\$PNPM_INSTALL_TIMEOUT" pnpm install --frozen-lockfile/,
    );
  });

  // Each argument is declared after the last manifest is copied: a changed value runs the install
  // again and keeps the base image, pnpm's fetch and the manifests' layers.
  it('[OPS-001] declares its arguments after the manifests, so a changed value busts no earlier layer', () => {
    const install = indexOf(/^RUN\b.*\bpnpm install\b/);
    const lastManifest = instructions().reduce(
      (last, i, n) => (/^COPY \S+\/package\.json\b/.test(i) ? n : last),
      -1,
    );
    expect(lastManifest).toBeGreaterThan(-1);
    for (const arg of INSTALL_ARGS) {
      const declared = indexOf(new RegExp(`^ARG ${arg}=`));
      expect(declared, arg).toBeGreaterThan(lastManifest);
      expect(declared, arg).toBeLessThan(install);
      // Read by this step alone.
      expect(
        instructions().filter((i) => i.includes(arg) && !/^ARG /.test(i)),
        arg,
      ).toHaveLength(1);
    }
  });

  it('[NFR-008] keeps the lockfile frozen and every check on, with no .npmrc in the image', () => {
    const script = installScript();
    expect(script).toContain('pnpm install --frozen-lockfile --ignore-scripts');
    // The network settings go in through the step's environment, nothing written to a file.
    expect(script).not.toMatch(/npmrc|pnpm config set/);
    expect(DOCKERFILE).not.toMatch(
      /no-frozen-lockfile|frozen-lockfile=false|verify[-_]store[-_]integrity|strict[-_]ssl|registry=|--force\b|--fix-lockfile|NODE_TLS_REJECT_UNAUTHORIZED/,
    );
    // pnpm's store is a build cache, kept between builds and never a layer of the image.
    expect(installFlags()).toContain(
      '--mount=type=cache,id=taskmoor-pnpm-store,target=/pnpm/store,sharing=locked',
    );
    expect(script).toContain('npm_config_store_dir=/pnpm/store');
  });

  it('[OPS-001] is described in the manual with its limit and the arguments that change it', () => {
    const manual = readFileSync(join(ROOT, 'docs/manual/admin/install.md'), 'utf8')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    expect(manual).toContain(`after ${Number(argDefault('PNPM_INSTALL_TIMEOUT')) / 60} minutes`);
    for (const arg of ['PNPM_INSTALL_TIMEOUT', 'PNPM_INSTALL_NETWORK_CONCURRENCY']) {
      expect(manual).toContain(`--build-arg ${arg.toLowerCase()}=`);
    }
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
 * `sleep` returns at once. `pnpm` writes its arguments and its settings from the environment,
 * then does as PNPM_PLAN says, in the same words. Every call is written to CALLS.
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
    pnpm: [
      'echo "pnpm $*" >> "$CALLS"',
      'env | grep "^npm_config_" | sort >> "$CALLS"',
      'case "$PNPM_PLAN" in ok) exit 0 ;; stall) exec /bin/sleep 30 ;; *) echo "ERR_PNPM_FETCH_404" >&2; exit 1 ;; esac',
    ],
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

/** The Dockerfile's own install step, run with the stand-ins and its arguments' defaults. */
function installDeps(plan: string, limit = argDefault('PNPM_INSTALL_TIMEOUT') ?? '') {
  const bin = fakeBin();
  const calls = join(bin, 'calls');
  const args = Object.fromEntries(
    [
      'PNPM_INSTALL_FETCH_TIMEOUT',
      'PNPM_INSTALL_FETCH_RETRIES',
      'PNPM_INSTALL_NETWORK_CONCURRENCY',
    ].map((a) => [a, argDefault(a) ?? '']),
  );
  const result = spawnSync('sh', ['-c', installScript()], {
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      CALLS: calls,
      PNPM_PLAN: plan,
      PNPM_INSTALL_TIMEOUT: limit,
      ...args,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const log = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
  return { status: result.status, stderr: result.stderr, log };
}

describe.skipIf(!hasSh || process.platform === 'win32')('the image’s install step, run', () => {
  it('[OPS-001] gives pnpm the bounded network settings and the frozen lockfile', () => {
    const run = installDeps('ok');
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.log).toEqual([
      'timeout 3600',
      'pnpm install --frozen-lockfile --ignore-scripts --filter @taskmoor/server... --filter @taskmoor/web...',
      'npm_config_fetch_retries=5',
      'npm_config_fetch_retry_maxtimeout=120000',
      'npm_config_fetch_retry_mintimeout=10000',
      'npm_config_fetch_timeout=60000',
      'npm_config_network_concurrency=8',
      'npm_config_store_dir=/pnpm/store',
      'npm_config_update_notifier=false',
    ]);
  });

  it('[OPS-001] stops a stalled install at its limit and says which argument to raise', () => {
    // Left alone, the stalled install would end by itself after 30 s, and succeed.
    const run = installDeps('stall', '1');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('pnpm install: stopped after 1 s');
    expect(run.stderr).toContain('--build-arg PNPM_INSTALL_TIMEOUT=7200');
  });

  it('[OPS-001] passes another failure through as it is, without blaming the limit', () => {
    const run = installDeps('fail');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('ERR_PNPM_FETCH_404');
    expect(run.stderr).not.toContain('stopped after');
  });
});
