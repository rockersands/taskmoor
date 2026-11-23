import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SORT,
  fileSort,
  menuEntry,
  nextSort,
  orderBy,
  readSort,
  routeWithSort,
  sortOfRoute,
  sortParams,
  usableSort,
} from './order';

describe('a list’s order (T-330)', () => {
  it('[AGL-016] [PLN-012] a column clicked goes its own way first, and the other way when clicked again', () => {
    const key = nextSort(DEFAULT_SORT, 'key');
    expect(key).toEqual({ column: 'key', direction: 'ascending' });
    expect(orderBy(key)).toBe('key ASC');
    const reversed = nextSort(key, 'key');
    expect(reversed).toEqual({ column: 'key', direction: 'descending' });
    expect(orderBy(reversed)).toBe('key DESC');
    expect(nextSort(reversed, 'key')).toEqual(key);
    // Each column's own way: times past newest first, due soonest, priority highest, names A to Z.
    expect(orderBy(nextSort(key, 'updatedAt'))).toBe('updated DESC');
    expect(orderBy(nextSort(key, 'dueDate'))).toBe('due ASC');
    expect(orderBy(nextSort(key, 'priority'))).toBe('priority DESC');
    expect(orderBy(nextSort(key, 'ticketType'))).toBe('type ASC');
    expect(orderBy(nextSort(key, 'summary'))).toBe('summary ASC');
    expect(orderBy(nextSort(key, 'cf[40]'))).toBe('cf[40] ASC');
  });

  it('[AGL-016] [PLN-012] the menu names an order it has, and none for an order a heading chose', () => {
    expect(menuEntry(DEFAULT_SORT)).toBe('created');
    expect(menuEntry({ column: 'key', direction: 'ascending' })).toBe('key');
    expect(menuEntry({ column: 'ticketType', direction: 'ascending' })).toBe('type');
    expect(menuEntry({ column: 'priority', direction: 'descending' })).toBe('priority');
    expect(menuEntry({ column: 'key', direction: 'descending' })).toBeNull();
    expect(menuEntry({ column: 'summary', direction: 'ascending' })).toBeNull();
  });

  it('[PLN-014] [AGL-016] the address holds the field and a way only when reversed, and reads back the same', () => {
    expect(sortParams(DEFAULT_SORT)).toEqual({});
    expect(sortParams({ column: 'key', direction: 'ascending' })).toEqual({ sort: 'key' });
    expect(sortParams({ column: 'key', direction: 'descending' })).toEqual({
      sort: 'key',
      order: 'desc',
    });
    expect(sortParams({ column: 'createdAt', direction: 'ascending' })).toEqual({
      sort: 'created',
      order: 'asc',
    });
    for (const sort of [
      { column: 'key', direction: 'ascending' },
      { column: 'key', direction: 'descending' },
      { column: 'ticketType', direction: 'descending' },
      { column: 'createdAt', direction: 'ascending' },
      { column: 'cf[40]', direction: 'descending' },
    ] as const) {
      const route = routeWithSort('#/tracks/SHOP/list?x=1', sort);
      expect(route.startsWith('#/tracks/SHOP/list?x=1&sort=')).toBe(true);
      expect(sortOfRoute(route)).toEqual(sort);
    }
    // The default leaves the address as it was, without the order.
    expect(routeWithSort('#/tracks/SHOP/list?sort=key&order=desc', DEFAULT_SORT)).toBe(
      '#/tracks/SHOP/list',
    );
  });

  it('[PLN-014] addresses made before T-330 open in the order they named', () => {
    expect(readSort('priority', null)).toEqual({ column: 'priority', direction: 'descending' });
    expect(readSort('updated', null)).toEqual({ column: 'updatedAt', direction: 'descending' });
    expect(readSort('due', null)).toEqual({ column: 'dueDate', direction: 'ascending' });
    expect(readSort('created', null)).toEqual(DEFAULT_SORT);
    expect(sortOfRoute('#/tracks/SHOP/list')).toEqual(DEFAULT_SORT);
  });

  it('[PLN-014] leaves out an order that could not be meant', () => {
    for (const [sort, order] of [
      ['labels', null],
      ['track', null],
      ['toString', null],
      ['created DESC', null],
      ['key', 'up'],
      ['cf[x]', null],
    ] as const) {
      expect(readSort(sort, order), `${sort} ${order}`).toBeNull();
    }
    expect(sortOfRoute('#/tracks/SHOP/list?sort=labels')).toEqual(DEFAULT_SORT);
  });

  it('[AGL-016] [PLN-012] an address ordered by a custom field the person cannot see opens in the default order', () => {
    const fields = [{ id: 40 }, { id: 41 }];
    const byField = { column: 'cf[40]', direction: 'ascending' } as const;
    expect(usableSort(byField, fields)).toEqual(byField);
    // Not among the fields this person sees, or since deleted: the default, not a refused query.
    expect(usableSort({ column: 'cf[99]', direction: 'descending' }, fields)).toEqual(DEFAULT_SORT);
    expect(usableSort(byField, [])).toEqual(DEFAULT_SORT);
    // While the fields load, a custom field's order waits; any other goes at once.
    expect(usableSort(byField, null)).toBeNull();
    const key = { column: 'key', direction: 'ascending' } as const;
    expect(usableSort(key, null)).toEqual(key);
    expect(usableSort(key, [])).toEqual(key);
  });

  it('[PLN-014] the plan’s file always asks for the field and the way', () => {
    expect(fileSort(DEFAULT_SORT)).toEqual({ sort: 'created', order: 'desc' });
    expect(fileSort({ column: 'key', direction: 'ascending' })).toEqual({
      sort: 'key',
      order: 'asc',
    });
  });
});
