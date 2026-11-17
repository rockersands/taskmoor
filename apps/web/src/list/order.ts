import type { MessageId } from '../i18n/messages.en';
import { columnOfOrder, orderOfColumn, type TableSort } from '../search/columns';

/**
 * A list's order (T-330; AGL-016, PLN-012): a column and a direction, one model for the "Sort by"
 * menu and the column headings of a track's List and a plan's. The address holds it as the query
 * language names it, `sort=key`, with `order=asc` or `order=desc` only when it goes the other way
 * from the column's own (see `orderOfColumn`), so the addresses made before (`sort=priority`,
 * `sort=due`) open as they did.
 */
export type ListSort = TableSort;

/** Newest created first: the order with nothing in the address. */
export const DEFAULT_SORT: ListSort = { column: 'createdAt', direction: 'descending' };

/** The menu's entries, each a column at its own direction; `id` is the address's word. */
export const MENU_SORTS = [
  { id: 'created', column: 'createdAt', label: 'list.sort.created' },
  { id: 'updated', column: 'updatedAt', label: 'list.sort.updated' },
  { id: 'due', column: 'dueDate', label: 'list.sort.due' },
  { id: 'priority', column: 'priority', label: 'list.sort.priority' },
  { id: 'type', column: 'ticketType', label: 'list.sort.type' },
  { id: 'key', column: 'key', label: 'list.sort.key' },
] as const satisfies readonly { id: string; column: string; label: MessageId }[];

export type MenuSortId = (typeof MENU_SORTS)[number]['id'];

const natural = (column: string): ListSort['direction'] =>
  orderOfColumn(column)?.natural ?? 'ascending';

/** A column at its own direction: what the menu and a first click on a heading give. */
export function sortBy(column: string): ListSort {
  return { column, direction: natural(column) };
}

/** The menu entry that is exactly this order, or null when a heading chose another. */
export function menuEntry(sort: ListSort): MenuSortId | null {
  const entry = MENU_SORTS.find((m) => m.column === sort.column);
  return entry && sort.direction === natural(sort.column) ? entry.id : null;
}

/** A click on a column's heading: the column at its own direction, or the other way round. */
export function nextSort(current: ListSort, column: string): ListSort {
  if (current.column !== column) return sortBy(column);
  return {
    column,
    direction: current.direction === 'ascending' ? 'descending' : 'ascending',
  };
}

/**
 * The order an address holds (`sort`, `order`), or null when it holds none or one that could not
 * be meant: a field the list cannot order by, or a direction that is neither way.
 */
export function readSort(
  sort: string | null | undefined,
  order: string | null | undefined,
): ListSort | null {
  if (!sort) return null;
  const column = columnOfOrder(sort);
  if (!column) return null;
  if (order === 'asc') return { column, direction: 'ascending' };
  if (order === 'desc') return { column, direction: 'descending' };
  if (order) return null;
  return sortBy(column);
}

/** What the address holds for an order: nothing for the default, `order` only when reversed. */
export function sortParams(sort: ListSort): { sort?: string; order?: 'asc' | 'desc' } {
  const field = orderOfColumn(sort.column)?.field;
  if (!field) return {};
  if (sort.column === DEFAULT_SORT.column && sort.direction === DEFAULT_SORT.direction) return {};
  if (sort.direction === natural(sort.column)) return { sort: field };
  return { sort: field, order: sort.direction === 'ascending' ? 'asc' : 'desc' };
}

/** The query language's `ORDER BY` for an order: `key ASC`, `created DESC`. */
export function orderBy(sort: ListSort): string {
  const field = orderOfColumn(sort.column)?.field ?? 'created';
  return `${field} ${sort.direction === 'ascending' ? 'ASC' : 'DESC'}`;
}

/** The order as the plan's file asks for it (PLN-014): always both the field and the way. */
export function fileSort(sort: ListSort): { sort: string; order: 'asc' | 'desc' } {
  const field = orderOfColumn(sort.column)?.field ?? 'created';
  return { sort: field, order: sort.direction === 'ascending' ? 'asc' : 'desc' };
}

/** A route with this order in it (none for the default), keeping what else it says. */
export function routeWithSort(route: string, sort: ListSort): string {
  const at = route.indexOf('?');
  const path = at < 0 ? route : route.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : route.slice(at + 1));
  params.delete('sort');
  params.delete('order');
  const held = sortParams(sort);
  if (held.sort) params.set('sort', held.sort);
  if (held.order) params.set('order', held.order);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** The order a route holds, or the default. */
export function sortOfRoute(route: string): ListSort {
  const at = route.indexOf('?');
  const params = new URLSearchParams(at < 0 ? '' : route.slice(at + 1));
  return readSort(params.get('sort'), params.get('order')) ?? DEFAULT_SORT;
}

/** The same order, as a string for keys and comparisons. */
export const sortKey = (sort: ListSort): string => `${sort.column}:${sort.direction}`;
