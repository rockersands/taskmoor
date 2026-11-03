import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip, saveProject, validateInputs } from '@taskmoor/builder-core';
import { afterAll, describe, expect, it } from 'vitest';
import { runBuilder } from './builder';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskmoor-builder-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A web build in miniature. */
function web(): string {
  const dir = temp();
  mkdirSync(join(dir, 'assets'));
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><script id="taskmoor-config" type="application/json">{}</script><script type="module" crossorigin src="./assets/app.js"></script></head><body></body></html>',
  );
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1);');
  return dir;
}

async function project(): Promise<string> {
  const form = validateInputs({
    backendUrl: 'https://api.example.com',
    frontendUrl: 'https://tracker.example.com/',
  });
  if (!form.ok) throw new Error('inputs');
  return saveProject(form.inputs, { builderVersion: '1.4.2' });
}

describe('the Builder CLI (M1-111)', () => {
  it('[OPS-016] (2) writes byte-identical kits from one project file and seed', async () => {
    const [text, build] = [await project(), web()];
    const run = async () => {
      const out = await runBuilder({
        project: text,
        webDir: build,
        outDir: temp(),
        seed: 'the same seed for both runs',
        versions: { backendVersion: '1.4.2', kitVersion: '1.4.2' },
      });
      return Object.values(out).map((path) => readFileSync(path));
    };
    expect(await run()).toEqual(await run());
  });

  it('[OPS-016] writes both kits, the frontend twice: a zip and one file', async () => {
    const out = await runBuilder({
      project: await project(),
      webDir: web(),
      outDir: temp(),
      versions: { backendVersion: '1.4.2', kitVersion: '1.4.2' },
    });
    expect(Object.keys(readZip(readFileSync(out.backend))).sort()).toEqual([
      '.env',
      'Caddyfile',
      'README.md',
      'connection-manifest.json',
      'docker-compose.yml',
      'install.ps1',
      'install.sh',
      'taskmoor-release.pub',
      'update.sh',
      'upgrade.sh',
    ]);
    expect(Object.keys(readZip(readFileSync(out.frontend))).sort()).toEqual([
      '.htaccess',
      '_redirects',
      'assets/app.js',
      'connection-manifest.json',
      'index.html',
      'nginx.conf',
    ]);
    expect(readFileSync(out.single, 'utf8')).toContain(
      '<script type="module">console.log(1);</script>',
    );
  });
});
