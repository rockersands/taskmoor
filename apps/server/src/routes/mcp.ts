import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { requireSiteAdmin } from '../auth';
import { emit } from '../events/bus';
import {
  callTool,
  failure,
  initializeResult,
  listTools,
  parseMessage,
  result,
  Sessions,
} from '../mcp/protocol';
import {
  clientAllowed,
  mcpSettingsInput,
  readMcpSettings,
  writeMcpSettings,
} from '../mcp/settings';
import type { Api } from '../mcp/tools';

/**
 * The built-in MCP server over streamable HTTP (M1-072; API-012; ADR-068): `POST /api/v1/mcp`
 * takes one JSON-RPC message and answers it in JSON (no server-sent stream: `GET` answers 405),
 * `DELETE` ends the session named by `Mcp-Session-Id`. A personal or service-account API token
 * (bearer), a session or an OAuth access token of a registered client authenticates; a 401
 * names the protected resource metadata, from which a client finds how to sign in (M1-072).
 * Every tool call is audited (`mcp.tool_called`: client, person, tool, outcome).
 *
 * `GET` and `PUT /api/v1/admin/mcp`: the settings (on or off, allowed clients, tool profile),
 * for site administrators.
 */
export interface McpRouteOptions {
  version: string;
  /** Marks the tools' own REST calls, which a registered client's token may make (M1-072). */
  innerCallSecret: string;
  /** The protected resource metadata, named in the 401 challenge (RFC 9728 section 5.1). */
  resourceMetadataUrl: string;
}

export const INNER_CALL_HEADER = 'x-taskmoor-inner-call';

export function registerMcpRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: McpRouteOptions,
): void {
  const sessions = new Sessions();

  /** Runs a REST call as the MCP caller: their token or session, their address. */
  const apiFor =
    (request: FastifyRequest): Api =>
    async (method, url, body) => {
      const headers: Record<string, string> = { [INNER_CALL_HEADER]: options.innerCallSecret };
      for (const name of ['authorization', 'cookie'] as const) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const res = await app.inject({
        method,
        url,
        headers,
        remoteAddress: request.ip,
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });
      let parsed: unknown = null;
      try {
        parsed = res.body ? JSON.parse(res.body) : null;
      } catch {
        parsed = null;
      }
      return { status: res.statusCode, body: parsed };
    };

  const unauthenticated = (reply: FastifyReply) =>
    reply
      .code(401)
      .header(
        'www-authenticate',
        `Bearer realm="taskmoor", resource_metadata="${options.resourceMetadataUrl}", scope="read write"`,
      )
      .send({ error: 'unauthenticated' });

  app.post('/api/v1/mcp', async (request, reply) => {
    const user = request.user;
    if (!user) return unauthenticated(reply);
    const settings = await readMcpSettings(db);
    if (!settings.enabled)
      return reply.code(403).send(failure(undefined, -32001, 'The MCP server is turned off.'));
    if (Array.isArray(request.body)) {
      return reply.code(400).send(failure(undefined, -32600, 'Send one message per request.'));
    }
    const parsed = parseMessage(request.body);
    if (!parsed.success)
      return reply.code(400).send(failure(undefined, -32600, 'Not a JSON-RPC 2.0 message.'));
    const msg = parsed.data;
    // Notifications and responses need no answer.
    if (msg.method === undefined || msg.id === undefined) return reply.code(202).send();

    if (msg.method === 'initialize') {
      const info = (msg.params?.clientInfo ?? {}) as { name?: unknown; version?: unknown };
      const client = { name: String(info.name ?? 'unknown'), version: String(info.version ?? '') };
      if (!clientAllowed(settings, client.name)) {
        return reply
          .code(403)
          .send(
            failure(
              msg.id,
              -32001,
              `The client "${client.name}" is not on this server’s allowed list.`,
            ),
          );
      }
      const answer = initializeResult(msg.params?.protocolVersion, options.version);
      const session = sessions.open({
        userId: user.id,
        workspaceId: request.workspaceId,
        client,
        protocolVersion: answer.protocolVersion,
      });
      reply.header('mcp-session-id', session.id);
      return result(msg.id, answer);
    }

    const header = request.headers['mcp-session-id'];
    if (typeof header !== 'string' || header === '') {
      return reply
        .code(400)
        .send(failure(msg.id, -32600, 'Send initialize first, then the Mcp-Session-Id it gives.'));
    }
    const session = sessions.find(header, user.id);
    if (!session)
      return reply.code(404).send(failure(msg.id, -32001, 'No such session: initialize again.'));

    switch (msg.method) {
      case 'ping':
        return result(msg.id, {});
      case 'tools/list':
        return listTools(msg.id, settings.profile);
      case 'tools/call': {
        const outcome = await callTool(msg.id, msg.params, settings.profile, apiFor(request));
        await emit(
          db,
          { workspaceId: request.workspaceId, actorId: user.id },
          {
            type: 'mcp.tool_called',
            subjectId: user.id,
            payload: {
              client: session.client.name,
              clientVersion: session.client.version,
              tool: outcome.tool,
              ok: outcome.ok,
            },
          },
        );
        return outcome.reply;
      }
      default:
        return failure(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  });

  // No server-sent stream: everything is answered in the POST.
  app.get('/api/v1/mcp', async (_request, reply) =>
    reply.code(405).header('allow', 'POST, DELETE').send({ error: 'method_not_allowed' }),
  );

  app.delete('/api/v1/mcp', async (request, reply) => {
    const user = request.user;
    if (!user) return unauthenticated(reply);
    const header = request.headers['mcp-session-id'];
    if (typeof header === 'string' && sessions.find(header, user.id)) sessions.close(header);
    return reply.code(204).send();
  });

  app.get('/api/v1/admin/mcp', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return { settings: await readMcpSettings(db) };
  });

  app.put('/api/v1/admin/mcp', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = mcpSettingsInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const settings = parsed.data;
    await db.transaction().execute(async (trx) => {
      await writeMcpSettings(trx, settings);
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: request.user?.id ?? null },
        { type: 'mcp.settings_updated', subjectId: request.workspaceId, payload: settings },
      );
    });
    return { settings };
  });
}
