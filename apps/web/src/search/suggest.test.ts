import { describe, expect, it } from 'vitest';
import { suggest } from './suggest';

const context = { customFields: ['Customer', 'Story points'], tracks: ['SHOP', 'OPS'] };
const at = (text: string) => suggest(text, text.length, context);

describe('query suggestions (M1-041)', () => {
  it('[QRY-001] offers fields where a clause starts, common ones first, custom ones quoted', () => {
    expect(at('')?.items.slice(0, 4)).toEqual(['track', 'stage', 'status', 'assignee']);
    expect(at('track = SHOP AND ')).toMatchObject({ kind: 'field' });
    expect(at('track = SHOP AND sto')).toEqual({
      from: 17,
      to: 20,
      kind: 'field',
      items: ['"Story points"'],
    });
    expect(at('(as')?.items).toEqual(['assignee']);
  });

  it('[QRY-001] offers operators after a field and values after an operator', () => {
    expect(at('track ')).toMatchObject({ kind: 'operator' });
    expect(at('track = ')).toMatchObject({ kind: 'value', items: ['SHOP', 'OPS'] });
    expect(at('project = o')).toMatchObject({ kind: 'value', items: ['OPS'] });
    expect(at('track IN (SHOP, ')).toMatchObject({ kind: 'value', items: ['SHOP', 'OPS'] });
    expect(at('statusCategory = ')).toMatchObject({ items: ['new', 'active', 'closed'] });
    expect(at('assignee = ')).toMatchObject({ items: ['currentUser()', 'EMPTY'] });
  });

  it('[QRY-001] offers connectives after a value, and the order after ORDER BY', () => {
    expect(at('track = SHOP ')).toMatchObject({
      kind: 'keyword',
      items: ['AND', 'OR', 'ORDER BY'],
    });
    expect(at('track = SHOP ORDER ')).toMatchObject({ items: ['BY'] });
    expect(at('track = SHOP ORDER BY up')).toMatchObject({ kind: 'field', items: ['updated'] });
    expect(at('track = SHOP ORDER BY updated ')).toMatchObject({ items: ['DESC', 'ASC'] });
  });

  it('[QRY-001] quotes a track key or field name that is a word of the grammar', () => {
    const odd = { customFields: ['Order', 'Customer'], tracks: ['ON', 'SHOP'] };
    expect(suggest('track = ', 8, odd)).toMatchObject({ items: ['"ON"', 'SHOP'] });
    expect(suggest('track = o', 9, odd)).toMatchObject({ items: ['"ON"'] });
    expect(suggest('ord', 3, odd)?.items).toEqual(['"Order"']);
    expect(suggest('cus', 3, odd)?.items).toEqual(['Customer']);
  });

  it('offers nothing when nothing matches', () => {
    expect(at('track = SHOP AND zzz')).toBeNull();
  });
});
