import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanRepository, scanText } from './secrets';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

// Fake credentials are assembled at runtime so this file never contains a match itself.
const fake = {
  aws: `AKIA${'Q'.repeat(16)}`,
  github: `ghp_${'a1'.repeat(18)}`,
  anthropic: `sk-ant-${'x'.repeat(30)}`,
  privateKey: `-----BEGIN ${'RSA '}PRIVATE KEY-----`,
  dbUrl: `postgres://admin:${'p'.repeat(12)}@db.example.com/prod`,
  taskmoor: `tmk_${'Ab3'.repeat(15)}x`,
};

describe('secret scan', () => {
  it('finds nothing in the files git would commit', () => {
    expect(scanRepository(REPO)).toEqual([]);
  });

  it('catches planted credentials with file and line', () => {
    const text = [
      'const a = 1;',
      `key = "${fake.aws}"`,
      fake.privateKey,
      `token: ${fake.github}`,
    ].join('\n');
    expect(scanText('src/config.ts', text)).toEqual([
      { file: 'src/config.ts', line: 2, rule: 'aws-access-key' },
      { file: 'src/config.ts', line: 3, rule: 'private-key' },
      { file: 'src/config.ts', line: 4, rule: 'github-token' },
    ]);
    expect(scanText('.env.example', `ANTHROPIC_API_KEY=${fake.anthropic}`)).toEqual([
      { file: '.env.example', line: 1, rule: 'anthropic-key' },
    ]);
  });

  it('flags passwords in URLs, except placeholder ones in test files', () => {
    expect(scanText('deploy/compose.yml', `DATABASE_URL=${fake.dbUrl}`)).toEqual([
      { file: 'deploy/compose.yml', line: 1, rule: 'url-credentials' },
    ]);
    expect(scanText('src/config.test.ts', `const url = '${fake.dbUrl}';`)).toEqual([]);
  });

  it('[IAM-007] catches a Taskmoor API token, in test files too', () => {
    expect(scanText('scripts/deploy.sh', `export TASKMOOR_TOKEN=${fake.taskmoor}`)).toEqual([
      { file: 'scripts/deploy.sh', line: 1, rule: 'taskmoor-api-token' },
    ]);
    expect(scanText('src/api.test.ts', `const t = '${fake.taskmoor}';`)).toHaveLength(1);
    // Shorter look-alikes are left alone.
    expect(scanText('src/a.ts', `tmk_${'Ab3'.repeat(10)}`)).toEqual([]);
  });

  it('accepts a line marked as reviewed', () => {
    expect(scanText('ci.yml', `URL: ${fake.dbUrl} # secret-scan: ${'allow'}`)).toEqual([]);
  });
});
