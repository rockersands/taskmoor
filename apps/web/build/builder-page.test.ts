import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, saveProject, validateInputs } from '@taskmoor/builder-core';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// By path, as the build's own plugin does (the boundary rules allow it under build/).
import { runBuilder } from '../../../packages/devtools/src/builder';
import { decodeWebBuild, WEB_BUILD_ELEMENT_ID } from '../src/builder/embedded';
import { generateKits } from '../src/builder/generate';
import { encodeWebBuild, readWebBuild, singlePage } from './builder-page';

const WEB = fileURLToPath(new URL('../', import.meta.url));
const SEED = 'the seed both faces of the Builder get';
const VERSION = '9.9.9-builder';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskmoor-builder-page-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A web build in miniature, stamped with its version. */
function miniatureWeb(): string {
  const dir = temp();
  mkdirSync(join(dir, 'assets'));
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><meta charset="UTF-8" /><script id="taskmoor-config" type="application/json">{}</script><script type="module" crossorigin src="./assets/app.js"></script><link rel="stylesheet" crossorigin href="./assets/app.css"></head><body></body></html>',
  );
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("</script> stays text");');
  writeFileSync(join(dir, 'assets', 'app.css'), 'body{color:red}');
  writeFileSync(
    join(dir, 'version.json'),
    JSON.stringify({ name: 'taskmoor-web', version: VERSION, files: [] }),
  );
  return dir;
}

const dataBlock = (html: string) =>
  html.match(
    new RegExp(`<script id="${WEB_BUILD_ELEMENT_ID}" type="application/json">(.*?)</script>`, 's'),
  )?.[1] ?? '';

describe('the Builder page build (M1-112)', () => {
  let webDir: string;
  let outDir: string;
  let page: string;

  beforeAll(async () => {
    webDir = miniatureWeb();
    outDir = temp();
    vi.stubEnv('TASKMOOR_BUILDER_WEB', webDir);
    await build({
      root: join(WEB, 'src/builder'),
      configFile: join(WEB, 'vite.builder.config.ts'),
      logLevel: 'error',
      build: { outDir, emptyOutDir: true },
    });
    vi.unstubAllEnvs();
    page = readFileSync(join(outDir, 'index.html'), 'utf8');
  });

  it('[OPS-016] (1) is one file that names no other and may make no request', () => {
    expect(readdirSync(outDir)).toEqual(['index.html']);
    // The page around its inline blocks (their code may say anything) loads no file.
    const shell = page
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '<script></script>')
      .replace(/<style>[\s\S]*?<\/style>/g, '<style></style>');
    expect(shell.length).toBeLessThan(2_000);
    expect(shell).not.toMatch(/\b(?:src|href)=/);
    const policy = page.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    // The page's one script is allowed by its hash, and nothing else is.
    const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] ?? '';
    const hash = createHash('sha256').update(script).digest('base64');
    expect(policy).toMatch(new RegExp(`script-src 'sha256-${hash.replace(/[+/]/g, '\\$&')}'(;|$)`));
  });

  it('[OPS-016] carries the web build byte for byte, with its version', () => {
    const carried = decodeWebBuild(dataBlock(page));
    expect(carried?.version).toBe(VERSION);
    const expected = readWebBuild(webDir);
    expect(Object.keys(carried?.web ?? {}).sort()).toEqual(Object.keys(expected).sort());
    for (const [path, bytes] of Object.entries(expected)) {
      expect(Buffer.from(carried?.web[path] ?? []).equals(Buffer.from(bytes)), path).toBe(true);
    }
  });

  it('[OPS-016] (2) the page and the CLI make the same bytes from one project file and seed', async () => {
    const form = validateInputs({
      backendUrl: 'https://api.example.com',
      frontendUrl: 'https://tracker.example.com/tracker/',
      instanceName: 'Acme tracker',
      routing: 'path',
      target: 'helm',
    });
    if (!form.ok) throw new Error('inputs');
    const project = await saveProject(form.inputs, { builderVersion: VERSION });
    const cli = await runBuilder({
      project,
      webDir,
      outDir: temp(),
      seed: SEED,
      versions: { backendVersion: VERSION, kitVersion: VERSION },
    });
    // The page's path: the build out of its data block, then its own run.
    const carried = decodeWebBuild(dataBlock(page));
    if (!carried) throw new Error('no build in the page');
    const { outputs } = await generateKits({
      inputs: form.inputs,
      user: {},
      secrets: null,
      seed: SEED,
      web: carried.web,
      version: carried.version,
    });
    for (const key of ['backend', 'frontend', 'single'] as const) {
      expect(Buffer.from(outputs[key]).equals(readFileSync(cli[key])), key).toBe(true);
    }
    expect(Object.keys(readZip(outputs.backend))).toContain('values.yaml');
  });

  it('refuses a page that would still load a file', () => {
    const html =
      '<html><head><meta charset="UTF-8" /><script type="module" src="./a.js"></script><link rel="icon" href="./x.png"></head><body></body></html>';
    expect(() => singlePage(html, () => '', encodeWebBuild({}))).toThrow(/still names a file/);
    expect(encodeWebBuild({ '<odd>.js': new Uint8Array([1]) })).not.toContain('<');
  });
});
