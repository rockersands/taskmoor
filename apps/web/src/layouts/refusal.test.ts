import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { Translate } from '../i18n/I18nProvider';
import { messagesFor } from '../i18n/locale';
import type { MessageId } from '../i18n/messages.en';
import { layoutRefusal } from './refusal';

const translator = (locale: 'en' | 'es'): Translate => {
  const intl = createIntl({ locale, messages: messagesFor(locale) });
  return (id: MessageId, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
};

const known = (key: string) => (key === 'cf[40]' ? 'Ops notes' : undefined);

/** The server's answers as `routes/layouts.ts` gives them: the schema's place, or a sentence. */
const refused = (detail: string) => ({ error: 'invalid_request', detail });

describe('why the server refuses layouts (UI-T15)', () => {
  const en = translator('en');
  const es = translator('es');

  it('[CORE-013] tells each refusal the editor can meet in the catalogue’s words', () => {
    const says = (body: unknown) => layoutRefusal(en, body, known);
    expect(says(refused('unknown field cf[99]'))).toBe(
      'cf[99] no longer exists. Take it off the layout.',
    );
    expect(says(refused('cf[40] belongs to another track'))).toBe(
      'Ops notes belongs to another track, so this set cannot place it. Take it off the layout.',
    );
    expect(says(refused('layouts.2.definition: each field once'))).toBe(
      'A field is placed twice. Each field goes on a form once.',
    );
    expect(
      says(
        refused(
          'layouts.0.definition.tabs.3.name: Too small: expected string to have >=1 characters',
        ),
      ),
    ).toBe('Every tab needs a name of up to 100 characters.');
    expect(
      says(refused('layouts.1.definition.tabs: Too big: expected array to have <=20 items')),
    ).toBe('A form has at most 20 tabs.');
    expect(
      says(
        refused('layouts.0.definition.tabs.0.sections: Too big: expected array to have <=20 items'),
      ),
    ).toBe('A tab has at most 20 sections.');
    expect(says({ error: 'unknown_ticket_type' })).toBe(
      'A ticket type here no longer exists. Load the page again to see the current ones.',
    );
    // The first issue the editor knows, of several.
    expect(
      says(refused('ticketTypeId: Invalid input; layouts.0.definition: each field once')),
    ).toBe('A field is placed twice. Each field goes on a form once.');
    expect(layoutRefusal(es, refused('unknown field cf[99]'), known)).toBe(
      'cf[99] ya no existe. Quítalo del diseño.',
    );
  });

  it('[CORE-013] leaves any other refusal to general words, never the server’s own', () => {
    const says = (body: unknown) => layoutRefusal(en, body, known);
    expect(says(refused('two edit layouts for one type'))).toBeNull();
    expect(says(refused('name: Too big: expected string to have <=255 characters'))).toBeNull();
    expect(says({ error: 'invalid_request' })).toBeNull();
    expect(says(null)).toBeNull();
    expect(says('not json')).toBeNull();
  });
});
