import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { Translate } from '../i18n/I18nProvider';
import { messagesFor } from '../i18n/locale';
import type { MessageId } from '../i18n/messages.en';
import { CHECK_MESSAGES, refusalMessage } from './refusal';

const translator = (locale: 'en' | 'en-XA'): Translate => {
  const intl = createIntl({ locale, messages: messagesFor(locale) });
  return (id: MessageId, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
};

describe('transition refusals (M1-026)', () => {
  const en = translator('en');
  const xa = translator('en-XA');

  it('[WF-004] words a failed check in the reader’s language with its field', () => {
    const refusal = {
      error: 'transition_refused' as const,
      by: 'check' as const,
      name: 'field-required',
      message: 'close-reason is required',
      check: { type: 'field-required', field: 'close-reason', configured: false },
    };
    expect(refusalMessage(en, refusal)).toBe('Close reason is required.');
    // The pseudo-locale proves the sentence and the field label both come from the catalogue.
    expect(refusalMessage(xa, refusal)).toMatch(/^\[.*Çĺóšé.*\]$/);
    expect(
      refusalMessage(en, {
        ...refusal,
        name: 'date-window',
        check: {
          type: 'date-window',
          field: 'due-date',
          other: 'start-date',
          days: 1,
          configured: false,
        },
      }),
    ).toBe('Due date must be within 1 day of Start date.');
  });

  it('[WF-004] shows a message an administrator wrote as written', () => {
    expect(
      refusalMessage(xa, {
        error: 'transition_refused',
        by: 'check',
        name: 'regex',
        message: 'Use KEY-123',
        check: { type: 'regex', field: 'summary', pattern: '^[A-Z]', configured: true },
      }),
    ).toBe('Use KEY-123');
  });

  it('[WF-004] has a sentence for every check type and falls back for unknown ones', () => {
    const sentences = Object.keys(CHECK_MESSAGES).map((name) =>
      refusalMessage(en, {
        error: 'transition_refused',
        by: 'check',
        name,
        check: {
          type: name,
          field: 'summary',
          other: 'due-date',
          op: '<',
          days: 2,
          configured: false,
        },
      }),
    );
    expect(new Set(sentences).size).toBe(Object.keys(CHECK_MESSAGES).length);
    expect(refusalMessage(en, { error: 'transition_refused', by: 'check', name: 'toString' })).toBe(
      'The ticket does not meet a condition of this transition.',
    );
  });

  it('[WF-003] names the guard where that helps, and says so plainly otherwise', () => {
    expect(
      refusalMessage(en, { error: 'transition_refused', by: 'guard', name: 'only-assignee' }),
    ).toBe('Only the assignee can do this.');
    expect(
      refusalMessage(en, { error: 'transition_refused', by: 'guard', name: 'user-in-group' }),
    ).toBe('This transition is not available to you on this ticket.');
    expect(
      refusalMessage(en, { error: 'transition_refused', by: 'rule', name: 'restrict-who' }),
    ).toBe('A rule of this track does not allow this transition now.');
  });
});
