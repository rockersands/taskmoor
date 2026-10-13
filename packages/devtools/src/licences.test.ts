import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deniedLicences, installedPackages, isAllowed } from './licences';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

describe('dependency licences', () => {
  // Reads every installed package.json: fast on an SSD, up to tens of seconds on a cold hard disk.
  it('are all on the allowlist', () => {
    const packages = installedPackages(REPO);
    expect(packages.length).toBeGreaterThan(100);
    expect(deniedLicences(packages)).toEqual([]);
  }, 60_000);

  it('reads every store folder, including the ones pnpm shortens with a hash', () => {
    const store = join(REPO, 'node_modules', '.pnpm');
    const folders = readdirSync(store, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && d.name !== 'node_modules',
    );
    const packages = installedPackages(REPO);
    // One package per folder; unique names are fewer when several versions are installed.
    expect(packages.length).toBeGreaterThanOrEqual(folders.length * 0.98);
    const names = new Set(packages.map((p) => p.name));
    // Long names such as this one live in folders like "@opentelemetry+sdk-trace-ba_<hash>".
    expect(names.has('@opentelemetry/sdk-trace-base')).toBe(true);
    expect(names.has('@opentelemetry/exporter-trace-otlp-http')).toBe(true);
  }, 60_000);

  it('a fixture with denied or missing licences fails', () => {
    expect(
      deniedLicences([
        { name: 'ok', version: '1.0.0', licence: 'MIT' },
        { name: 'sspl-db', version: '2.0.0', licence: 'SSPL-1.0' },
        { name: 'old-gpl', version: '0.1.0', licence: 'GPL-2.0-only' },
        { name: 'mystery', version: '3.0.0', licence: '' },
      ]),
    ).toEqual([
      'mystery@3.0.0: no licence declared',
      'old-gpl@0.1.0: GPL-2.0-only',
      'sspl-db@2.0.0: SSPL-1.0',
    ]);
  });
});

describe('isAllowed', () => {
  it('evaluates SPDX expressions', () => {
    expect(isAllowed('MIT')).toBe(true);
    expect(isAllowed('(MIT OR GPL-2.0-only)')).toBe(true);
    expect(isAllowed('MIT AND BUSL-1.1')).toBe(false);
    expect(isAllowed('(MIT AND ISC) OR SSPL-1.0')).toBe(true);
    expect(isAllowed('Apache-2.0 WITH LLVM-exception')).toBe(true);
    expect(isAllowed('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(false);
  });

  it('rejects malformed or unknown licences', () => {
    expect(isAllowed('')).toBe(false);
    expect(isAllowed('UNLICENSED')).toBe(false);
    expect(isAllowed('SEE LICENSE IN LICENSE.md')).toBe(false);
    expect(isAllowed('(MIT')).toBe(false);
    expect(isAllowed('MIT OR')).toBe(false);
  });
});
