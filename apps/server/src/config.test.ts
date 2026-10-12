import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const DB = 'postgres://tracksmith:s3cret@db:5432/tracksmith';

describe('loadConfig', () => {
  it('applies defaults when only DATABASE_URL is set', () => {
    expect(loadConfig({ DATABASE_URL: DB })).toEqual({
      databaseUrl: DB,
      port: 8080,
      host: '0.0.0.0',
      logLevel: 'info',
      version: '0.0.0-dev',
      roles: ['api', 'worker', 'realtime', 'web'],
      webDir: undefined,
      publicUrl: 'http://localhost:8080',
      secureCookies: false,
      setupToken: undefined,
      dataDir: undefined,
      metricsPort: 9464,
      metricsHost: '0.0.0.0',
    });
  });

  it('[OPS-011] reads the metrics listener and the data directory', () => {
    expect(
      loadConfig({
        DATABASE_URL: DB,
        METRICS_PORT: '0',
        HOST: '127.0.0.1',
        TRACKSMITH_DATA: '/data',
      }),
    ).toMatchObject({ metricsPort: 0, metricsHost: '127.0.0.1', dataDir: '/data' });
    expect(loadConfig({ DATABASE_URL: DB, METRICS_HOST: '10.0.0.5' }).metricsHost).toBe('10.0.0.5');
    expect(() => loadConfig({ DATABASE_URL: DB, METRICS_PORT: '70000' })).toThrow(/METRICS_PORT/);
  });

  it('reads every supported variable', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/ts',
      PORT: '9000',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'debug',
      TRACKSMITH_VERSION: '1.2.3',
    });
    expect(config).toMatchObject({
      port: 9000,
      host: '127.0.0.1',
      logLevel: 'debug',
      version: '1.2.3',
    });
  });

  it('lists every problem and never echoes the database URL', () => {
    const run = () =>
      loadConfig({ DATABASE_URL: 'mysql://root:hunter2@db/x', PORT: '70000', LOG_LEVEL: 'loud' });
    expect(run).toThrow(/DATABASE_URL must be a postgres/);
    expect(run).toThrow(/PORT/);
    expect(run).toThrow(/LOG_LEVEL/);
    expect(run).not.toThrow(/hunter2/);
  });

  it('requires DATABASE_URL for every role but web', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required for the api, worker/);
    expect(() => loadConfig({ TRACKSMITH_ROLE: 'worker' })).toThrow(/DATABASE_URL is required/);
    expect(loadConfig({ TRACKSMITH_ROLE: 'web', TRACKSMITH_WEB_DIR: '/app/web' })).toMatchObject({
      databaseUrl: undefined,
      roles: ['web'],
      webDir: '/app/web',
    });
  });

  it('[OPS-003] derives the setup link base and cookie security from PUBLIC_URL', () => {
    const config = loadConfig({
      DATABASE_URL: DB,
      PUBLIC_URL: 'https://tracker.example.com/',
      TRACKSMITH_SETUP_TOKEN: 'fixed-token-for-the-installer',
    });
    expect(config).toMatchObject({
      publicUrl: 'https://tracker.example.com/',
      secureCookies: true,
      setupToken: 'fixed-token-for-the-installer',
    });
    expect(() => loadConfig({ DATABASE_URL: DB, PUBLIC_URL: 'tracker' })).toThrow(/PUBLIC_URL/);
  });

  it('treats empty variables as unset, which is what Compose passes for them', () => {
    const config = loadConfig({ DATABASE_URL: DB, TRACKSMITH_SETUP_TOKEN: '', PUBLIC_URL: '' });
    expect(config.setupToken).toBeUndefined();
    expect(config.publicUrl).toBe('http://localhost:8080');
  });

  it('[OPS-002] runs every role by default and accepts a comma-separated subset', () => {
    expect(loadConfig({ DATABASE_URL: DB }).roles).toEqual(['api', 'worker', 'realtime', 'web']);
    expect(loadConfig({ DATABASE_URL: DB, TRACKSMITH_ROLE: 'realtime, API' }).roles).toEqual([
      'api',
      'realtime',
    ]);
    expect(() => loadConfig({ DATABASE_URL: DB, TRACKSMITH_ROLE: 'api,cron' })).toThrow(
      /unknown: cron/,
    );
  });
});
