import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Pepper, type PepperRing, pepperFromSecret } from '@taskmoor/iam';

/**
 * The password peppers of an install (ASVS 2.4.5, ADR-019): secret keys kept outside the
 * database. The keyring is a file in the data directory, one base64url key per line, the first
 * being the active one; it is created on first start. TASKMOOR_PASSWORD_PEPPER, when set,
 * supplies the active key instead (Helm sets it from a Secret so every pod shares it).
 *
 * Backups carry the keyring and a restore merges it in (backup.ts), so a restored database's
 * hashes still verify; sign-in then moves them to the active key. A key id the ring has not
 * seen makes it read the file again when the file changed, which picks up keys a restore added
 * while the server was running.
 */
export const PEPPER_FILE = join('secrets', 'password-peppers');

export function pepperFile(dataDir: string): string {
  return join(dataDir, PEPPER_FILE);
}

/** Reads a keyring file: one key per line, blank lines and # comments ignored. */
export function readPepperFile(file: string): Pepper[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => pepperFromSecret(line));
}

/** Adds keys that are missing, keeping the file's order (and so its active key). */
export function mergePepperFile(file: string, secrets: readonly string[]): number {
  const known = new Set(readPepperFile(file).map((p) => p.id));
  const missing = secrets.filter((s) => !known.has(pepperFromSecret(s).id));
  if (missing.length === 0) return 0;
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(file, `${current}${prefix}${missing.join('\n')}\n`, { mode: 0o600 });
  return missing.length;
}

export class FilePepperRing implements PepperRing {
  active: Pepper | undefined;
  private readonly keys = new Map<string, Pepper>();
  /** Size and modification time of the file at the last read. */
  private seen = '';

  constructor(
    private readonly file: string | undefined,
    envSecret?: string,
  ) {
    if (file && !envSecret && !existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      try {
        // 'wx' fails if another role created the file first; then its key is the one to use.
        writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    this.reload();
    this.active = envSecret ? pepperFromSecret(envSecret) : this.firstFromFile();
    if (this.active) this.keys.set(this.active.id, this.active);
  }

  private firstFromFile(): Pepper | undefined {
    return this.file ? readPepperFile(this.file)[0] : undefined;
  }

  private stamp(): string {
    if (!this.file || !existsSync(this.file)) return '';
    const stat = statSync(this.file);
    return `${stat.size}:${stat.mtimeMs}`;
  }

  private reload(): void {
    if (!this.file) return;
    this.seen = this.stamp();
    for (const pepper of readPepperFile(this.file)) this.keys.set(pepper.id, pepper);
  }

  find(id: string): Pepper | undefined {
    const found = this.keys.get(id);
    if (found || this.stamp() === this.seen) return found;
    this.reload();
    return this.keys.get(id);
  }
}

/** The install's keyring, or undefined when there is neither a data directory nor a key. */
export function loadPeppers(options: {
  dataDir?: string | undefined;
  envSecret?: string | undefined;
}): PepperRing | undefined {
  if (!options.dataDir && !options.envSecret) return undefined;
  return new FilePepperRing(
    options.dataDir ? pepperFile(options.dataDir) : undefined,
    options.envSecret,
  );
}
