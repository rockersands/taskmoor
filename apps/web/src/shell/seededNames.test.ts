import { describe, expect, it } from 'vitest';
import { messagesEs } from '../i18n/messages.es';
import { fieldName, typeName } from './seededNames';

describe('a seeded name in the person’s language', () => {
  it('[AGL-007] names the seeded Points field from the catalogue and leaves a renamed one as written', () => {
    const t = ((id: string) => id) as never;
    expect(fieldName(t, 'Points')).toBe('field.name.points');
    expect(fieldName(t, 'Esfuerzo')).toBe('Esfuerzo');
    expect(fieldName(t, 'constructor')).toBe('constructor');
    expect(messagesEs['field.name.points']).toBe('Puntos');
  });

  it('[CORE-012] names the seeded ticket types from the catalogue and leaves a renamed one as written', () => {
    const t = ((id: string) => id) as never;
    expect(typeName(t, 'To-do')).toBe('ticketType.name.toDo');
    expect(typeName(t, 'Epic')).toBe('Epic');
    expect(typeName(t, 'constructor')).toBe('constructor');
    expect(messagesEs['ticketType.name.outcome']).toBe('Objetivo');
    expect(messagesEs['ticketType.name.bug']).toBe('Error');
  });
});
