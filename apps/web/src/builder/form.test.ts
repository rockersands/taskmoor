import {
  AI_PROVIDERS,
  type BuilderInputs,
  LANGUAGES,
  validateInputs,
} from '@taskmoor/builder-core';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { checkForm, EMPTY_FORM, fieldOf, formFrom, formInputs, formUserSecrets } from './form';

const host = fc.constantFrom('example.com', 'acme.test', 'localhost', 'tracker.example.org');
const inputsArb: fc.Arbitrary<BuilderInputs> = fc
  .record({
    backendUrl: host.map((h) => `https://api.${h}`),
    frontendUrl: fc
      .tuple(host, fc.constantFrom('/', '/tracker/', '/a/b/'))
      .map(([h, p]) => `https://app.${h}${p}`),
    instanceName: fc.string({ maxLength: 40 }),
    defaultLanguage: fc.constantFrom(...LANGUAGES),
    routing: fc.constantFrom('path' as const, 'hash' as const),
    branding: fc.option(fc.constantFrom('#112233', '#a1b2c3'), { nil: undefined }),
    smtp: fc.option(
      fc.record({
        host: fc.constantFrom('mail.example.com', 'smtp.acme.test'),
        port: fc.integer({ min: 1, max: 65_535 }),
        user: fc.constantFrom('', 'robot'),
        from: fc.constantFrom('', 'tracker@example.com'),
      }),
      { nil: undefined },
    ),
    ai: fc.option(fc.constantFrom(...AI_PROVIDERS), { nil: undefined }),
    target: fc.constantFrom('compose' as const, 'helm' as const),
    signIn: fc.constantFrom('auto' as const, 'session' as const, 'oauth' as const),
  })
  .map((raw) => {
    const checked = validateInputs({
      ...raw,
      branding: raw.branding ? { accentColour: raw.branding } : {},
      ...(raw.ai ? { ai: { provider: raw.ai } } : { ai: undefined }),
    });
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
    return checked.inputs;
  });

describe('the Builder page form (M1-112)', () => {
  it('[OPS-016] a loaded project gives back the same inputs and secrets', () => {
    fc.assert(
      fc.property(inputsArb, fc.constantFrom('', 'pw'), (inputs, secret) => {
        const user = {
          ...(inputs.smtp && secret ? { smtpPassword: secret } : {}),
          ...(inputs.ai && secret ? { aiKey: secret } : {}),
        };
        const form = formFrom(inputs, user);
        const again = checkForm(form);
        expect(again).toEqual({ ok: true, inputs });
        expect(formUserSecrets(form)).toEqual(user);
      }),
    );
  });

  it('[OPS-014] (2) names the problem of each field with the core code', () => {
    const result = checkForm({
      ...EMPTY_FORM,
      backendUrl: 'http://api.example.com',
      frontendUrl: 'https://tracker.example.com/app',
      withSmtp: true,
      smtpHost: 'mail.example.com',
      smtpPort: '99999',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => [fieldOf(p), p.code])).toEqual([['smtpPort', 'invalid']]);
    const urls = checkForm({
      ...EMPTY_FORM,
      backendUrl: 'http://api.example.com',
      frontendUrl: 'https://tracker.example.com/app',
    });
    expect(urls.ok ? [] : urls.problems.map((p) => [fieldOf(p), p.code])).toEqual([
      ['backendUrl', 'insecure_url'],
      ['frontendUrl', 'not_a_directory'],
    ]);
  });

  it('leaves secrets of switched-off parts out, and a port that is not a number invalid', () => {
    const form = {
      ...EMPTY_FORM,
      smtpPassword: 'typed before switching mail off',
      aiKey: 'typed before choosing none',
    };
    expect(formUserSecrets(form)).toEqual({});
    expect(formInputs({ ...form, withSmtp: true, smtpPort: '25x' })).toMatchObject({
      smtp: { port: Number.NaN },
    });
  });
});
