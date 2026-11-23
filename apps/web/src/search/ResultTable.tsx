import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { type NumberShow, numberText } from '../fields/numberFormat';
import { dayText, isCalendarDay, isInstant, momentDayText, momentText } from '../i18n/days';
import { useT } from '../i18n/I18nProvider';
import { type Lock, useLockText } from '../locks/useLockText';
import { routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { IconSelect } from '../shell/IconSelect';
import { useMoreSides } from '../shell/moreSides';
import { priorityName } from '../shell/priorityName';
import { PriorityGlyph, PriorityIcon, TypeIcon } from '../shell/TicketIcons';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
import type { SubticketProgress } from '../tickets/tools/client';
import { SubticketProgressMini, useSubticketProgress } from '../tickets/tools/Progress';
import type { SearchClient, SearchTicket } from './client';
import {
  type CellEditor,
  type ColumnField,
  cellChange,
  cellEditor,
  cellValue,
  DATE_COLUMNS,
  editorStart,
  isDateTimeColumn,
  isTicketMomentColumn,
  numberShowOfColumn,
  orderOfColumn,
  type TableSort,
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
  /** The order the rows are in, marked on that column's header (PL-11). */
  sort?: TableSort | null;
  /**
   * Ordering by a column's heading (T-330): a heading the query language can order by becomes a
   * button that calls this with its column; the page decides the order (`nextSort`) and gives it
   * back as `sort`. Without it the headings are plain words, as search shows them.
   */
  onSort?: (column: string) => void;
  /** No cell edits in place: a plan's List read in a scenario (ADR-122 stage 6). */
  readOnly?: boolean;
  /**
   * The scrolling table's name, 'Result table' by default. A page with a table per group names
   * each after its group: regions of one page need names of their own (axe landmark-unique).
   */
  label?: string;
}

/**
 * Short values that read best on one line; the summary takes the width they leave (TR-8). A name
 * stays whole too ('Chen Wei', not 'Chen' above 'Wei').
 */
const ONE_LINE = new Set([
  ...DATE_COLUMNS,
  'ticketType',
  'status',
  'assignee',
  'priority',
  'voteCount',
]);

/**
 * The results as a table in the person's columns (M1-042; QRY-014): the key links the ticket,
 * and editable cells (summary, assignee, priority, labels, dates, simple custom fields) change
 * in place through the ticket route, which checks permissions, locks and values as it does
 * everywhere; a refusal is shown on the cell. Wide tables scroll inside their own region; the
 * summary takes the width the short columns leave. On a phone the same tickets are stacked rows
 * (TR-1, PL-1): key, summary, then status, assignee and priority, as the phone backlog shows
 * them. A track's list, search results and a plan's list all show their tickets through here.
 */
export function ResultTable(props: ResultTableProps) {
  const compact = useMediaQuery(COMPACT_QUERY);
  return compact ? <ResultRows {...props} /> : <ResultGrid {...props} />;
}

/** The key's cell: the link, subticket progress and the names of the format rules that apply. */
function KeyCell({
  ticket,
  progress,
  marks,
}: {
  ticket: SearchTicket;
  progress: SubticketProgress | undefined;
  marks: RowFormat | null;
}) {
  return (
    <>
      <a href={routeHref(`#/tickets/${encodeURIComponent(ticket.key)}`)}>{ticket.key}</a>
      {progress && <SubticketProgressMini progress={progress} named />}
      {marks && marks.names.length > 0 && (
        <span className="format-marks">
          {marks.names.map((name) => (
            <span key={name} className="format-mark">
              {name}
            </span>
          ))}
        </span>
      )}
    </>
  );
}

/**
 * A phone's stacked rows (D1): one block per ticket, read top to bottom, never sideways. Exported
 * for the stories, whose browser is not a phone; pages use `ResultTable`.
 */
export function ResultRows({ tickets, fields, client, format }: ResultTableProps) {
  const t = useT();
  const nameOf = useColumnName(fields);
  const progress = useSubticketProgress(tickets, client.subticketProgress);
  return (
    <ul className="glass-card result-rows" aria-label={t('list.tickets')}>
      {tickets.map((ticket) => {
        const marks = format?.(ticket) ?? null;
        const priority = (ticket.priority ?? null) as { name: string; level?: number } | null;
        return (
          <li key={ticket.id} className="result-row" data-tone={marks?.row ?? undefined}>
            <p className="result-row-key">
              <KeyCell ticket={ticket} progress={progress[ticket.id]} marks={marks} />
            </p>
            <p className="result-row-summary" data-tone={marks?.cells.summary ?? undefined}>
              {ticket.summary}
            </p>
            <dl className="result-row-facts">
              <div data-tone={marks?.cells.status ?? undefined}>
                <dt className="visually-hidden">{nameOf('status')}</dt>
                <dd className="result-row-status" data-stage={ticket.status.stage}>
                  {ticket.status.name}
                </dd>
              </div>
              <div data-tone={marks?.cells.assignee ?? undefined}>
                <dt className="visually-hidden">{nameOf('assignee')}</dt>
                <dd>{ticket.assignee?.name ?? t('search.edit.unassigned')}</dd>
              </div>
              {priority && (
                <div data-tone={marks?.cells.priority ?? undefined}>
                  <dt className="visually-hidden">{nameOf('priority')}</dt>
                  <dd>
                    <PriorityIcon name={priority.name} level={priority.level} />
                  </dd>
                </div>
              )}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The table on a wider screen. The key and the short columns take their own width and the summary
 * the rest, so at 1280 px the default columns fit the card (TR-8, PL-10). A table wider than its
 * card scrolls inside it, and the edge with more beyond it fades (D2), so a cut column reads as
 * "more this way" instead of being clipped. Exported for the stories, which set the card's
 * width themselves; pages use `ResultTable`.
 */
export function ResultGrid({
  tickets,
  columns,
  fields,
  client,
  onSaved,
  format,
  sort,
  onSort,
  readOnly = false,
  label,
}: ResultTableProps) {
  const t = useT();
  const region = useRef<HTMLElement>(null);
  const more = useMoreSides(region, `${tickets.length}/${columns.join()}`);
  const nameOf = useColumnName(fields);
  const progress = useSubticketProgress(tickets, client.subticketProgress);
  const [priorities, setPriorities] = useState<
    { id: number; name: string; level?: number }[] | null
  >(null);
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
    <section
      ref={region}
      className="glass-card glass-scroller search-table-scroll"
      data-more={more}
      aria-label={label ?? t('search.table')}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
      tabIndex={0}
    >
      <table className="data-table search-table">
        <thead>
          <tr>
            <th scope="col" aria-sort={sortOf('key', sort)}>
              <Heading column="key" name={t('search.column.key')} sort={sort} onSort={onSort} />
            </th>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                data-column={column}
                data-one-line={ONE_LINE.has(column) || undefined}
                aria-sort={sortOf(column, sort)}
              >
                <Heading column={column} name={nameOf(column)} sort={sort} onSort={onSort} />
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
                  <KeyCell ticket={ticket} progress={progress[ticket.id]} marks={marks} />
                </th>
                {columns.map((column) => (
                  <Cell
                    key={column}
                    ticket={ticket}
                    column={column}
                    columnName={nameOf(column)}
                    editor={readOnly ? null : cellEditor(column, fields)}
                    dateTime={isDateTimeColumn(column, fields)}
                    number={numberShowOfColumn(column, fields)}
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

/** A header's `aria-sort`: only on the column the rows follow. */
function sortOf(column: string, sort: TableSort | null | undefined) {
  return sort?.column === column ? sort.direction : undefined;
}

/** The arrow beside the sorted column's name; `aria-sort` says the same to a screen reader. */
function SortMark({ column, sort }: { column: string; sort: TableSort | null | undefined }) {
  if (sort?.column !== column) return null;
  return (
    <span className="search-sort-mark" aria-hidden="true">
      {sort.direction === 'ascending' ? '\u2191' : '\u2193'}
    </span>
  );
}

/**
 * A column's heading: its name and the arrow when the rows follow it. Where the page orders by
 * headings (T-330) and the query language can order by the column, a button named by those
 * words: a click or Enter orders by it, and again the other way. The `th` keeps `aria-sort`.
 */
function Heading({
  column,
  name,
  sort,
  onSort,
}: {
  column: string;
  name: string;
  sort: TableSort | null | undefined;
  onSort: ((column: string) => void) | undefined;
}) {
  if (!onSort || !orderOfColumn(column)) {
    return (
      <>
        {name}
        <SortMark column={column} sort={sort} />
      </>
    );
  }
  return (
    <button type="button" className="search-sort-button" onClick={() => onSort(column)}>
      {name}
      <SortMark column={column} sort={sort} />
    </button>
  );
}

/**
 * One editable cell of a ticket's column, shared with a plan's Grid (ADR-122 stage 10): the value,
 * and where `editor` allows, an edit in place through the ticket route with the refusal on the cell.
 */
export function Cell({
  ticket,
  column,
  columnName,
  editor,
  dateTime,
  number = null,
  priorities,
  client,
  onSaved,
  tone,
}: {
  ticket: SearchTicket;
  column: string;
  columnName: string;
  editor: CellEditor | null;
  /** A moment (created, updated, closed or a custom datetime field), read in the locale. */
  dateTime: boolean;
  /** How a number field's or formula's numbers show, by its settings (T-320). */
  number?: NumberShow | null;
  priorities: { id: number; name: string; level?: number }[] | null;
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
  // No one assigned reads 'Unassigned', as the phone's rows say, never a blank cell.
  const unassigned = column === 'assignee' && (value === null || value === undefined);
  const shown =
    dateTime && isInstant(value)
      ? momentText(intl, value)
      : editor?.kind === 'date' && isCalendarDay(value)
        ? dayText(intl, value)
        : unassigned
          ? t('search.edit.unassigned')
          : valueText(value);
  // The ticket's own moments show their day, so the summary keeps the room; the time stays in
  // the cell's words and its tooltip (TR-8, PL-10).
  const moment = dateTime && isTicketMomentColumn(column) && isInstant(value) ? value : null;
  // A number as its field's settings show it (T-320).
  const text =
    number !== null && typeof value === 'number' ? numberText(intl, value, number) : shown;

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
      data-column={column}
      data-one-line={ONE_LINE.has(column) || undefined}
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
          <span className={unassigned ? 'search-cell-value search-cell-none' : 'search-cell-value'}>
            {moment !== null ? (
              <time dateTime={moment} title={text}>
                <span aria-hidden="true">{momentDayText(intl, moment)}</span>
                <span className="visually-hidden">{text}</span>
              </time>
            ) : (
              <CellPicture column={column} value={value} shown={text} />
            )}
          </span>
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

/** The type and priority columns show their icon (CORE-005, CORE-014); the rest their text. */
function CellPicture({ column, value, shown }: { column: string; value: unknown; shown: string }) {
  const named = value as { name?: unknown; icon?: string | null; level?: number } | null;
  if (typeof named?.name !== 'string') return shown;
  if (column === 'ticketType') return <TypeIcon name={named.name} icon={named.icon} />;
  if (column === 'priority') return <PriorityIcon name={named.name} level={named.level} />;
  return shown;
}

/** The input of a cell being edited, by its editor's kind. */
export function CellInput({
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
  priorities: { id: number; name: string; level?: number }[] | null;
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
      const list =
        priorities ?? (current ? [current as { id: number; name: string; level?: number }] : []);
      return (
        <IconSelect
          // One ref for whichever control the cell shows; only `focus()` is called on it.
          buttonRef={inputRef as unknown as React.RefObject<HTMLButtonElement | null>}
          aria-label={label}
          aria-invalid={describedBy ? true : undefined}
          aria-describedby={describedBy}
          value={value}
          // Only an imported ticket can have none; a ticket's priority cannot be taken away.
          placeholder={t('priority.choose')}
          options={list.map((p) => ({
            value: String(p.id),
            label: priorityName(t, p.name),
            icon: <PriorityGlyph level={p.level} />,
          }))}
          onChange={onChange}
        />
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
