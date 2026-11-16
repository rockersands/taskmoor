import { describe, expect, it, vi } from 'vitest';
import { setAccountTimeZone } from '../i18n/zone';
import { notesFileHref } from './client';

// The frontend hosted at one site and the backend at another (OPS-017): the page's configuration
// names the backend, and every address to it starts there.
vi.mock('../runtime/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('../runtime/config')>();
  return {
    ...original,
    runtimeConfig: { ...original.runtimeConfig, apiUrl: 'https://api.example.test' },
  };
});

describe('the release notes file with the backend at another site (T-282)', () => {
  it('[CORE-016] [OPS-017] downloads the notes from the configured backend, not the frontend’s host', () => {
    const zone = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...new Intl.DateTimeFormat().resolvedOptions(),
      timeZone: 'Europe/Madrid',
    });
    expect(notesFileHref(7)).toBe(
      'https://api.example.test/api/v1/releases/7/notes?format=markdown&timeZone=Europe%2FMadrid',
    );
    zone.mockRestore();
  });

  it('[CORE-016] [IAM-008] names the account’s zone over the device’s (T-280)', () => {
    const zone = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...new Intl.DateTimeFormat().resolvedOptions(),
      timeZone: 'Europe/Madrid',
    });
    setAccountTimeZone('America/Bogota');
    try {
      expect(notesFileHref(7)).toBe(
        'https://api.example.test/api/v1/releases/7/notes?format=markdown&timeZone=America%2FBogota',
      );
    } finally {
      setAccountTimeZone(null);
      zone.mockRestore();
    }
  });
});
