import { execFile, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  backendKit,
  buildKits,
  generateSecrets,
  systemRandom,
  validateInputs,
} from '@taskmoor/builder-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The one update command (OPS-025, ADR-117), both kits: the real `update.sh` and `upgrade.sh` in
 * Git Bash or bash, with a stand-in for Docker, a throwaway signing key and a fake release source
 * on loopback. Nothing here reaches GitHub or a registry; `tools/image/smoke-backend-kit.sh` is
 * where a real Docker runs a kit.
 */
const REPO = resolve(__dirname, '../../..');
const DIGEST = `sha256:${'ab'.repeat(32)}`;
const OLD_IMAGE = 'ghcr.io/rockersands/taskmoor:1.2.0';
const NEW_IMAGE = `ghcr.io/rockersands/taskmoor:1.4.0@${DIGEST}`;
const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const execute = promisify(execFile);

/** A release key that is only ever a test's. The kits get its public half in place of the real one. */
const keys = temp('taskmoor-keys-');
const signingKey = join(keys, 'key.pem');
const publicKey = join(keys, 'public.pem');
const otherKey = join(keys, 'other.pem');
const pair = () =>
  generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
const release = pair();
writeFileSync(signingKey, release.privateKey);
writeFileSync(publicKey, release.publicKey);
writeFileSync(otherKey, pair().privateKey);

/** The tools of this machine, with no Docker among them, as in backend-kit.test.ts. */
let systemTools: string | undefined;
function tools(): string {
  if (systemTools) return systemTools;
  if (process.platform === 'win32') {
    const gitCore = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    // Git for Windows keeps bash in usr/bin and curl in mingw64/bin.
    systemTools = [resolve(gitCore, '../../../usr/bin'), resolve(gitCore, '../../bin')].join(
      delimiter,
    );
    return systemTools;
  }
  const dir = temp('taskmoor-tools-');
  for (const from of ['/usr/bin', '/bin']) {
    if (!existsSync(from)) continue;
    for (const name of readdirSync(from)) {
      if (name.startsWith('docker') || existsSync(join(dir, name))) continue;
      symlinkSync(join(from, name), join(dir, name));
    }
  }
  systemTools = dir;
  return dir;
}

/** Signs a release with the project's own tool: what a maintainer attaches to a release. */
function signedRelease(
  out: string,
  version: string,
  image: string,
  env: Record<string, string> = {},
): void {
  execFileSync('bash', ['tools/release/sign-update-manifest.sh', version, image, out], {
    cwd: REPO,
    env: {
      PATH: `${tools()}${delimiter}${process.env.PATH ?? ''}`,
      SIGNING_KEY: signingKey,
      PUBLIC_KEY: publicKey,
      ...env,
    },
    stdio: 'pipe',
  });
}

/** The fake releases: `/latest` answers like GitHub, `/download/<tag>/<file>` serves files. */
interface FakeReleases {
  url: string;
  requests: { method: string; url: string; headers: Record<string, unknown> }[];
  latest: () => string | number;
  publish: (tag: string, files: Record<string, string>) => void;
  setLatest: (answer: string | number) => void;
  close: () => Promise<void>;
}
async function fakeReleases(): Promise<FakeReleases> {
  const files = new Map<string, string>();
  let latest: string | number = 404;
  const requests: FakeReleases['requests'] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (req.url === '/latest') {
      if (typeof latest === 'number') {
        res.writeHead(latest).end('{"message":"Not Found"}');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end(latest);
      }
      return;
    }
    const body = files.get(req.url ?? '');
    if (body === undefined) res.writeHead(404).end();
    else res.writeHead(200).end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    latest: () => latest,
    publish: (tag, published) => {
      for (const [name, body] of Object.entries(published)) {
        files.set(`/download/${tag}/${name}`, body);
      }
    },
    setLatest: (answer) => {
      latest = answer;
    },
    close: () => new Promise((done) => server.close(() => done())),
  };
}

const githubAnswer = (tag: string) =>
  `${JSON.stringify({ url: 'x', tag_name: tag, draft: false, prerelease: false, body: 'notes' }, null, 2)}\n`;

/** A stand-in for Docker: logs every call and answers as the case asks. */
function fakeDocker(): string {
  const bin = temp('taskmoor-bin-');
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case " $* " in
  *" compose version "*|" info "*) exit 0 ;;
  *" config --services "*) printf 'postgres-tls\\npostgres\\ntaskmoor\\n'; exit 0 ;;
  *" ps -q taskmoor "*) echo cid; exit 0 ;;
  *" inspect --format "*) echo "$FAKE_RUNNING"; exit 0 ;;
  *" image inspect "*) exit 1 ;;
  " pull "*) exit \${FAKE_PULL_EXIT:-0} ;;
  *" run --rm -T taskmoor node cli.mjs upgrade --dry-run "*) echo "the plan"; exit \${FAKE_UPGRADE_EXIT:-0} ;;
  *" run --rm -T taskmoor node cli.mjs upgrade "*) exit \${FAKE_UPGRADE_EXIT:-0} ;;
  *" exec -T taskmoor node cli.mjs frontends "*) printf '%s' "$FAKE_FRONTENDS"; exit \${FAKE_FRONTENDS_EXIT:-0} ;;
  *" exec -T taskmoor node -e "*) exit \${FAKE_READY_EXIT:-0} ;;
  *" exec -T postgres psql "*) echo on; exit 0 ;;
  *" exec -T postgres pg_isready "*) exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  // upgrade.sh waits a second between readiness tries; here it need not.
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'sleep'), 0o755);
  return bin;
}

/** The Compose kit as a person has it, with the test's public key beside the scripts. */
function composeKit(env = `TASKMOOR_IMAGE=${OLD_IMAGE}\n`): string {
  const dir = temp('taskmoor-compose-');
  for (const name of ['update.sh', 'upgrade.sh', 'docker-compose.yml']) {
    copyFileSync(join(REPO, 'deploy/compose', name), join(dir, name));
  }
  copyFileSync(publicKey, join(dir, 'taskmoor-release.pub'));
  writeFileSync(join(dir, '.env'), `POSTGRES_PASSWORD=x\n${env}`);
  return dir;
}

/** The Builder's backend kit, with the test's public key; its image is the given version. */
async function builderKit(frontendUrl: string, version = '1.2.0'): Promise<string> {
  const form = validateInputs({ backendUrl: 'https://api.acme.example', frontendUrl });
  if (!form.ok) throw new Error(JSON.stringify(form.problems));
  const kits = await buildKits(
    form.inputs,
    await generateSecrets(systemRandom),
    {},
    { backendVersion: version, kitVersion: version },
  );
  const dir = temp('taskmoor-kit-');
  for (const [path, text] of Object.entries(backendKit(kits, form.inputs))) {
    writeFileSync(join(dir, path), text);
  }
  copyFileSync(publicKey, join(dir, 'taskmoor-release.pub'));
  return dir;
}

let releases: FakeReleases;
let bin: string;

beforeAll(async () => {
  releases = await fakeReleases();
  bin = fakeDocker();
  const out = temp('taskmoor-release-');
  signedRelease(out, '1.4.0', `ghcr.io/rockersands/taskmoor@${DIGEST}`);
  releases.publish('v1.4.0', {
    'taskmoor-release.txt': readFileSync(join(out, 'taskmoor-release.txt'), 'utf8'),
    'taskmoor-release.txt.sig': readFileSync(join(out, 'taskmoor-release.txt.sig'), 'utf8'),
  });
  releases.setLatest(githubAnswer('v1.4.0'));
});

afterAll(async () => {
  await releases.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  docker: string[];
  env: string;
}

async function update(
  kit: string,
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<Run> {
  const log = join(kit, 'docker.log');
  writeFileSync(log, '');
  let code = 0;
  let out: string;
  try {
    const done = await execute('bash', ['update.sh', ...args], {
      cwd: kit,
      env: {
        PATH: `${bin}${delimiter}${tools()}`,
        HOME: kit,
        FAKE_LOG: log,
        FAKE_RUNNING: OLD_IMAGE,
        FAKE_FRONTENDS: '',
        TASKMOOR_RELEASES_URL: `${releases.url}/latest`,
        TASKMOOR_RELEASE_DOWNLOADS: `${releases.url}/download`,
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        ...env,
      },
    });
    out = `${done.stdout}${done.stderr}`;
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    code = e.code;
    out = `${e.stdout}${e.stderr}`;
  }
  return {
    code,
    out,
    docker: readFileSync(log, 'utf8').split('\n').filter(Boolean),
    env: readFileSync(join(kit, '.env'), 'utf8'),
  };
}

const called = (run: Run, words: string) => run.docker.some((line) => line.includes(words));
const lastLine = (run: Run) => run.out.trim().split('\n').at(-1) ?? '';

describe.each([
  ['deploy/compose', () => composeKit()],
  ['the Builder backend kit', () => builderKit('https://api.acme.example/')],
])('update.sh in %s', (_name, makeKit) => {
  it('[OPS-025] finds the newest release, verifies it and runs the upgrade with the signed image', async () => {
    const kit = await makeKit();
    const before = releases.requests.length;
    const run = await update(kit);
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain('verified: release 1.4.0 is signed');
    expect(lastLine(run)).toBe('Updated: Taskmoor 1.4.0 is running.');
    // The image is pulled by the digest the signature names, and recorded in .env.
    expect(called(run, `pull ${NEW_IMAGE}`)).toBe(true);
    expect(called(run, 'run --rm -T taskmoor node cli.mjs upgrade')).toBe(true);
    expect(run.env).toContain(`TASKMOOR_IMAGE=${NEW_IMAGE}\n`);
    // Plain requests for public files: nothing about the install.
    const sent = releases.requests.slice(before);
    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /latest',
      'GET /download/v1.4.0/taskmoor-release.txt',
      'GET /download/v1.4.0/taskmoor-release.txt.sig',
    ]);
    expect(Object.keys(sent[0]?.headers ?? {}).sort()).toEqual(['accept', 'host', 'user-agent']);
  });

  it('[OPS-025] with --dry-run says what it would do and changes nothing', async () => {
    const kit = await makeKit();
    const envBefore = readFileSync(join(kit, '.env'), 'utf8');
    const run = await update(kit, ['--dry-run']);
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain('This is a dry run');
    expect(run.out).toContain('from 1.2.0 to 1.4.0');
    expect(run.out).toContain('the plan');
    expect(called(run, ' stop taskmoor')).toBe(false);
    expect(called(run, ' up -d taskmoor')).toBe(false);
    expect(run.env).toBe(envBefore);
  });

  it('[OPS-025] takes an explicit version without asking for the newest', async () => {
    const kit = await makeKit();
    const before = releases.requests.length;
    const run = await update(kit, ['v1.4.0']);
    expect(run.code, run.out).toBe(0);
    expect(run.env).toContain(`TASKMOOR_IMAGE=${NEW_IMAGE}\n`);
    expect(releases.requests.slice(before).map((r) => r.url)).not.toContain('/latest');
  });
});

describe('update.sh refuses what it cannot verify (OPS-025)', () => {
  const refusesWithoutTouching = (run: Run, why: string) => {
    expect(run.code, run.out).toBe(1);
    expect(run.out).toContain(why);
    expect(run.out).toContain('nothing was changed; 1.2.0 stays as it is.');
    expect(called(run, ' pull ')).toBe(false);
    expect(called(run, ' stop taskmoor')).toBe(false);
    expect(called(run, 'cli.mjs upgrade')).toBe(false);
    expect(run.env).toContain(`TASKMOOR_IMAGE=${OLD_IMAGE}\n`);
  };

  it('[OPS-025] a release with no signed statement', async () => {
    const run = await update(composeKit(), ['1.5.0']);
    refusesWithoutTouching(run, 'release 1.5.0 cannot be verified');
  });

  it('[OPS-025] a statement changed after signing', async () => {
    const out = temp('taskmoor-release-');
    signedRelease(out, '1.5.1', `ghcr.io/rockersands/taskmoor@${DIGEST}`);
    const statement = readFileSync(join(out, 'taskmoor-release.txt'), 'utf8');
    releases.publish('v1.5.1', {
      'taskmoor-release.txt': statement.replace('ab', 'cd'),
      'taskmoor-release.txt.sig': readFileSync(join(out, 'taskmoor-release.txt.sig'), 'utf8'),
    });
    const run = await update(composeKit(), ['1.5.1']);
    refusesWithoutTouching(run, 'its signature does not match taskmoor-release.pub');
  });

  it('[OPS-025] a statement signed with another key', async () => {
    const out = temp('taskmoor-release-');
    // Signed with the wrong key, as a forger would; the tool itself refuses to publish this.
    writeFileSync(
      join(out, 'taskmoor-release.txt'),
      `version=1.5.2\nimage=ghcr.io/evil/taskmoor@${DIGEST}\n`,
    );
    const signature = execFileSync(
      'openssl',
      ['dgst', '-sha256', '-sign', otherKey, join(out, 'taskmoor-release.txt')],
      { env: { PATH: `${tools()}${delimiter}${process.env.PATH ?? ''}` } },
    );
    releases.publish('v1.5.2', {
      'taskmoor-release.txt': readFileSync(join(out, 'taskmoor-release.txt'), 'utf8'),
      'taskmoor-release.txt.sig': signature.toString('base64'),
    });
    const run = await update(composeKit(), ['1.5.2']);
    refusesWithoutTouching(run, 'its signature does not match taskmoor-release.pub');
    expect(run.out).not.toContain('ghcr.io/evil');
  });

  it('[OPS-025] an old release presented as a newer one', async () => {
    const out = temp('taskmoor-release-');
    signedRelease(out, '1.4.0', `ghcr.io/rockersands/taskmoor@${DIGEST}`);
    releases.publish('v1.6.0', {
      'taskmoor-release.txt': readFileSync(join(out, 'taskmoor-release.txt'), 'utf8'),
      'taskmoor-release.txt.sig': readFileSync(join(out, 'taskmoor-release.txt.sig'), 'utf8'),
    });
    const run = await update(composeKit(), ['1.6.0']);
    refusesWithoutTouching(run, "its signature is for version '1.4.0'");
  });

  it('[OPS-025] a kit without the release key, or no way to check a signature', async () => {
    const noKey = composeKit();
    rmSync(join(noKey, 'taskmoor-release.pub'));
    refusesWithoutTouching(await update(noKey), 'no release can be verified');
    const noOpenssl = temp('taskmoor-bin-');
    writeFileSync(join(noOpenssl, 'openssl'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(noOpenssl, 'openssl'), 0o755);
    const run = await update(composeKit(), [], {
      PATH: `${noOpenssl}${delimiter}${bin}${delimiter}${tools()}`,
    });
    refusesWithoutTouching(run, 'its signature does not match');
  });

  it('[OPS-025] a tag that is no version, whatever it holds', async () => {
    const was = releases.latest();
    try {
      const marker = 'update-injected';
      releases.setLatest(githubAnswer(`v1.9.0$(touch ${marker})`));
      const kit = composeKit();
      const run = await update(kit);
      refusesWithoutTouching(run, 'which is not a version like 1.4.0');
      expect(existsSync(join(kit, marker))).toBe(false);
    } finally {
      releases.setLatest(was);
    }
  });

  it('[OPS-025] says so when no release can be found, and how to name one', async () => {
    const was = releases.latest();
    try {
      releases.setLatest(404);
      const run = await update(composeKit());
      refusesWithoutTouching(run, 'could not read the newest release');
      expect(run.out).toContain('bash update.sh 1.4.0');
    } finally {
      releases.setLatest(was);
    }
  });

  it('[OPS-025] an install that contacts no registry is told to use the bundle', async () => {
    const run = await update(composeKit(), [], { TASKMOOR_PULL: 'never' });
    refusesWithoutTouching(run, 'air-gap bundle');
  });

  it('[OPS-025] Docker that is not running stops it before anything is asked', async () => {
    const stopped = temp('taskmoor-bin-');
    writeFileSync(
      join(stopped, 'docker'),
      '#!/bin/sh\ncase "$1" in info) exit 1 ;; esac\nexit 0\n',
    );
    chmodSync(join(stopped, 'docker'), 0o755);
    const run = await update(composeKit(), [], {
      PATH: `${stopped}${delimiter}${tools()}`,
    });
    expect(run.code).toBe(1);
    expect(run.out).toContain('Docker is not running');
  });

  it('[OPS-025] wrong arguments exit with 2', async () => {
    for (const args of [['1.4'], ['--nope'], ['1.4.0', '1.5.0'], ['latest']]) {
      const run = await update(composeKit(), args);
      expect(run.code, args.join(' ')).toBe(2);
      expect(run.docker).toEqual([]);
    }
  });
});

describe('update.sh and versions (OPS-025)', () => {
  it('[OPS-025] reads the release answer in compact JSON too', async () => {
    const was = releases.latest();
    try {
      releases.setLatest(JSON.stringify({ tag_name: 'v1.4.0', body: '"tag_name": "v9.9.9"' }));
      const run = await update(composeKit());
      expect(run.code, run.out).toBe(0);
      expect(lastLine(run)).toBe('Updated: Taskmoor 1.4.0 is running.');
    } finally {
      releases.setLatest(was);
    }
  });

  it('[OPS-025] has nothing to do on the newest version, or a newer one', async () => {
    const same = await update(composeKit(`TASKMOOR_IMAGE=ghcr.io/rockersands/taskmoor:1.4.0\n`));
    expect(same.code, same.out).toBe(0);
    expect(same.out).toContain('nothing to do');
    expect(called(same, 'upgrade')).toBe(false);
    const newer = await update(composeKit(`TASKMOOR_IMAGE=ghcr.io/rockersands/taskmoor:1.10.0\n`));
    expect(newer.code, newer.out).toBe(0);
    expect(newer.out).toContain('newer than the newest release');
  });

  it('[OPS-025] reads the version of an image it recorded itself, tag and digest', async () => {
    const run = await update(composeKit(`TASKMOOR_IMAGE=${NEW_IMAGE}\n`));
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain('Taskmoor 1.4.0 is the version this kit runs');
  });

  it('[OPS-025] refuses to go back to an older version', async () => {
    const run = await update(composeKit(`TASKMOOR_IMAGE=ghcr.io/rockersands/taskmoor:1.5.0\n`), [
      '1.4.0',
    ]);
    expect(run.code).toBe(1);
    expect(run.out).toContain('1.4.0 is older than 1.5.0');
    expect(called(run, 'cli.mjs upgrade')).toBe(false);
  });

  it('[OPS-025] a kit on a registry of its own keeps it, with the signed digest', async () => {
    const run = await update(
      composeKit(`TASKMOOR_IMAGE=registry.acme.example:5000/tm/app:1.2.0\n`),
    );
    expect(run.code, run.out).toBe(0);
    expect(run.env).toContain(`TASKMOOR_IMAGE=registry.acme.example:5000/tm/app:1.4.0@${DIGEST}\n`);
  });

  it('[OPS-025] a local development image goes to the signed registry', async () => {
    const run = await update(composeKit('TASKMOOR_IMAGE=taskmoor:dev\n'));
    expect(run.code, run.out).toBe(0);
    expect(run.env).toContain(`TASKMOOR_IMAGE=${NEW_IMAGE}\n`);
  });
});

describe('update.sh when the upgrade fails (OPS-025, OPS-006)', () => {
  it('[OPS-025] says plainly that it did not complete and that the previous version is back', async () => {
    const run = await update(composeKit(), [], { FAKE_UPGRADE_EXIT: '1' });
    expect(run.code).toBe(1);
    expect(lastLine(run)).toContain('the update to 1.4.0 did not complete');
    expect(lastLine(run)).toContain('1.2.0 is running again');
    expect(lastLine(run)).toContain('database as it was');
    expect(run.env).toContain(`TASKMOOR_IMAGE=${OLD_IMAGE}\n`);
    expect(called(run, ' up -d taskmoor')).toBe(true);
  });

  it('[OPS-025] says plainly when the rollback failed too: the previous version is not back', async () => {
    const run = await update(composeKit(), [], { FAKE_UPGRADE_EXIT: '3' });
    expect(run.code).toBe(3);
    expect(lastLine(run)).toContain('The previous version is NOT back');
    expect(called(run, ' up -d taskmoor')).toBe(false);
  });

  it('[OPS-025] never claims the previous version is back when no backend became ready', async () => {
    const run = await update(composeKit(), [], { FAKE_READY_EXIT: '1' });
    expect(run.code).toBe(4);
    expect(lastLine(run)).toContain('NOT confirmed running');
    expect(run.out).not.toContain('Updated:');
  });

  it('[OPS-025] a failed pull changes nothing and says so', async () => {
    const run = await update(composeKit(), [], { FAKE_PULL_EXIT: '1' });
    expect(run.code).toBe(1);
    expect(lastLine(run)).toContain('did not complete');
    expect(called(run, ' stop taskmoor')).toBe(false);
  });

  it('[OPS-025] a dry run the checks block reports it and changes nothing', async () => {
    const kit = composeKit();
    const run = await update(kit, ['--dry-run'], { FAKE_UPGRADE_EXIT: '1' });
    expect(run.code).toBe(1);
    expect(lastLine(run)).toContain('Nothing was changed');
    expect(run.out).not.toContain('Updated:');
  });
});

describe('update.sh and the frontend (OPS-025)', () => {
  const STEPS = ['load your saved project file', 'Load your saved project file'];
  const mentionsBuilder = (run: Run) => STEPS.some((step) => run.out.includes(step));

  it('[OPS-025] a frontend the backend serves updates with it: not a word more', async () => {
    const kit = await builderKit('https://api.acme.example/');
    const run = await update(kit);
    expect(run.code, run.out).toBe(0);
    expect(mentionsBuilder(run)).toBe(false);
    expect(lastLine(run)).toBe('Updated: Taskmoor 1.4.0 is running.');
  });

  it('[OPS-025] a frontend on another host gets the Builder steps as the last message', async () => {
    const kit = await builderKit('https://tracker.acme.example/');
    const run = await update(kit, [], {
      FAKE_FRONTENDS: 'https://tracker.acme.example\n',
    });
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain('the frontend on another host (https://tracker.acme.example)');
    expect(run.out).toContain('Load your saved project file');
    expect(run.out).toContain('releases/tag/v1.4.0');
    expect(lastLine(run)).toContain('Upload the new frontend');
  });

  it('[OPS-025] names a frontend an administrator registered in the app, too', async () => {
    const run = await update(composeKit(), [], {
      FAKE_FRONTENDS: 'https://a.example\nhttps://b.example\n',
    });
    expect(run.out).toContain('(https://a.example, https://b.example)');
  });

  it('[OPS-025] with a backend that cannot say, falls back to the kit .env', async () => {
    const kit = await builderKit('https://tracker.acme.example/');
    const run = await update(kit, [], { FAKE_FRONTENDS_EXIT: '1' });
    expect(run.out).toContain('(https://tracker.acme.example)');
    const same = await builderKit('https://api.acme.example/');
    const none = await update(same, [], { FAKE_FRONTENDS_EXIT: '1' });
    expect(mentionsBuilder(none)).toBe(false);
  });

  it('[OPS-025] a dry run names the step too, and a failed update does not', async () => {
    const kit = await builderKit('https://tracker.acme.example/');
    const dry = await update(kit, ['--dry-run'], { FAKE_FRONTENDS: 'https://x.example\n' });
    expect(mentionsBuilder(dry)).toBe(true);
    const failed = await update(kit, [], {
      FAKE_FRONTENDS: 'https://x.example\n',
      FAKE_UPGRADE_EXIT: '1',
    });
    expect(mentionsBuilder(failed)).toBe(false);
  });
});

describe('signing a release (OPS-025)', () => {
  it('[OPS-025] refuses a key other than the one the kits carry', () => {
    const out = temp('taskmoor-release-');
    expect(() =>
      signedRelease(out, '1.4.0', `ghcr.io/rockersands/taskmoor@${DIGEST}`, {
        SIGNING_KEY: otherKey,
      }),
    ).toThrow();
  });

  it('[OPS-025] refuses an image without a digest, or something that is no version', () => {
    const out = temp('taskmoor-release-');
    expect(() => signedRelease(out, '1.4.0', 'ghcr.io/rockersands/taskmoor:1.4.0')).toThrow();
    expect(() => signedRelease(out, 'latest', `ghcr.io/rockersands/taskmoor@${DIGEST}`)).toThrow();
  });

  it('[OPS-025] writes the statement update.sh reads', () => {
    const out = temp('taskmoor-release-');
    mkdirSync(out, { recursive: true });
    signedRelease(out, '2.0.1', `ghcr.io/rockersands/taskmoor@${DIGEST}`);
    expect(readFileSync(join(out, 'taskmoor-release.txt'), 'utf8')).toBe(
      `version=2.0.1\nimage=ghcr.io/rockersands/taskmoor@${DIGEST}\n`,
    );
  });
});

describe('the air-gap bundle (OPS-005, OPS-026)', () => {
  it('[OPS-026] its installer turns the new-version check off, and the kit keeps that in .env', () => {
    expect(readFileSync(join(REPO, 'tools/airgap/install-offline.sh'), 'utf8')).toContain(
      'TASKMOOR_UPDATE_CHECK=off bash install.sh',
    );
    const install = readFileSync(join(REPO, 'deploy/compose/install.sh'), 'utf8');
    expect(install).toContain(`printf 'TASKMOOR_UPDATE_CHECK=%s\\n'`);
    for (const file of ['docker-compose.yml', 'docker-compose.external.yml']) {
      expect(readFileSync(join(REPO, 'deploy/compose', file), 'utf8')).toContain(
        'TASKMOOR_UPDATE_CHECK: ',
      );
    }
    // The bundle's kit is complete: update.sh and the key travel with upgrade.sh.
    const bundle = readFileSync(join(REPO, 'tools/airgap/bundle.sh'), 'utf8');
    expect(bundle).toContain('deploy/compose/update.sh');
    expect(bundle).toContain('deploy/compose/taskmoor-release.pub');
  });
});
