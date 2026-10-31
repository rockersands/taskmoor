import { error, fieldList, instant, issue, nativeFormat, ok, status, user } from './map';
import { type Native, type ShimContext, ShimError, type ShimRoute } from './types';

/**
 * The issue operations of the Jira-compatible API (M1-069; API-003, API-004; ADR-086): create,
 * read, edit and delete issues, their transitions, history, comments, worklogs, watchers,
 * votes, remote links, properties and links, each as calls to the native ticket API.
 */
// biome-ignore lint/suspicious/noExplicitAny: request and native bodies are read field by field
type Any = any;
const API = '/rest/api/:v';
const enc = encodeURIComponent;
const ISSUE = 'The issue';

const ticketPath = (ctx: ShimContext) => `/api/v1/tickets/${enc(ctx.params.issueIdOrKey ?? '')}`;
const withFormat = (ctx: ShimContext, path: string) =>
  `${path}${path.includes('?') ? '&' : '?'}format=${nativeFormat(ctx.version)}`;

async function loadTicket(ctx: ShimContext) {
  const ticket = ok(await ctx.native('GET', withFormat(ctx, ticketPath(ctx))), ISSUE).ticket as Any;
  // A ticket in the trash is deleted as far as the compatible API goes.
  if (ticket.trash) {
    throw new ShimError(
      error(404, ['The issue does not exist, or you do not have permission to see it.']),
    );
  }
  return ticket;
}

const idOrName = (x: Any) => (x && typeof x === 'object' ? (x.id ?? x.name ?? x.key) : x);

async function lookup(
  native: Native,
  path: string,
  key: string,
  wanted: Any,
  what: string,
): Promise<number> {
  const list = ok(await native('GET', path))[key] as Any[];
  const value = idOrName(wanted);
  const found = (list ?? []).find(
    (x) =>
      String(x.id) === String(value) ||
      String(x.name).toLowerCase() === String(value).toLowerCase(),
  );
  if (!found) throw new ShimError(error(400, [], { [what]: `No ${what} "${value}" here.` }));
  return Number(found.id);
}

/** Jira-compatible `fields` as a native create or change; unknown fields are refused. */
async function nativeFields(ctx: ShimContext, fields: Any, trackRef: string | null) {
  const out: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  const problems: Record<string, string> = {};
  let track: Any = null;
  const trackOf = async () => {
    if (track) return track;
    if (!trackRef) throw new ShimError(error(400, [], { project: 'Specify a project.' }));
    track = ok(await ctx.native('GET', `/api/v1/tracks/${enc(trackRef)}`), 'The project').track;
    return track;
  };
  for (const [name, value] of Object.entries((fields ?? {}) as Record<string, Any>)) {
    switch (name) {
      case 'project':
        break;
      case 'summary':
        out.summary = value;
        break;
      case 'description':
        out.description = value;
        break;
      case 'environment':
        out.environment = value;
        break;
      case 'labels':
        out.labels = value;
        break;
      case 'duedate':
        out.dueDate = value;
        break;
      case 'issuetype':
        out.ticketTypeId = await lookup(
          ctx.native,
          `/api/v1/tracks/${(await trackOf()).id}/ticket-types`,
          'ticketTypes',
          value,
          'issuetype',
        );
        break;
      case 'priority':
        out.priorityId =
          value === null
            ? null
            : await lookup(ctx.native, '/api/v1/priorities', 'priorities', value, 'priority');
        break;
      case 'resolution':
        out.closeReasonId =
          value === null
            ? null
            : await lookup(
                ctx.native,
                '/api/v1/close-reasons',
                'closeReasons',
                value,
                'resolution',
              );
        break;
      case 'assignee':
        out.assigneeId = value === null || !value.accountId ? null : Number(value.accountId);
        break;
      case 'reporter':
        out.requesterId = Number(value?.accountId);
        break;
      case 'parent':
        out.parent = value === null ? null : String(idOrName(value));
        break;
      case 'components': {
        const t = await trackOf();
        out.areaIds = await Promise.all(
          (value as Any[]).map((c) =>
            lookup(ctx.native, `/api/v1/tracks/${t.id}/areas`, 'areas', c, 'components'),
          ),
        );
        break;
      }
      case 'fixVersions':
      case 'versions': {
        const t = await trackOf();
        const ids = await Promise.all(
          (value as Any[]).map((r) =>
            lookup(ctx.native, `/api/v1/tracks/${t.id}/releases`, 'releases', r, name),
          ),
        );
        out[name === 'fixVersions' ? 'targetReleaseIds' : 'foundInReleaseIds'] = ids;
        break;
      }
      default: {
        const m = /^customfield_(\d+)$/.exec(name);
        if (m) custom[m[1] as string] = value;
        else
          problems[name] =
            `Field '${name}' cannot be set. It is not on the appropriate screen, or unknown.`;
      }
    }
  }
  if (Object.keys(problems).length > 0) throw new ShimError(error(400, [], problems));
  if (Object.keys(custom).length > 0) out.fields = custom;
  return { body: out, trackOf };
}

async function createOne(ctx: ShimContext, body: Any) {
  const fields = body?.fields ?? {};
  const projectRef = fields.project ? String(idOrName(fields.project)) : null;
  if (!projectRef)
    throw new ShimError(error(400, [], { project: 'Specify a valid project ID or key' }));
  if (!fields.issuetype)
    throw new ShimError(error(400, [], { issuetype: 'Specify an issue type' }));
  if (!fields.summary)
    throw new ShimError(error(400, [], { summary: 'You must specify a summary of the issue.' }));
  const { body: native } = await nativeFields(ctx, fields, projectRef);
  const made = ok(
    await ctx.native('POST', withFormat(ctx, '/api/v1/tickets'), { track: projectRef, ...native }),
  ).ticket;
  return {
    id: String(made.id),
    key: made.key,
    self: `${ctx.baseUrl}/rest/api/${ctx.version}/issue/${made.id}`,
  };
}

/** `update`: add, remove and set operations per field, applied to the current values. */
async function applyUpdate(
  ctx: ShimContext,
  update: Any,
  current: Any,
  change: Record<string, unknown>,
) {
  for (const [name, ops] of Object.entries((update ?? {}) as Record<string, Any[]>)) {
    if (name === 'labels') {
      let labels: string[] = (change.labels as string[] | undefined) ?? [...(current.labels ?? [])];
      for (const op of ops) {
        if (op.set !== undefined) labels = [...op.set];
        if (op.add !== undefined && !labels.includes(op.add)) labels.push(op.add);
        if (op.remove !== undefined) labels = labels.filter((l) => l !== op.remove);
      }
      change.labels = labels;
    } else {
      const set = ops.find((op) => op.set !== undefined);
      if (!set) {
        throw new ShimError(error(400, [], { [name]: `Only set is supported for ${name} here.` }));
      }
      const { body } = await nativeFields(ctx, { [name]: set.set }, current.track?.key ?? null);
      Object.assign(change, body);
    }
  }
}

const pageOf = (ctx: ShimContext) => {
  const startAt = Math.max(0, Number(ctx.query.startAt ?? 0) || 0);
  const maxResults = Math.min(1000, Math.max(1, Number(ctx.query.maxResults ?? 50) || 50));
  return { startAt, maxResults };
};

/** Every page of a native list that pages by cursor. */
async function allPages(native: Native, path: string, key: string): Promise<Any[]> {
  const out: Any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const page = ok(
      await native('GET', `${path}${sep}limit=200${cursor ? `&cursor=${enc(cursor)}` : ''}`),
    );
    out.push(...(page[key] ?? []));
    cursor = page.next ?? null;
    if (cursor === null || cursor === undefined) break;
  }
  return out;
}

function comment(c: Any, ctx: ShimContext) {
  return {
    self: `${ctx.baseUrl}/rest/api/${ctx.version}/issue/${ctx.params.issueIdOrKey}/comment/${c.id}`,
    id: String(c.id),
    author: user(c.author, ctx.baseUrl),
    updateAuthor: user(c.author, ctx.baseUrl),
    body: c.body ?? null,
    created: instant(c.createdAt),
    updated: instant(c.updatedAt ?? c.editedAt ?? c.createdAt),
    jsdPublic: true,
  };
}

function worklog(w: Any, ctx: ShimContext) {
  return {
    self: `${ctx.baseUrl}/rest/api/${ctx.version}/issue/${ctx.params.issueIdOrKey}/worklog/${w.id}`,
    id: String(w.id),
    author: user(w.author, ctx.baseUrl),
    updateAuthor: user(w.author, ctx.baseUrl),
    timeSpentSeconds: Number(w.duration ?? w.seconds ?? 0),
    started: instant(w.startedAt),
    created: instant(w.createdAt),
    updated: instant(w.updatedAt ?? w.createdAt),
    ...(w.description !== undefined ? { comment: w.description } : {}),
  };
}

/** Native durations are words such as `1h 30m`; worklogs keep whole minutes. */
function minutesText(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : ''].filter(Boolean).join(' ');
}

async function myAccountId(ctx: ShimContext): Promise<string> {
  return String(ok(await ctx.native('GET', '/api/v1/session')).user.id);
}

export const ISSUE_ROUTES: readonly ShimRoute[] = [
  {
    method: 'POST',
    path: `${API}/issue`,
    handle: async (ctx) => ({ status: 201, body: await createOne(ctx, ctx.body) }),
  },
  {
    method: 'POST',
    path: `${API}/issue/bulk`,
    handle: async (ctx) => {
      const issues: Any[] = [];
      const errors: Any[] = [];
      const updates = ((ctx.body as Any)?.issueUpdates ?? []) as Any[];
      for (const [i, u] of updates.entries()) {
        try {
          issues.push(await createOne(ctx, u));
        } catch (e) {
          if (!(e instanceof ShimError)) throw e;
          errors.push({
            status: e.reply.status,
            elementErrors: e.reply.body,
            failedElementNumber: i,
          });
        }
      }
      return { status: 201, body: { issues, errors } };
    },
  },
  {
    method: 'POST',
    path: `${API}/issue/bulkfetch`,
    handle: async (ctx) => {
      const wanted = ((ctx.body as Any)?.issueIdsOrKeys ?? []) as string[];
      const only = fieldList((ctx.body as Any)?.fields);
      const issues: Any[] = [];
      const issueErrors: Any[] = [];
      for (const ref of wanted.slice(0, 100)) {
        const res = await ctx.native('GET', withFormat(ctx, `/api/v1/tickets/${enc(String(ref))}`));
        if (res.status === 200 && !res.body.ticket.trash) {
          issues.push(issue(res.body.ticket, ctx.version, ctx.baseUrl, only));
        } else
          issueErrors.push({
            issueIdOrKey: ref,
            errorMessages: ['Issue not found or not visible.'],
          });
      }
      return { status: 200, body: { expand: '', issues, issueErrors } };
    },
  },
  {
    method: 'GET',
    path: `${API}/issue/:issueIdOrKey`,
    handle: async (ctx) => {
      const ticket = await loadTicket(ctx);
      return {
        status: 200,
        body: issue(ticket, ctx.version, ctx.baseUrl, fieldList(ctx.query.fields)),
      };
    },
  },
  {
    method: 'PUT',
    path: `${API}/issue/:issueIdOrKey`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const current = await loadTicket(ctx);
      const change: Record<string, unknown> = {};
      if (body.fields) {
        const { body: native } = await nativeFields(ctx, body.fields, current.track?.key ?? null);
        Object.assign(change, native);
      }
      if (body.update) await applyUpdate(ctx, body.update, current, change);
      if (Object.keys(change).length > 0) {
        ok(await ctx.native('PATCH', withFormat(ctx, ticketPath(ctx)), change), ISSUE);
      }
      return { status: 204 };
    },
  },
  {
    method: 'DELETE',
    path: `${API}/issue/:issueIdOrKey`,
    handle: async (ctx) => {
      ok(await ctx.native('DELETE', ticketPath(ctx)), ISSUE);
      return { status: 204 };
    },
  },
  {
    method: 'GET',
    path: `${API}/issue/:issueIdOrKey/transitions`,
    handle: async (ctx) => {
      const list = ok(await ctx.native('GET', `${ticketPath(ctx)}/transitions`), ISSUE)
        .transitions as Any[];
      return {
        status: 200,
        body: {
          expand: 'transitions',
          transitions: list.map((t) => ({
            id: String(t.id),
            name: t.name,
            to: status(t.to, ctx.baseUrl),
            hasScreen: Boolean(t.layout ?? t.hasScreen),
            isGlobal: Boolean(t.global),
            isInitial: false,
            isConditional: false,
          })),
        },
      };
    },
  },
  {
    method: 'POST',
    path: `${API}/issue/:issueIdOrKey/transitions`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const id = Number(body.transition?.id);
      if (!Number.isInteger(id)) {
        throw new ShimError(error(400, ['Specify a transition by id.']));
      }
      const res = await ctx.native('POST', withFormat(ctx, `${ticketPath(ctx)}/transitions`), {
        transitionId: id,
      });
      if (res.status === 404 && res.body?.error !== 'not_found') {
        return error(400, [`Transition id '${id}' is not valid for this issue.`]);
      }
      if (res.status >= 400 && res.status !== 401 && res.status !== 403) {
        // The issue exists: a transition that is unknown or not available is a bad request.
        const exists = await ctx.native('GET', ticketPath(ctx));
        if (exists.status === 200) {
          return error(400, [`Transition id '${id}' is not valid for this issue.`]);
        }
      }
      ok(res, ISSUE);
      return { status: 204 };
    },
  },
  {
    method: 'GET',
    path: `${API}/issue/:issueIdOrKey/changelog`,
    handle: async (ctx) => {
      const { startAt, maxResults } = pageOf(ctx);
      const changes = await allPages(ctx.native, `${ticketPath(ctx)}/history?order=asc`, 'changes');
      // One entry per change set: changes by the same person at the same instant.
      const entries: Any[] = [];
      for (const c of changes) {
        const last = entries[entries.length - 1];
        const at = c.at ?? c.createdAt ?? c.changedAt;
        const by = c.by ?? c.actor ?? null;
        const item = {
          field: c.field,
          fieldtype: String(c.field).startsWith('customfield_') ? 'custom' : 'jira',
          from: c.from?.value ?? null,
          fromString: c.from?.display ?? null,
          to: c.to?.value ?? null,
          toString: c.to?.display ?? null,
        };
        if (last && last._at === at && last._by === (by?.id ?? null)) last.items.push(item);
        else {
          entries.push({
            _at: at,
            _by: by?.id ?? null,
            id: String(c.id ?? entries.length + 1),
            author: user(by, ctx.baseUrl),
            created: instant(at),
            items: [item],
          });
        }
      }
      const values = entries
        .map(({ _at, _by, ...rest }) => rest)
        .slice(startAt, startAt + maxResults);
      return {
        status: 200,
        body: {
          self: `${ctx.baseUrl}/rest/api/${ctx.version}/issue/${ctx.params.issueIdOrKey}/changelog`,
          startAt,
          maxResults,
          total: entries.length,
          isLast: startAt + maxResults >= entries.length,
          values,
        },
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/issue/:issueIdOrKey/comment`,
    handle: async (ctx) => {
      const { startAt, maxResults } = pageOf(ctx);
      const all = await allPages(
        ctx.native,
        withFormat(ctx, `${ticketPath(ctx)}/comments`),
        'comments',
      );
      return {
        status: 200,
        body: {
          startAt,
          maxResults,
          total: all.length,
          comments: all.slice(startAt, startAt + maxResults).map((c) => comment(c, ctx)),
        },
      };
    },
  },
  {
    method: 'POST',
    path: `${API}/issue/:issueIdOrKey/comment`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const made = ok(
        await ctx.native('POST', withFormat(ctx, `${ticketPath(ctx)}/comments`), {
          body: body.body,
        }),
        ISSUE,
      ).comment;
      return { status: 201, body: comment(made, ctx) };
    },
  },
  {
    method: 'PUT',
    path: `${API}/issue/:issueIdOrKey/comment/:id`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const changed = ok(
        await ctx.native(
          'PATCH',
          withFormat(ctx, `${ticketPath(ctx)}/comments/${enc(ctx.params.id ?? '')}`),
          { body: body.body },
        ),
        'The comment',
      ).comment;
      return { status: 200, body: comment(changed, ctx) };
    },
  },
  {
    method: 'DELETE',
    path: `${API}/issue/:issueIdOrKey/comment/:id`,
    handle: async (ctx) => {
      ok(
        await ctx.native('DELETE', `${ticketPath(ctx)}/comments/${enc(ctx.params.id ?? '')}`),
        'The comment',
      );
      return { status: 204 };
    },
  },
  {
    method: 'GET',
    path: `${API}/issue/:issueIdOrKey/worklog`,
    handle: async (ctx) => {
      const { startAt, maxResults } = pageOf(ctx);
      const all = await allPages(ctx.native, `${ticketPath(ctx)}/time-entries`, 'timeEntries');
      return {
        status: 200,
        body: {
          startAt,
          maxResults,
          total: all.length,
          worklogs: all.slice(startAt, startAt + maxResults).map((w) => worklog(w, ctx)),
        },
      };
    },
  },
  {
    method: 'POST',
    path: `${API}/issue/:issueIdOrKey/worklog`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const duration =
        body.timeSpentSeconds !== undefined
          ? minutesText(Number(body.timeSpentSeconds))
          : body.timeSpent;
      if (!duration) throw new ShimError(error(400, [], { timeLogged: 'Specify the time spent.' }));
      const made = ok(
        await ctx.native('POST', `${ticketPath(ctx)}/time-entries`, {
          duration,
          ...(body.started
            ? {
                startedAt: new Date(
                  String(body.started).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'),
                ).toISOString(),
              }
            : {}),
          ...(body.comment !== undefined ? { description: body.comment } : {}),
        }),
        ISSUE,
      ).timeEntry;
      return { status: 201, body: worklog(made, ctx) };
    },
  },
  {
    method: 'GET',
    path: `${API}/issue/:issueIdOrKey/watchers`,
    handle: async (ctx) => {
      const list = ok(await ctx.native('GET', `${ticketPath(ctx)}/followers`), ISSUE);
      const people = (list.followers ?? list.people ?? []) as Any[];
      const me = await myAccountId(ctx);
      return {
        status: 200,
        body: {
          self: `${ctx.baseUrl}/rest/api/${ctx.version}/issue/${ctx.params.issueIdOrKey}/watchers`,
          watchCount: people.length,
          isWatching: people.some((p) => String(p.id) === me),
          watchers: people.map((p) => user(p, ctx.baseUrl)),
        },
      };
    },
  },
  {
    method: 'POST',
    path: `${API}/issue/:issueIdOrKey/watchers`,
    handle: async (ctx) => {
      const who = typeof ctx.body === 'string' && ctx.body !== '' ? ctx.body : 'me';
      ok(await ctx.native('PUT', `${ticketPath(ctx)}/followers/${enc(who)}`), ISSUE);
      return { status: 204 };
    },
  },
  {
    method: 'GET',
    path: `${API}/issue/:issueIdOrKey/votes`,
    handle: async (ctx) => {
      const v = ok(await ctx.native('GET', `${ticketPath(ctx)}/votes`), ISSUE);
      const voters = (v.voters ?? []) as Any[];
      return {
        status: 200,
        body: {
          self: `${ctx.baseUrl}/rest/api/${ctx.version}/issue/${ctx.params.issueIdOrKey}/votes`,
          votes: Number(v.count ?? v.voteCount ?? voters.length),
          hasVoted: Boolean(v.voted ?? v.hasVoted),
          voters: voters.map((p) => user(p, ctx.baseUrl)),
        },
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/issue/:issueIdOrKey/remotelink`,
    handle: async (ctx) => {
      const links = ok(await ctx.native('GET', `${ticketPath(ctx)}/links`), ISSUE);
      return {
        status: 200,
        body: ((links.webLinks ?? []) as Any[]).map((l) => ({
          id: Number(l.id),
          self: `${ctx.baseUrl}/rest/api/${ctx.version}/issue/${ctx.params.issueIdOrKey}/remotelink/${l.id}`,
          ...(l.globalId ? { globalId: l.globalId } : {}),
          object: { url: l.url, title: l.title },
        })),
      };
    },
  },
  {
    method: 'POST',
    path: `${API}/issue/:issueIdOrKey/remotelink`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const object = body.object ?? {};
      const self = (id: number) =>
        `${ctx.baseUrl}/rest/api/${ctx.version}/issue/${ctx.params.issueIdOrKey}/remotelink/${id}`;
      if (body.globalId) {
        const links = ok(await ctx.native('GET', `${ticketPath(ctx)}/links`), ISSUE);
        const same = ((links.webLinks ?? []) as Any[]).find((l) => l.globalId === body.globalId);
        if (same) {
          ok(
            await ctx.native('PATCH', `${ticketPath(ctx)}/web-links/${same.id}`, {
              url: object.url,
              title: object.title,
            }),
            ISSUE,
          );
          return { status: 200, body: { id: Number(same.id), self: self(Number(same.id)) } };
        }
      }
      const made = ok(
        await ctx.native('POST', `${ticketPath(ctx)}/web-links`, {
          url: object.url,
          title: object.title,
          ...(body.globalId ? { globalId: body.globalId } : {}),
        }),
        ISSUE,
      ).webLink;
      return { status: 201, body: { id: Number(made.id), self: self(Number(made.id)) } };
    },
  },
  {
    method: 'GET',
    path: `${API}/issue/:issueIdOrKey/properties`,
    handle: async (ctx) => {
      const list = ok(await ctx.native('GET', `${ticketPath(ctx)}/properties`), ISSUE);
      return {
        status: 200,
        body: {
          keys: ((list.properties ?? []) as Any[]).map((p) => ({
            key: p.key,
            self: `${ctx.baseUrl}/rest/api/${ctx.version}/issue/${ctx.params.issueIdOrKey}/properties/${enc(p.key)}`,
          })),
        },
      };
    },
  },
  {
    method: 'GET',
    path: `${API}/issue/:issueIdOrKey/properties/:propertyKey`,
    handle: async (ctx) => {
      const p = ok(
        await ctx.native(
          'GET',
          `${ticketPath(ctx)}/properties/${enc(ctx.params.propertyKey ?? '')}`,
        ),
        'The property',
      ).property;
      return { status: 200, body: { key: p.key, value: p.value } };
    },
  },
  {
    method: 'PUT',
    path: `${API}/issue/:issueIdOrKey/properties/:propertyKey`,
    handle: async (ctx) => {
      const res = await ctx.native(
        'PUT',
        `${ticketPath(ctx)}/properties/${enc(ctx.params.propertyKey ?? '')}`,
        { value: ctx.body ?? null },
      );
      ok(res, ISSUE);
      return { status: res.status === 201 ? 201 : 200 };
    },
  },
  {
    method: 'DELETE',
    path: `${API}/issue/:issueIdOrKey/properties/:propertyKey`,
    handle: async (ctx) => {
      ok(
        await ctx.native(
          'DELETE',
          `${ticketPath(ctx)}/properties/${enc(ctx.params.propertyKey ?? '')}`,
        ),
        'The property',
      );
      return { status: 204 };
    },
  },
  {
    method: 'POST',
    path: `${API}/issueLink`,
    handle: async (ctx) => {
      const body = (ctx.body ?? {}) as Any;
      const typeId = await lookup(ctx.native, '/api/v1/link-types', 'linkTypes', body.type, 'type');
      // The inward issue takes the type's outward phrase: "inward blocks outward".
      const from = String(idOrName(body.inwardIssue));
      const to = String(idOrName(body.outwardIssue));
      ok(
        await ctx.native('POST', `/api/v1/tickets/${enc(from)}/links`, {
          linkTypeId: typeId,
          ticket: to,
        }),
        ISSUE,
      );
      return { status: 201 };
    },
  },
];
