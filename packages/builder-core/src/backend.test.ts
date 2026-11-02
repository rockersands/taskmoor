import { describe, expect, it } from 'vitest';
import { backendKit, DEFAULT_IMAGE, POSTGRES_IMAGE } from './backend';
import { validateInputs } from './inputs';
import { buildKits, checkKits, ENV_FILE, MANIFEST_FILE } from './kits';
import {
  DB_TLS_PARAMS,
  POSTGRES_TLS_COMMAND,
  POSTGRES_TLS_DEPENDS,
  postgresTlsService,
} from './postgres-tls';
import { systemRandom } from './random';
import { generateSecrets, secretValues } from './secrets';

async function kit(raw: Record<string, unknown> = {}) {
  const form = validateInputs({
    backendUrl: 'https://api.acme.example',
    frontendUrl: 'https://tracker.acme.example/',
    ...raw,
  });
  if (!form.ok) throw new Error(JSON.stringify(form.problems));
  const secrets = await generateSecrets(systemRandom);
  const kits = await buildKits(
    form.inputs,
    secrets,
    {},
    { backendVersion: '1.4.2', kitVersion: '1.4.2' },
  );
  return { secrets, kits, inputs: form.inputs, files: backendKit(kits, form.inputs) };
}

describe('the backend kit (M1-110)', () => {
  it('[OPS-015] brings Compose with PostgreSQL, the pinned backend and Caddy, the installers and the README', async () => {
    const { files, kits } = await kit();
    expect(Object.keys(files).sort()).toEqual([
      ENV_FILE,
      'Caddyfile',
      'README.md',
      MANIFEST_FILE,
      'docker-compose.yml',
      'install.ps1',
      'install.sh',
    ]);
    // (3) The pinned image is the version the manifest records.
    expect(files[ENV_FILE]).toContain(`TASKMOOR_IMAGE=${DEFAULT_IMAGE}:1.4.2\n`);
    expect(kits.manifest.manifest.backendVersion).toBe('1.4.2');
    expect(files[ENV_FILE]).toContain('TASKMOOR_DOMAIN=api.acme.example\n');
    expect(files['docker-compose.yml']).toContain('image: caddy:2');
    expect(files['docker-compose.yml']).toContain('image: ${TASKMOOR_IMAGE:?');
    // PostgreSQL 16 with pgvector, for the similar-ticket index (M1-078, ADR-106).
    expect(files['docker-compose.yml']).toContain('image: pgvector/pgvector:0.8.1-pg16-trixie');
    expect(files['docker-compose.yml']).toContain('env_file: [.env]');
    expect(files.Caddyfile).toContain('api.acme.example {');
    expect(files.Caddyfile).not.toContain('tls internal');
    // The shared core still agrees with the manifest.
    expect(
      await checkKits({ ...kits, backend: { ...kits.backend, [ENV_FILE]: files[ENV_FILE] ?? '' } }),
    ).toEqual([]);
  });

  it('[OPS-015] ASVS 1.9.1: the backend reaches PostgreSQL over TLS with a certificate made at install (ADR-111)', async () => {
    const compose = (await kit()).files['docker-compose.yml'] ?? '';
    expect(compose).toContain(postgresTlsService(POSTGRES_IMAGE));
    expect(compose).toContain(POSTGRES_TLS_COMMAND);
    expect(compose).toContain(POSTGRES_TLS_DEPENDS);
    expect(compose).toContain(
      `DATABASE_URL: postgres://taskmoor:\${POSTGRES_PASSWORD}@postgres:5432/taskmoor?${DB_TLS_PARAMS} # secret-scan: allow`,
    );
    expect(compose).toContain('- postgres-tls:/db-tls:ro');
    expect(compose).toContain('- postgres-tls:/tls:ro');
    expect(compose).toMatch(/\n {2}postgres-ca:\n {2}postgres-tls:\n/);
    // No key or certificate travels in the kit: they are made on the machine it runs on.
    expect(compose).not.toMatch(/BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/);
  });

  it('[OPS-015] (2) lists exactly the DNS records the URLs need', async () => {
    const split = (await kit()).files['README.md'] ?? '';
    expect(split).toContain('| `api.acme.example` | A (and AAAA for IPv6) |');
    expect(split).toContain('The frontend at `tracker.acme.example` is served by its static host');
    const same = (await kit({ frontendUrl: 'https://api.acme.example/' })).files['README.md'] ?? '';
    expect(same).toContain('served from the same address, so no other record is needed');
  });

  it('[OPS-015] lets Caddy sign for a local name itself', async () => {
    const { files } = await kit({
      backendUrl: 'https://localhost:18443',
      frontendUrl: 'https://localhost:18443/',
    });
    expect(files.Caddyfile).toContain('localhost {\n\t# A local name');
    expect(files.Caddyfile).toContain('tls internal');
  });

  it('[OPS-015] installs check Docker, the ports and the DNS record before anything starts', async () => {
    const { files } = await kit();
    const sh = files['install.sh'] ?? '';
    for (const check of [
      'Docker is not installed',
      'Docker Compose v2 is missing',
      'is in use',
      'does not resolve',
    ]) {
      expect(sh).toContain(check);
      expect(files['install.ps1']).toContain(check);
    }
    expect(sh.indexOf('preflight\n[ "${1:-}" = "--preflight" ]')).toBeGreaterThan(0);
    expect(sh).toContain('$PUBLIC_URL/#/setup?token=$TOKEN');
    // IAM-020 (3): once the backend holds the AI key sealed, the key leaves .env.
    expect(sh).toContain("sed -i.bak '/^TASKMOOR_AI_KEY=/d' .env");
    expect(sh.indexOf('TASKMOOR_AI_KEY=/d')).toBeGreaterThan(sh.indexOf('ready || {'));
  });

  it('[OPS-015] offers Helm values and a Secret instead, for the Helm target', async () => {
    const { files, secrets } = await kit({ target: 'helm' });
    expect(Object.keys(files).sort()).toEqual([MANIFEST_FILE, 'secret.yaml', 'values.yaml']);
    expect(files['values.yaml']).toContain('tag: "1.4.2"');
    expect(files['values.yaml']).toContain('publicUrl: "https://api.acme.example"');
    expect(files['secret.yaml']).toContain(`TASKMOOR_INSTANCE_KEY: "${secrets.instanceKey.seed}"`);
    // Secrets live in secret.yaml only.
    for (const s of secretValues(secrets)) expect(files['values.yaml']).not.toContain(s);
  });
});
