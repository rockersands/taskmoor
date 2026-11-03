import { api } from '../api/client';
import type { Tone } from '../search/ResultTable';

/** The fields a list groups by (M1-049; AGL-016 (2)), as the reports name them. */
export const GROUP_FIELDS = [
  'status',
  'assignee',
  'priority',
  'type',
  'targetRelease',
  'labels',
] as const;
export type GroupField = (typeof GROUP_FIELDS)[number];

/** One group: a value (an id, a label's text), none, or the rest gathered as other. */
export interface GroupValue {
  id: string | null;
  name: string | null;
  kind: 'value' | 'none' | 'other';
  total: number;
}

/** A format rule (AGL-016): a condition in the query language, what it colours and how. */
export interface FormatRule {
  id: string;
  name: string;
  query: string;
  /** The whole row, or one column by its id. */
  target: 'row' | string;
  tone: Tone;
}

export interface RuleMatches {
  matches: Record<string, number[]>;
  errors: Record<string, string>;
}

export interface ListClient {
  track(key: string): Promise<{ id: number; key: string; name: string }>;
  /**
   * Tickets per value of a field, for the query (the two-dimensional report against the track:
   * one column); a Multi-track plan also groups by track (ADR-122).
   */
  groups(query: string, field: GroupField | 'track'): Promise<GroupValue[]>;
  /** Which of these tickets each rule's condition matches, as the viewer. */
  formatRules(ids: number[], rules: Pick<FormatRule, 'id' | 'query'>[]): Promise<RuleMatches>;
  createTicket(track: string, summary: string): Promise<{ id: number; key: string }>;
}

export const listClient: ListClient = {
  track: async (key) =>
    (
      await api<{ track: { id: number; key: string; name: string } }>(
        `/tracks/${encodeURIComponent(key)}`,
      )
    ).track,
  groups: async (query, field) =>
    (
      await api<{ x: GroupValue[] }>(
        `/reports/two-dimensional?${new URLSearchParams({ query, x: field, y: 'track' }).toString()}`,
      )
    ).x,
  formatRules: (ids, rules) =>
    api<RuleMatches>('/search/format-rules', { method: 'POST', body: { ids, rules } }),
  createTicket: async (track, summary) =>
    (
      await api<{ ticket: { id: number; key: string } }>('/tickets', {
        method: 'POST',
        body: { track, summary },
      })
    ).ticket,
};

/** A value as the query language reads it: a quoted string with its quotes escaped. */
const quoted = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The condition that finds a group's tickets; null for the rest gathered as other. */
export function groupClause(field: GroupField | 'track', value: GroupValue): string | null {
  if (value.kind === 'other') return null;
  if (value.kind === 'none' || value.id === null) return `${field} IS EMPTY`;
  return field === 'labels' ? `labels = ${quoted(value.id)}` : `${field} = ${value.id}`;
}

/** A track's format rules and columns, kept per person in this browser (like M1-042's columns). */
const rulesKey = (track: string) => `taskmoor.list.rules.${track}`;
const columnsKey = (track: string) => `taskmoor.list.columns.${track}`;

export function loadRules(track: string): FormatRule[] {
  try {
    const raw = window.localStorage.getItem(rulesKey(track));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as FormatRule[]) : [];
  } catch {
    return [];
  }
}

export function saveRules(track: string, rules: readonly FormatRule[]): void {
  try {
    window.localStorage.setItem(rulesKey(track), JSON.stringify(rules));
  } catch {
    // Private windows and full storage: the rules last for this visit only.
  }
}

export function loadListColumns(track: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(columnsKey(track));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) && parsed.every((c) => typeof c === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

export function saveListColumns(track: string, columns: readonly string[]): void {
  try {
    window.localStorage.setItem(columnsKey(track), JSON.stringify(columns));
  } catch {
    // As above.
  }
}
