import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { Translate } from '../i18n/I18nProvider';
import { messagesFor } from '../i18n/locale';
import type { MessageId } from '../i18n/messages.en';
import { passwordProblemMessages, retryMessage, tooManyAttemptsMessage } from './errors';

const intl = createIntl({ locale: 'en', messages: messagesFor('en') });
const t: Translate = (id: MessageId, values) => intl.formatMessage({ id }, values);

describe('lockout messages', () => {
  it.each([
    [1, 'Too many attempts. Try again in 1 second.'],
    [30, 'Too many attempts. Try again in 30 seconds.'],
    [59.2, 'Too many attempts. Try again in 1 minute.'],
    [60, 'Too many attempts. Try again in 1 minute.'],
    [61, 'Too many attempts. Try again in 2 minutes.'],
    [900, 'Too many attempts. Try again in 15 minutes.'],
    [null, 'Too many attempts. Try again later.'],
    [0, 'Too many attempts. Try again later.'],
  ])('[IAM-001] says how long to wait for %s seconds', (seconds, message) => {
    expect(retryMessage(t, seconds)).toBe(message);
  });

  it('[IAM-001] reads the wait from a 429 answer and ignores other errors', () => {
    const locked = new ApiError(429, { error: 'too_many_attempts', retryAfterSeconds: 120 });
    expect(tooManyAttemptsMessage(t, locked)).toBe('Too many attempts. Try again in 2 minutes.');
    expect(tooManyAttemptsMessage(t, new ApiError(429, null))).toBe(
      'Too many attempts. Try again later.',
    );
    expect(tooManyAttemptsMessage(t, new ApiError(401, { error: 'invalid_credentials' }))).toBe(
      null,
    );
    expect(tooManyAttemptsMessage(t, new Error('offline'))).toBe(null);
  });
});

describe('password problem messages', () => {
  it('[IAM-001] translates every code the backend sends', () => {
    const body = {
      error: 'weak_password',
      codes: ['too_short', 'too_long', 'common', 'predictable', 'contains_identity'],
    };
    expect(passwordProblemMessages(t, body)).toEqual([
      'Too short: use at least 12 characters.',
      'Too long: use at most 256 characters.',
      'Too common: it appears in lists of leaked passwords, also with digits or symbols added.',
      'Too predictable: avoid repeated patterns and sequences such as abcabc or 123456.',
      'It contains your name, your email address or the product name.',
    ]);
  });

  it('[IAM-001] falls back to the backend’s sentence for codes it does not know', () => {
    expect(
      passwordProblemMessages(t, {
        codes: ['constructor', 'too_short'],
        problems: ['password: something new', 'password: must be at least 12 characters'],
      }),
    ).toEqual(['password: something new', 'Too short: use at least 12 characters.']);
    expect(passwordProblemMessages(t, { problems: ['instanceName: Required'] })).toEqual([
      'instanceName: Required',
    ]);
    expect(passwordProblemMessages(t, null)).toEqual([]);
  });
});
