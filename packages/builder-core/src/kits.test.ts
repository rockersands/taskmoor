import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { type BuilderInputs, validateInputs } from './inputs';
import { buildKits, CONFIG_FILE, checkKits, ENV_FILE, MANIFEST_FILE, zipKit } from './kits';
import { verifyManifest } from './manifest';
import { loadProject, ProjectError, saveProject } from './project';
import { seededRandom, systemRandom } from './random';
import { type GeneratedSecrets, generateSecrets, secretValues } from './secrets';
import { readZip, writeZip } from './zip';

const VERSIONS = { backendVersion: '1.4.2', kitVersion: '1.4.2' };

function inputs(raw: Record<string, unknown> = {}): BuilderInputs {
  const result = validateInputs({
    backendUrl: 'https://api.example.com',
    frontendUrl: 'https://tracker.example.com/',
    instanceName: 'Acme tracker',
    ...raw,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.inputs;
}

/** Every generated value replaced by its name: what is left must not depend on the secrets. */
function masked(files: Record<string, string>, s: GeneratedSecrets, signature: string) {
  const values: [string, string][] = [
    ...secretValues(s).map((v, i): [string, string] => [v, `<secret ${i}>`]),
    [s.instanceId, '<instance id>'],
    [s.instanceKey.publicKey, '<public key>'],
    [s.instanceKey.fingerprint, '<fingerprint>'],
    [signature, '<signature>'],
  ];
  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      path,
      values.reduce((t, [v, name]) => t.split(v).join(name), text),
    ]),
  );
}

describe('the Builder inputs (M1-109)', () => {
  it('[OPS-014] (2) refuses http on a public domain, with a message', () => {
    const result = validateInputs({
      backendUrl: 'http://api.example.com',
      frontendUrl: 'https://tracker.example.com/',
    });
    expect(result).toEqual({
      ok: false,
      problems: [
        {
          field: 'backendUrl',
          code: 'insecure_url',
          message:
            'Use https: plain http is only for a machine of your own (localhost or a .test name).',
        },
      ],
    });
    expect(
      validateInputs({ backendUrl: 'http://localhost:8080', frontendUrl: 'http://x.test/' }).ok,
    ).toBe(true);
    const codes = (raw: Record<string, unknown>) => {
      const r = validateInputs({
        backendUrl: 'https://a.example',
        frontendUrl: 'https://b.example/',
        ...raw,
      });
      return r.ok ? [] : r.problems.map((p) => p.code);
    };
    expect(codes({ backendUrl: 'not a url' })).toEqual(['not_a_url']);
    expect(codes({ backendUrl: 'https://a.example/api' })).toEqual(['has_path']);
    expect(codes({ frontendUrl: 'https://b.example/app' })).toEqual(['not_a_directory']);
    expect(codes({ frontendUrl: 'https://b.example/?x=1' })).toEqual(['has_query']);
    expect(codes({ routing: 'cookies' })).toEqual(['invalid']);
  });

  it('[OPS-014] fills the defaults: clean URLs, English, Compose', () => {
    expect(inputs()).toMatchObject({ routing: 'path', defaultLanguage: 'en', target: 'compose' });
  });
});

describe('the kits (M1-109)', () => {
  it('[OPS-014] (1) agree for every deployment target and routing mode', async () => {
    const secrets = await generateSecrets(systemRandom);
    for (const target of ['compose', 'helm'] as const) {
      for (const routing of ['path', 'hash'] as const) {
        for (const frontendUrl of [
          'https://tracker.example.com/',
          'https://api.example.com/app/',
        ]) {
          const kits = await buildKits(
            inputs({ target, routing, frontendUrl }),
            secrets,
            {},
            VERSIONS,
          );
          expect(await checkKits(kits, secrets)).toEqual([]);
          expect(await verifyManifest(kits.manifest)).toBe(true);
        }
      }
    }
  });

  it('[OPS-014] keeps every secret out of the frontend kit, and catches one put there', async () => {
    const secrets = await generateSecrets(systemRandom);
    const user = { smtpPassword: 'smtp-password-of-the-user', aiKey: 'sk-test-key-of-the-user' };
    const kits = await buildKits(
      inputs({
        smtp: { host: 'smtp.example.com', port: 587, user: 'mailer' },
        ai: { provider: 'anthropic' },
      }),
      secrets,
      user,
      VERSIONS,
    );
    const env = kits.backend[ENV_FILE] ?? '';
    expect(env).toContain(`TASKMOOR_SMTP_PASSWORD=${user.smtpPassword}`);
    expect(env).toContain('TASKMOOR_SMTP_URL=smtp://smtp.example.com:587');
    const frontend = Object.values(kits.frontend).join('\n');
    for (const s of [...secretValues(secrets), user.smtpPassword, user.aiKey]) {
      expect(frontend).not.toContain(s);
    }
    // Only the instance id and the public half of its key reach the frontend.
    expect(frontend).toContain(secrets.instanceId);
    expect(frontend).toContain(secrets.instanceKey.fingerprint);
    const leaked = { ...kits, frontend: { ...kits.frontend, 'leak.txt': secrets.masterKey } };
    expect(await checkKits(leaked, secrets)).toContain('a secret is in leak.txt');
  });

  it('[OPS-016] (2) gives byte-identical kits for the same inputs and seed', async () => {
    const build = async () => {
      const secrets = await generateSecrets(seededRandom('the project seed of this test'));
      const kits = await buildKits(inputs(), secrets, {}, VERSIONS);
      return [zipKit(kits.backend), zipKit(kits.frontend)];
    };
    expect(await build()).toEqual(await build());
  });

  it('[OPS-014] gives the same kits for the same inputs except the secrets', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 16 }), fc.string({ minLength: 16 }), async (a, b) => {
        fc.pre(a !== b);
        const [x, y] = [
          await generateSecrets(seededRandom(a)),
          await generateSecrets(seededRandom(b)),
        ];
        const [kx, ky] = [
          await buildKits(inputs(), x, {}, VERSIONS),
          await buildKits(inputs(), y, {}, VERSIONS),
        ];
        expect(masked(kx.backend, x, kx.manifest.signature)).toEqual(
          masked(ky.backend, y, ky.manifest.signature),
        );
        expect(masked(kx.frontend, x, kx.manifest.signature)).toEqual(
          masked(ky.frontend, y, ky.manifest.signature),
        );
      }),
      { numRuns: 10 },
    );
  });

  it('[API-017] signs a manifest that breaks if any field changes', async () => {
    const secrets = await generateSecrets(systemRandom);
    const { manifest } = await buildKits(inputs(), secrets, {}, VERSIONS);
    const fields = Object.keys(manifest.manifest) as (keyof typeof manifest.manifest)[];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...fields),
        fc.string({ minLength: 1 }),
        async (field, value) => {
          const original = manifest.manifest[field];
          fc.pre(JSON.stringify(original) !== JSON.stringify(value));
          const changed = { ...manifest, manifest: { ...manifest.manifest, [field]: value } };
          expect(await verifyManifest(changed)).toBe(false);
        },
      ),
      { numRuns: 40 },
    );
    // A signature with one character changed.
    const sig = manifest.signature;
    const flipped = `${sig.slice(0, 10)}${sig[10] === 'A' ? 'B' : 'A'}${sig.slice(11)}`;
    expect(await verifyManifest({ ...manifest, signature: flipped })).toBe(false);
  });

  it('[OPS-014] writes the frontend kit the runtime config of ADR-066', async () => {
    const secrets = await generateSecrets(systemRandom);
    const kits = await buildKits(inputs({ routing: 'hash' }), secrets, {}, VERSIONS);
    expect(JSON.parse(kits.frontend[CONFIG_FILE] ?? '')).toEqual({
      apiUrl: 'https://api.example.com',
      basePath: '/',
      instanceName: 'Acme tracker',
      routing: 'hash',
      instanceId: secrets.instanceId,
      instanceKey: secrets.instanceKey.publicKey,
    });
    // On the backend's own origin, the frontend calls its own origin.
    const same = await buildKits(
      inputs({ frontendUrl: 'https://api.example.com/' }),
      secrets,
      {},
      VERSIONS,
    );
    expect(JSON.parse(same.frontend[CONFIG_FILE] ?? '').apiUrl).toBe('');
    expect(Object.keys(kits.backend).sort()).toEqual([ENV_FILE, MANIFEST_FILE]);
  });
});

describe('the project file (M1-109)', () => {
  it('[OPS-016] round-trips the inputs, leaving the secrets out without a passphrase', async () => {
    const form = inputs({ smtp: { host: 'smtp.example.com', port: 465 } });
    const text = await saveProject(form, {
      builderVersion: '1.4.2',
      secrets: { generated: await generateSecrets(systemRandom), user: {} },
    });
    expect(text).not.toContain('secrets');
    expect(await loadProject(text)).toEqual({
      inputs: form,
      builderVersion: '1.4.2',
      secrets: null,
    });
  });

  it('[OPS-016] keeps the secrets only encrypted, and only the passphrase opens them', async () => {
    const secrets = {
      generated: await generateSecrets(systemRandom),
      user: { smtpPassword: 'the smtp password' },
    };
    const text = await saveProject(inputs(), {
      builderVersion: '1.4.2',
      secrets,
      passphrase: 'correct horse battery staple',
    });
    for (const s of [...secretValues(secrets.generated), 'the smtp password']) {
      expect(text).not.toContain(s);
    }
    expect((await loadProject(text, 'correct horse battery staple')).secrets).toEqual(secrets);
    await expect(loadProject(text, 'wrong passphrase')).rejects.toThrow(ProjectError);
    // Without the passphrase, the inputs still open.
    expect((await loadProject(text)).secrets).toBe(null);
    await expect(loadProject('{"format":"something else"}')).rejects.toThrow('not_a_project');
  });

  it('[OPS-016] writes one text for one set of inputs, secrets and seed', async () => {
    const save = async () =>
      saveProject(inputs(), {
        builderVersion: '1.4.2',
        secrets: {
          generated: await generateSecrets(seededRandom('seed of the secrets!')),
          user: {},
        },
        passphrase: 'a passphrase',
        random: seededRandom('seed of the salt and iv'),
      });
    expect(await save()).toBe(await save());
  });
});

describe('kit archives (M1-109)', () => {
  it('[OPS-016] writes the same bytes for the same files, whatever their order', () => {
    const a = writeZip({ 'b.txt': 'two', 'a/one.txt': 'one', '.env': 'X=1\n' });
    const b = writeZip({ '.env': 'X=1\n', 'a/one.txt': 'one', 'b.txt': 'two' });
    expect(a).toEqual(b);
    expect(new TextDecoder().decode(readZip(a)['a/one.txt'])).toBe('one');
    expect(() => writeZip({ '../escape': 'x' })).toThrow(/relative path/);
  });

  it('[OPS-016] writes archives a standard unzip reads', () => {
    let unzip = true;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      unzip = false;
    }
    if (!unzip) return;
    const dir = mkdtempSync(join(tmpdir(), 'taskmoor-zip-'));
    try {
      const file = join(dir, 'kit.zip');
      writeFileSync(file, writeZip({ 'docs/readme.txt': 'hello', 'é.txt': 'accent' }));
      expect(execFileSync('unzip', ['-t', file]).toString()).toMatch(/No errors detected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
