import { error, fieldList, issue, issueType, ok, project, status, user } from './map';
import { type ShimContext, ShimError, type ShimRoute } from './types';

/**
 * Search, configuration, people, projects, filters, dashboards, bulk tasks and webhooks of the
 * Jira-compatible API (M1-069; API-003, API-005, API-007, API-009; ADR-086), each as calls to
 * the native API.
 */
// biome-ignore lint/suspicious/noExplicitAny: request and native bodies are read field by field
type Any = any;
const API = '/rest/api/:v';
const enc = encodeURIComponent;

/** One native search page; the query reads Jira-compatible names as they are (QRY-003). */
async function searchPage(
  ctx: ShimContext,
  jql: string,
  limit: number,
  cursor?: string,
  count = false,
) {
  const params = new URLSearchParams({ q: jql, limit: String(Math.min(200, Math.max(1, limit))) });
  if (cursor) params.set('cursor', cursor);
  if (count) params.set('count', 'true');
  const res = await ctx.native('GET', `/api/v1/search?${params}`);
  if (res.status === 400) {
    throw new ShimError(
      error(400, [String(res.body?.message ?? res.body?.error ?? 'The query is not valid.')]),
    );
  }
  return ok(res);
}

/** Tracks read in full at most, a backstop against a list that never ends. */
const MOST_TRACKS = 20_000;

/**
 * Every track the caller may browse, a page of 500 at a time: the native list pages by `after`
 * (the last key of the page before, T-305), so reading its first page alone left out every
 * track past it. `q` narrows the list on the server, by key or name. Stops at a repeated `after`.
 */
async function everyTrack(ctx: ShimContext, q?: string): Promise<Any[]> {
  const all: Any[] = [];
  let after: string | null = null;
  do {
    const params = new URLSearchParams({ limit: '500' });
    if (q) params.set('q', q);
    if (after !== null) params.set('after', after);
    const page = ok(await ctx.native('GET', `/api/v1/tracks?${params}`));
    all.push(...((page.tracks ?? []) as Any[]));
    const next: string | null = page.next ?? null;
    after = next !== null && next !== after ? next : null;
  } while (after !== null && all.length < MOST_TRACKS);
  return all;
}

async function tokenSearch(ctx: ShimContext, input: Any) {
  const jql = String(input.jql ?? '');
  const max = Math.min(5000, Math.max(1, Number(input.maxResults ?? 50) || 50));
  const page = await searchPage(
    ctx,
    jql,
    max,
    input.nextPageToken ? String(input.nextPageToken) : undefined,
  );
  const only = fieldList(input.fields);
  return {
    status: 200,
    body: {
      issues: (page.tickets as Any[]).map((t) =>
        issue(t, ctx.version, ctx.baseUrl, only, ctx.richText),
      ),
      isLast: !page.next,
      ...(page.next ? { nextPageToken: page.next } : {}),
    },
  };
}

/** The older offset search: pages through native cursors to the offset, with the total. */
async function offsetSearch(ctx: ShimContext, input: Any) {
  const jql = String(input.jql ?? '');
  const startAt = Math.max(0, Number(input.startAt ?? 0) || 0);
  const maxResults = Math.min(1000, Math.max(0, Number(input.maxResults ?? 50) || 50));
  const only = fieldList(input.fields);
  const tickets: Any[] = [];
  let cursor: string | undefined;
  let total = 0;
  let seen = 0;
  for (let first = true; ; first = false) {
    const page = await searchPage(ctx, jql, 200, cursor, first);
    if (first) total = Number(page.total?.count ?? 0);
    for (const t of page.tickets as Any[]) {
      if (seen >= startAt && tickets.length < maxResults) tickets.push(t);
      seen += 1;
    }
    cursor = page.next ?? undefined;
    if (!cursor || tickets.length >= maxResults) break;
  }
  return {
    status: 200,
    body: {
      expand: 'schema,names',
      startAt,
      maxResults,
      total: Math.max(total, seen),
      issues: tickets.map((t) => issue(t, ctx.version, ctx.baseUrl, only, ctx.richText)),
    },
  };
}

/** Built-in fields as the compatible API names them, with their native counterparts. */
const SYSTEM_FIELDS: readonly [string, string, string][] = [
  ['summary', 'Summary', 'string'],
  ['description', 'Description', 'string'],
  ['environment', 'Environment', 'string'],
  ['status', 'Status', 'status'],
  ['issuetype', 'Issue Type', 'issuetype'],
  ['project', 'Project', 'project'],
  ['assignee', 'Assignee', 'user'],
  ['reporter', 'Reporter', 'user'],
  ['creator', 'Creator', 'user'],
  ['priority', 'Priority', 'priority'],
  ['resolution', 'Resolution', 'resolution'],
  ['resolutiondate', 'Resolved', 'datetime'],
  ['labels', 'Labels', 'array'],
  ['components', 'Components', 'array'],
  ['fixVersions', 'Fix versions', 'array'],
  ['versions', 'Affects versions', 'array'],
  ['duedate', 'Due date', 'date'],
  ['created', 'Created', 'datetime'],
  ['updated', 'Updated', 'datetime'],
  ['parent', 'Parent', 'issuelink'],
  ['timetracking', 'Time tracking', 'timetracking'],
  ['comment', 'Comment', 'comments-page'],
  ['worklog', 'Log Work', 'array'],
  ['watches', 'Watchers', 'watches'],
  ['votes', 'Votes', 'votes'],
];

/** Jira-compatible permission keys and the Taskmoor permissions they mean. */
const PERMISSIONS: Record<string, string> = {
  BROWSE_PROJECTS: 'browse_track',
  CREATE_ISSUES: 'create_tickets',
  EDIT_ISSUES: 'edit_tickets',
  DELETE_ISSUES: 'delete_tickets',
  ASSIGN_ISSUES: 'assign_tickets',
  ASSIGNABLE_USER: 'assignable',
  TRANSITION_ISSUES: 'transition_tickets',
  CLOSE_ISSUES: 'close_tickets',
  ADD_COMMENTS: 'add_comments',
  WORK_ON_ISSUES: 'log_work',
  ADMINISTER_PROJECTS: 'administer_track',
  LINK_ISSUES: 'link_tickets',
  MANAGE_WATCHERS: 'manage_followers',
  SCHEDULE_ISSUES: 'schedule_tickets',
  MOVE_ISSUES: 'move_tickets',
  CREATE_ATTACHMENTS: 'add_attachments',
  MANAGE_SPRINTS_PERMISSION: 'manage_sprints',
};

const WEBHOOK_EVENTS: Record<string, string> = {
  'jira:issue_created': 'ticket.created',
  'jira:issue_updated': 'ticket.updated',
  'jira:issue_deleted': 'ticket.deleted',
  comment_created: 'comment.created',
  comment_updated: 'comment.updated',
  comment_deleted: 'comment.deleted',
  worklog_created: 'time_entry.created',
  worklog_updated: 'time_entry.updated',
  worklog_deleted: 'time_entry.deleted',
  issuelink_created: 'ticket.linked',
  issuelink_deleted: 'ticket.unlinked',
  project_created: 'track.created',
  project_updated: 'track.updated',
  project_deleted: 'track.deleted',
  jira_version_created: 'release.created',
  jira_version_updated: 'release.updated',
  jira_version_released: 'release.shipped',
  jira_version_deleted: 'release.deleted',
  sprint_created: 'sprint.created',
  sprint_started: 'sprint.started',
  sprint_closed: 'sprint.completed',
  board_created: 'board.created',
  issue_property_set: 'ticket.property_set',
  issue_property_deleted: 'ticket.property_deleted',
};
const NATIVE_EVENTS = Object.fromEntries(Object.entries(WEBHOOK_EVENTS).map(([k, v]) => [v, k]));

function filter(s: Any, ctx: ShimContext) {
  return {
    self: `${ctx.baseUrl}/rest/api/${ctx.version}/filter/${s.id}`,
    id: String(s.id),
    name: s.name,
    description: s.description ?? '',
    jql: s.query ?? s.jql ?? '',
    owner: user(s.owner, ctx.baseUrl),
    favourite: Boolean(s.starred),
    viewUrl: `${ctx.baseUrl}/#/search?savedSearch=${s.id}`,
  };
}

function version(r: Any, ctx: ShimContext) {
  return {
    self: `${ctx.baseUrl}/rest/api/${ctx.version}/version/${r.id}`,
    id: String(r.id),
    name: r.name,
    description: r.description ?? undefined,
    archived: Boolean(r.archivedAt ?? r.archived),
    released: Boolean(r.shippedAt ?? r.shipped),
    ...(r.releaseDate ? { releaseDate: r.releaseDate } : {}),
    ...(r.startDate ? { startDate: r.startDate } : {}),
    projectId: Number(r.trackId ?? r.track?.id ?? 0),
  };
}

const TASK_STATES: Record<string, string> = {
  queued: 'ENQUEUED',
  running: 'RUNNING',
  done: 'COMPLETE',
  completed: 'COMPLETE',
  failed: 'FAILED',
  cancelling: 'CANCEL_REQUESTED',
  cancelled: 'CANCELLED',
};

async function startBulk(ctx: ShimContext, body: Record<string, unknown>) {
  const made = ok(await ctx.native('POST', '/api/v1/bulk-operations', body)).bulkOperation;
  return { status: 201, body: { taskId: String(made.id) } };
}

export const PLATFORM_ROUTES: readonly ShimRoute[] = [
  // Search.
  { method: 'POST', path: `${API}/search/jql`, handle: (ctx) => tokenSearch(ctx, ctx.body ?? {}) },
  { method: 'GET', path: `${API}/search/jql`, handle: (ctx) => tokenSearch(ctx, ctx.query) },
  { method: 'GET', path: `${API}/search`, handle: (ctx) => offsetSearch(ctx, ctx.query) },
  { method: 'POST', path: `${API}/search`, handle: (ctx) => offsetSearch(ctx, ctx.body ?? {}) },

  // Bulk tasks.
  {
    method: 'POST',
    path: `${API}/bulk/issues/transition`,
    handle: async (ctx) => {
      const inputs = ((ctx.body as Any)?.bulkTransitionInputs ?? []) as Any[];
      const first = inputs[0];
      if (!first) throw new ShimError(error(400, ['Name the issues and a transition.']));
      return startBulk(ctx, {
        action: 'transition',
        tickets: inputs.flatMap((i) => i.selectedIssueIdsOrKeys ?? []),
        transition: { transitionId: Number(first.transitionId) },
      });
    },
  },
  {
    method: 'POST',
    path: `${API}/bulk/issues/fields`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const labels = (body.editedFieldsInput?.labelsFields ?? []) as Any[];
      if (labels.length === 0) {
        throw new ShimError(error(400, ['Only labels can be changed in bulk here.']));
      }
      // Native bulk edits set values; adding or removing per issue is not offered yet.
      if (labels.some((l) => (l.bulkEditMultiSelectFieldOption ?? 'REPLACE') !== 'REPLACE')) {
        throw new ShimError(
          error(400, [
            'Bulk label changes support REPLACE only; ADD and REMOVE are not available yet.',
          ]),
        );
      }
      return startBulk(ctx, {
        action: 'edit',
        tickets: body.selectedIssueIdsOrKeys ?? [],
        edit: { labels: labels.flatMap((l) => (l.labels ?? []).map((x: Any) => String(x.name))) },
      });
    },
  },
  {
    method: 'POST',
    path: `${API}/bulk/issues/delete`,
    handle: async (ctx) =>
      startBulk(ctx, {
        action: 'delete',
        tickets: (ctx.body as Any)?.selectedIssueIdsOrKeys ?? [],
      }),
  },
  {
    method: 'GET',
    path: `${API}/bulk/queue/:taskId`,
    handle: async (ctx) => {
      const op = ok(
        await ctx.native('GET', `/api/v1/bulk-operations/${enc(ctx.params.taskId ?? '')}`),
        'The task',
      ).bulkOperation;
      const total = Number(op.total ?? 0);
      const finished = Number(op.succeeded ?? 0) + Number(op.failed ?? 0) + Number(op.skipped ?? 0);
      return {
        status: 200,
        body: {
          taskId: String(op.id),
          status:
            op.cancelRequested && op.status !== 'cancelled'
              ? 'CANCEL_REQUESTED'
              : (TASK_STATES[op.status] ?? 'RUNNING'),
          progressPercent: total > 0 ? Math.round((finished / total) * 100) : 0,
          submittedBy: op.userId ?? undefined,
          created: op.createdAt,
        },
      };
    },
  },

  // Projects.
  {
    method: 'GET',
    path: `${API}/project`,
    handle: async (ctx) => {
      const list = await everyTrack(ctx);
      return { status: 200, body: list.map((t) => project(t, ctx.baseUrl)) };
    },
  },
  {
    method: 'GET',
    path: `${API}/project/search`,
    handle: async (ctx) => {
      const startAt = Math.max(0, Number(ctx.query.startAt ?? 0) || 0);
      const maxResults = Math.min(100, Math.max(1, Number(ctx.query.maxResults ?? 50) || 50));
      // The server matches the query against key and name, ignoring case; no key or name is
      // longer than 255 characters, so a longer query finds nothing.
      const q = (ctx.query.query ?? '').trim();
      const found = q.length > 255 ? [] : await everyTrack(ctx, q || undefined);
      const values = found.slice(startAt, startAt + maxResults).map((t) => project(t, ctx.baseUrl));
      return {
        status: 200,
        body: {
          startAt,
          maxResults,
          total: found.length,
          isLast: startAt + maxResults >= found.length,
          values,
        },
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/project/:projectIdOrKey`,
    handle: async (ctx) => {
      const t = ok(
        await ctx.native('GET', `/api/v1/tracks/${enc(ctx.params.projectIdOrKey ?? '')}`),
        'The project',
      ).track;
      const types = await ctx.native('GET', `/api/v1/tracks/${t.id}/ticket-types`);
      return {
        status: 200,
        body: {
          ...project(t, ctx.baseUrl),
          description: t.description ?? '',
          lead: user(t.lead, ctx.baseUrl),
          issueTypes: ((types.body?.ticketTypes ?? []) as Any[]).map((x) =>
            issueType(x, ctx.baseUrl),
          ),
        },
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/project/:projectIdOrKey/components`,
    handle: async (ctx) => {
      const t = ok(
        await ctx.native('GET', `/api/v1/tracks/${enc(ctx.params.projectIdOrKey ?? '')}`),
        'The project',
      ).track;
      const areas = ok(await ctx.native('GET', `/api/v1/tracks/${t.id}/areas`)).areas as Any[];
      return {
        status: 200,
        body: areas.map((a) => ({
          self: `${ctx.baseUrl}/rest/api/${ctx.version}/component/${a.id}`,
          id: String(a.id),
          name: a.name,
          description: a.description ?? undefined,
          project: t.key,
          projectId: Number(t.id),
        })),
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/project/:projectIdOrKey/versions`,
    handle: async (ctx) => {
      const t = ok(
        await ctx.native('GET', `/api/v1/tracks/${enc(ctx.params.projectIdOrKey ?? '')}`),
        'The project',
      ).track;
      const list = ok(await ctx.native('GET', `/api/v1/tracks/${t.id}/releases?archived=include`))
        .releases as Any[];
      return { status: 200, body: list.map((r) => version({ trackId: t.id, ...r }, ctx)) };
    },
  },
  {
    method: 'POST',
    path: `${API}/version`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const trackRef = body.projectId ?? body.project;
      if (trackRef === undefined)
        throw new ShimError(error(400, [], { project: 'Specify a project.' }));
      const made = ok(
        await ctx.native('POST', `/api/v1/tracks/${enc(String(trackRef))}/releases`, {
          name: body.name,
          ...(body.description ? { description: body.description } : {}),
          ...(body.releaseDate ? { releaseDate: body.releaseDate } : {}),
          ...(body.startDate ? { startDate: body.startDate } : {}),
        }),
        'The project',
      ).release;
      return { status: 201, body: version({ trackId: trackRef, ...made }, ctx) };
    },
  },
  {
    method: 'GET',
    path: `${API}/project/:projectIdOrKey/role`,
    handle: async (ctx) => {
      const t = ok(
        await ctx.native('GET', `/api/v1/tracks/${enc(ctx.params.projectIdOrKey ?? '')}`),
        'The project',
      ).track;
      const roles = await ctx.native('GET', '/api/v1/roles');
      const list = ((roles.status === 200 ? roles.body.roles : null) ?? [
        { id: 1, name: 'Administrators' },
        { id: 2, name: 'Members' },
        { id: 3, name: 'Viewers' },
      ]) as Any[];
      return {
        status: 200,
        body: Object.fromEntries(
          list.map((r) => [
            r.name,
            `${ctx.baseUrl}/rest/api/${ctx.version}/project/${t.id}/role/${r.id}`,
          ]),
        ),
      };
    },
  },

  // Configuration.
  {
    method: 'GET',
    path: `${API}/field`,
    handle: async (ctx) => {
      const custom = ok(await ctx.native('GET', '/api/v1/fields')).fields as Any[];
      return {
        status: 200,
        body: [
          ...SYSTEM_FIELDS.map(([id, name, type]) => ({
            id,
            key: id,
            name,
            custom: false,
            orderable: true,
            navigable: true,
            searchable: true,
            clauseNames: [id],
            schema: { type, system: id },
          })),
          ...custom.map((f) => ({
            id: `customfield_${f.id}`,
            key: `customfield_${f.id}`,
            name: f.name,
            custom: true,
            orderable: true,
            navigable: true,
            searchable: true,
            clauseNames: [`cf[${f.id}]`, f.name],
            // A field of several values is an array of its type, as the compatible API says.
            schema: {
              type: f.multiple ? 'array' : f.type,
              ...(f.multiple ? { items: f.type } : {}),
              custom: `taskmoor:${f.type}`,
              customId: Number(f.id),
            },
          })),
        ],
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/issuetype`,
    handle: async (ctx) => {
      const list = ok(await ctx.native('GET', '/api/v1/ticket-types')).ticketTypes as Any[];
      return { status: 200, body: list.map((t) => issueType(t, ctx.baseUrl)) };
    },
  },
  {
    method: 'GET',
    path: `${API}/priority`,
    handle: async (ctx) => {
      const list = ok(await ctx.native('GET', '/api/v1/priorities')).priorities as Any[];
      return {
        status: 200,
        body: list.map((p) => ({
          self: `${ctx.baseUrl}/rest/api/${ctx.version}/priority/${p.id}`,
          id: String(p.id),
          name: p.name,
          ...(p.color ? { statusColor: p.color } : {}),
        })),
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/resolution`,
    handle: async (ctx) => {
      const list = ok(await ctx.native('GET', '/api/v1/close-reasons')).closeReasons as Any[];
      return {
        status: 200,
        body: list.map((r) => ({
          self: `${ctx.baseUrl}/rest/api/${ctx.version}/resolution/${r.id}`,
          id: String(r.id),
          name: r.name,
          description: r.description ?? '',
        })),
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/status`,
    handle: async (ctx) => {
      const list = ok(await ctx.native('GET', '/api/v1/statuses')).statuses as Any[];
      return { status: 200, body: list.map((s) => status(s, ctx.baseUrl)) };
    },
  },
  {
    method: 'GET',
    path: `${API}/issueLinkType`,
    handle: async (ctx) => {
      const list = ok(await ctx.native('GET', '/api/v1/link-types')).linkTypes as Any[];
      return {
        status: 200,
        body: {
          issueLinkTypes: list.map((t) => ({
            self: `${ctx.baseUrl}/rest/api/${ctx.version}/issueLinkType/${t.id}`,
            id: String(t.id),
            name: t.name,
            inward: t.inward,
            outward: t.outward,
          })),
        },
      };
    },
  },

  // Filters and dashboards.
  {
    method: 'POST',
    path: `${API}/filter`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const made = ok(
        await ctx.native('POST', '/api/v1/saved-searches', {
          name: body.name,
          query: body.jql ?? '',
          ...(body.description ? { description: body.description } : {}),
        }),
      ).savedSearch;
      if (body.favourite) await ctx.native('PUT', `/api/v1/saved-searches/${made.id}/star`);
      return { status: 200, body: filter(made, ctx) };
    },
  },
  {
    method: 'GET',
    path: `${API}/filter/favourite`,
    handle: async (ctx) => {
      const list = ok(await ctx.native('GET', '/api/v1/saved-searches?filter=starred'))
        .savedSearches as Any[];
      return {
        status: 200,
        body: list.filter((s) => s.starred !== false).map((s) => filter(s, ctx)),
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/filter/:id`,
    handle: async (ctx) => {
      const s = ok(
        await ctx.native('GET', `/api/v1/saved-searches/${enc(ctx.params.id ?? '')}`),
        'The filter',
      ).savedSearch;
      return { status: 200, body: filter(s, ctx) };
    },
  },
  {
    method: 'GET',
    path: `${API}/dashboard`,
    handle: async (ctx) => {
      const list = ok(await ctx.native('GET', '/api/v1/dashboards')).dashboards as Any[];
      const startAt = Math.max(0, Number(ctx.query.startAt ?? 0) || 0);
      const maxResults = Math.min(1000, Math.max(1, Number(ctx.query.maxResults ?? 20) || 20));
      return {
        status: 200,
        body: {
          startAt,
          maxResults,
          total: list.length,
          dashboards: list.slice(startAt, startAt + maxResults).map((d) => ({
            id: String(d.id),
            name: d.name,
            self: `${ctx.baseUrl}/rest/api/${ctx.version}/dashboard/${d.id}`,
            view: `${ctx.baseUrl}/#/dashboards/${d.id}`,
          })),
        },
      };
    },
  },

  // People and permissions.
  {
    method: 'GET',
    path: `${API}/myself`,
    handle: async (ctx) => {
      const me = ok(await ctx.native('GET', '/api/v1/session')).user;
      return {
        status: 200,
        body: {
          ...user(me, ctx.baseUrl),
          emailAddress: me.email ?? undefined,
          timeZone: me.timeZone ?? 'UTC',
          locale: me.locale ?? 'en_US',
        },
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/user/search`,
    handle: async (ctx) => {
      const q = ctx.query.query ?? ctx.query.username ?? '';
      const limit = Math.min(50, Math.max(1, Number(ctx.query.maxResults ?? 50) || 50));
      // Administrators search everyone; others, the people of a track they work in.
      const all = await ctx.native('GET', `/api/v1/users?query=${enc(q)}&limit=${limit}`);
      if (all.status === 200) {
        return { status: 200, body: (all.body.users as Any[]).map((p) => user(p, ctx.baseUrl)) };
      }
      const tracks = ok(await ctx.native('GET', '/api/v1/tracks?limit=1')).tracks as Any[];
      const track = ctx.query.projectKey ?? tracks[0]?.key;
      if (!track) return { status: 200, body: [] };
      const found = ok(
        await ctx.native(
          'GET',
          `/api/v1/people/mentionable?track=${enc(track)}&q=${enc(q)}&limit=${limit}`,
        ),
      );
      return {
        status: 200,
        body: ((found.people ?? found.users ?? []) as Any[]).map((p) => user(p, ctx.baseUrl)),
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/user`,
    handle: async (ctx) => {
      const id = ctx.query.accountId ?? '';
      if (!/^\d{1,10}$/.test(id)) throw new ShimError(error(404, ['The user does not exist.']));
      const me = ok(await ctx.native('GET', '/api/v1/session')).user;
      if (String(me.id) === id) return { status: 200, body: user(me, ctx.baseUrl) };
      const res = await ctx.native('GET', `/api/v1/users/${id}`);
      if (res.status === 200) return { status: 200, body: user(res.body.user, ctx.baseUrl) };
      throw new ShimError(error(404, ['The user does not exist, or you may not see them.']));
    },
  },
  {
    method: 'GET',
    path: `${API}/groups/picker`,
    handle: async (ctx) => {
      const res = await ctx.native('GET', '/api/v1/groups');
      const q = (ctx.query.query ?? '').toLowerCase();
      const groups = ((res.status === 200 ? res.body.groups : []) as Any[]).filter(
        (g) => !q || String(g.name).toLowerCase().includes(q),
      );
      return {
        status: 200,
        body: {
          header: `Showing ${groups.length} of ${groups.length} matching groups`,
          total: groups.length,
          groups: groups.map((g) => ({
            name: g.name,
            html: g.name,
            groupId: String(g.id),
            labels: [],
          })),
        },
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/mypermissions`,
    handle: async (ctx) => {
      const keys = (ctx.query.permissions ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
      if (keys.length === 0) throw new ShimError(error(400, ['Name the permissions to check.']));
      const trackRef = ctx.query.projectKey ?? ctx.query.projectId;
      let trackId: string | undefined;
      if (trackRef) {
        trackId = String(
          ok(await ctx.native('GET', `/api/v1/tracks/${enc(trackRef)}`), 'The project').track.id,
        );
      }
      const held = ok(
        await ctx.native('GET', `/api/v1/me/permissions${trackId ? `?trackId=${trackId}` : ''}`),
      );
      const all = new Set<string>([...(held.global ?? []), ...(held.track ?? [])]);
      return {
        status: 200,
        body: {
          permissions: Object.fromEntries(
            keys.map((k) => [
              k,
              {
                id: k,
                key: k,
                name: k,
                type: trackId ? 'PROJECT' : 'GLOBAL',
                havePermission: PERMISSIONS[k] ? all.has(PERMISSIONS[k] as string) : false,
              },
            ]),
          ),
        },
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/serverInfo`,
    handle: async (ctx) => {
      const meta = ok(await ctx.native('GET', '/api/meta'));
      return {
        status: 200,
        body: {
          baseUrl: ctx.baseUrl,
          version: String(meta.backend?.version ?? meta.version ?? '1.0.0'),
          versionNumbers: [1, 0, 0],
          deploymentType: 'Server',
          buildNumber: 1,
          serverTitle: String(meta.instance?.name ?? 'Taskmoor'),
        },
      };
    },
  },

  // Webhooks.
  {
    method: 'POST',
    path: '/rest/webhooks/1.0/webhook',
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const events = ((body.events ?? []) as string[])
        .map((e) => WEBHOOK_EVENTS[e])
        .filter(Boolean);
      if (events.length === 0)
        throw new ShimError(error(400, [], { events: 'Name at least one known event.' }));
      const made = ok(
        await ctx.native('POST', '/api/v1/webhooks', {
          name: body.name,
          url: body.url,
          events,
          ...(body.filters?.['issue-related-events-section']
            ? { filter: body.filters['issue-related-events-section'] }
            : {}),
        }),
      ).webhook;
      return { status: 201, body: webhook(made, ctx) };
    },
  },
  {
    method: 'GET',
    path: '/rest/webhooks/1.0/webhook',
    handle: async (ctx) => {
      const list = ok(await ctx.native('GET', '/api/v1/webhooks')).webhooks as Any[];
      return { status: 200, body: list.map((w) => webhook(w, ctx)) };
    },
  },
];

function webhook(w: Any, ctx: ShimContext) {
  return {
    self: `${ctx.baseUrl}/rest/webhooks/1.0/webhook/${w.id}`,
    name: w.name,
    url: w.url,
    events: ((w.events ?? []) as string[]).map((e) => NATIVE_EVENTS[e] ?? e),
    enabled: w.enabled !== false,
    ...(w.filter ? { filters: { 'issue-related-events-section': w.filter } } : {}),
  };
}
