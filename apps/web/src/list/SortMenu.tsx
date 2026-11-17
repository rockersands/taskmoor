import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { DATE_COLUMNS } from '../search/columns';
import { type ListSort, MENU_SORTS, menuEntry, sortBy, sortKey } from './order';

/** The value of the entry that names an order the menu has no entry for. */
const CURRENT = 'current';

/**
 * A list's "Sort by" menu (T-330; AGL-016, PLN-012): newest created, recently updated, due date,
 * priority, type and key, each at its column's own direction. A heading can choose an order the
 * menu has no entry for (another column, or one reversed); the menu then shows an extra entry
 * first that names it, "Summary, ascending", so it always says the order the rows are in. A new
 * order, from here or a heading, is said in a polite live region, since a heading's `aria-sort`
 * changing is not announced.
 */
export function SortMenu({
  sort,
  nameOf,
  onChange,
}: {
  sort: ListSort;
  /** A column's heading, as the table names it. */
  nameOf: (column: string) => string;
  onChange: (sort: ListSort) => void;
}) {
  const t = useT();
  const entry = menuEntry(sort);
  const current = t(
    DATE_COLUMNS.has(sort.column) ? 'list.sort.current.date' : 'list.sort.current',
    { column: nameOf(sort.column), direction: sort.direction },
  );
  const named = entry
    ? t(MENU_SORTS.find((m) => m.id === entry)?.label ?? 'list.sort.created')
    : current;
  // Said only when the order changes, not when the list opens.
  const [said, setSaid] = useState('');
  const opened = useRef(sortKey(sort));
  const key = sortKey(sort);
  // biome-ignore lint/correctness/useExhaustiveDependencies: said once per order, in its words then
  useEffect(() => {
    if (key === opened.current) return;
    opened.current = key;
    setSaid(t('list.sort.announce', { order: named }));
  }, [key]);
  return (
    <>
      <label className="form-field">
        <span className="form-label">{t('list.sortBy')}</span>
        <select
          value={entry ?? CURRENT}
          onChange={(event) => {
            const chosen = MENU_SORTS.find((m) => m.id === event.target.value);
            if (chosen) onChange(sortBy(chosen.column));
          }}
        >
          {entry === null && <option value={CURRENT}>{current}</option>}
          {MENU_SORTS.map((m) => (
            <option key={m.id} value={m.id}>
              {t(m.label)}
            </option>
          ))}
        </select>
      </label>
      <p className="visually-hidden" role="status">
        {said}
      </p>
    </>
  );
}
