import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { Popover } from '../shell/Popover';
import { type ColumnField, customColumn, DEFAULT_COLUMNS, SYSTEM_COLUMNS } from './columns';
import { useColumnName } from './useColumnName';

export interface ColumnPickerProps {
  columns: readonly string[];
  fields: readonly ColumnField[];
  onChange: (columns: string[]) => void;
}

/**
 * Choosing the results list's columns (M1-042; QRY-014 (3)): the shown columns in order, each
 * moved up or down or removed with its own buttons, and a column added from the system columns
 * and the custom fields the person sees. Every step is a button or a select, so it works from
 * the keyboard and on touch; focus stays on the column that moved.
 */
export function ColumnPicker({ columns, fields, onChange }: ColumnPickerProps) {
  const t = useT();
  const id = useId();
  const nameOf = useColumnName(fields);
  const [adding, setAdding] = useState('');
  const [said, setSaid] = useState('');
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    if (!focusNext.current) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  });

  const available = [
    ...SYSTEM_COLUMNS.filter((c) => !columns.includes(c)),
    ...fields.map((f) => customColumn(f.id)).filter((c) => !columns.includes(c)),
  ];
  const buttonId = (column: string, action: string) =>
    `${id}-${action}-${column.replace(/\W/g, '_')}`;

  const move = (index: number, by: -1 | 1) => {
    const next = [...columns];
    const [column] = next.splice(index, 1);
    if (column === undefined) return;
    const to = index + by;
    next.splice(to, 0, column);
    // At either end the other button keeps the focus.
    const action = (by === -1 && to === 0) || (by === 1 && to === next.length - 1);
    focusNext.current = buttonId(
      column,
      action ? (by === -1 ? 'down' : 'up') : by === -1 ? 'up' : 'down',
    );
    setSaid(t('search.columns.moved', { name: nameOf(column), position: to + 2 }));
    onChange(next);
  };
  const remove = (index: number) => {
    const column = columns[index];
    if (column === undefined) return;
    const next = columns.filter((_, i) => i !== index);
    const neighbour = next[Math.min(index, next.length - 1)];
    focusNext.current = neighbour ? buttonId(neighbour, 'remove') : `${id}-add`;
    setSaid(t('search.columns.removed', { name: nameOf(column) }));
    onChange(next);
  };
  const add = () => {
    const column = adding || available[0];
    if (!column) return;
    setAdding('');
    setSaid(t('search.columns.added', { name: nameOf(column) }));
    onChange([...columns, column]);
  };

  return (
    <Popover label={t('search.columns')} title={t('search.columns')}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a click that removes its own row is still inside, so it must not reach the page and close the pop-over; the keys are the buttons' own */}
      <div className="search-columns-panel" onClick={(event) => event.stopPropagation()}>
        <p className="form-hint">{t('search.columns.keyFirst')}</p>
        <ol className="search-columns-list">
          {columns.map((column, index) => (
            <li key={column} className="search-columns-item">
              <span className="search-columns-name">{nameOf(column)}</span>
              <span className="search-columns-actions">
                <button
                  id={buttonId(column, 'up')}
                  type="button"
                  className="button-secondary search-columns-button"
                  aria-label={t('search.columns.up', { name: nameOf(column) })}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <Glyph d="M12 19V5M6 11l6-6 6 6" />
                </button>
                <button
                  id={buttonId(column, 'down')}
                  type="button"
                  className="button-secondary search-columns-button"
                  aria-label={t('search.columns.down', { name: nameOf(column) })}
                  disabled={index === columns.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <Glyph d="M12 5v14M6 13l6 6 6-6" />
                </button>
                <button
                  id={buttonId(column, 'remove')}
                  type="button"
                  className="button-secondary search-columns-button"
                  aria-label={t('search.columns.remove', { name: nameOf(column) })}
                  onClick={() => remove(index)}
                >
                  <Glyph d="M6 6l12 12M18 6 6 18" />
                </button>
              </span>
            </li>
          ))}
        </ol>
        {available.length > 0 && (
          <div className="search-columns-add">
            <label htmlFor={`${id}-add`} className="form-label">
              {t('search.columns.add')}
            </label>
            <span className="search-columns-actions">
              <select
                id={`${id}-add`}
                value={adding || available[0]}
                onChange={(event) => setAdding(event.target.value)}
              >
                {available.map((column) => (
                  <option key={column} value={column}>
                    {nameOf(column)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="button-secondary search-columns-button"
                onClick={add}
              >
                {t('search.columns.addButton')}
              </button>
            </span>
          </div>
        )}
        <button
          type="button"
          className="button-secondary search-columns-button"
          onClick={() => {
            setSaid(t('search.columns.reset.done'));
            onChange([...DEFAULT_COLUMNS]);
          }}
        >
          {t('search.columns.reset')}
        </button>
        <p role="status" className="visually-hidden">
          {said}
        </p>
      </div>
    </Popover>
  );
}

function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
