import { describe, expect, it } from 'vitest';
import { buildVersion, DEV_VERSION, parseManifest } from './manifest';

const SHA = 'a'.repeat(64);

describe('artefact manifest', () => {
  it('[OPS-017] stamps TASKMOOR_VERSION, or the development version without one', () => {
    expect(buildVersion({})).toBe(DEV_VERSION);
    expect(buildVersion({ TASKMOOR_VERSION: ' ' })).toBe(DEV_VERSION);
    expect(buildVersion({ TASKMOOR_VERSION: 'v1.2.3-4-gabc1234' })).toBe('v1.2.3-4-gabc1234');
    expect(buildVersion({ TASKMOOR_VERSION: '0a1b2c3d4e5f' })).toBe('0a1b2c3d4e5f');
    expect(() => buildVersion({ TASKMOOR_VERSION: '1.0 beta' })).toThrow(/not a version/);
    expect(() => buildVersion({ TASKMOOR_VERSION: '-rf' })).toThrow(/not a version/);
  });

  it('[OPS-017] reads a manifest and refuses anything else', () => {
    const manifest = {
      name: 'taskmoor-web',
      version: '1.2.3',
      files: [{ path: 'assets/app.js', bytes: 10, sha256: SHA }],
    };
    expect(parseManifest(manifest)).toEqual(manifest);
    expect(() => parseManifest(null)).toThrow(/not a taskmoor-web manifest/);
    expect(() => parseManifest({ ...manifest, name: 'other' })).toThrow(/not a taskmoor-web/);
    expect(() => parseManifest({ ...manifest, version: '' })).toThrow(/no valid version/);
    for (const file of [
      { path: '../server.mjs', bytes: 1, sha256: SHA },
      { path: '/etc/passwd', bytes: 1, sha256: SHA },
      { path: 'a.js', bytes: 1.5, sha256: SHA },
      { path: 'a.js', bytes: 1, sha256: 'xyz' },
    ]) {
      expect(() => parseManifest({ ...manifest, files: [file] })).toThrow(/invalid files/);
    }
  });
});
