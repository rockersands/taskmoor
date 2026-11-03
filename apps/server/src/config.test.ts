import { randomBytes } from 'node:crypto';
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
      webRouting: 'hash',
      publicUrl: 'http://localhost:8080',
      secureCookies: false,
      allowedOrigins: [],
      oauthRedirectUris: [],
      setupToken: undefined,
      dataDir: undefined,
      metricsPort: 9464,
      metricsHost: '0.0.0.0',
      shutdownDrainMs: 2000,
      queryTimeoutMs: 30_000,
      jiraCompat: true,
      updateCheck: true,
      storage: { urlTtl: 300 },
      previousMasterKeys: [],
      aiEnvironment: {},
      embeddings: { mode: 'local' },
      vectorSearch: 'auto',
    });
  });

  it('[OPS-026] looks for new versions unless the environment says off; Compose passes an unset one as empty', () => {
    expect(loadConfig({ DATABASE_URL: DB }).updateCheck).toBe(true);
    expect(loadConfig({ DATABASE_URL: DB, TASKMOOR_UPDATE_CHECK: '' }).updateCheck).toBe(true);
    expect(loadConfig({ DATABASE_URL: DB, TASKMOOR_UPDATE_CHECK: 'off' }).updateCheck).toBe(false);
    expect(() => loadConfig({ DATABASE_URL: DB, TASKMOOR_UPDATE_CHECK: 'no' })).toThrow(
      'TASKMOOR_UPDATE_CHECK',
    );
    expect(
      loadConfig({ DATABASE_URL: DB, TASKMOOR_UPDATE_COMMAND: 'x {version}' }).updateCommand,
    ).toBe('x {version}');
  });

  it('[AI-012] uses the bundled embedding model unless an endpoint is configured or they are off', () => {
    const key = `fake-embed-key-${randomBytes(12).toString('hex')}`;
    expect(loadConfig({ DATABASE_URL: DB, TASKMOOR_EMBEDDINGS: 'off' }).embeddings).toEqual({
      mode: 'off',
    });
    const endpoint = loadConfig({
      DATABASE_URL: DB,
      TASKMOOR_EMBEDDINGS: 'endpoint',
      TASKMOOR_EMBEDDINGS_URL: 'http://ollama:11434/v1',
      TASKMOOR_EMBEDDINGS_MODEL: 'nomic-embed-text',
      TASKMOOR_EMBEDDINGS_KEY: key,
      TASKMOOR_EMBEDDINGS_DIMENSIONS: '768',
      TASKMOOR_VECTOR_SEARCH: 'exact',
    });
    expect(endpoint.embeddings).toEqual({
      mode: 'endpoint',
      url: 'http://ollama:11434/v1',
      model: 'nomic-embed-text',
      apiKey: key,
      dimensions: 768,
    });
    expect(endpoint.vectorSearch).toBe('exact');
    let message = '';
    try {
      loadConfig({
        DATABASE_URL: DB,
        TASKMOOR_EMBEDDINGS: 'endpoint',
        TASKMOOR_EMBEDDINGS_KEY: key,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('TASKMOOR_EMBEDDINGS=endpoint needs TASKMOOR_EMBEDDINGS_URL');
    expect(message).not.toContain(key);
  });

  it('[IAM-020] reads the master key and the AI settings of a backend kit, and names no value when they are wrong', () => {
    // Made at run time: never a real key in the repository.
    const master = randomBytes(32).toString('base64url');
    const previous = randomBytes(32).toString('base64url');
    const key = `fake-ai-key-${randomBytes(18).toString('hex')}`;
    const config = loadConfig({
      DATABASE_URL: DB,
      TASKMOOR_MASTER_KEY: master,
      TASKMOOR_MASTER_KEY_PREVIOUS: ` ${previous} ,`,
      TASKMOOR_AI_PROVIDER: 'bedrock',
      TASKMOOR_AI_KEY: key,
      TASKMOOR_AI_REGION: 'eu-west-1',
    });
    expect(config.masterKey).toBe(master);
    expect(config.previousMasterKeys).toEqual([previous]);
    expect(config.aiEnvironment).toMatchObject({ provider: 'bedrock', key, region: 'eu-west-1' });
    for (const env of [
      { TASKMOOR_MASTER_KEY: master.slice(0, 20) },
      { TASKMOOR_MASTER_KEY_PREVIOUS: `${previous},${master.slice(0, 20)}` },
      { TASKMOOR_AI_PROVIDER: 'other', TASKMOOR_AI_KEY: key },
    ]) {
      let message = '';
      try {
        loadConfig({ DATABASE_URL: DB, ...env });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('Invalid server configuration');
      for (const value of [master, master.slice(0, 20), previous, key]) {
        expect(message).not.toContain(value);
      }
    }
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

  it('[API-017] takes the instance identity of a Builder kit, both parts or neither', () => {
    const seed = 'A'.repeat(43);
    const id = '00000000-0000-4000-8000-000000000042';
    expect(
      loadConfig({ DATABASE_URL: DB, TASKMOOR_INSTANCE_ID: id, TASKMOOR_INSTANCE_KEY: seed })
        .instance,
    ).toEqual({ id, seed });
    expect(() => loadConfig({ DATABASE_URL: DB, TASKMOOR_INSTANCE_ID: id })).toThrow(/go together/);
    expect(() =>
      loadConfig({ DATABASE_URL: DB, TASKMOOR_INSTANCE_ID: id, TASKMOOR_INSTANCE_KEY: 'short' }),
    ).toThrow(/base64url/);
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

  it('[OPS-017] serves the frontend with hash routing unless clean URLs are asked for', () => {
    const web = { TASKMOOR_ROLE: 'web', TASKMOOR_WEB_DIR: '/app/web' };
    expect(loadConfig(web).webRouting).toBe('hash');
    expect(loadConfig({ ...web, TASKMOOR_WEB_ROUTING: 'path' }).webRouting).toBe('path');
    expect(() => loadConfig({ ...web, TASKMOOR_WEB_ROUTING: 'pretty' })).toThrow(
      /TASKMOOR_WEB_ROUTING/,
    );
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

  it('[IAM-025] reads the allowed frontend origins and OAuth redirect URIs exactly', () => {
    const none = loadConfig({ DATABASE_URL: DB });
    expect(none.allowedOrigins).toEqual([]);
    expect(none.oauthRedirectUris).toEqual([]);
    const listed = loadConfig({
      DATABASE_URL: DB,
      TASKMOOR_ALLOWED_ORIGINS:
        'https://Tracker.Example.org, http://localhost:4178/,https://tracker.example.org',
    });
    expect(listed.allowedOrigins).toEqual(['https://tracker.example.org', 'http://localhost:4178']);
    // Unset, each origin's root is where sign-in may return.
    expect(listed.oauthRedirectUris).toEqual([
      'https://tracker.example.org/',
      'http://localhost:4178/',
    ]);
    const kit = loadConfig({
      DATABASE_URL: DB,
      TASKMOOR_ALLOWED_ORIGINS: 'https://example.org',
      TASKMOOR_OAUTH_REDIRECT_URIS: 'https://example.org/tracker/',
    });
    expect(kit.oauthRedirectUris).toEqual(['https://example.org/tracker/']);
    for (const bad of [
      'http://tracker.example.org',
      'https://tracker.example.org/app',
      'https://tracker.example.org/?x=1',
      '*',
      'null',
      'tracker.example.org',
    ]) {
      expect(() => loadConfig({ DATABASE_URL: DB, TASKMOOR_ALLOWED_ORIGINS: bad }), bad).toThrow(
        /TASKMOOR_ALLOWED_ORIGINS/,
      );
    }
    expect(() =>
      loadConfig({
        DATABASE_URL: DB,
        TASKMOOR_ALLOWED_ORIGINS: 'https://example.org',
        TASKMOOR_OAUTH_REDIRECT_URIS: 'https://elsewhere.example/',
      }),
    ).toThrow(/TASKMOOR_OAUTH_REDIRECT_URIS/);
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
