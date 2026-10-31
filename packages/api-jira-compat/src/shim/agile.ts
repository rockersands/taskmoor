import { error, instant, issue, nativeFormat, ok, project } from './map';
import { type ShimContext, ShimError, type ShimRoute } from './types';

/**
 * The Agile API of the Jira-compatible API (M1-070; API-006; ADR-086): boards with their
 * configuration, issues and backlog; sprints created, read, changed, started and completed;
 * issues moved into sprints and back to the backlog; rank. Every route calls the native board
 * and sprint API. Its issues have the version 2 shape.
 */
// biome-ignore lint/suspicious/noExplicitAny: native bodies are read field by field
type Any = any;
const AGILE = '/rest/agile/1.0';
const enc = encodeURIComponent;

const boardType = (kind: string) =>
  kind === 'scrum' ? 'scrum' : kind === 'kanban' ? 'kanban' : 'simple';

function board(b: Any, ctx: ShimContext, track?: Any) {
  return {
    id: Number(b.id),
    self: `${ctx.baseUrl}${AGILE}/board/${b.id}`,
    name: b.name,
    type: boardType(b.kind),
    ...(track
      ? {
          location: {
            projectId: Number(track.id),
            projectKey: track.key,
            projectName: track.name,
            projectTypeKey: project(track, ctx.baseUrl).projectTypeKey,
            displayName: `${track.name} (${track.key})`,
          },
        }
      : {}),
  };
}

const STATES: Record<string, string> = { future: 'future', active: 'active', closed: 'closed' };

function sprint(s: Any, ctx: ShimContext) {
  return {
    id: Number(s.id),
    self: `${ctx.baseUrl}${AGILE}/sprint/${s.id}`,
    state: STATES[s.state] ?? 'future',
    name: s.name,
    ...(s.startAt ? { startDate: instant(s.startAt) } : {}),
    ...(s.endAt ? { endDate: instant(s.endAt) } : {}),
    ...(s.startedAt ? { activatedDate: instant(s.startedAt) } : {}),
    ...(s.completedAt ? { completeDate: instant(s.completedAt) } : {}),
    originBoardId: Number(s.boardId),
    goal: s.goal ?? '',
  };
}

const page = (ctx: ShimContext, max = 50) => ({
  startAt: Math.max(0, Number(ctx.query.startAt ?? 0) || 0),
  maxResults: Math.min(1000, Math.max(1, Number(ctx.query.maxResults ?? max) || max)),
});

/** The issues a query finds, by offset, as the Agile API answers them. */
async function issuesBy(ctx: ShimContext, query: string, keys?: readonly string[]) {
  const { startAt, maxResults } = page(ctx);
  const jql = ctx.query.jql ? `(${query}) AND (${ctx.query.jql})` : query;
  const found: Any[] = [];
  let cursor: string | undefined;
  let total = 0;
  for (let first = true; ; first = false) {
    const params = new URLSearchParams({ q: jql, limit: '200' });
    if (cursor) params.set('cursor', cursor);
    if (first) params.set('count', 'true');
    const res = ok(await ctx.native('GET', `/api/v1/search?${params}`));
    if (first) total = Number(res.total?.count ?? 0);
    found.push(...(res.tickets as Any[]));
    cursor = res.next ?? undefined;
    if (!cursor || found.length >= startAt + maxResults) break;
  }
  const ordered = keys
    ? keys.map((k) => found.find((t) => t.key === k)).filter((t) => t !== undefined)
    : found;
  return {
    expand: 'schema,names',
    startAt,
    maxResults,
    total: keys ? ordered.length : Math.max(total, found.length),
    issues: ordered
      .slice(startAt, startAt + maxResults)
      .map((t) => issue(t, '2', ctx.baseUrl, undefined, ctx.richText)),
  };
}

async function loadBoard(ctx: ShimContext) {
  return ok(await ctx.native('GET', `/api/v1/boards/${enc(ctx.params.boardId ?? '')}`), 'The board')
    .board as Any;
}

/** A board's own query: its saved search or its query. */
function boardQuery(b: Any): string {
  const source = b.source ?? {};
  if (source.savedSearchId) return `savedSearch = ${source.savedSearchId}`;
  return String(source.query ?? '');
}

const loadSprint = async (ctx: ShimContext) =>
  ok(await ctx.native('GET', `/api/v1/sprints/${enc(ctx.params.sprintId ?? '')}`), 'The sprint')
    .sprint as Any;

export const AGILE_ROUTES: readonly ShimRoute[] = [
  {
    method: 'GET',
    path: `${AGILE}/board`,
    handle: async (ctx) => {
      const params = new URLSearchParams();
      if (ctx.query.projectKeyOrId) {
        const t = ok(
          await ctx.native('GET', `/api/v1/tracks/${enc(ctx.query.projectKeyOrId)}`),
          'The project',
        ).track;
        params.set('trackId', String(t.id));
      }
      const list = ok(await ctx.native('GET', `/api/v1/boards${params.size ? `?${params}` : ''}`))
        .boards as Any[];
      const wanted = ctx.query.type;
      const name = (ctx.query.name ?? '').toLowerCase();
      const found = list.filter(
        (b) =>
          (!wanted || boardType(b.kind) === wanted) &&
          (!name || String(b.name).toLowerCase().includes(name)),
      );
      const { startAt, maxResults } = page(ctx);
      return {
        status: 200,
        body: {
          maxResults,
          startAt,
          total: found.length,
          isLast: startAt + maxResults >= found.length,
          values: found.slice(startAt, startAt + maxResults).map((b) => board(b, ctx)),
        },
      };
    },
  },
  {
    method: 'GET',
    path: `${AGILE}/board/:boardId`,
    handle: async (ctx) => {
      const b = await loadBoard(ctx);
      const trackId =
        b.location?.track?.id ?? b.location?.trackId ?? b.trackId ?? b.locationTrackId;
      const track = trackId
        ? (await ctx.native('GET', `/api/v1/tracks/${trackId}`)).body?.track
        : undefined;
      return { status: 200, body: board(b, ctx, track) };
    },
  },
  {
    method: 'GET',
    path: `${AGILE}/board/:boardId/configuration`,
    handle: async (ctx) => {
      const b = await loadBoard(ctx);
      return {
        status: 200,
        body: {
          id: Number(b.id),
          name: b.name,
          type: boardType(b.kind),
          self: `${ctx.baseUrl}${AGILE}/board/${b.id}/configuration`,
          filter: {
            id: String(b.source?.savedSearchId ?? 0),
            self: `${ctx.baseUrl}/rest/api/2/filter/${b.source?.savedSearchId ?? 0}`,
          },
          columnConfig: {
            columns: ((b.columns ?? []) as Any[]).map((c) => ({
              name: c.name,
              statuses: ((c.statusIds ?? []) as Any[]).map((id) => ({
                id: String(id),
                self: `${ctx.baseUrl}/rest/api/2/status/${id}`,
              })),
              ...(c.min !== null && c.min !== undefined ? { min: c.min } : {}),
              ...(c.max !== null && c.max !== undefined ? { max: c.max } : {}),
            })),
            constraintType: 'issueCount',
          },
          ranking: { rankCustomFieldId: 0 },
        },
      };
    },
  },
  {
    method: 'GET',
    path: `${AGILE}/board/:boardId/issue`,
    handle: async (ctx) => {
      const b = await loadBoard(ctx);
      return { status: 200, body: await issuesBy(ctx, boardQuery(b)) };
    },
  },
  {
    method: 'GET',
    path: `${AGILE}/board/:boardId/backlog`,
    handle: async (ctx) => {
      const backlog = ok(
        await ctx.native('GET', `/api/v1/boards/${enc(ctx.params.boardId ?? '')}/backlog`),
        'The board',
      );
      const keys = ((backlog.backlog?.tickets ?? []) as Any[]).map((t) => String(t.key));
      if (keys.length === 0) {
        const { startAt, maxResults } = page(ctx);
        return { status: 200, body: { startAt, maxResults, total: 0, issues: [] } };
      }
      return { status: 200, body: await issuesBy(ctx, `key in (${keys.join(', ')})`, keys) };
    },
  },
  {
    method: 'GET',
    path: `${AGILE}/board/:boardId/sprint`,
    handle: async (ctx) => {
      const list = ok(
        await ctx.native('GET', `/api/v1/boards/${enc(ctx.params.boardId ?? '')}/sprints`),
        'The board',
      ).sprints as Any[];
      const states = (ctx.query.state ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const found = list.filter(
        (s) => states.length === 0 || states.includes(STATES[s.state] ?? ''),
      );
      const { startAt, maxResults } = page(ctx);
      return {
        status: 200,
        body: {
          maxResults,
          startAt,
          isLast: startAt + maxResults >= found.length,
          values: found.slice(startAt, startAt + maxResults).map((s) => sprint(s, ctx)),
        },
      };
    },
  },
  {
    method: 'POST',
    path: `${AGILE}/sprint`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      if (!body.originBoardId) {
        throw new ShimError(error(400, [], { originBoardId: 'Name the board of the sprint.' }));
      }
      const made = ok(
        await ctx.native('POST', `/api/v1/boards/${Number(body.originBoardId)}/sprints`, {
          ...(body.name ? { name: body.name } : {}),
          ...(body.goal ? { goal: body.goal } : {}),
          ...(body.startDate ? { startAt: new Date(body.startDate).toISOString() } : {}),
          ...(body.endDate ? { endAt: new Date(body.endDate).toISOString() } : {}),
        }),
        'The board',
      ).sprint;
      return { status: 201, body: sprint(made, ctx) };
    },
  },
  {
    method: 'GET',
    path: `${AGILE}/sprint/:sprintId`,
    handle: async (ctx) => ({ status: 200, body: sprint(await loadSprint(ctx), ctx) }),
  },
  {
    method: 'POST',
    path: `${AGILE}/sprint/:sprintId`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const current = await loadSprint(ctx);
      const path = `/api/v1/sprints/${current.id}`;
      const dates = {
        ...(body.startDate ? { startAt: new Date(body.startDate).toISOString() } : {}),
        ...(body.endDate ? { endAt: new Date(body.endDate).toISOString() } : {}),
      };
      const named = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.goal !== undefined ? { goal: body.goal } : {}),
      };
      if (body.state === 'active' && current.state === 'future') {
        ok(await ctx.native('POST', `${path}/start`, { ...named, ...dates }), 'The sprint');
      } else if (body.state === 'closed' && current.state === 'active') {
        ok(
          await ctx.native('POST', `${path}/complete`, { moveTo: { type: 'backlog' } }),
          'The sprint',
        );
      } else if (body.state !== undefined && body.state !== current.state) {
        throw new ShimError(error(400, [`A ${current.state} sprint cannot become ${body.state}.`]));
      } else if (Object.keys({ ...named, ...dates }).length > 0) {
        ok(
          await ctx.native('PATCH', path, { ...named, ...dates, version: current.version }),
          'The sprint',
        );
      }
      return { status: 200, body: sprint(await loadSprint(ctx), ctx) };
    },
  },
  {
    method: 'POST',
    path: `${AGILE}/sprint/:sprintId/issue`,
    handle: async (ctx) => {
      const issues = ((ctx.body as Any)?.issues ?? []) as string[];
      ok(
        await ctx.native('POST', `/api/v1/sprints/${enc(ctx.params.sprintId ?? '')}/tickets`, {
          tickets: issues,
        }),
        'The sprint',
      );
      return { status: 204 };
    },
  },
  {
    method: 'GET',
    path: `${AGILE}/sprint/:sprintId/issue`,
    handle: async (ctx) => {
      const s = await loadSprint(ctx);
      return { status: 200, body: await issuesBy(ctx, `sprint = ${Number(s.id)}`) };
    },
  },
  {
    method: 'POST',
    path: `${AGILE}/backlog/issue`,
    handle: async (ctx) => {
      const issues = ((ctx.body as Any)?.issues ?? []) as string[];
      if (issues.length === 0) throw new ShimError(error(400, ['Name the issues to move.']));
      // Each issue leaves the open sprint it is in, on whichever board the caller sees.
      const boards = ok(await ctx.native('GET', '/api/v1/boards')).boards as Any[];
      const wanted = new Set(issues.map(String));
      for (const b of boards.filter((x) => x.kind === 'scrum')) {
        const sprints = ok(await ctx.native('GET', `/api/v1/boards/${b.id}/sprints`))
          .sprints as Any[];
        for (const s of sprints.filter((x) => x.state !== 'closed')) {
          if (wanted.size === 0) break;
          const params = new URLSearchParams({
            q: `sprint = ${s.id} AND key in (${[...wanted].join(', ')})`,
            limit: '200',
          });
          const found = ok(await ctx.native('GET', `/api/v1/search?${params}`)).tickets as Any[];
          if (found.length === 0) continue;
          const keys = found.map((t) => String(t.key));
          ok(
            await ctx.native('POST', `/api/v1/sprints/${s.id}/tickets/remove`, { tickets: keys }),
            'The sprint',
          );
          for (const t of found) {
            wanted.delete(String(t.key));
            wanted.delete(String(t.id));
          }
        }
      }
      return { status: 204 };
    },
  },
  {
    method: 'PUT',
    path: `${AGILE}/issue/rank`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const issues = (body.issues ?? []) as string[];
      const before = body.rankBeforeIssue as string | undefined;
      const after = body.rankAfterIssue as string | undefined;
      if (issues.length === 0 || (before === undefined) === (after === undefined)) {
        throw new ShimError(
          error(400, ['Name the issues, and one issue to rank before or after.']),
        );
      }
      // In the order given: the first next to the target, each next one after the last.
      let anchor: { before?: string; after?: string } = before
        ? { before }
        : { after: after as string };
      for (const key of issues) {
        ok(await ctx.native('PUT', `/api/v1/tickets/${enc(key)}/rank`, anchor), 'The issue');
        anchor = { after: key };
      }
      return { status: 204 };
    },
  },
  {
    method: 'GET',
    path: `${AGILE}/issue/:issueIdOrKey`,
    handle: async (ctx) => {
      const t = ok(
        await ctx.native(
          'GET',
          `/api/v1/tickets/${enc(ctx.params.issueIdOrKey ?? '')}?format=${nativeFormat('2')}`,
        ),
        'The issue',
      ).ticket;
      if (t.trash)
        throw new ShimError(error(404, ['The issue does not exist, or you may not see it.']));
      return { status: 200, body: issue(t, '2', ctx.baseUrl) };
    },
  },
];
