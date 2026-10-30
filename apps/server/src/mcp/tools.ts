import { z } from 'zod';
import type { McpProfile } from './settings';

/**
 * The MCP server's tools (M1-072; API-012; ADR-068). Each tool runs operations of the REST API
 * as the person who connected, with their token or session, through the server itself: the
 * token's scope, the person's permissions, field rules, history and events apply exactly as
 * for any API call, so a tool can never do what its caller could not. Rich text is Markdown.
 */

/** Calls the REST API as the MCP caller; the status and the parsed body. */
export type Api = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

/** A refusal of the REST API, told to the model in words with its code. */
export class ToolError extends Error {}

interface Tool {
  name: string;
  title: string;
  description: string;
  /** The least profile that offers it. */
  profile: McpProfile;
  /** Whether it only reads (MCP's `readOnlyHint`). */
  readOnly: boolean;
  input: z.ZodObject;
  run: (api: Api, args: Record<string, unknown>) => Promise<unknown>;
}

const RANK: Record<McpProfile, number> = { 'read-only': 0, planner: 1, full: 2 };

type Json = Record<string, unknown>;

/** The body of a successful call, or a ToolError saying why it failed. */
async function ok(
  api: Api,
  method: Parameters<Api>[0],
  url: string,
  body?: unknown,
): Promise<Json> {
  const res = await api(method, url, body);
  if (res.status >= 200 && res.status < 300) return (res.body ?? {}) as Json;
  const error = (res.body as { error?: unknown; fields?: unknown } | null) ?? {};
  const fields = error.fields ? ` ${JSON.stringify(error.fields)}` : '';
  throw new ToolError(
    `The server refused (${res.status} ${String(error.error ?? 'error')}).${fields}`,
  );
}

const q = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null) s.set(k, String(v));
  const text = s.toString();
  return text ? `?${text}` : '';
};
const enc = encodeURIComponent;
const sameName = (a: unknown, b: string) =>
  String(a ?? '').toLowerCase() === b.trim().toLowerCase();

/** A ticket as tools show it: the fields a model needs, nothing more. */
function brief(t: Json) {
  const name = (v: unknown) => (v as { name?: unknown } | null)?.name ?? null;
  return {
    key: t.key,
    summary: t.summary,
    type: name(t.ticketType),
    status: name(t.status),
    stage: (t.status as { stage?: unknown } | undefined)?.stage ?? null,
    assignee: name(t.assignee),
    priority: name(t.priority),
    startDate: t.startDate ?? null,
    dueDate: t.dueDate ?? null,
    labels: t.labels ?? [],
    ...(t.description !== undefined ? { description: t.description } : {}),
  };
}

const key = z.string().min(1).max(300).describe('The ticket key, such as PAY-12.');

export const TOOLS: readonly Tool[] = [
  {
    name: 'search_tickets',
    title: 'Search tickets',
    description:
      'Find tickets with a query in Taskmoor’s query language, for example `track = PAY AND stage != closed ORDER BY updated DESC`. Returns up to `limit` tickets and a cursor for more.',
    profile: 'read-only',
    readOnly: true,
    input: z.object({
      query: z.string().max(20_000).describe('The query.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('How many tickets, 20 by default.'),
      cursor: z.string().max(4000).optional().describe('The `next` of an earlier answer.'),
    }),
    run: async (api, a) => {
      const page = await ok(
        api,
        'GET',
        `/api/v1/search${q({ q: a.query, limit: a.limit ?? 20, cursor: a.cursor })}`,
      );
      return {
        tickets: ((page.tickets ?? []) as Json[]).map(brief),
        next: page.next ?? null,
        ...(page.total ? { total: page.total } : {}),
      };
    },
  },
  {
    name: 'get_ticket',
    title: 'Read a ticket',
    description: 'One ticket with its description (Markdown), status, people and dates.',
    profile: 'read-only',
    readOnly: true,
    input: z.object({ key }),
    run: async (api, a) =>
      brief(
        (await ok(api, 'GET', `/api/v1/tickets/${enc(String(a.key))}?format=markdown`))
          .ticket as Json,
      ),
  },
  {
    name: 'list_tracks',
    title: 'List tracks',
    description: 'The tracks (projects) the caller may browse, with their keys.',
    profile: 'read-only',
    readOnly: true,
    input: z.object({}),
    run: async (api) => ({
      tracks: (((await ok(api, 'GET', '/api/v1/tracks')).tracks ?? []) as Json[]).map((t) => ({
        key: t.key,
        name: t.name,
        type: t.type,
      })),
    }),
  },
  {
    name: 'list_boards',
    title: 'List boards',
    description: 'The boards the caller may see, optionally of one track (by its id).',
    profile: 'read-only',
    readOnly: true,
    input: z.object({ trackId: z.number().int().positive().optional() }),
    run: async (api, a) => ({
      boards: (
        ((await ok(api, 'GET', `/api/v1/boards${q({ trackId: a.trackId })}`)).boards ??
          []) as Json[]
      ).map((b) => ({ id: b.id, name: b.name, kind: b.kind })),
    }),
  },
  {
    name: 'list_sprints',
    title: 'List sprints',
    description: 'A Scrum board’s sprints with their states and dates.',
    profile: 'read-only',
    readOnly: true,
    input: z.object({ boardId: z.number().int().positive() }),
    run: async (api, a) => ({
      sprints: (
        ((await ok(api, 'GET', `/api/v1/boards/${Number(a.boardId)}/sprints`)).sprints ??
          []) as Json[]
      ).map((s) => ({
        id: s.id,
        name: s.name,
        state: s.state,
        startAt: s.startAt,
        endAt: s.endAt,
        goal: s.goal,
      })),
    }),
  },
  {
    name: 'create_ticket',
    title: 'Create a ticket',
    description:
      'Make a ticket in a track. The type and priority are names, such as Bug and High; the description is Markdown.',
    profile: 'planner',
    readOnly: false,
    input: z.object({
      track: z.string().min(1).max(300).describe('The track key.'),
      summary: z.string().min(1).max(255),
      description: z.string().max(100_000).optional(),
      type: z
        .string()
        .max(255)
        .optional()
        .describe('A ticket type the track offers; its default otherwise.'),
      priority: z.string().max(255).optional(),
      dueDate: z.string().max(10).optional().describe('YYYY-MM-DD.'),
    }),
    run: async (api, a) => {
      const body: Json = { track: a.track, summary: a.summary };
      if (a.description !== undefined) body.description = a.description;
      if (a.dueDate !== undefined) body.dueDate = a.dueDate;
      if (a.type !== undefined) {
        const types = (await ok(api, 'GET', `/api/v1/tracks/${enc(String(a.track))}/ticket-types`))
          .ticketTypes as Json[];
        const type = types.find((t) => sameName(t.name, String(a.type)));
        if (!type) throw new ToolError(`The track has no ticket type named "${a.type}".`);
        body.ticketTypeId = type.id;
      }
      if (a.priority !== undefined) body.priorityId = await priorityId(api, String(a.priority));
      return brief((await ok(api, 'POST', '/api/v1/tickets?format=markdown', body)).ticket as Json);
    },
  },
  {
    name: 'update_ticket',
    title: 'Change a ticket',
    description:
      'Change a ticket’s summary, description (Markdown), priority, dates or labels; only what is given changes.',
    profile: 'planner',
    readOnly: false,
    input: z.object({
      key,
      summary: z.string().min(1).max(255).optional(),
      description: z.string().max(100_000).optional(),
      priority: z.string().max(255).optional(),
      startDate: z.string().max(10).nullable().optional(),
      dueDate: z.string().max(10).nullable().optional(),
      labels: z.array(z.string().max(255)).max(100).optional(),
    }),
    run: async (api, a) => {
      const body: Json = {};
      for (const f of ['summary', 'description', 'startDate', 'dueDate', 'labels'] as const) {
        if (a[f] !== undefined) body[f] = a[f];
      }
      if (a.priority !== undefined) body.priorityId = await priorityId(api, String(a.priority));
      if (Object.keys(body).length === 0) throw new ToolError('Nothing to change.');
      return brief(
        (await ok(api, 'PATCH', `/api/v1/tickets/${enc(String(a.key))}?format=markdown`, body))
          .ticket as Json,
      );
    },
  },
  {
    name: 'add_comment',
    title: 'Comment on a ticket',
    description: 'Add a comment (Markdown) to a ticket.',
    profile: 'planner',
    readOnly: false,
    input: z.object({ key, body: z.string().min(1).max(100_000) }),
    run: async (api, a) => {
      const comment = (
        await ok(api, 'POST', `/api/v1/tickets/${enc(String(a.key))}/comments?format=markdown`, {
          body: a.body,
        })
      ).comment as Json;
      return { id: comment.id, createdAt: comment.createdAt };
    },
  },
  {
    name: 'link_tickets',
    title: 'Link two tickets',
    description:
      'Link a ticket to another, by link type name such as Blocks or Relates: the ticket is the source.',
    profile: 'planner',
    readOnly: false,
    input: z.object({ key, type: z.string().min(1).max(255), other: key }),
    run: async (api, a) => {
      const types = (await ok(api, 'GET', '/api/v1/link-types')).linkTypes as Json[];
      const type = types.find(
        (t) => sameName(t.name, String(a.type)) || sameName(t.outward, String(a.type)),
      );
      if (!type) throw new ToolError(`There is no link type named "${a.type}".`);
      const link = (
        await ok(api, 'POST', `/api/v1/tickets/${enc(String(a.key))}/links`, {
          linkTypeId: type.id,
          ticket: a.other,
        })
      ).link as Json;
      return { id: link.id, phrase: link.phrase, ticket: (link.ticket as Json | undefined)?.key };
    },
  },
  {
    name: 'transition_ticket',
    title: 'Move a ticket through a transition',
    description:
      'Move a ticket by the name of a transition (such as Start) or of the status it leads to (such as Done). A close reason, by name, for transitions that ask for one.',
    profile: 'full',
    readOnly: false,
    input: z.object({
      key,
      to: z.string().min(1).max(255).describe('A transition name or a status name.'),
      closeReason: z.string().max(255).optional(),
    }),
    run: async (api, a) => {
      const id = enc(String(a.key));
      const transitions = (await ok(api, 'GET', `/api/v1/tickets/${id}/transitions`))
        .transitions as Json[];
      const chosen = transitions.find(
        (t) =>
          sameName(t.name, String(a.to)) ||
          sameName((t.to as Json | undefined)?.name, String(a.to)),
      );
      if (!chosen) {
        throw new ToolError(
          `No transition "${a.to}" now; it may take: ${transitions.map((t) => t.name).join(', ') || 'none'}.`,
        );
      }
      const fields: Json = {};
      if ((chosen.layout as string[] | undefined)?.includes('close-reason')) {
        const reasons = (await ok(api, 'GET', '/api/v1/close-reasons')).closeReasons as Json[];
        const reason = a.closeReason
          ? reasons.find((r) => sameName(r.name, String(a.closeReason)))
          : reasons[0];
        if (!reason) throw new ToolError(`There is no close reason named "${a.closeReason}".`);
        fields['close-reason'] = reason.id;
      }
      return brief(
        (
          await ok(api, 'POST', `/api/v1/tickets/${id}/transitions?format=markdown`, {
            transitionId: chosen.id,
            ...(Object.keys(fields).length > 0 ? { fields } : {}),
          })
        ).ticket as Json,
      );
    },
  },
];

async function priorityId(api: Api, name: string): Promise<number> {
  const priorities = (await ok(api, 'GET', '/api/v1/priorities')).priorities as Json[];
  const found = priorities.find((p) => sameName(p.name, name));
  if (!found) throw new ToolError(`There is no priority named "${name}".`);
  return found.id as number;
}

/** The tools a profile offers. */
export const toolsFor = (profile: McpProfile) =>
  TOOLS.filter((t) => RANK[t.profile] <= RANK[profile]);
