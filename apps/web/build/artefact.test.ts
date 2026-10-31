import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildKits,
  frontendKit,
  generateSecrets,
  kitText,
  secretValues,
  systemRandom,
  validateInputs,
} from '@taskmoor/builder-core';
import { buildApp } from '@taskmoor/server';
import { DEFAULT_RUNTIME_CONFIG, parseManifest, readRuntimeConfig } from '@taskmoor/webconfig';
import { build, type Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { scanText } from '../../../packages/devtools/src/secrets';
import {
  scanArtefact,
  serverCode,
  serverModules,
  taskmoorArtefact,
  writeManifest,
} from './artefact';

const WEB = fileURLToPath(new URL('../', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VERSION = '9.9.9-artefact';
/**
 * AI secrets present in the build's environment (M1-075; IAM-020 (1)), made at run time and
 * shaped so no scanner mistakes them for real keys: the bundle must carry none of them, under
 * any of the names a build tool might expose.
 */
const BUILD_SECRETS = {
  TASKMOOR_AI_KEY: `fake-ai-key-${randomBytes(18).toString('hex')}`,
  VITE_TASKMOOR_AI_KEY: `fake-ai-key-${randomBytes(18).toString('hex')}`,
  TASKMOOR_MASTER_KEY: randomBytes(32).toString('base64url'),
  VITE_TASKMOOR_MASTER_KEY: randomBytes(32).toString('base64url'),
};

/** Every file under a folder, relative, with forward slashes. */
const filesOf = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) =>
      join(e.parentPath, e.name)
        .slice(dir.length + 1)
        .replaceAll('\\', '/'),
    )
    .sort();

describe('the frontend build', () => {
  let outDir: string;
  let modules: string[] = [];

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'taskmoor-web-artefact-'));
    vi.stubEnv('TASKMOOR_VERSION', VERSION);
    for (const [name, value] of Object.entries(BUILD_SECRETS)) vi.stubEnv(name, value);
    // Notes every module of the graph, to show the guard sees the workspace packages too.
    const capture: Plugin = {
      name: 'capture-modules',
      generateBundle() {
        modules = [...this.getModuleIds()];
      },
    };
    await build({
      root: WEB,
      configFile: join(WEB, 'vite.config.ts'),
      logLevel: 'error',
      plugins: [capture],
      build: { outDir, emptyOutDir: true },
    });
    vi.unstubAllEnvs();
  });
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('[OPS-013] makes frontend kits from the build with no secret in them', async () => {
    const files = (dir: string, prefix = ''): Record<string, Uint8Array> =>
      Object.fromEntries(
        readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? Object.entries(files(dir, `${prefix}${e.name}/`))
            : [[`${prefix}${e.name}`, new Uint8Array(readFileSync(join(dir, prefix, e.name)))]],
        ),
      );
    const web = files(outDir);
    const form = validateInputs({
      backendUrl: 'https://api.example.com',
      frontendUrl: 'https://tracker.example.com/',
    });
    if (!form.ok) throw new Error('inputs');
    const secrets = await generateSecrets(systemRandom);
    const kits = await buildKits(
      form.inputs,
      secrets,
      { smtpPassword: 'smtp secret value' },
      {
        backendVersion: VERSION,
        kitVersion: VERSION,
      },
    );
    for (const singleFile of [false, true]) {
      const kit = await frontendKit(kits, web, { singleFile });
      for (const [path, file] of Object.entries(kit)) {
        const text = kitText(file);
        expect(scanText(path, text), path).toEqual([]);
        for (const s of [...secretValues(secrets), 'smtp secret value'])
          expect(text).not.toContain(s);
      }
      expect(kitText(kit['index.html'])).toContain(secrets.instanceId);
    }
  });

  it('[IAM-020] (1) carries no AI key or master key from the build environment', () => {
    const shipped = filesOf(outDir).map((f) => readFileSync(join(outDir, f), 'utf8'));
    expect(shipped.length).toBeGreaterThan(3);
    for (const [name, value] of Object.entries(BUILD_SECRETS)) {
      const found = shipped.filter((text) => text.includes(value));
      expect(found.length, `${name} is in the bundle`).toBe(0);
    }
  });

  it('[OPS-013] is a versioned artefact whose manifest lists every file it ships', () => {
    const manifest = parseManifest(JSON.parse(readFileSync(join(outDir, 'version.json'), 'utf8')));
    expect(manifest.version).toBe(VERSION);
    expect(manifest.files.map((f) => f.path)).toEqual(
      filesOf(outDir).filter((f) => f !== 'version.json'),
    );
    for (const file of manifest.files) {
      const bytes = readFileSync(join(outDir, file.path));
      expect(file.bytes).toBe(bytes.length);
      expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(filesOf(outDir).filter((f) => !/\.(html|js|css|json)$/.test(f))).toEqual([]);
  });

  it('[OPS-013] bundles no server code and ships its runtime-config slot empty', () => {
    const code = serverCode(ROOT);
    expect(modules.some((id) => id.includes('/packages/query/src/'))).toBe(true);
    expect(modules.some((id) => id.includes('/node_modules/react-dom/'))).toBe(true);
    expect(serverModules(modules, code)).toEqual([]);
    expect(scanArtefact(outDir)).toEqual([]);
    const index = readFileSync(join(outDir, 'index.html'), 'utf8');
    expect(readRuntimeConfig(index)).toEqual({ config: DEFAULT_RUNTIME_CONFIG, problems: [] });
    // Relative asset URLs, so the files work from any folder on any host.
    expect(index).toMatch(/src="\.\/assets\/index-[\w-]+\.js"/);
    const js = filesOf(outDir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(outDir, f), 'utf8'))
      .join('\n');
    for (const marker of ['DATABASE_URL', 'TASKMOOR_PASSWORD_PEPPER', 'pg_catalog', 'fastify']) {
      expect(js).not.toContain(marker);
    }
  });

  it('[OPS-017] is served by a backend of the same version and refused by any other', async () => {
    const app = await buildApp({ version: VERSION, roles: ['web'], webDir: outDir });
    const manifest = await app.inject({ method: 'GET', url: '/version.json' });
    expect(manifest.json().version).toBe(VERSION);
    expect((await app.inject({ method: 'GET', url: '/health' })).json().version).toBe(VERSION);
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(readRuntimeConfig(index.body)?.config.routing).toBe('hash');
    await app.close();
    await expect(buildApp({ version: '9.9.8', roles: ['web'], webDir: outDir })).rejects.toThrow(
      new RegExp(`holds frontend ${VERSION.replaceAll('.', '\\.')} but this server is 9\\.9\\.8`),
    );
  });
});

describe('the server-code guard', () => {
  // Inside the app's folder, so its imports resolve through the app's own node_modules.
  const fixtures = join(WEB, '.cache');
  let dir: string;
  beforeAll(() => {
    mkdirSync(fixtures, { recursive: true });
    dir = mkdtempSync(join(fixtures, 'guard-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const buildFixture = (entry: string) => {
    const root = mkdtempSync(join(dir, 'app-'));
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><script id="taskmoor-config" type="application/json">{}</script>' +
        '<script type="module" src="./main.ts"></script>',
    );
    writeFileSync(join(root, 'main.ts'), entry);
    return build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [taskmoorArtefact({ root: ROOT })],
      build: { outDir: join(root, 'dist') },
    });
  };

  it('[OPS-013] fails a build that would bundle a server package', async () => {
    await expect(
      buildFixture("import { createDb } from '@taskmoor/db';\nconsole.log(createDb);\n"),
    ).rejects.toThrow(/would include server code:[\s\S]*packages\/db\/src\//);
  });

  it('[OPS-013] fails a build that would bundle a Node built-in', async () => {
    await expect(
      buildFixture("import { readFileSync } from 'node:fs';\nconsole.log(readFileSync);\n"),
    ).rejects.toThrow(/would include server code/);
  });

  it('[OPS-013] knows the server-only packages from the workspace manifests', () => {
    const code = serverCode(ROOT);
    for (const name of ['fastify', 'kysely', 'pg', 'nodemailer', '@fastify/static', 'ldapts']) {
      expect(code.packages).toContain(name);
    }
    // micromark: a direct dependency of devtools (the docs build), and browser code too, which
    // the app reaches through @taskmoor/richtext and mdast-util-from-markdown.
    for (const name of ['react', 'react-dom', 'yjs', '@tiptap/core', '@taskmoor/db', 'micromark']) {
      expect(code.packages).not.toContain(name);
    }
    expect(code.dirs.some((d) => d.endsWith('/apps/server/'))).toBe(true);
    expect(code.dirs.some((d) => d.endsWith('/apps/web/'))).toBe(false);
    const ids = [
      `${ROOT}packages/query/src/index.ts`,
      `${ROOT}node_modules/.pnpm/fastify@5.12.5/node_modules/fastify/fastify.js?commonjs-module`,
      `\0${ROOT}node_modules/.pnpm/@fastify+static@10/node_modules/@fastify/static/index.js`,
      '__vite-browser-external:node:net',
      `${ROOT}node_modules/.pnpm/react@19/node_modules/react/index.js`,
    ];
    expect(serverModules(ids, code)).toEqual([
      `${ROOT}node_modules/.pnpm/fastify@5.12.5/node_modules/fastify/fastify.js`,
      `${ROOT}node_modules/.pnpm/@fastify+static@10/node_modules/@fastify/static/index.js`,
      '__vite-browser-external:node:net',
    ]);
  });
});

describe('the artefact scan', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'taskmoor-web-scan-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('[OPS-013] names unexpected files, secret-looking text and an unusable slot', () => {
    const index = '<script id="taskmoor-config" type="application/json">{}</script>';
    writeFileSync(join(dir, 'index.html'), index);
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    writeManifest(dir, '1.0.0');
    expect(scanArtefact(dir)).toEqual([]);
    // Built at run time, so the repository's own secret scan has nothing to find here.
    writeFileSync(join(dir, 'app.js'), `const key = "${'AKIA'}${'Q'.repeat(16)}";`);
    writeFileSync(join(dir, 'server.mjs'), 'export {}');
    expect(scanArtefact(dir)).toEqual([
      'text that looks like a secret (aws-access-key) in app.js:1',
      'unexpected file server.mjs',
    ]);
    rmSync(join(dir, 'server.mjs'));
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'index.html'), index.replace('{}', '{"routing":"path"}'));
    expect(scanArtefact(dir)).toEqual(['index.html ships with its runtime-config slot filled']);
    writeFileSync(join(dir, 'index.html'), '<div id="root"></div>');
    expect(scanArtefact(dir)).toEqual(['index.html has no runtime-config slot']);
  });
});
