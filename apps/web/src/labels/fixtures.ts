import { ApiError } from '../api/client';
import type { LabelPage, LabelPageQuery, LabelsClient, MergedLabels } from './client';

export interface FakeLabelsClient extends LabelsClient {
  calls: { action: string; args: unknown[] }[];
  /** The tickets' labels as they are now, to check what a merge did. */
  tickets: () => string[][];
}

/** The server's order: by lower case, then as written, byte by byte (`COLLATE "C"`). */
function byName(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * An in-memory backend for stories and tests that answers as the API would (CORE-017): three
 * words for the front end (frontend on two tickets, front-end on two, one of them with frontend
 * too, and fe on one), FE beside fe, ops, ui and a label no ticket has any more. With `many`,
 * sixty more labels, so the list comes a page at a time.
 */
export function fakeLabelsClient({ many = false }: { many?: boolean } = {}): FakeLabelsClient {
  let tickets: string[][] = [
    ['frontend', 'ui'],
    ['front-end'],
    ['front-end', 'frontend'],
    ['fe', 'ops'],
    ['FE'],
    ['backend', 'ops'],
    ['backend'],
    ['ui'],
  ];
  const vocabulary = new Set(tickets.flat());
  vocabulary.add('old-sprint');
  if (many) {
    for (let i = 1; i <= 60; i++) vocabulary.add(`team-${String(i).padStart(2, '0')}`);
  }
  const calls: FakeLabelsClient['calls'] = [];
  const count = (name: string) => tickets.filter((t) => t.includes(name)).length;

  return {
    calls,
    tickets: () => tickets.map((t) => [...t]),
    usage: async (query: LabelPageQuery): Promise<LabelPage> => {
      calls.push({ action: 'usage', args: [query] });
      const typed = query.q?.trim().toLowerCase() ?? '';
      const limit = query.limit ?? 50;
      const after = query.after;
      const names = [...vocabulary]
        .filter((n) => n.toLowerCase().startsWith(typed))
        .sort(byName)
        .filter((n) => after === undefined || byName(n, after) > 0);
      return {
        labels: names.slice(0, limit).map((name) => ({ name, ticketCount: count(name) })),
        more: names.length > limit,
      };
    },
    merge: async (labels: string[], into: string): Promise<MergedLabels> => {
      calls.push({ action: 'merge', args: [labels, into] });
      const target = into.trim();
      if (target === '' || /\s/.test(target) || [...target].length > 255) {
        throw new ApiError(400, { error: 'invalid_request', detail: 'into' });
      }
      const merged = [...new Set(labels.map((l) => l.trim()))].filter((l) => l !== target);
      if (merged.length === 0 || merged.length > 100) {
        throw new ApiError(400, { error: 'invalid_request', detail: 'labels' });
      }
      let ticketCount = 0;
      tickets = tickets.map((t) => {
        if (!t.some((l) => merged.includes(l))) return t;
        ticketCount += 1;
        const named = t.map((l) => (merged.includes(l) ? target : l));
        return named.filter((l, i) => named.indexOf(l) === i);
      });
      for (const label of merged) vocabulary.delete(label);
      vocabulary.add(target);
      return { into: target, labels: merged, ticketCount };
    },
  };
}
