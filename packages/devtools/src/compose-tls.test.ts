import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DB_TLS_MOUNT,
  DB_TLS_PARAMS,
  POSTGRES_TLS_COMMAND,
  POSTGRES_TLS_DEPENDS,
  POSTGRES_TLS_SCRIPT,
  postgresTlsService,
} from '@taskmoor/builder-core';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const COMPOSE = readFileSync(join(ROOT, 'deploy/compose/docker-compose.yml'), 'utf8');
// biome-ignore lint/suspicious/noTemplateCurlyInString: a Compose variable with its default, not a template
const IMAGE = '${POSTGRES_IMAGE:-pgvector/pgvector:0.8.1-pg16-trixie}';
const hasTools =
  spawnSync('openssl', ['version']).status === 0 && spawnSync('sh', ['-c', 'exit 0']).status === 0;

/** One service's block of the Compose file, up to the next service or section. */
function service(name: string): string {
  const start = COMPOSE.indexOf(`\n  ${name}:\n`);
  if (start < 0) return '';
  const rest = COMPOSE.slice(start + 1);
  const end = rest.slice(3).search(/\n {2}[a-z][a-z-]*:\n|\n[a-z]+:\n/);
  return end < 0 ? rest : rest.slice(0, end + 3);
}

describe('TLS to the bundled PostgreSQL of the Compose kit (ASVS 1.9.1, ADR-111)', () => {
  it('[OPS-001] the kit runs postgres-tls first, PostgreSQL with TLS, and the backend with verify-full', () => {
    // The same texts as the Builder's backend kit, so the two cannot drift apart.
    expect(COMPOSE).toContain(postgresTlsService(IMAGE));
    const postgres = service('postgres');
    expect(postgres).toContain(POSTGRES_TLS_COMMAND);
    expect(postgres).toContain(POSTGRES_TLS_DEPENDS);
    expect(postgres).toContain('- postgres-tls:/tls:ro');
    const backend = service('taskmoor');
    expect(backend).toContain(
      `DATABASE_URL: postgres://taskmoor:\${POSTGRES_PASSWORD}@postgres:5432/taskmoor?${DB_TLS_PARAMS} # secret-scan: allow`,
    );
    expect(DB_TLS_PARAMS).toBe('sslmode=verify-full&sslrootcert=/db-tls/ca.crt');
    expect(backend).toContain(`- postgres-tls:${DB_TLS_MOUNT}:ro`);
    // The authority's key is in its own volume, which only postgres-tls mounts.
    expect(COMPOSE.match(/postgres-ca:/g)?.length).toBe(2);
    expect(service('postgres-tls')).toContain('- postgres-ca:/ca');
    expect(COMPOSE).toMatch(
      /\nvolumes:\n(?: {2}[a-z-]+:\n)*? {2}postgres-ca:\n {2}postgres-tls:\n/,
    );
  });

  it('[OPS-001] Compose reads the script with its shell variables left to the shell', () => {
    const block = service('postgres-tls');
    const script = block
      .slice(block.indexOf('      - |\n') + '      - |\n'.length, block.indexOf('\n    volumes:'))
      .split('\n')
      .map((line) => line.slice(8))
      .join('\n');
    // Compose turns $$ into $: what the container runs is the script, word for word.
    expect(`${script.replaceAll('$$', '$')}\n`).toBe(POSTGRES_TLS_SCRIPT);
    expect(script).not.toMatch(/(?<!\$)\$(?!\$)/);
  });

  describe.skipIf(!hasTools)('the certificate it makes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskmoor-pg-tls-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const ca = join(dir, 'ca');
    const out = join(dir, 'tls');
    const run = () =>
      execFileSync('sh', ['-c', POSTGRES_TLS_SCRIPT], {
        env: {
          ...process.env,
          TLS_CA_DIR: ca,
          TLS_DIR: out,
          TLS_KEY_OWNER: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          // Git for Windows' shell would otherwise rewrite openssl's "/CN=..." as a file path.
          MSYS_NO_PATHCONV: '1',
        },
        encoding: 'utf8',
      });
    const read = (path: string) => new X509Certificate(readFileSync(path));

    it('[IAM-017] ASVS 1.9.1: a private authority and a server certificate for postgres, keys private', () => {
      const said = run();
      expect(said).toContain('made the private certificate authority');
      expect(said).toContain('issued the database certificate for postgres');
      const authority = read(join(ca, 'ca.crt'));
      const server = read(join(out, 'server.crt'));
      expect(authority.ca).toBe(true);
      expect(server.ca).toBe(false);
      expect(server.checkIssued(authority)).toBe(true);
      expect(server.verify(authority.publicKey)).toBe(true);
      expect(server.checkHost('postgres')).toBe('postgres');
      expect(server.checkHost('localhost')).toBe('localhost');
      expect(server.checkHost('db.example.com')).toBeUndefined();
      expect(server.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
      expect(server.publicKey.asymmetricKeyType).toBe('ec');
      const years = (Date.parse(server.validTo) - Date.now()) / (365.25 * 86_400_000);
      expect(years).toBeGreaterThan(9.9);
      // The backend trusts the authority's copy next to the server certificate.
      expect(readFileSync(join(out, 'ca.crt'), 'utf8')).toBe(
        readFileSync(join(ca, 'ca.crt'), 'utf8'),
      );
      // PostgreSQL refuses a key others can read; nothing but the key's owner reads either key.
      // Windows has no such modes to read back; the kit's containers run this on Linux.
      if (process.platform !== 'win32') {
        expect(statSync(join(out, 'server.key')).mode & 0o777).toBe(0o600);
        expect(statSync(join(ca, 'ca.key')).mode & 0o777).toBe(0o600);
        expect(statSync(join(out, 'server.crt')).mode & 0o777).toBe(0o644);
      }
      const hba = readFileSync(join(out, 'pg_hba.conf'), 'utf8')
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(/\s+/).join(' '));
      expect(hba).toEqual([
        'local all all trust',
        'hostssl all all all scram-sha-256',
        'host all all all reject',
      ]);
    });

    it('[IAM-017] ASVS 1.9.1: later starts keep both, and reissue only a missing server certificate', () => {
      const authority = readFileSync(join(ca, 'ca.crt'), 'utf8');
      const server = readFileSync(join(out, 'server.crt'), 'utf8');
      expect(run()).toBe('');
      expect(readFileSync(join(ca, 'ca.crt'), 'utf8')).toBe(authority);
      expect(readFileSync(join(out, 'server.crt'), 'utf8')).toBe(server);
      rmSync(join(out, 'server.crt'));
      expect(run()).toContain('issued the database certificate');
      expect(readFileSync(join(ca, 'ca.crt'), 'utf8')).toBe(authority);
      const reissued = read(join(out, 'server.crt'));
      expect(reissued.checkIssued(new X509Certificate(authority))).toBe(true);
      expect(reissued.serialNumber).not.toBe(new X509Certificate(server).serialNumber);
    });
  });
});
