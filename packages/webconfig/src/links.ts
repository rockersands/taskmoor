/**
 * Links from the tracker an import came from (M1-128; IMP-011; ADR-097): the addresses people
 * have in bookmarks, emails, wiki pages and commit messages, as the app's own routes. Both sides
 * use this: the backend answers them with a redirect when it serves the frontend, and the app
 * reads them when a static host hands it any path (clean URLs) or the backend sent it there.
 *
 * The patterns, in our own words (each **Verify** until a design partner's links confirm it):
 *
 * - an issue: `/browse/ABC-42`, with anything after it (`?focusedCommentId=...`, a fragment), and
 *   `/projects/ABC/issues/ABC-42`; a project: `/browse/ABC`;
 * - a saved filter: `/issues/?filter=10010` and the older
 *   `/secure/IssueNavigator.jspa?requestId=10010`; a query: `/issues/?jql=...` and
 *   `/secure/IssueNavigator.jspa?jqlQuery=...`;
 * - a board: `/secure/RapidBoard.jspa?rapidView=12`; a dashboard:
 *   `/secure/Dashboard.jspa?selectPageId=10100`.
 *
 * Keys need no lookup: tickets keep their keys, and the earlier keys of moved tickets and renamed
 * projects still open them. Filters, boards and dashboards are named by the source's ids, so
 * they go to `#/imported/<kind>/<source id>`, which the app maps through the import's external ids
 * for a signed-in person (`GET /api/v1/imported-links/<kind>/<source id>`).
 */

/** The kinds a link from the source names by id, as the imported-links route takes them. */
export const IMPORTED_LINK_KINDS = ['saved-search', 'board', 'dashboard'] as const;
export type ImportedLinkKind = (typeof IMPORTED_LINK_KINDS)[number];

const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9_]{0,29})-(\d{1,9})$/;
const TRACK_KEY = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;
const SOURCE_ID = /^\d{1,18}$/;

const segment = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * The app route (`#/tickets/ABC-42`) for a path and query string of the source's links, or null
 * when the path is none of them. The path is relative to the app's base path.
 */
export function importedLinkRoute(path: string, search: string): string | null {
  const parts = path.replace(/^\/+/, '').split('/').map(segment);
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const first = (parts[0] ?? '').toLowerCase();
  const byId = (kind: ImportedLinkKind, id: string | null) =>
    id !== null && SOURCE_ID.test(id) ? `#/imported/${kind}/${id}` : null;
  const query = (jql: string | null) =>
    jql === null ? null : `#/search?${new URLSearchParams({ q: jql }).toString()}`;

  if (first === 'browse' && parts.length >= 2 && (parts.length === 2 || parts[2] === '')) {
    const key = parts[1] ?? '';
    if (ISSUE_KEY.test(key)) return `#/tickets/${key.toUpperCase()}`;
    if (TRACK_KEY.test(key)) return `#/tracks/${key.toUpperCase()}`;
    return null;
  }
  if (first === 'projects' && (parts[2] ?? '').toLowerCase() === 'issues') {
    const key = parts[3] ?? '';
    if (ISSUE_KEY.test(key)) return `#/tickets/${key.toUpperCase()}`;
    if (key === '' && TRACK_KEY.test(parts[1] ?? '')) {
      return `#/tracks/${(parts[1] as string).toUpperCase()}`;
    }
    return null;
  }
  if (first === 'issues' && parts.length <= 2 && (parts[1] ?? '') === '') {
    return byId('saved-search', params.get('filter')) ?? query(params.get('jql')) ?? '#/search';
  }
  if (first === 'secure' && parts.length === 2) {
    switch ((parts[1] ?? '').toLowerCase()) {
      case 'issuenavigator.jspa':
        return (
          byId('saved-search', params.get('requestId') ?? params.get('filter')) ??
          query(params.get('jqlQuery') ?? params.get('jql')) ??
          '#/search'
        );
      case 'rapidboard.jspa':
        return byId('board', params.get('rapidView')) ?? '#/boards';
      case 'dashboard.jspa':
        return byId('dashboard', params.get('selectPageId')) ?? '#/dashboards';
    }
  }
  return null;
}

/** The kind and source id of an `#/imported/<kind>/<id>` route, or null. */
export function importedLinkOf(route: string): { kind: ImportedLinkKind; id: string } | null {
  const m = /^#\/imported\/([a-z-]+)\/(\d{1,18})(?:[/?]|$)/.exec(route);
  if (!m || !(IMPORTED_LINK_KINDS as readonly string[]).includes(m[1] as string)) return null;
  return { kind: m[1] as ImportedLinkKind, id: m[2] as string };
}

/** The app's route for an imported object's target id. */
export function importedTargetRoute(kind: ImportedLinkKind, targetId: number): string {
  switch (kind) {
    case 'saved-search':
      return `#/search?savedSearch=${targetId}`;
    case 'board':
      return `#/boards/${targetId}`;
    case 'dashboard':
      return `#/dashboards/${targetId}`;
  }
}
