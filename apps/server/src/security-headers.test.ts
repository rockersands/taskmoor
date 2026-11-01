import { useMigratedDatabase } from '@taskmoor/db/testing';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

describe('security headers (M1-118, ASVS 14.4)', () => {
  const database = useMigratedDatabase();

  it('[NFR-008] ASVS 8.2.1, 14.4.2, 14.4.4, 14.4.6: nosniff, same-origin referrers, API JSON as an uncached attachment', async () => {
    const app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    try {
      const meta = await app.inject({ method: 'GET', url: '/api/meta' });
      expect(meta.headers['x-content-type-options']).toBe('nosniff');
      expect(meta.headers['referrer-policy']).toBe('same-origin');
      expect(meta.headers['content-disposition']).toBe('attachment; filename="api.json"');
      expect(meta.headers['cache-control']).toBe('no-store');
      expect(meta.headers['strict-transport-security']).toBeUndefined();
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.headers['x-content-type-options']).toBe('nosniff');
      expect(health.headers['content-disposition']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('[NFR-008] ASVS 14.4.5: HSTS on an instance served over HTTPS', async () => {
    const app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      secureCookies: true,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    } finally {
      await app.close();
    }
  });
});
