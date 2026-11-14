import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { messagesEs } from './messages.es';

describe('the Spanish catalogue', () => {
  it('[PLN-007] treats "track" as masculine throughout, and spells "ningún" with its accent', () => {
    const wrong = Object.entries(messagesEs).filter(([, text]) =>
      /\b(?:las|unas|varias|estas|esas|una|la|esta|esa|ninguna)\s+tracks?\b|\bningun\s/i.test(
        String(text),
      ),
    );
    expect(wrong).toEqual([]);
  });

  it('[PLN-002] agrees a scenario’s counts with their number, one or more', () => {
    const intl = createIntl({ locale: 'es', messages: messagesEs });
    const say = (id: keyof typeof messagesEs, values: Record<string, number>) =>
      intl.formatMessage({ id }, values);
    expect(say('scenario.apply.result', { applied: 1, refused: 1 })).toBe(
      '1 aplicado, 1 rechazado',
    );
    expect(say('scenario.apply.result', { applied: 3, refused: 2 })).toBe(
      '3 aplicados, 2 rechazados',
    );
    expect(say('scenario.changes.counts', { count: 1, ready: 1, changed: 0, refused: 1 })).toBe(
      '1 cambio: 1 listo, 0 cambiados desde el borrador, 1 rechazado.',
    );
    expect(say('scenario.apply.progress', { done: 1, total: 1 })).toBe('Aplicando: van 1 de 1.');
  });
});
