import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACTION_PATTERNS, placeholder, REDACTION_PATTERNS, Redactor } from './redact';
import type { AdapterRequest } from './types';

const all = new Redactor({ patterns: REDACTION_PATTERNS, terms: [] });

describe('redaction (M1-077)', () => {
  it('[IAM-022] (1) replaces card numbers with a valid check digit, and leaves other numbers', () => {
    const text = all.text(
      'Card 4111 1111 1111 1111 and 5500-0000-0000-0004 failed; order 4111111111111112 and phone 2026-10-31 stay.',
    );
    expect(text).toBe(
      `Card ${placeholder('card number')} and ${placeholder('card number')} failed; order 4111111111111112 and phone 2026-10-31 stay.`,
    );
  });

  it('[IAM-022] replaces IBANs, US social security numbers and email addresses', () => {
    expect(all.text('Pay GB82 WEST 1234 5698 7654 32 now')).toBe(`Pay ${placeholder('IBAN')} now`);
    expect(all.text('Not an IBAN: GB00 WEST 1234 5698 7654 32')).toBe(
      'Not an IBAN: GB00 WEST 1234 5698 7654 32',
    );
    expect(all.text('SSN 123-45-6789, not 000-12-3456')).toBe(
      `SSN ${placeholder('national ID')}, not 000-12-3456`,
    );
    expect(all.text('Write to ada.l+ai@example.org today')).toBe(
      `Write to ${placeholder('email address')} today`,
    );
    // Email addresses are off unless an administrator turns them on.
    expect(DEFAULT_REDACTION_PATTERNS).not.toContain('email');
  });

  it('[IAM-022] replaces listed terms and sensitive field values in any case, longest first', () => {
    const redactor = new Redactor({ patterns: [], terms: ['Project Heron'] }, [
      { value: 'ACCT-7731', label: 'Account number' },
      { value: 'ACCT-7731-B', label: 'Account number' },
      { value: '42', label: 'Short' },
    ]);
    expect(redactor.text('project heron bills acct-7731-b and ACCT-7731; 42 stays')).toBe(
      `${placeholder('term')} bills ${placeholder('Account number')} and ${placeholder('Account number')}; 42 stays`,
    );
    expect(redactor.count).toBe(3);
  });

  it('[IAM-022] redacts every text a provider receives and leaves provider turns as they came', () => {
    const redactor = new Redactor({ patterns: ['card-number'], terms: ['heron'] });
    const native = {
      format: 'claude-messages' as const,
      content: [{ type: 'text', text: 'heron' }],
    };
    const request: AdapterRequest = {
      model: 'claude-opus-5-5',
      system: 'About heron.',
      context: 'Track HERON.',
      messages: [
        { role: 'user', content: 'Card 4111111111111111' },
        { role: 'assistant', content: 'heron', native },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'heron' },
            { type: 'tool-result', toolCallId: 't1', content: 'card 4111-1111-1111-1111' },
            { type: 'tool-call', id: 't2', name: 'x', input: { q: ['heron'] } },
          ],
        },
      ],
      maxTokens: 10,
      effort: 'low',
      cacheSystem: true,
    };
    const out = redactor.request(request);
    const sent = JSON.stringify({ ...out, messages: out.messages.filter((m) => !m.native) });
    expect(sent).not.toMatch(/heron|4111/i);
    expect(out.messages[1]).toBe(request.messages[1]);
    // Without rules the request is the very same object.
    const none = new Redactor({ patterns: [], terms: [] });
    expect(none.request(request)).toBe(request);
  });

  it('[IAM-022] no sensitive value survives redaction, wherever it sits in the text', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 4, maxLength: 20 })
          .filter(
            (v) =>
              v.trim().length >= 4 &&
              !/[[\]]/.test(v) &&
              !placeholder('Secret field').toLowerCase().includes(v.trim().toLowerCase()),
          ),
        fc.array(fc.string({ maxLength: 30 }), { maxLength: 4 }),
        (value, around) => {
          const redactor = new Redactor({ patterns: DEFAULT_REDACTION_PATTERNS, terms: [] }, [
            { value, label: 'Secret field' },
          ]);
          const text = around.join(value);
          const out = redactor.text(`${text}${value}`);
          return !out.toLowerCase().includes(value.trim().toLowerCase());
        },
      ),
    );
  });
});
