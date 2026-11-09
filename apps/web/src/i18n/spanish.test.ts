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
});
