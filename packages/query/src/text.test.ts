import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { parseTextSearch, printTextTerm, type TextSearch, TextSearchError } from './text';

const terms = (value: string) => parseTextSearch(value).terms;

/** The search syntax of spec 01b section 1.8 (M1-040; QRY-007). */
describe('text search syntax (M1-040)', () => {
  it('[QRY-007] reads words, phrases, prefixes, wildcards, fuzzy words and exclusions', () => {
    expect(parseTextSearch('login  timeout')).toEqual({
      terms: [
        { kind: 'word', text: 'login' },
        { kind: 'word', text: 'timeout' },
      ],
      excluded: [],
    });
    expect(terms('"login failed" now')).toEqual([
      { kind: 'phrase', text: 'login failed' },
      { kind: 'word', text: 'now' },
    ]);
    expect(terms('log*')).toEqual([{ kind: 'word', text: 'log', prefix: true }]);
    // Stars side by side are one (found by the print property: `ßßé**` printed as a prefix).
    expect(terms('ßßé**')).toEqual([{ kind: 'word', text: 'ßßé', prefix: true }]);
    expect(terms('lo?in')).toEqual([{ kind: 'wildcard', parts: ['lo', 'in'] }]);
    expect(terms('?og?n*')).toEqual([{ kind: 'wildcard', parts: ['', 'og', 'n'], prefix: true }]);
    expect(terms('login~')).toEqual([{ kind: 'fuzzy', text: 'login' }]);
    expect(parseTextSearch('login -password -"reset link"')).toEqual({
      terms: [{ kind: 'word', text: 'login' }],
      excluded: [
        { kind: 'word', text: 'password' },
        { kind: 'phrase', text: 'reset link' },
      ],
    });
    // A hyphen inside a word is the word's own.
    expect(terms('e-mail')).toEqual([{ kind: 'word', text: 'e-mail' }]);
  });

  it('[QRY-007] reads * inside or in front of a word as a pattern', () => {
    expect(terms('*Exception')).toEqual([
      { kind: 'pattern', parts: ['', 'Exception'], gaps: ['many'] },
    ]);
    expect(terms('**Null*Pointer?x*')).toEqual([
      {
        kind: 'pattern',
        parts: ['', 'Null', 'Pointer', 'x', ''],
        gaps: ['many', 'many', 'one', 'many'],
      },
    ]);
    expect(() => parseTextSearch('*ab')).toThrow('three letters or digits in a row');
  });

  it('[QRY-007] makes escaped and quoted characters literal', () => {
    expect(terms('C\\+\\+')).toEqual([{ kind: 'word', text: 'C++' }]);
    expect(terms('what\\? \\-1 \\*star a\\~')).toEqual([
      { kind: 'word', text: 'what?' },
      { kind: 'word', text: '-1' },
      { kind: 'word', text: '*star' },
      { kind: 'word', text: 'a~' },
    ]);
    expect(terms('"say \\"hi\\" *now?"')).toEqual([{ kind: 'phrase', text: 'say "hi" *now?' }]);
    // An unclosed quote runs to the end.
    expect(terms('"login failed')).toEqual([{ kind: 'phrase', text: 'login failed' }]);
  });

  it('[QRY-007] leaves out terms without a letter or digit, and refuses a search of none', () => {
    expect(terms('login + * -- "!"')).toEqual([{ kind: 'word', text: 'login' }]);
    expect(() => parseTextSearch('  ')).toThrow('The search has no words to look for');
    expect(() => parseTextSearch('+++')).toThrow(TextSearchError);
    expect(() => parseTextSearch('-password')).toThrow('cannot only exclude words');
  });

  it('[QRY-007] refuses a fuzzy wildcard and more than two ? in a word', () => {
    expect(() => parseTextSearch('lo?in~')).toThrow('both fuzzy (~) and a wildcard');
    expect(() => parseTextSearch('log*~')).toThrow('both fuzzy (~) and a wildcard');
    expect(() => parseTextSearch('a?b?c?d')).toThrow('at most 2 ? wildcards');
  });

  it('[QRY-007] prints each term so that it reads back the same', () => {
    const word = fc.stringMatching(/^[a-zA-Z0-9éß.+\-*?~"\\ ]{1,12}$/u);
    fc.assert(
      fc.property(fc.array(word, { minLength: 1, maxLength: 5 }), (words) => {
        let search: TextSearch;
        try {
          search = parseTextSearch(words.join(' '));
        } catch (error) {
          if (error instanceof TextSearchError) return;
          throw error;
        }
        const printed = [
          ...search.terms.map(printTextTerm),
          ...search.excluded.map((t) => `-${printTextTerm(t)}`),
        ].join(' ');
        expect(parseTextSearch(printed)).toEqual(search);
      }),
    );
  });
});
