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
    });
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

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required/);
  });
});
