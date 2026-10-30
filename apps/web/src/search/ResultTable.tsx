import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { type Lock, useLockText } from '../locks/useLockText';
import { routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import type { SearchClient, SearchTicket } from './client';
import {
  type CellEditor,
  type ColumnField,
  cellChange,
  cellEditor,
  cellValue,
  editorStart,
  valueText,
} from './columns';
import { useColumnName } from './useColumnName';

/** A format rule's colour (M1-049): one of four tones, each with the rule's name beside it. */
export type Tone = 'red' | 'amber' | 'green' | 'blue';

/** What format rules make of a row: its tone, tones for some cells, and the rules' names. */
export interface RowFormat {
  row: Tone | null;
  cells: Record<string, Tone>;
  names: string[];
}

export interface ResultTableProps {
  tickets: readonly SearchTicket[];
  columns: readonly string[];
  fields: readonly ColumnField[];
  client: SearchClient;
  /** A ticket as the ticket route returned it after an edit in place. */
  onSaved: (ticket: SearchTicket) => void;
  /** Format rules' marks for a ticket (list views, M1-049); none by default. */
  format?: (ticket: SearchTicket) => RowFormat | null;
}

const DATE_TIMES = new Set(['createdAt', 'updatedAt', 'closedAt']);

/**
 * The results as a table in the person's columns (M1-042; QRY-014): the key links the ticket,
 * and editable cells (summary, assignee, priority, labels, dates, simple custom fields) change
 * in place through the ticket route, which checks permissions, locks and values as it does
 * everywhere; a refusal is shown on the cell. Wide tables scroll inside their own region.
 */
export function ResultTable({
  tickets,
  columns,
  fields,
  client,
  onSaved,
  format,
}: ResultTableProps) {
  const t = useT();
  const nameOf = useColumnName(fields);
  const [priorities, setPriorities] = useState<{ id: number; name: string }[] | null>(null);
  const wantsPriorities = columns.includes('priority');
  useEffect(() => {
    if (!wantsPriorities || priorities) return;
    let live = true;
    client.priorities().then(
      (list) => live && setPriorities(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, wantsPriorities, priorities]);

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
    <section className="search-table-scroll" aria-label={t('search.table')} tabIndex={0}>
      <table className="search-table">
        <thead>
          <tr>
            <th scope="col">{t('search.column.key')}</th>
            {columns.map((column) => (
              <th key={column} scope="col">
                {nameOf(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => {
            const marks = format?.(ticket) ?? null;
            return (
              <tr key={ticket.id} data-tone={marks?.row ?? undefined}>
                <th scope="row" className="search-key">
                  <a href={routeHref(`#/tickets/${encodeURIComponent(ticket.key)}`)}>
                    {ticket.key}
                  </a>
                  {marks && marks.names.length > 0 && (
                    <span className="format-marks">
                      {marks.names.map((name) => (
                        <span key={name} className="format-mark">
                          {name}
                        </span>
                      ))}
                    </span>
                  )}
                </th>
                {columns.map((column) => (
                  <Cell
                    key={column}
                    ticket={ticket}
                    column={column}
                    columnName={nameOf(column)}
                    editor={cellEditor(column, fields)}
                    priorities={priorities}
                    client={client}
                    onSaved={onSaved}
                    tone={marks?.cells[column] ?? null}
                  />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Cell({
  ticket,
  column,
  columnName,
  editor,
  priorities,
  client,
  onSaved,
  tone,
}: {
  ticket: SearchTicket;
  column: string;
  columnName: string;
  editor: CellEditor | null;
  priorities: { id: number; name: string }[] | null;
  client: SearchClient;
  onSaved: (ticket: SearchTicket) => void;
  tone: Tone | null;
}) {
  const t = useT();
  const intl = useIntl();
  const lockText = useLockText();
  const id = useId();
  const { session } = useSession();
  const me = session.status === 'signed-in' ? session.user : null;
  const [input, setInput] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const edit = useRef<HTMLButtonElement>(null);
  const editing = input !== null;

  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);

  const value = cellValue(ticket, column);
  const shown =
    DATE_TIMES.has(column) && typeof value === 'string'
      ? intl.formatDate(value, { dateStyle: 'medium', timeStyle: 'short' })
      : valueText(value);

  const close = () => {
    setInput(null);
    window.setTimeout(() => edit.current?.focus(), 0);
  };

  const refusal = (error: unknown): string => {
    if (error instanceof ApiError) {
      const body = error.body as { error?: string; locks?: Lock[]; fields?: unknown } | null;
      const lock = body?.locks?.[0];
      if (error.status === 403 && lock)
        return lockText(lock, column === 'assignee' ? 'assign' : 'edit');
      if (error.status === 403) return t('search.edit.forbidden');
      if (error.status === 409 && body?.error === 'version_conflict') return t('search.edit.stale');
      if (error.status === 400) return t('search.edit.invalid');
    }
    return t('search.edit.other');
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor || input === null) return;
    setSaving(true);
    try {
      const change = {
        ...cellChange(column, editor, input),
        ...(ticket.version !== undefined ? { version: ticket.version } : {}),
      };
      const updated = await client.edit(ticket.id, change);
      setProblem(null);
      onSaved(updated);
      close();
    } catch (error) {
      setProblem(refusal(error));
    } finally {
      setSaving(false);
    }
  };

  const problemId = `${id}-problem`;
  const label = t('search.edit', { column: columnName, key: ticket.key });
  return (
    <td
      className={problem ? 'search-cell has-problem' : 'search-cell'}
      data-tone={tone ?? undefined}
    >
      {editing && editor ? (
        <form
          className="search-cell-form"
          aria-label={label}
          onSubmit={save}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setProblem(null);
              close();
            }
          }}
        >
          <CellInput
            editor={editor}
            value={input}
            label={label}
            priorities={priorities}
            current={value}
            me={me}
            inputRef={field}
            describedBy={problem ? problemId : undefined}
            onChange={setInput}
          />
          <span className="search-cell-actions">
            <button type="submit" className="button-primary search-cell-button" disabled={saving}>
              {saving ? t('search.edit.saving') : t('search.edit.save')}
            </button>
            <button
              type="button"
              className="button-secondary search-cell-button"
              onClick={() => {
                setProblem(null);
                close();
              }}
            >
              {t('search.edit.cancel')}
            </button>
          </span>
        </form>
      ) : (
        <span className="search-cell-view">
          <span className="search-cell-value">{shown}</span>
          {editor && (
            <button
              ref={edit}
              type="button"
              className="search-cell-edit"
              aria-label={label}
              aria-describedby={problem ? problemId : undefined}
              onClick={() => setInput(editorStart(editor, value))}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                <path
                  d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </span>
      )}
      {problem && (
        <p id={problemId} role="alert" className="form-error search-cell-problem">
          {problem}
        </p>
      )}
    </td>
  );
}

function CellInput({
  editor,
  value,
  label,
  priorities,
  current,
  me,
  inputRef,
  describedBy,
  onChange,
}: {
  editor: CellEditor;
  value: string;
  label: string;
  priorities: { id: number; name: string }[] | null;
  current: unknown;
  me: { id: number; name: string } | null;
  inputRef: React.RefObject<(HTMLInputElement & HTMLSelectElement) | null>;
  describedBy: string | undefined;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const common = {
    ref: inputRef,
    'aria-label': label,
    'aria-invalid': describedBy ? true : undefined,
    'aria-describedby': describedBy,
    value,
  } as const;
  switch (editor.kind) {
    case 'priority': {
      const list = priorities ?? (current ? [current as { id: number; name: string }] : []);
      return (
        <select {...common} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('search.edit.none')}</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      );
    }
    case 'assignee': {
      const now = current as { id?: number; name: string } | null;
      return (
        <select {...common} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('search.edit.unassigned')}</option>
          {me && <option value={me.id}>{t('search.edit.me', { name: me.name })}</option>}
          {now?.id !== undefined && now.id !== me?.id && <option value={now.id}>{now.name}</option>}
        </select>
      );
    }
    case 'number':
      return (
        <input
          {...common}
          type="number"
          step="any"
          inputMode="decimal"
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'date':
      return <input {...common} type="date" onChange={(event) => onChange(event.target.value)} />;
    default:
      return (
        <input
          {...common}
          type="text"
          {...(editor.kind === 'text' && editor.max ? { maxLength: editor.max } : {})}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}
