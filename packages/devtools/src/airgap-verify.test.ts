import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { POSTGRES_IMAGE } from '@taskmoor/builder-core';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The air-gap bundle's own check (OPS-005, ADR-021): the real tools/airgap/verify.sh on this
 * machine's bash, base64, openssl and sha256sum, against a small bundle signed with a throwaway
 * key in the format bundle.sh writes (ECDSA P-256 over SHA-256, DER, one line of base64). On a
 * Mac it refused every bundle until T-023: a Mac's base64 takes no file argument.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** PATH with Git Bash's tools first on Windows, as update-kit.test.ts does. */
function toolPath(): string {
  const path = process.env.PATH ?? '';
  if (process.platform !== 'win32') return path;
  const gitCore = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  return [resolve(gitCore, '../../../usr/bin'), resolve(gitCore, '../../bin'), path].join(
    delimiter,
  );
}
const env = { ...process.env, PATH: toolPath() };
const has = (tool: string, args: string[]) => spawnSync(tool, args, { env }).status === 0;
const hasTools =
  has('bash', ['-c', 'exit 0']) && has('openssl', ['version']) && has('sha256sum', ['--version']);

const pair = () =>
  generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

/** A bundle of two files with SHA256SUMS, its signature, cosign.pub and verify.sh. */
function bundle(): { dir: string; otherKey: string } {
  const dir = mkdtempSync(join(tmpdir(), 'taskmoor-airgap-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'compose'));
  const files: Record<string, string> = {
    'compose/install.sh': '#!/usr/bin/env bash\necho install\n',
    'images.txt': 'taskmoor taskmoor:1.0.0 sha256:00\n',
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  copyFileSync(join(ROOT, 'tools/airgap/verify.sh'), join(dir, 'verify.sh'));
  const sums = Object.entries({ ...files, 'verify.sh': readFileSync(join(dir, 'verify.sh')) })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, data]) => `${createHash('sha256').update(data).digest('hex')}  ${name}\n`)
    .join('');
  writeFileSync(join(dir, 'SHA256SUMS'), sums);
  const key = pair();
  writeFileSync(join(dir, 'cosign.pub'), key.publicKey);
  const signature = sign('sha256', Buffer.from(sums), key.privateKey).toString('base64');
  writeFileSync(join(dir, 'SHA256SUMS.sig'), signature);
  const otherKey = join(dir, '..', `${dir.split(/[\\/]/).pop()}-other.pub`);
  writeFileSync(otherKey, pair().publicKey);
  dirs.push(otherKey);
  return { dir, otherKey };
}

const verify = (dir: string, key?: string) =>
  spawnSync('bash', [join(dir, 'verify.sh'), ...(key ? [key] : [])], { env, encoding: 'utf8' });

describe.skipIf(!hasTools)('tools/airgap/verify.sh on this machine', () => {
  it('[OPS-005] accepts a bundle signed as bundle.sh signs it', () => {
    const { dir } = bundle();
    const result = verify(dir);
    expect({ status: result.status, out: result.stdout }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain('verify: signature ok');
    expect(result.stdout).toContain('verify: 3 files match SHA256SUMS');
  });

  it('[OPS-005] refuses a changed file and a key other than the signer’s', () => {
    const changed = bundle();
    writeFileSync(join(changed.dir, 'compose/install.sh'), '#!/usr/bin/env bash\necho changed\n');
    const tampered = verify(changed.dir);
    expect(tampered.status).toBe(1);
    expect(tampered.stdout).toContain('a file does not match SHA256SUMS');

    const other = bundle();
    const wrongKey = verify(other.dir, other.otherKey);
    expect(wrongKey.status).toBe(1);
    expect(wrongKey.stdout).toContain('does not match');
  });
});

describe('tools/airgap/bundle.sh', () => {
  it('[OPS-005] writes the signature with base64 flags every platform has', () => {
    const script = readFileSync(join(ROOT, 'tools/airgap/bundle.sh'), 'utf8');
    // -w0 is GNU's alone; a Mac's base64 also takes no file argument to decode.
    expect(script).not.toMatch(/base64 -w/);
    expect(readFileSync(join(ROOT, 'tools/airgap/verify.sh'), 'utf8')).toMatch(
      /base64 -d < SHA256SUMS\.sig/,
    );
  });

  // The kit's postgres-tls service runs openssl in the database image (ADR-111). The bundle
  // shipped Alpine's PostgreSQL image, which has none, so every offline install stopped at
  // "postgres-tls didn't complete successfully: exit 127" (T-023).
  it.skipIf(!hasTools)('[OPS-005] ships the database image its Compose kit names', () => {
    const script = readFileSync(join(ROOT, 'tools/airgap/bundle.sh'), 'utf8');
    const line = script.split('\n').find((l) => l.startsWith('kit_db=$('));
    expect(line).toBeDefined();
    const found = execFileSync('bash', ['-c', `${line}\nprintf %s "$kit_db"`], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    expect(found).toBe(POSTGRES_IMAGE);
    expect(script).toMatch(/^db=\$\{POSTGRES_IMAGE:-\$\{kit_db:\?/m);
    expect(readFileSync(join(ROOT, 'deploy/compose/docker-compose.yml'), 'utf8')).toContain(
      `image: \${POSTGRES_IMAGE:-${POSTGRES_IMAGE}}`,
    );
  });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * A stand-in for Docker with its images in $FAKE_STATE, one file per reference holding the
 * image's platform, and every call logged to $FAKE_STATE/calls. A pull without --platform gets
 * arm64, as on an Apple silicon Mac; the server's own platform is $FAKE_SERVER. A stand-in for
 * Helm keeps the real one out.
 */
function fakeBin(): string {
  const bin = temp('taskmoor-bin-');
  const docker = [
    '#!/bin/sh',
    'echo "$*" >> "$FAKE_STATE/calls"',
    `key() { printf '%s' "$1" | tr '/:@' '___'; }`,
    'case "$1" in',
    '  image)',
    '    shift 2',
    '    format=',
    '    if [ "$1" = --format ]; then format=$2; shift 2; fi',
    '    [ -f "$FAKE_STATE/$(key "$1")" ] || exit 1',
    '    case "$format" in',
    '      *Architecture*) cat "$FAKE_STATE/$(key "$1")" ;;',
    '      *Id*) echo sha256:0123456789abcdef ;;',
    '    esac ;;',
    '  pull)',
    '    shift',
    '    platform=linux/arm64',
    '    while [ $# -gt 1 ]; do',
    '      case "$1" in --platform) platform=$2; shift 2 ;; *) shift ;; esac',
    '    done',
    '    echo "$platform" > "$FAKE_STATE/$(key "$1")" ;;',
    '  save) echo "archive of $2" ;;',
    '  create) echo 0123456789ab ;;',
    `  cp) mkdir -p "$3" && echo '{"version":"1.0.0"}' > "$3/version.json" ;;`,
    `  run) echo '{"bomFormat": "CycloneDX"}' ;;`,
    '  version) echo "$FAKE_SERVER" ;;',
    '  load) cat > /dev/null ;;',
    'esac',
    '',
  ];
  writeFileSync(join(bin, 'docker'), docker.join('\n'));
  writeFileSync(join(bin, 'helm'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'helm'), 0o755);
  return bin;
}

const imageFile = (state: string, ref: string) => join(state, ref.replace(/[/:@]/g, '_'));

function run(script: string, args: string[], state: string, extra: Record<string, string>) {
  const runEnv: NodeJS.ProcessEnv = {
    ...env,
    PATH: `${fakeBin()}${delimiter}${env.PATH ?? ''}`,
    FAKE_STATE: state,
    ...extra,
  };
  if (!('PLATFORM' in extra)) delete runEnv.PLATFORM;
  delete runEnv.POSTGRES_IMAGE;
  const result = spawnSync('bash', [script, ...args], { env: runEnv, encoding: 'utf8' });
  const calls = join(state, 'calls');
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
  };
}

/** bundle.sh for version 1.0.0 with the given local images and their platforms. */
function makeBundle(images: Record<string, string>, extra: Record<string, string> = {}) {
  const state = temp('taskmoor-docker-');
  for (const [ref, platform] of Object.entries(images))
    writeFileSync(imageFile(state, ref), `${platform}\n`);
  const key = pair();
  writeFileSync(join(state, 'key.pem'), key.privateKey);
  writeFileSync(join(state, 'cosign.pub'), key.publicKey);
  const out = temp('taskmoor-bundle-');
  const result = run(join(ROOT, 'tools/airgap/bundle.sh'), ['1.0.0', out], state, {
    TASKMOOR_IMAGE: 'taskmoor:1.0.0',
    SIGNING_KEY: join(state, 'key.pem'),
    PUBLIC_KEY: join(state, 'cosign.pub'),
    ...extra,
  });
  const dir = join(out, 'taskmoor-1.0.0');
  const list = join(dir, 'images.txt');
  return { ...result, dir, imagesTxt: existsSync(list) ? readFileSync(list, 'utf8') : '' };
}

// An image archive holds one platform, and an air-gapped server has no registry to fetch
// another from. A bundle made on an Apple silicon Mac carried arm64 images, which an amd64
// server cannot start (T-023 review).
describe.skipIf(!hasTools)('tools/airgap/bundle.sh and the servers’ platform', () => {
  it('[OPS-005] is for amd64 servers by default, with the database image pulled for them', () => {
    const made = makeBundle({ 'taskmoor:1.0.0': 'linux/amd64' });
    expect({ status: made.status, out: made.out }).toMatchObject({ status: 0 });
    expect(made.calls).toContain(`pull -q --platform linux/amd64 ${POSTGRES_IMAGE}`);
    expect(made.imagesTxt).toContain('platform linux/amd64\n');
    expect(made.out).toContain('for linux/amd64 servers');
  });

  it('[OPS-005] refuses an image of another platform before writing anything', () => {
    const app = makeBundle({ 'taskmoor:1.0.0': 'linux/arm64', [POSTGRES_IMAGE]: 'linux/amd64' });
    expect(app.status).toBe(1);
    expect(app.out).toContain(
      'taskmoor:1.0.0 is linux/arm64 here, and this bundle is for linux/amd64 servers',
    );
    expect(app.out).toContain('PLATFORM=linux/arm64');
    expect(existsSync(app.dir)).toBe(false);
    expect(app.calls).not.toMatch(/^save /m);

    // A database image pulled earlier on the Mac is arm64 too.
    const db = makeBundle({ 'taskmoor:1.0.0': 'linux/amd64', [POSTGRES_IMAGE]: 'linux/arm64' });
    expect(db.status).toBe(1);
    expect(db.out).toContain(`${POSTGRES_IMAGE} is linux/arm64 here`);
  });

  it('[OPS-005] makes an arm64 bundle when PLATFORM names it, and takes no other', () => {
    const made = makeBundle({ 'taskmoor:1.0.0': 'linux/arm64' }, { PLATFORM: 'linux/arm64' });
    expect({ status: made.status, out: made.out }).toMatchObject({ status: 0 });
    expect(made.calls).toContain(`pull -q --platform linux/arm64 ${POSTGRES_IMAGE}`);
    expect(made.imagesTxt).toContain('platform linux/arm64\n');

    const other = makeBundle({ 'taskmoor:1.0.0': 'linux/amd64' }, { PLATFORM: 'linux/riscv64' });
    expect(other.status).toBe(1);
    expect(other.out).toContain('PLATFORM is linux/amd64 or linux/arm64');
  });
});

/** install-offline.sh in a bundle whose images.txt names `platform`, on a `server`. */
function installOffline(platform: string | null, server: string) {
  const dir = temp('taskmoor-offline-');
  mkdirSync(join(dir, 'images'));
  mkdirSync(join(dir, 'compose'));
  copyFileSync(join(ROOT, 'tools/airgap/install-offline.sh'), join(dir, 'install-offline.sh'));
  // verify.sh itself is tested above; here it stands aside.
  writeFileSync(join(dir, 'verify.sh'), 'echo "verify: stand-in"\n');
  writeFileSync(join(dir, 'images/taskmoor.tar.gz'), gzipSync('archive'));
  writeFileSync(
    join(dir, 'images.txt'),
    `taskmoor taskmoor:1.0.0 sha256:01\npostgres ${POSTGRES_IMAGE} sha256:02\n${
      platform ? `platform ${platform}\n` : ''
    }`,
  );
  writeFileSync(join(dir, 'compose/install.sh'), 'echo "install.sh with $TASKMOOR_IMAGE"\n');
  return run(join(dir, 'install-offline.sh'), [], temp('taskmoor-docker-'), {
    FAKE_SERVER: server,
  });
}

describe.skipIf(!hasTools)('tools/airgap/install-offline.sh and the server’s platform', () => {
  it('[OPS-005] refuses a bundle for another platform before loading anything', () => {
    const result = installOffline('linux/amd64', 'linux/arm64');
    expect(result.status).toBe(1);
    expect(result.out).toContain(
      "This bundle's images are for linux/amd64 servers, and this one is linux/arm64.",
    );
    expect(result.calls).not.toMatch(/^load/m);
    expect(result.out).not.toContain('install.sh with');
  });

  it('[OPS-005] installs a bundle for its own platform, and one that names none', () => {
    for (const platform of ['linux/arm64', null]) {
      const result = installOffline(platform, 'linux/arm64');
      expect({ platform, status: result.status, out: result.out }).toMatchObject({ status: 0 });
      expect(result.calls).toMatch(/^load/m);
      expect(result.out).toContain('install.sh with taskmoor:1.0.0');
    }
  });
});
