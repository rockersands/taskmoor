import type { SearchTicket } from './client';

/**
 * The columns of the results list (M1-042; QRY-014 (3)): system columns and custom fields
 * (`cf[N]`), in the person's order, the key always first. The choice is kept in this browser per
 * person (localStorage, read and written in try/catch: storage can be off); column sets on the
 * server come with saved searches (M1-063). The ids are those the export takes (`columns=`).
 */
export const SYSTEM_COLUMNS = [
  'summary',
  'ticketType',
  'status',
  'assignee',
  'priority',
  'labels',
  'track',
  'requester',
  'creator',
  'parent',
  'startDate',
  'dueDate',
  'createdAt',
  'updatedAt',
  'closedAt',
  'targetReleases',
  'areas',
  'voteCount',
] as const;
export type SystemColumn = (typeof SYSTEM_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly string[] = [
  'summary',
  'ticketType',
  'status',
  'assignee',
  'priority',
  'updatedAt',
];

/** A custom field as the column picker offers it. */
export interface ColumnField {
  id: number;
  name: string;
  type: string;
  multiple?: boolean;
}

export const customColumn = (id: number) => `cf[${id}]`;

export function customFieldId(column: string): number | null {
  const m = /^cf\[(\d{1,10})\]$/.exec(column);
  return m ? Number(m[1]) : null;
}

const SYSTEM = new Set<string>(SYSTEM_COLUMNS);

const storageKey = (userId: number) => `taskmoor.search.columns.${userId}`;

/** The person's columns in this browser, or the defaults; unknown entries are dropped. */
export function loadColumns(userId: number): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const columns = parsed.filter(
          (c): c is string => typeof c === 'string' && (SYSTEM.has(c) || customFieldId(c) !== null),
        );
        return [...new Set(columns)];
      }
    }
  } catch {
    // Storage off or unreadable: the defaults.
  }
  return [...DEFAULT_COLUMNS];
}

export function saveColumns(userId: number, columns: readonly string[]): void {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(columns));
  } catch {
    // Not remembered in this browser; the list still shows the choice until reload.
  }
}

/** How a cell is edited in place (QRY-014 (2)), or null for a read-only column. */
export type CellEditor =
  | { kind: 'text'; max?: number }
  | { kind: 'number' }
  | { kind: 'date' }
  | { kind: 'labels' }
  | { kind: 'priority' }
  | { kind: 'assignee' };

export function cellEditor(column: string, fields: readonly ColumnField[]): CellEditor | null {
  switch (column) {
    case 'summary':
      return { kind: 'text', max: 255 };
    case 'assignee':
      return { kind: 'assignee' };
    case 'priority':
      return { kind: 'priority' };
    case 'labels':
      return { kind: 'labels' };
    case 'startDate':
    case 'dueDate':
      return { kind: 'date' };
  }
  const id = customFieldId(column);
  const field = id === null ? undefined : fields.find((f) => f.id === id);
  switch (field?.type) {
    case 'text':
    case 'url':
      return { kind: 'text' };
    case 'number':
      return { kind: 'number' };
    case 'date':
      return { kind: 'date' };
    case 'labels':
      return { kind: 'labels' };
    default:
      return null;
  }
}

/** The value a cell holds, as the ticket view in search returns it. */
export function cellValue(ticket: SearchTicket, column: string): unknown {
  const id = customFieldId(column);
  if (id !== null) return ticket.fields?.[String(id)] ?? null;
  return (ticket as unknown as Record<string, unknown>)[column] ?? null;
}

/** A value as one line of text: names of references, lists joined, rich text as its words. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join(', ');
  const v = value as {
    type?: unknown;
    content?: unknown[];
    text?: unknown;
    key?: unknown;
    name?: unknown;
    value?: unknown;
    child?: unknown;
  };
  if (v.type === 'doc') return docText(v);
  const own =
    typeof v.key === 'string'
      ? v.key
      : typeof v.name === 'string'
        ? v.name
        : typeof v.value === 'string'
          ? v.value
          : '';
  if ('child' in v && v.child) return `${own} / ${valueText(v.child)}`;
  return own;
}

function docText(node: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const x = n as { text?: unknown; content?: unknown[] };
    if (typeof x.text === 'string') out.push(x.text);
    for (const c of x.content ?? []) walk(c);
    if (Array.isArray(x.content)) out.push(' ');
  };
  walk(node);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** The cell's input value when editing starts. */
export function editorStart(editor: CellEditor, value: unknown): string {
  if (editor.kind === 'labels') return Array.isArray(value) ? value.join(', ') : '';
  if (editor.kind === 'priority' || editor.kind === 'assignee') {
    const id = (value as { id?: unknown } | null)?.id;
    return typeof id === 'number' ? String(id) : '';
  }
  return value === null || value === undefined ? '' : String(value);
}

/** The ticket PATCH body for a cell's new input. */
export function cellChange(column: string, editor: CellEditor, input: string): object {
  const text = input.trim();
  let value: unknown;
  switch (editor.kind) {
    case 'labels':
      value = text
        .split(/[\s,]+/)
        .map((l) => l.trim())
        .filter(Boolean);
      break;
    case 'number':
      value = text === '' ? null : Number(text);
      break;
    case 'priority':
    case 'assignee':
      value = text === '' ? null : Number(text);
      break;
    case 'date':
      value = text === '' ? null : text;
      break;
    default:
      value = column === 'summary' ? input : text === '' ? null : input;
  }
  const id = customFieldId(column);
  if (id !== null) return { fields: { [id]: value } };
  if (column === 'assignee') return { assigneeId: value };
  if (column === 'priority') return { priorityId: value };
  return { [column]: value };
}
