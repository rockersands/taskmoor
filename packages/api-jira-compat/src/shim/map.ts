import { type PmJson, toAdfFromJson, toWiki } from '@taskmoor/richtext';
import type { Version } from '../operations';
import { type NativeAnswer, ShimError, type ShimReply } from './types';

/**
 * From Taskmoor's own bodies to the Jira-compatible ones (M1-069; ADR-086): people, statuses,
 * issue types, projects and issues, and native refusals as Jira-compatible errors. Ids become
 * strings; a person's account id is their Taskmoor id as a string. Instants are written with
 * a numeric offset and milliseconds, as scripts parse them.
 */
type Json = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: native bodies are read field by field
type Any = any;

/** Rich text as native requests ask for it: the document format on v3, wiki markup on v2. */
export const nativeFormat = (version: Version) => (version === '3' ? 'adf' : 'wiki');

export function error(status: number, messages: string[], errors: Record<string, string> = {}) {
  return { status, body: { errorMessages: messages, errors } };
}

/** A native refusal in Jira-compatible words; `what` names the resource for a 404. */
export function fromNative(answer: NativeAnswer, what = 'The item'): ShimReply {
  const b = answer.body ?? {};
  switch (answer.status) {
    case 401:
      return error(401, ['You are not signed in, or your token is not valid.']);
    case 403:
      return error(403, [
        b.permission
          ? `You do not have the permission this needs (${b.permission}).`
          : 'You do not have permission to do this.',
      ]);
    case 404:
      return error(404, [`${what} does not exist, or you do not have permission to see it.`]);
    case 409:
      return error(409, [String(b.error ?? 'conflict')]);
    case 429:
      return error(429, ['Too many requests; try again later.']);
    default: {
      if (answer.status >= 500) return error(500, ['The server could not do this.']);
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries((b.fields ?? {}) as Json)) {
        fields[jiraFieldName(k)] = String(v);
      }
      const messages =
        Object.keys(fields).length > 0 ? [] : [String(b.message ?? b.error ?? 'invalid request')];
      return error(400, messages, fields);
    }
  }
}

/** Throws the Jira-compatible error unless the native answer is a success. */
export function ok(answer: NativeAnswer, what?: string): Any {
  if (answer.status >= 200 && answer.status < 300) return answer.body;
  throw new ShimError(fromNative(answer, what));
}

const FIELD_NAMES: Record<string, string> = {
  track: 'project',
  ticketTypeId: 'issuetype',
  assigneeId: 'assignee',
  requesterId: 'reporter',
  priorityId: 'priority',
  dueDate: 'duedate',
  closeReasonId: 'resolution',
  areaIds: 'components',
  targetReleaseIds: 'fixVersions',
  foundInReleaseIds: 'versions',
};
export const jiraFieldName = (native: string) => FIELD_NAMES[native] ?? native;

/** An instant as scripts parse it: `2026-10-31T09:00:00.000+0000`. */
export function instant(value: string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString().replace('Z', '+0000');
}

export function user(person: Any, base: string): Json | null {
  if (!person) return null;
  return {
    self: `${base}/rest/api/2/user?accountId=${person.id}`,
    accountId: String(person.id),
    displayName: String(person.name ?? ''),
    active: person.active !== false && !person.deactivatedAt,
    ...(person.email ? { emailAddress: person.email } : {}),
    accountType: 'atlassian',
  };
}

const CATEGORIES = {
  new: { id: 2, key: 'new', name: 'To Do', colorName: 'blue-gray' },
  active: { id: 4, key: 'indeterminate', name: 'In Progress', colorName: 'yellow' },
  closed: { id: 3, key: 'done', name: 'Done', colorName: 'green' },
} as const;

export function status(s: Any, base: string): Json {
  const category = CATEGORIES[(s.stage as keyof typeof CATEGORIES) ?? 'new'] ?? CATEGORIES.new;
  return {
    self: `${base}/rest/api/2/status/${s.id}`,
    id: String(s.id),
    name: s.name,
    statusCategory: category,
  };
}

/** A ticket type; one below the standard level is a subtask. */
export function issueType(t: Any, base: string): Json {
  return {
    self: `${base}/rest/api/2/issuetype/${t.id}`,
    id: String(t.id),
    name: t.name,
    subtask: Boolean(t.level && Number(t.level.rank) < 0) || t.kind === 'subticket',
    hierarchyLevel: t.level ? Number(t.level.rank) : 0,
  };
}

export function project(t: Any, base: string): Json {
  return {
    self: `${base}/rest/api/2/project/${t.id}`,
    id: String(t.id),
    key: t.key,
    name: t.name,
    projectTypeKey: t.mode === 'service' ? 'service_desk' : 'software',
    ...(t.archived !== undefined ? { archived: Boolean(t.archived) } : {}),
  };
}

const named = (x: Any, base: string, kind: string) =>
  x ? { self: `${base}/rest/api/2/${kind}/${x.id}`, id: String(x.id), name: x.name } : null;

/**
 * Rich text in the version's form. Native reads that took `?format=` are already in it; search
 * answers the stored document, which becomes wiki markup on v2 and the document format on v3.
 */
export function richText(value: unknown, version: Version): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  const doc = value as { type?: string; version?: number };
  if (doc.type !== 'doc' || doc.version !== undefined) return value;
  return version === '3' ? toAdfFromJson(value as PmJson) : toWiki(value as PmJson);
}

/** A native ticket as a Jira-compatible issue; `only` narrows `fields` (the `fields` parameter). */
export function issue(t: Any, version: Version, base: string, only?: readonly string[]): Json {
  const custom: Json = {};
  for (const [id, value] of Object.entries((t.fields ?? {}) as Json)) {
    custom[`customfield_${id}`] = value ?? null;
  }
  const all: Json = {
    summary: t.summary,
    status: t.status ? status(t.status, base) : null,
    issuetype: t.ticketType ? issueType(t.ticketType, base) : null,
    project: t.track ? project(t.track, base) : null,
    assignee: user(t.assignee, base),
    reporter: user(t.requester, base),
    creator: user(t.creator, base),
    created: instant(t.createdAt),
    updated: instant(t.updatedAt),
    labels: t.labels ?? [],
    description: richText(t.description, version),
    environment: richText(t.environment, version),
    priority: named(t.priority, base, 'priority'),
    resolution: named(t.closeReason, base, 'resolution'),
    resolutiondate: instant(t.closedAt),
    duedate: t.dueDate ?? null,
    components: (t.areas ?? []).map((a: Any) => named(a, base, 'component')),
    fixVersions: (t.targetReleases ?? []).map((r: Any) => named(r, base, 'version')),
    versions: (t.foundInReleases ?? []).map((r: Any) => named(r, base, 'version')),
    parent: t.parent?.key ? { id: String(t.parent.id), key: t.parent.key } : null,
    timetracking: t.timeTracking
      ? {
          originalEstimateSeconds: t.timeTracking.originalEstimate ?? undefined,
          remainingEstimateSeconds: t.timeTracking.remainingEstimate ?? undefined,
          timeSpentSeconds: t.timeTracking.timeSpent ?? 0,
        }
      : {},
    votes: { votes: t.voteCount ?? 0 },
    watches: { watchCount: t.followerCount ?? 0 },
    ...custom,
  };
  const wanted = only && !only.some((f) => f === '*all' || f === '*navigable') ? only : null;
  const fields = wanted
    ? Object.fromEntries(Object.entries(all).filter(([k]) => wanted.includes(k)))
    : all;
  return {
    expand: 'renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations',
    id: String(t.id),
    self: `${base}/rest/api/${version}/issue/${t.id}`,
    key: t.key,
    fields,
  };
}

/** `fields=a,b` or `["a","b"]` as a list; undefined for all. */
export function fieldList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim() !== '')
    return value.split(',').map((f) => f.trim());
  return undefined;
}
