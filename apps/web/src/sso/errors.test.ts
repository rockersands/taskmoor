import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { Translate } from '../i18n/I18nProvider';
import { messagesEn as messages } from '../i18n/messages.en';
import { SSO_ERROR_CODES, ssoErrorMessage, ssoRequiredProvider } from './errors';

// The catalogue's English text, without formatting: enough to tell the messages apart.
const t: Translate = (id) => messages[id];

describe('single sign-on errors (M1-080)', () => {
  it('[IAM-003] every reason the backend sends has its own sentence', () => {
    const sentences = SSO_ERROR_CODES.map((code) => ssoErrorMessage(t, code));
    expect(new Set(sentences).size).toBe(SSO_ERROR_CODES.length);
    expect(sentences).not.toContain(messages['auth.sso.error.unknown']);
  });

  it('[IAM-003] knows every reason the backend redirects with', () => {
    // The backend's sign-in routes send these through fail(), literally or as an outcome's
    // error; read from the source (from the repo or the app) so both lists stay in step.
    const path = ['apps/server/src/routes/sso.ts', '../server/src/routes/sso.ts']
      .map((p) => resolve(process.cwd(), p))
      .find((p) => existsSync(p));
    const source = readFileSync(path ?? 'sso.ts', 'utf8');
    const sent = new Set([
      ...[...source.matchAll(/fail\(reply, '([a-z_]+)'\)/g)].map((m) => m[1]),
      ...[...source.matchAll(/error: '([a-z_]+)' as const/g)].map((m) => m[1]),
    ]);
    expect(sent.size).toBeGreaterThan(5);
    expect([...SSO_ERROR_CODES].sort()).toEqual([...sent].sort());
  });

  it('[IAM-003] an unknown reason still gets a sentence', () => {
    expect(ssoErrorMessage(t, 'something_new')).toBe(messages['auth.sso.error.unknown']);
    expect(ssoErrorMessage(t, 'toString')).toBe(messages['auth.sso.error.unknown']);
  });

  it('[IAM-004] reads the provider of an sso_required refusal, and nothing else', () => {
    const required = new ApiError(403, {
      error: 'sso_required',
      provider: { id: 3, name: 'Umbrella' },
    });
    expect(ssoRequiredProvider(required)).toEqual({ id: 3, name: 'Umbrella' });
    expect(ssoRequiredProvider(new ApiError(403, { error: 'sso_required' }))).toBeNull();
    expect(ssoRequiredProvider(new ApiError(403, { error: 'forbidden' }))).toBeNull();
    expect(
      ssoRequiredProvider(
        new ApiError(401, { error: 'sso_required', provider: { id: 3, name: 'U' } }),
      ),
    ).toBeNull();
    expect(ssoRequiredProvider(new Error('network'))).toBeNull();
  });
});
