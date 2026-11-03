import { describe, expect, it } from 'vitest';
import { messagesEs } from '../i18n/messages.es';
import { priorityName } from './priorityName';

describe('a priority in the person’s language', () => {
  it('[CORE-014] names the seeded list from the catalogue and leaves a renamed one as written', () => {
    const t = ((id: string) => id) as never;
    expect(priorityName(t, 'Very low')).toBe('priority.name.veryLow');
    expect(priorityName(t, 'Whenever')).toBe('Whenever');
    expect(priorityName(t, 'constructor')).toBe('constructor');
    expect(messagesEs['priority.name.veryLow']).toBe('Muy baja');
  });
});
