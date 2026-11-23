import { api } from './client';
import { everyPage } from './pages';

/**
 * Every team `GET /teams` gives, following its pages (500 a page, by name; T-286). The list
 * answers 100 teams unless asked for more, so a reader that wants them all, such as the Teams
 * page, a board's team or a plan's teams, follows `next` to the end. `query` narrows by part of
 * a name. A picker reads one short page of its own instead.
 */
export function everyTeam<T>(query = ''): Promise<T[]> {
  return everyPage<T, string>(async (after) => {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    params.set('limit', '500');
    if (after !== null) params.set('after', after);
    const page: { teams: T[]; next?: string | null } = await api(`/teams?${params}`);
    return { items: page.teams, next: page.next };
  });
}
