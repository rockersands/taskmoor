import { describe, expect, it } from 'vitest';
import { BUG_FORM, CHORE_FORM } from './fixtures';
import { createBody, fieldErrors, textDocument } from './form';

describe('the create form data (M1-012)', () => {
  it('[CORE-008] sends what was typed, by body key, and leaves empty fields out', () => {
    expect(
      createBody('SHOP', 3, BUG_FORM, {
        summary: 'Checkout fails',
        description: 'Open the cart\n\nPay',
        'cf[7]': '70',
        'cf[8]': '80',
        'cf[8]/child': '81',
        priority: '',
        dueDate: '2026-12-01',
      }),
    ).toEqual({
      track: 'SHOP',
      ticketTypeId: 3,
      summary: 'Checkout fails',
      description: textDocument('Open the cart\n\nPay'),
      dueDate: '2026-12-01',
      fields: { 7: 70, 8: { parent: 80, child: 81 } },
    });
    expect(createBody('SHOP', 4, CHORE_FORM, { summary: 'Tidy', labels: ' a  b ' })).toEqual({
      track: 'SHOP',
      ticketTypeId: 4,
      summary: 'Tidy',
      labels: ['a', 'b'],
    });
  });

  it('[CORE-008] puts the backend refusals on the fields they name', () => {
    expect(
      fieldErrors({ dueDate: 'required', 'fields.7': 'required', priorityId: 'not_found' }),
    ).toEqual({ dueDate: 'required', 'cf[7]': 'required', priority: 'not_found' });
  });

  it('turns lines of text into paragraphs, and no text into nothing', () => {
    expect(textDocument('  ')).toBeNull();
    expect(textDocument('a\n\nb')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
  });
});
