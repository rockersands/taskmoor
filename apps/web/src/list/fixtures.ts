import { ApiError } from '../api/client';
import type { SearchTicket } from '../search/client';
import { type FakeSearchClient, fakeSearchClient } from '../search/fixtures';
import type { GroupField, GroupValue, ListClient, RuleMatches } from './client';

/**
 * A track's list in memory for stories and tests (M1-049): the search fixtures' tickets (two
 * priorities, one ticket closed and locked), filtered by the group and filter clauses a list
 * sends, counted per value, and format rules evaluated for the conditions the tests use. A
 * filter naming `nope` is refused, as the server would.
 */
async function everything(search: FakeSearchClient): Promise<SearchTicket[]> {
  const out: SearchTicket[] = [];
  let cursor: string | undefined;
  do {
    const page = await search.search('', cursor);
    out.push(...page.tickets);
    cursor = page.next ?? undefined;
  } while (cursor);
  search.queries.length = 0;
  return out;
}

/** What a group or filter clause keeps, for the clauses a list sends. */
function keeps(q: string, t: SearchTicket): boolean {
  const priority = /priority = (\d+)/.exec(q);
  if (priority && String(t.priority?.id) !== priority[1]) return false;
  if (q.includes('priority IS EMPTY') && t.priority) return false;
  const assignee = /assignee = (\d+)/.exec(q);
  if (assignee && String(t.assignee?.id) !== assignee[1]) return false;
  if (q.includes('assignee IS EMPTY') && t.assignee) return false;
  if (q.includes('stage = new') && t.status.stage !== 'new') return false;
  return true;
}

const valuesOf = (field: GroupField, t: SearchTicket): { id: string; name: string } | null => {
  if (field === 'priority')
    return t.priority ? { id: String(t.priority.id), name: t.priority.name } : null;
  if (field === 'assignee')
    return t.assignee ? { id: String(t.assignee.id), name: t.assignee.name } : null;
  // The query language takes a type by its name too.
  if (field === 'type') return { id: t.ticketType.name, name: t.ticketType.name };
  return null;
};

/** A list's search: the clauses filter, fifty a page, and edits as in the search fixtures. */
export function fakeListSearch(): FakeSearchClient {
  const inner = fakeSearchClient();
  const queries: string[] = [];
  return {
    ...inner,
    queries,
    search: async (q, cursor) => {
      queries.push(q);
      if (q.includes('nope')) throw new ApiError(400, { error: 'invalid_query' });
      const all = (await everything(inner)).filter((t) => keeps(q, t));
      const from = cursor ? Number(cursor) : 0;
      return {
        tickets: all.slice(from, from + 50),
        next: from + 50 < all.length ? String(from + 50) : null,
      };
    },
  };
}

export function fakeListClient(search: FakeSearchClient): ListClient & {
  created: string[];
  ruleCalls: number;
} {
  const created: string[] = [];
  const state = { ruleCalls: 0 };
  return {
    created,
    get ruleCalls() {
      return state.ruleCalls;
    },
    track: async (key) => {
      if (key !== 'SHOP') throw new ApiError(404, { error: 'not_found' });
      return { id: 3, key: 'SHOP', name: 'Shop' };
    },
    groups: async (query, field) => {
      if (query.includes('nope')) throw new ApiError(400, { error: 'invalid_query' });
      const all = (await everything(search as FakeSearchClient)).filter((t) => keeps(query, t));
      const out = new Map<string, GroupValue>();
      for (const t of all) {
        const v = valuesOf(field, t);
        const key = v?.id ?? '';
        const seen = out.get(key) ?? {
          id: v?.id ?? null,
          name: v?.name ?? null,
          kind: v ? ('value' as const) : ('none' as const),
          total: 0,
        };
        out.set(key, { ...seen, total: seen.total + 1 });
      }
      return [...out.values()];
    },
    formatRules: async (ids, rules): Promise<RuleMatches> => {
      state.ruleCalls++;
      const all = (await everything(search as FakeSearchClient)).filter((t) => ids.includes(t.id));
      const matches: Record<string, number[]> = {};
      const errors: Record<string, string> = {};
      for (const rule of rules) {
        if (rule.query.includes('nope')) {
          errors[rule.id] = 'There is no field "nope"';
          matches[rule.id] = [];
          continue;
        }
        matches[rule.id] = all
          .filter((t) =>
            rule.query === 'priority = High'
              ? t.priority?.name === 'High'
              : rule.query === 'stage = new'
                ? t.status.stage === 'new'
                : false,
          )
          .map((t) => t.id);
      }
      return { matches, errors };
    },
    createTicket: async (_track, summary) => {
      created.push(summary);
      return { id: 900 + created.length, key: `SHOP-${900 + created.length}` };
    },
  };
}
