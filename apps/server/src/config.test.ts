import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const DB = 'postgres://taskmoor:s3cret@db:5432/taskmoor';

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
      shutdownDrainMs: 2000,
      storage: { urlTtl: 300 },
    });
  });

  it('[CORE-021] reads the attachment store, S3 credentials and the scanner from the environment', () => {
    // Placeholders only: real credentials come from the environment at run time.
    const config = loadConfig({
      DATABASE_URL: DB,
      TASKMOOR_S3_BUCKET: 'taskmoor-files',
      TASKMOOR_S3_ENDPOINT: 'http://minio:9000',
      TASKMOOR_S3_PUBLIC_ENDPOINT: 'https://files.example.com',
      TASKMOOR_S3_PREFIX: 'attachments/',
      TASKMOOR_S3_ACCESS_KEY_ID: 'placeholder-id',
      TASKMOOR_S3_SECRET_ACCESS_KEY: 'placeholder-secret',
      TASKMOOR_S3_URL_TTL: '120',
      TASKMOOR_SCAN_CLAMD: 'clamav:3310',
    });
    expect(config.storage).toEqual({
      backend: undefined,
      filesDir: undefined,
      urlTtl: 120,
      scanClamd: 'clamav:3310',
      s3: {
        bucket: 'taskmoor-files',
        region: 'us-east-1',
        endpoint: 'http://minio:9000',
        publicEndpoint: 'https://files.example.com',
        forcePathStyle: true,
        prefix: 'attachments/',
        credentials: { accessKeyId: 'placeholder-id', secretAccessKey: 'placeholder-secret' },
      },
    });
    // AWS itself: virtual-hosted addressing, the default credential chain.
    expect(loadConfig({ DATABASE_URL: DB, TASKMOOR_S3_BUCKET: 'files-1' }).storage.s3).toEqual({
      bucket: 'files-1',
      region: 'us-east-1',
      forcePathStyle: false,
      prefix: '',
    });
    const refused = (env: Record<string, string>) => () => loadConfig({ DATABASE_URL: DB, ...env });
    expect(refused({ TASKMOOR_STORAGE: 's3' })).toThrow(/needs TASKMOOR_S3_BUCKET/);
    expect(
      refused({ TASKMOOR_S3_BUCKET: 'files-1', TASKMOOR_S3_SECRET_ACCESS_KEY: 'only-the-secret' }),
    ).toThrow(/go together/);
    expect(
      refused({ TASKMOOR_S3_BUCKET: 'files-1', TASKMOOR_S3_SECRET_ACCESS_KEY: 'only-the-secret' }),
    ).not.toThrow(/only-the-secret/);
    expect(refused({ TASKMOOR_S3_BUCKET: 'Not_A_Bucket' })).toThrow(/TASKMOOR_S3_BUCKET/);
    expect(refused({ TASKMOOR_S3_PREFIX: '../x' })).toThrow(/TASKMOOR_S3_PREFIX/);
    expect(refused({ TASKMOOR_S3_URL_TTL: '86400' })).toThrow(/TASKMOOR_S3_URL_TTL/);
  });

  it('[OPS-011] reads the metrics listener and the data directory', () => {
    expect(
      loadConfig({
        DATABASE_URL: DB,
        METRICS_PORT: '0',
        HOST: '127.0.0.1',
        TASKMOOR_DATA: '/data',
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
      TASKMOOR_VERSION: '1.2.3',
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
    expect(() => loadConfig({ TASKMOOR_ROLE: 'worker' })).toThrow(/DATABASE_URL is required/);
    expect(loadConfig({ TASKMOOR_ROLE: 'web', TASKMOOR_WEB_DIR: '/app/web' })).toMatchObject({
      databaseUrl: undefined,
      roles: ['web'],
      webDir: '/app/web',
    });
  });

  it('[OPS-003] derives the setup link base and cookie security from PUBLIC_URL', () => {
    const config = loadConfig({
      DATABASE_URL: DB,
      PUBLIC_URL: 'https://tracker.example.com/',
      TASKMOOR_SETUP_TOKEN: 'fixed-token-for-the-installer',
    });
    expect(config).toMatchObject({
      publicUrl: 'https://tracker.example.com/',
      secureCookies: true,
      setupToken: 'fixed-token-for-the-installer',
    });
    expect(() => loadConfig({ DATABASE_URL: DB, PUBLIC_URL: 'tracker' })).toThrow(/PUBLIC_URL/);
  });

  it('treats empty variables as unset, which is what Compose passes for them', () => {
    const config = loadConfig({ DATABASE_URL: DB, TASKMOOR_SETUP_TOKEN: '', PUBLIC_URL: '' });
    expect(config.setupToken).toBeUndefined();
    expect(config.publicUrl).toBe('http://localhost:8080');
  });

  it('[OPS-002] runs every role by default and accepts a comma-separated subset', () => {
    expect(loadConfig({ DATABASE_URL: DB }).roles).toEqual(['api', 'worker', 'realtime', 'web']);
    expect(loadConfig({ DATABASE_URL: DB, TASKMOOR_ROLE: 'realtime, API' }).roles).toEqual([
      'api',
      'realtime',
    ]);
    expect(() => loadConfig({ DATABASE_URL: DB, TASKMOOR_ROLE: 'api,cron' })).toThrow(
      /unknown: cron/,
    );
  });
});
