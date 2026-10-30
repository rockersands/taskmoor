import { describe, expect, it } from 'vitest';
import { compareReleases, frontendSkew, frontendWindow, parseRelease } from './versions';

const release = (version: string) => {
  const parsed = parseRelease(version);
  if (!parsed) throw new Error(`not a release: ${version}`);
  return parsed;
};

describe('frontend versions', () => {
  it('[API-018] reads release versions and nothing else', () => {
    expect(parseRelease('1.4.2')).toEqual({ major: 1, minor: 4, patch: 2, prerelease: '' });
    expect(parseRelease('v2.0.0-rc.1')).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: 'rc.1',
    });
    expect(parseRelease('1.4.2+build.7')?.prerelease).toBe('');
    for (const other of ['0a1b2c3d4e5f', '1.4', '', 'latest'])
      expect(parseRelease(other)).toBe(null);
  });

  it('[API-018] orders releases, a prerelease before its release', () => {
    const sorted = ['1.10.0', '1.2.0', '1.2.0-rc.2', '1.2.0-rc.10', '0.9.9', '2.0.0-dev'].sort(
      (a, b) => compareReleases(release(a), release(b)),
    );
    expect(sorted).toEqual(['0.9.9', '1.2.0-rc.2', '1.2.0-rc.10', '1.2.0', '1.10.0', '2.0.0-dev']);
  });

  it('[NFR-010] a release serves its own frontends and the previous release’s', () => {
    expect(frontendWindow('1.4.2')).toEqual({ minimum: '1.3.0', recommended: '1.4.0' });
    expect(frontendWindow('v1.1.0')).toEqual({ minimum: '1.0.0', recommended: '1.1.0' });
    // A major release breaks the API on purpose.
    expect(frontendWindow('2.0.3')).toEqual({ minimum: '2.0.0', recommended: '2.0.0' });
    // Development builds take any frontend.
    for (const dev of ['0.0.0-dev', '1.4.2-3-gabc1234', '0a1b2c3d4e5f']) {
      expect(frontendWindow(dev)).toEqual({ minimum: null, recommended: null });
    }
  });

  it('[API-018] [OPS-017] tells a frontend one release behind to update, an older one that it must', () => {
    const window = frontendWindow('1.4.2');
    expect(frontendSkew('1.4.0', window)).toBe('current');
    expect(frontendSkew('1.4.7', window)).toBe('current');
    expect(frontendSkew('1.5.0', window)).toBe('current');
    expect(frontendSkew('1.3.9', window)).toBe('update-available');
    expect(frontendSkew('1.4.0-rc.1', window)).toBe('update-available');
    expect(frontendSkew('1.2.9', window)).toBe('update-required');
    expect(frontendSkew('0.0.0-dev', window)).toBe('update-required');
    expect(frontendSkew('0a1b2c3d4e5f', window)).toBe('unknown');
    expect(frontendSkew('1.0.0', frontendWindow('0.0.0-dev'))).toBe('unknown');
  });
});
