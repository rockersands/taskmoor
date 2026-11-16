import { splitLabels, textDocument } from '../tickets/form';
import { localDateTime } from '../tickets/templates/start';
import type { Field, Named } from './client';

/**
 * A context's default as the page edits it (CORE-009; T-320): typed text, chosen option ids (a
 * two-level list's parent and child), or people, groups and teams with their names.
 */
export interface DefaultDraft {
  text: string;
  child: string;
  ids: string[];
  picked: Named[];
}

export const EMPTY_DRAFT: DefaultDraft = { text: '', child: '', ids: [], picked: [] };

/** The words of a rich text document, one line a paragraph. */
export function docText(doc: unknown): string {
  const blocks = (doc as { content?: unknown[] } | null)?.content ?? [];
  const words = (node: unknown): string => {
    const n = node as { text?: unknown; content?: unknown[] } | null;
    if (!n) return '';
    if (typeof n.text === 'string') return n.text;
    return (n.content ?? []).map(words).join('');
  };
  return blocks.map(words).join('\n');
}

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
const idOf = (value: unknown) => String((value as { id?: unknown }).id ?? value);

/** A default as `GET /fields/:id` shows it (options and people with their names), for the form. */
export function draftOf(field: Field, value: unknown): DefaultDraft {
  if (value === null || value === undefined) return EMPTY_DRAFT;
  switch (field.type) {
    case 'paragraph':
      return { ...EMPTY_DRAFT, text: docText(value) };
    case 'datetime':
      return { ...EMPTY_DRAFT, text: localDateTime(String(value)) };
    case 'labels':
      return { ...EMPTY_DRAFT, text: asArray(value).map(String).join(' ') };
    case 'select':
      return { ...EMPTY_DRAFT, ids: asArray(value).map(idOf) };
    case 'cascading-select': {
      const chosen = value as { id?: unknown; child?: { id?: unknown } | null };
      return {
        ...EMPTY_DRAFT,
        ids: chosen.id === undefined ? [] : [String(chosen.id)],
        child: chosen.child?.id === undefined ? '' : String(chosen.child.id),
      };
    }
    case 'user':
    case 'group':
    case 'team':
      return {
        ...EMPTY_DRAFT,
        picked: asArray(value).map((v) => {
          const named = v as { id: number; name?: string };
          return { id: named.id, name: named.name ?? String(named.id) };
        }),
      };
    default:
      return { ...EMPTY_DRAFT, text: String(value) };
  }
}

/** A context's option as the default form reads it: offered or not, a two-level list's children. */
interface OfferedOption {
  id: number;
  value: string;
  disabled: boolean;
  children?: readonly OfferedOption[];
}

/**
 * The draft with only the options the context still offers (T-320), and the names of those left
 * out. Stopping offering an option leaves a saved default naming it, and the server refuses a
 * default that names an option no longer offered; the form draws only offered ones, so it could
 * neither show nor untick it. Other types come back as they are.
 */
export function offeredOnly(
  field: Field,
  draft: DefaultDraft,
  options: readonly OfferedOption[],
): { draft: DefaultDraft; dropped: string[] } {
  if (field.type !== 'select' && field.type !== 'cascading-select') return { draft, dropped: [] };
  const all = options.flatMap((o) => [o, ...(o.children ?? [])]);
  const nameOf = (id: string) => all.find((o) => String(o.id) === id)?.value ?? `#${id}`;
  const offered = (list: readonly OfferedOption[] | undefined, id: string) =>
    (list ?? []).some((o) => String(o.id) === id && !o.disabled);
  if (field.type === 'select') {
    const ids = draft.ids.filter((id) => offered(options, id));
    const dropped = draft.ids.filter((id) => !ids.includes(id)).map(nameOf);
    return { draft: dropped.length === 0 ? draft : { ...draft, ids }, dropped };
  }
  const parentId = draft.ids[0];
  if (parentId === undefined || parentId === '') return { draft, dropped: [] };
  if (!offered(options, parentId)) {
    const dropped = [nameOf(parentId), ...(draft.child === '' ? [] : [nameOf(draft.child)])];
    return { draft: { ...draft, ids: [], child: '' }, dropped };
  }
  const parent = options.find((o) => String(o.id) === parentId);
  if (draft.child !== '' && !offered(parent?.children, draft.child)) {
    return { draft: { ...draft, child: '' }, dropped: [nameOf(draft.child)] };
  }
  return { draft, dropped: [] };
}

/** What the form holds as `defaultValue` for `PATCH .../contexts/:id`; null for no default. */
export function defaultInput(field: Field, draft: DefaultDraft): unknown {
  const text = draft.text.trim();
  switch (field.type) {
    case 'paragraph':
      return textDocument(draft.text);
    case 'datetime':
      return text === '' ? null : new Date(text).toISOString();
    case 'labels': {
      const labels = splitLabels(text);
      return labels.length === 0 ? null : labels;
    }
    case 'select': {
      const ids = draft.ids.filter((id) => id !== '').map(Number);
      if (ids.length === 0) return null;
      return field.multiple ? ids : ids[0];
    }
    case 'cascading-select': {
      const parent = draft.ids[0];
      if (parent === undefined || parent === '') return null;
      return {
        parent: Number(parent),
        ...(draft.child === '' ? {} : { child: Number(draft.child) }),
      };
    }
    case 'user':
    case 'group':
    case 'team': {
      const ids = draft.picked.map((p) => p.id);
      if (ids.length === 0) return null;
      return field.multiple ? ids : ids[0];
    }
    default:
      return text === '' ? null : text;
  }
}

/** The option ids a default names, to mark them in the option list. */
export function defaultOptionIds(value: unknown): number[] {
  if (value === null || value === undefined) return [];
  const out: number[] = [];
  for (const v of asArray(value)) {
    const named = v as { id?: unknown; child?: { id?: unknown } | null };
    if (typeof named.id === 'number') out.push(named.id);
    if (typeof named.child?.id === 'number') out.push(named.child.id);
  }
  return out;
}
