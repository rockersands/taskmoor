import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { MessageId } from '../i18n/messages.en';
import { messagesEn } from '../i18n/messages.en';
import { messagesEs } from '../i18n/messages.es';
import type { Field } from './client';
import { FORMULA_PROBLEMS, formulaProblemText, readableFields, readName } from './formulaWords';

const translate = (messages: Record<string, string>, locale: string) => {
  const intl = createIntl({ locale, messages });
  return (id: MessageId, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
};

const field = (id: number, name: string, type: Field['type'], trackId: number | null = null) =>
  ({ id, name, type, trackId, description: '', multiple: false, contexts: [] }) as Field;

describe('a formula’s refusal in words (T-320)', () => {
  it('[CORE-011] [NFR-006] words every code of the formula language in English and Spanish', () => {
    for (const id of Object.values(FORMULA_PROBLEMS)) {
      expect(messagesEn[id]).toBeTruthy();
      expect(messagesEs[id]).toBeTruthy();
    }
  });

  it('[CORE-011] says the line, the column and the part at fault, as typed', () => {
    const expression = 'sum(1,\n  {Pionts})';
    const problem = { code: 'unknown_field', start: 9, end: 17, line: 2, column: 3 };
    expect(formulaProblemText(translate(messagesEn, 'en'), problem, expression)).toBe(
      'Line 2, column 3: No field is called {Pionts}, or a formula here cannot see it.',
    );
    expect(formulaProblemText(translate(messagesEs, 'es'), problem, expression)).toBe(
      'Línea 2, columna 3: Ningún campo se llama {Pionts}, o una fórmula de aquí no puede verlo.',
    );
    // A code it does not know, or a part it cannot show, still says where.
    expect(
      formulaProblemText(
        translate(messagesEn, 'en'),
        { code: 'something_new', start: 0, end: 1, line: 1, column: 1 },
        'x',
      ),
    ).toBe('Line 1, column 1: Something is wrong here.');
  });

  it('[CORE-011] lists the fields a formula of a track may read, by name in braces', () => {
    const fields = [
      field(1, 'Points', 'number'),
      field(2, 'Severity', 'select'),
      field(3, 'Own', 'text', 4),
      field(4, 'Other', 'text', 5),
      field(5, 'Spend', 'formula'),
    ];
    expect(readableFields(fields, 4, 5).map((f) => f.name)).toEqual(['Points', 'Own']);
    expect(readableFields(fields, null).map((f) => f.name)).toEqual(['Points', 'Spend']);
    expect(readName('cf[1]', fields)).toBe('{Points}');
    expect(readName('dueDate', fields)).toBe('{Due date}');
    expect(readName('cf[99]', fields)).toBe('{cf[99]}');
  });
});
