import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
});
