import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { Translate } from '../i18n/I18nProvider';
import { type Locale, messagesFor } from '../i18n/locale';
import { refusedFieldLabel, refusedFieldsMessage } from './refusedFields';

const translate = (locale: Locale): Translate => {
  const intl = createIntl({ locale, messages: messagesFor(locale) });
  return (id, values) => intl.formatMessage({ id }, values);
};

describe('refused fields by their labels (T-292)', () => {
  const t = translate('en');

  it('[CORE-008] names a system field by every key the ticket routes use for it', () => {
    for (const key of ['priority', 'priorityId']) {
      expect(refusedFieldLabel(t, key)).toBe('Priority');
    }
    for (const key of ['closeReason', 'closeReasonId', 'close-reason']) {
      expect(refusedFieldLabel(t, key)).toBe('Close reason');
    }
    expect(refusedFieldLabel(t, 'targetReleaseIds')).toBe('Target releases');
    expect(refusedFieldLabel(t, 'ticketTypeId')).toBe('Ticket type');
    expect(refusedFieldLabel(t, 'visibilityLevelId')).toBe('Visibility level');
  });

  it('[CORE-008] names a custom field from the catalogue, a seeded one in the reader’s language', () => {
    const names = new Map([
      [12, 'Customer tier'],
      [31, 'Points'],
    ]);
    expect(refusedFieldLabel(t, 'fields.12', names)).toBe('Customer tier');
    expect(refusedFieldLabel(t, 'cf[12]', names)).toBe('Customer tier');
    expect(refusedFieldLabel(translate('es'), 'fields.31', names)).toBe('Puntos');
    expect(refusedFieldLabel(t, 'fields.99', names)).toBe('A custom field');
    expect(refusedFieldLabel(t, 'fields.99', names, 'clone.customField')).toBe('a custom field');
  });

  it('[CORE-008] never names a key it does not know, an inherited property included', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'version', 'fields.x']) {
      expect(refusedFieldLabel(t, key)).toBeNull();
    }
    expect(refusedFieldsMessage(t, { constructor: 'invalid', body: 'invalid' })).toBeNull();
    // A reason named like an inherited property is a reason it does not know.
    expect(refusedFieldsMessage(t, { summary: 'constructor' })).toBe(
      'Check these values. Summary: This value was refused.',
    );
  });

  it('[CORE-008] gives each field the server’s reason, a reason it does not know in general words', () => {
    expect(refusedFieldsMessage(t, { dueDate: 'invalid', parent: 'self' })).toBe(
      'Check these values. Due date: This value is not valid here. Parent: This value was refused.',
    );
    expect(refusedFieldsMessage(translate('es'), { summary: 'required' })).toBe(
      'Revisa estos valores. Resumen: Este campo es obligatorio.',
    );
  });
});
