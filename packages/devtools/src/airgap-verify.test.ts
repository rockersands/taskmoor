import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
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
 * A stand-in for Docker with its images in $FAKE_STATE, one file per reference listing the
 * platforms its tag holds, and every call logged to $FAKE_STATE/calls. As with Docker 29's
 * containerd image store, a tag holds every platform pulled for it: a pull adds one (arm64
 * without --platform, as on an Apple silicon Mac), a plain inspect reports the first (the
 * host's), and an inspect for a platform the tag lacks answers "/" and succeeds, as Docker 29
 * does for a platform its image index lists but that was never pulled. $FAKE_OLD_DOCKER is a
 * Docker without --platform on `image inspect` and `save` (before 28.1, or a daemon older than
 * API 1.49, whose help hides the flag). The server's own platform is $FAKE_SERVER. syft's
 * container writes what it read: the archive copied into it, or a tag as a plain inspect shows
 * it (seen on a Mac: given a tag holding both, syft read arm64); $FAKE_SYFT_FAIL makes it fail.
 * A stand-in for Helm keeps the real one out.
 */
function fakeBin(): string {
  const bin = temp('taskmoor-bin-');
  const docker = [
    '#!/bin/sh',
    'echo "$*" >> "$FAKE_STATE/calls"',
    `key() { printf '%s' "$1" | tr '/:@' '___'; }`,
    'help() {',
    '  echo "Usage:  docker $1 [OPTIONS] IMAGE"',
    '  [ -n "$FAKE_OLD_DOCKER" ] || echo "      --platform string   One platform of the image"',
    '}',
    'unknown() { echo "unknown flag: --platform" >&2; exit 125; }',
    'case "$1" in',
    '  image)',
    '    sub=$2',
    '    shift 2',
    '    if [ "$1" = --help ]; then help "image $sub"; exit 0; fi',
    '    platform= format=',
    '    while [ $# -gt 1 ]; do',
    '      case "$1" in',
    '        --platform) [ -z "$FAKE_OLD_DOCKER" ] || unknown; platform=$2; shift 2 ;;',
    '        --format) format=$2; shift 2 ;;',
    '        *) shift ;;',
    '      esac',
    '    done',
    '    file="$FAKE_STATE/$(key "$1")"',
    '    if [ "$sub" = rm ]; then rm "$file" || exit 1; exit 0; fi',
    '    [ -f "$file" ] || exit 1',
    '    if [ -z "$platform" ]; then found=$(head -1 "$file")',
    '    elif grep -qx "$platform" "$file"; then found=$platform',
    '    else found=/; fi',
    '    case "$format" in',
    '      *Architecture*) echo "$found" ;;',
    `      *Id*) echo "sha256:$(printf '%s' "$found" | tr -dc 'a-z0-9')" ;;`,
    '    esac ;;',
    '  pull)',
    '    shift',
    '    platform=linux/arm64',
    '    while [ $# -gt 1 ]; do',
    '      case "$1" in --platform) platform=$2; shift 2 ;; *) shift ;; esac',
    '    done',
    '    file="$FAKE_STATE/$(key "$1")"',
    '    grep -qx "$platform" "$file" 2>/dev/null || echo "$platform" >> "$file" ;;',
    '  save)',
    '    shift',
    '    if [ "$1" = --help ]; then help save; exit 0; fi',
    '    if [ "$1" = --platform ]; then',
    '      [ -z "$FAKE_OLD_DOCKER" ] || unknown',
    '      echo "archive of $3 for $2"',
    '    else',
    '      echo "archive of $1, every platform its tag holds"',
    '    fi ;;',
    '  create) case "$*" in *anchore/syft*) echo syft0123 ;; *) echo 0123456789ab ;; esac ;;',
    '  cp)',
    '    case "$3" in',
    '      *:/*) cp "$2" "$FAKE_STATE/copied" ;;',
    `      *) mkdir -p "$3" && echo '{"version":"1.0.0"}' > "$3/version.json" ;;`,
    '    esac ;;',
    // syft reads what it is given: the archive copied into its container, or a tag it asks
    // Docker for, which answers with the host's platform where the tag holds several.
    '  start)',
    '    [ -z "$FAKE_SYFT_FAIL" ] || { echo "syft: unable to read the archive" >&2; exit 1; }',
    `    printf '{"bomFormat": "CycloneDX", "read": "%s"}\\n' "$(cat "$FAKE_STATE/copied")" ;;`,
    '  run)',
    '    while [ $# -gt 0 ]; do case "$1" in anchore/syft:*) break ;; esac; shift; done',
    `    printf '{"bomFormat": "CycloneDX", "read": "%s as Docker shows it: %s"}\\n' "$2" \\`,
    '      "$(head -1 "$FAKE_STATE/$(key "$2")")" ;;',
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

/** The stand-in's local images: each reference with the platforms its tag holds, host's first. */
function dockerState(images: Record<string, string | string[]>): string {
  const state = temp('taskmoor-docker-');
  for (const [ref, platforms] of Object.entries(images))
    writeFileSync(
      imageFile(state, ref),
      [platforms]
        .flat()
        .map((platform) => `${platform}\n`)
        .join(''),
    );
  return state;
}

/** A command a maintainer runs, on the stand-in for Docker. */
const fakeDocker = (state: string, args: string[], extra: Record<string, string> = {}) =>
  spawnSync('sh', [join(fakeBin(), 'docker'), ...args], {
    env: { ...env, FAKE_STATE: state, ...extra },
    encoding: 'utf8',
  }).status;

/**
 * bundle.sh for version 1.0.0 with the given local images and their platforms, or on the
 * stand-in's state from an earlier run (its calls start again).
 */
function makeBundle(
  images: Record<string, string | string[]> | string,
  extra: Record<string, string> = {},
) {
  const state = typeof images === 'string' ? images : dockerState(images);
  rmSync(join(state, 'calls'), { force: true });
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
      'taskmoor:1.0.0 has no linux/amd64 image here, and this bundle is for linux/amd64 servers',
    );
    expect(app.out).toContain('docker buildx build --platform linux/amd64 --load');
    expect(app.out).toContain('PLATFORM=linux/arm64');
    expect(existsSync(app.dir)).toBe(false);
    expect(app.calls).not.toMatch(/^save (?!--help$)/m);

    // A database image pulled earlier on the Mac is arm64 too.
    const db = makeBundle({ 'taskmoor:1.0.0': 'linux/amd64', [POSTGRES_IMAGE]: 'linux/arm64' });
    expect(db.status).toBe(1);
    expect(db.out).toContain(`${POSTGRES_IMAGE} has no linux/amd64 image here`);
  });

  // Docker 29's containerd image store keeps every platform pulled for a tag: on an Apple
  // silicon Mac `docker pull --platform linux/amd64` adds amd64 beside the arm64 the tag held,
  // while a plain `docker image inspect` still reports arm64 and a plain `docker save` writes
  // both. bundle.sh refused the image its message had just told the maintainer to pull (T-023
  // re-check); it now inspects and saves the servers' platform by name.
  it('[OPS-005] takes the servers’ platform from a tag that holds two', () => {
    const both = ['linux/arm64', 'linux/amd64'];
    const images = { 'taskmoor:1.0.0': both, [POSTGRES_IMAGE]: both };
    const made = makeBundle(images);
    expect({ status: made.status, out: made.out }).toMatchObject({ status: 0 });
    expect(made.calls).toMatch(/^save --platform linux\/amd64 taskmoor:1\.0\.0$/m);
    expect(made.calls).toContain(`save --platform linux/amd64 ${POSTGRES_IMAGE}\n`);
    expect(made.calls).not.toMatch(/^pull /m);
    expect(made.imagesTxt).toBe(
      `taskmoor taskmoor:1.0.0 sha256:linuxamd64\npostgres ${POSTGRES_IMAGE} sha256:linuxamd64\nplatform linux/amd64\n`,
    );

    const arm = makeBundle(images, { PLATFORM: 'linux/arm64' });
    expect({ status: arm.status, out: arm.out }).toMatchObject({ status: 0 });
    expect(arm.calls).toMatch(/^save --platform linux\/arm64 taskmoor:1\.0\.0$/m);
    expect(arm.imagesTxt).toContain('platform linux/arm64\n');
  });

  // syft was given the tag and asked Docker for it without a platform, and Docker answers with
  // the host's where the tag holds several: an amd64 bundle made on an Apple silicon Mac from a
  // tag that holds both would have carried the arm64 image's SBOM (T-023 second re-check).
  it('[OPS-005] makes the SBOM from the Taskmoor archive the bundle carries', () => {
    const both = ['linux/arm64', 'linux/amd64'];
    const made = makeBundle({ 'taskmoor:1.0.0': both, [POSTGRES_IMAGE]: both });
    expect({ status: made.status, out: made.out }).toMatchObject({ status: 0 });
    const archive = 'archive of taskmoor:1.0.0 for linux/amd64';
    expect(JSON.parse(readFileSync(join(made.dir, 'sbom.cdx.json'), 'utf8'))).toEqual({
      bomFormat: 'CycloneDX',
      read: archive,
    });
    // Named as syft names an image given by tag, as the SBOM was before.
    expect(made.calls).toMatch(
      /^create anchore\/syft:v1\.33\.0 docker-archive:\/tmp\/taskmoor\.tar --source-name taskmoor --source-version 1\.0\.0 -o cyclonedx-json -q$/m,
    );
    const registry = makeBundle(
      { 'localhost:5000/team/taskmoor': 'linux/amd64', [POSTGRES_IMAGE]: 'linux/amd64' },
      { TASKMOOR_IMAGE: 'localhost:5000/team/taskmoor' },
    );
    expect({ status: registry.status, out: registry.out }).toMatchObject({ status: 0 });
    expect(registry.calls).toMatch(/ --source-name localhost:5000\/team\/taskmoor -o /);
    expect(made.calls).toMatch(/^rm -v syft0123$/m);
    // The archive is packed once read; the bundle carries it alone, and its checksum.
    expect(readdirSync(join(made.dir, 'images')).sort()).toEqual([
      'postgres.tar.gz',
      'taskmoor.tar.gz',
    ]);
    expect(gunzipSync(readFileSync(join(made.dir, 'images/taskmoor.tar.gz'))).toString()).toBe(
      `${archive}\n`,
    );
    expect(readFileSync(join(made.dir, 'SHA256SUMS'), 'utf8')).toMatch(
      / images\/taskmoor\.tar\.gz$/m,
    );

    const failed = makeBundle(
      { 'taskmoor:1.0.0': 'linux/amd64', [POSTGRES_IMAGE]: 'linux/amd64' },
      { FAKE_SYFT_FAIL: '1' },
    );
    expect(failed.status).toBe(1);
    expect(failed.out).toContain('syft could not make the SBOM');
    expect(failed.calls).toMatch(/^rm -v syft0123$/m);
    expect(existsSync(join(failed.dir, 'SHA256SUMS.sig'))).toBe(false);
  });

  it('[OPS-005] names the pull that gives a tag the servers’ platform, and that pull works', () => {
    const state = dockerState({ 'taskmoor:1.0.0': 'linux/amd64', [POSTGRES_IMAGE]: 'linux/arm64' });
    const refused = makeBundle(state);
    expect(refused.status).toBe(1);
    const pull = `docker pull --platform linux/amd64 ${POSTGRES_IMAGE}`;
    expect(refused.out).toContain(pull);

    expect(fakeDocker(state, pull.split(' ').slice(1))).toBe(0);
    const made = makeBundle(state);
    expect({ status: made.status, out: made.out }).toMatchObject({ status: 0 });
    expect(made.calls).toContain(`save --platform linux/amd64 ${POSTGRES_IMAGE}\n`);
  });

  // An older Docker cannot pick one platform of a tag, so the tag must hold only the servers':
  // its pull for another platform would add to the tag with the containerd store.
  it('[OPS-005] keeps the check on the whole tag where Docker cannot pick a platform', () => {
    const old = { FAKE_OLD_DOCKER: '1' };
    const state = dockerState({
      'taskmoor:1.0.0': 'linux/amd64',
      [POSTGRES_IMAGE]: ['linux/arm64', 'linux/amd64'],
    });
    const refused = makeBundle(state, old);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain(`${POSTGRES_IMAGE} is linux/arm64 here`);
    const remove = `docker image rm ${POSTGRES_IMAGE}`;
    const pull = `docker pull --platform linux/amd64 ${POSTGRES_IMAGE}`;
    expect(refused.out).toContain(remove);
    expect(refused.out).toContain(pull);
    expect(refused.calls).not.toMatch(/--platform linux\/amd64 taskmoor/);

    for (const command of [remove, pull])
      expect(fakeDocker(state, command.split(' ').slice(1), old)).toBe(0);
    const made = makeBundle(state, old);
    expect({ status: made.status, out: made.out }).toMatchObject({ status: 0 });
    expect(made.calls).toContain(`save ${POSTGRES_IMAGE}\n`);
    expect(made.calls).toMatch(/^save taskmoor:1\.0\.0$/m);
    expect(made.imagesTxt).toContain('platform linux/amd64\n');
    expect(readFileSync(join(made.dir, 'sbom.cdx.json'), 'utf8')).toContain(
      'archive of taskmoor:1.0.0, every platform its tag holds',
    );
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
