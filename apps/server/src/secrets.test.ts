import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword, passwordHasher, pepperFromSecret, pepperIdOf } from '@taskmoor/iam';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FilePepperRing,
  loadPeppers,
  mergePepperFile,
  pepperFile,
  readPepperFile,
} from './secrets';

const OLD = 'an older key that is certainly long enough';
const ENV = 'a key from the environment, long enough as well';

describe('password keyring (ASVS 2.4.5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'taskmoor-secrets-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('[IAM-001] creates a private keyring in the data directory on first start and reuses it', () => {
    const first = loadPeppers({ dataDir: dir });
    const file = pepperFile(dir);
    expect(readPepperFile(file)).toHaveLength(1);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const second = loadPeppers({ dataDir: dir });
    expect(second?.active?.id).toBe(first?.active?.id);
    expect(loadPeppers({})).toBeUndefined();
  });

  it('[IAM-001] prefers the environment key and still knows the file keys', () => {
    const fromFile = loadPeppers({ dataDir: dir })?.active;
    const ring = loadPeppers({ dataDir: dir, envSecret: ENV });
    expect(ring?.active?.id).toBe(pepperFromSecret(ENV).id);
    expect(fromFile && ring?.find(fromFile.id)?.id).toBe(fromFile?.id);
  });

  it('[IAM-001] merges keys without changing the active one, and the ring finds them later', async () => {
    const ring = new FilePepperRing(pepperFile(dir));
    const active = ring.active?.id;
    const oldHash = await hashPassword('correct horse battery staple', pepperFromSecret(OLD));
    // A restore running in another process adds the backup's key to the file.
    expect(mergePepperFile(pepperFile(dir), [OLD])).toBe(1);
    expect(mergePepperFile(pepperFile(dir), [OLD])).toBe(0);
    expect(readFileSync(pepperFile(dir), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(new FilePepperRing(pepperFile(dir)).active?.id).toBe(active);

    // The running ring reads the changed file when it meets the unknown key.
    const hasher = passwordHasher(ring);
    expect(await hasher.verify('correct horse battery staple', oldHash)).toBe(true);
    expect(hasher.needsRehash(oldHash)).toBe(true);
    expect(pepperIdOf(await hasher.hash('x'))).toBe(active);
  });

  it('ignores blank lines and comments in the keyring', () => {
    mergePepperFile(pepperFile(dir), [OLD]);
    writeFileSync(pepperFile(dir), `# keys\n\n${readFileSync(pepperFile(dir), 'utf8')}\n`);
    expect(readPepperFile(pepperFile(dir)).map((p) => p.id)).toEqual([pepperFromSecret(OLD).id]);
  });
});
