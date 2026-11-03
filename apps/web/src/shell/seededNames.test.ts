import { describe, expect, it } from 'vitest';
import { messagesEs } from '../i18n/messages.es';
import { fieldName } from './seededNames';

describe('a seeded name in the person’s language', () => {
  it('[AGL-007] names the seeded Points field from the catalogue and leaves a renamed one as written', () => {
    const t = ((id: string) => id) as never;
    expect(fieldName(t, 'Points')).toBe('field.name.points');
    expect(fieldName(t, 'Esfuerzo')).toBe('Esfuerzo');
    expect(fieldName(t, 'constructor')).toBe('constructor');
    expect(messagesEs['field.name.points']).toBe('Puntos');
  });
});
