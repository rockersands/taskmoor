import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { messagesFor, resolveLocale, STORAGE_KEY } from './locale';
import { messagesEn } from './messages.en';
import { argumentNames, pseudoBidi, pseudoLocalize, pseudoText } from './pseudo';

describe('pseudoLocalize', () => {
  it('accents, lengthens and brackets plain text', () => {
    expect(pseudoText('Home')).toBe('Ĥóɱé~~');
    expect(pseudoLocalize('Skip to content')).toBe('[Šķíþ ťó çóñťéñť~~~~]');
  });

  it('leaves arguments, plural syntax and tags intact', () => {
    const pseudo = pseudoLocalize('{count, plural, =0 {No items} one {# item} other {# items}}');
    expect(pseudo).toContain('{count, plural');
    expect(pseudo).toContain('=0 {');
    expect(pseudo).toContain('#');
    expect(pseudo).not.toContain('items}');
    expect(argumentNames(pseudo)).toEqual(['count']);
    expect(pseudoLocalize('Hello <b>{name}</b>')).toBe('[Ĥéĺĺó~~ <b>{name}</b>]');
  });

  it('formats every catalogue message in both locales with the same arguments', () => {
    // The pseudo catalogue once: building it per message made this test quadratic.
    const pseudoMessages = messagesFor('en-XA');
    const en = createIntl({ locale: 'en', messages: messagesFor('en') });
    const xa = createIntl({ locale: 'en-XA', messages: pseudoMessages });
    for (const [id, source] of Object.entries(messagesEn)) {
      const values = Object.fromEntries(argumentNames(source).map((name) => [name, 3]));
      const original = en.formatMessage({ id }, values);
      const pseudo = xa.formatMessage({ id }, values);
      expect(argumentNames(pseudoMessages[id] ?? '')).toEqual(argumentNames(source));
      expect(pseudo).toMatch(/^\[.*\]$/s);
      expect(pseudo.length).toBeGreaterThan(original.length);
    }
    expect(xa.formatMessage({ id: 'page.itemCount' }, { count: 0 })).toBe('[Ñó íťéɱš~~~]');
  });
});

describe('pseudoBidi (M1-116)', () => {
  it('[NFR-006] forces each run of text right to left and leaves arguments alone', () => {
    expect(pseudoBidi('Hello {name}!')).toBe('\u202EHello \u202C{name}\u202E!\u202C');
    const plural = pseudoBidi('{count, plural, one {# item} other {# items}}');
    expect(argumentNames(plural)).toEqual(['count']);
    expect(plural).toContain('\u202E items\u202C');
  });

  it('[NFR-006] formats every catalogue message right to left with the same arguments', () => {
    const bidi = messagesFor('ar-XB');
    const xb = createIntl({ locale: 'en', messages: bidi });
    for (const [id, source] of Object.entries(messagesEn)) {
      const values = Object.fromEntries(argumentNames(source).map((name) => [name, 3]));
      expect(argumentNames(bidi[id] ?? '')).toEqual(argumentNames(source));
      const text = xb.formatMessage({ id }, values);
      if (/\p{L}/u.test(text)) expect(text).toContain('\u202E');
    }
  });
});

describe('resolveLocale', () => {
  const win = (overrides: {
    search?: string;
    hash?: string;
    saved?: string | null;
    language?: string;
  }) => ({
    location: { search: overrides.search ?? '', hash: overrides.hash ?? '' } as Location,
    localStorage: {
      getItem: (key: string) => (key === STORAGE_KEY ? (overrides.saved ?? null) : null),
    } as Storage,
    navigator: { language: overrides.language ?? 'en-GB' } as Navigator,
  });

  it('prefers the query string, then the hash query, then the saved preference', () => {
    expect(resolveLocale(win({ search: '?locale=en-XA' }))).toBe('en-XA');
    expect(resolveLocale(win({ hash: '#/boards?locale=en-XA' }))).toBe('en-XA');
    expect(resolveLocale(win({ saved: 'en-XA' }))).toBe('en-XA');
    expect(resolveLocale(win({ search: '?locale=en', saved: 'en-XA' }))).toBe('en');
    expect(resolveLocale(win({ search: '?locale=ar-XB' }))).toBe('ar-XB');
  });

  it('ignores unknown values and falls back to English', () => {
    expect(resolveLocale(win({ search: '?locale=xx', saved: 'yy', language: 'fr-FR' }))).toBe('en');
    expect(resolveLocale(win({}))).toBe('en');
  });
});
