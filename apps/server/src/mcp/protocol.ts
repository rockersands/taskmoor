import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { McpProfile } from './settings';
import { type Api, ToolError, toolsFor } from './tools';

/**
 * The Model Context Protocol, as much of it as a tool server needs (M1-072; API-012;
 * ADR-068): JSON-RPC 2.0 messages for `initialize`, `ping`, `tools/list` and `tools/call`, and
 * the notifications a client sends. Sessions are kept in memory by the process that made them,
 * bound to the person who opened them, for a day; the transport (streamable HTTP, or stdio
 * through the CLI's bridge) is the caller's.
 */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const LATEST = '2025-06-18';
const SESSION_TTL_MS = 24 * 3600 * 1000;
const MAX_SESSIONS = 10_000;

export interface Session {
  id: string;
  userId: number;
  workspaceId: number;
  client: { name: string; version: string };
  protocolVersion: string;
  lastSeen: number;
}

/** Sessions by id, oldest first; expired ones go as new ones come. */
export class Sessions {
  private readonly byId = new Map<string, Session>();

  open(input: Omit<Session, 'id' | 'lastSeen'>): Session {
    this.prune();
    const session = { ...input, id: randomBytes(24).toString('base64url'), lastSeen: Date.now() };
    this.byId.set(session.id, session);
    return session;
  }

  /** The caller's own live session, or null (an unknown, expired or someone else's id). */
  find(id: string, userId: number): Session | null {
    const session = this.byId.get(id);
    if (!session || session.userId !== userId || Date.now() - session.lastSeen > SESSION_TTL_MS)
      return null;
    session.lastSeen = Date.now();
    return session;
  }

  close(id: string): void {
    this.byId.delete(id);
  }

  private prune() {
    const now = Date.now();
    for (const [id, s] of this.byId) if (now - s.lastSeen > SESSION_TTL_MS) this.byId.delete(id);
    while (this.byId.size >= MAX_SESSIONS) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
  }
}

const message = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
export type Message = z.infer<typeof message>;

export const parseMessage = (body: unknown) => message.safeParse(body);

export type Reply = Record<string, unknown>;
export const result = (id: Message['id'], value: unknown): Reply => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result: value,
});
export const failure = (id: Message['id'], code: number, text: string): Reply => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message: text },
});

/** What `initialize` answers: the version both speak, what this server offers, who it is. */
export function initializeResult(requested: unknown, serverVersion: string) {
  const version = PROTOCOL_VERSIONS.find((v) => v === requested) ?? LATEST;
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'taskmoor', title: 'Taskmoor', version: serverVersion },
    instructions:
      'Taskmoor tracks work as tickets in tracks. Search with its query language (for example `track = PAY AND stage != closed`), read tickets by key, and change them only as the person connected may.',
  };
}

export interface ToolCallOutcome {
  reply: Reply;
  tool: string;
  ok: boolean;
}

/** `tools/list` for a profile. */
export function listTools(id: Message['id'], profile: McpProfile): Reply {
  return result(id, {
    tools: toolsFor(profile).map((t) => {
      const schema = z.toJSONSchema(t.input, { io: 'input', target: 'draft-2020-12' }) as Record<
        string,
        unknown
      >;
      delete schema.$schema;
      return {
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: schema,
        annotations: { title: t.title, readOnlyHint: t.readOnly, openWorldHint: false },
      };
    }),
  });
}

/** `tools/call`: the tool's answer as text and structured content, or why it failed. */
export async function callTool(
  id: Message['id'],
  params: Record<string, unknown> | undefined,
  profile: McpProfile,
  api: Api,
): Promise<ToolCallOutcome> {
  const name = String(params?.name ?? '');
  const tool = toolsFor(profile).find((t) => t.name === name);
  if (!tool) {
    return {
      reply: failure(id, -32602, `Unknown tool, or not in this server’s profile: ${name}`),
      tool: name,
      ok: false,
    };
  }
  const args = tool.input.safeParse(params?.arguments ?? {});
  if (!args.success) {
    return {
      reply: failure(
        id,
        -32602,
        `Invalid arguments for ${name}: ${args.error.issues.map((i) => `${i.path.join('.') || 'arguments'} ${i.message}`).join('; ')}`,
      ),
      tool: name,
      ok: false,
    };
  }
  try {
    const value = await tool.run(api, args.data as Record<string, unknown>);
    return {
      reply: result(id, {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
        isError: false,
      }),
      tool: name,
      ok: true,
    };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    // A refusal is the tool's answer, so the model can read it and try otherwise.
    return {
      reply: result(id, { content: [{ type: 'text', text: error.message }], isError: true }),
      tool: name,
      ok: false,
    };
  }
}
