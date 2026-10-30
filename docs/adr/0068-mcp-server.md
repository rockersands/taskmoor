# ADR-068: A built-in MCP tool server over the REST API, as the caller

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-072

## Context

API-012 asks for a free, built-in MCP server over streamable HTTP (OAuth 2.1 or personal
token) and local stdio. Its tools search, read, create, update, transition, comment on and
link tickets, and list tracks, boards, sprints and knowledge articles. Administrators allowlist
clients and pick a tool profile (read-only, planner or full), and every call is audited. Its
checks:

1. A client lists tools and creates a ticket the UI shows.
2. A read-only profile rejects write tools.
3. Each call is audited with client, user and tool.

M1-072 is done when MCP protocol tests are green and a token's scope cannot be exceeded. The
stable REST API (ADR-067), personal and service-account tokens with scopes (ADR-035) and the
audit log (ADR-016) exist.

## Decision

- **Our own protocol code.**
  - `apps/server/src/mcp/protocol.ts` implements what a tool server needs: JSON-RPC 2.0
    `initialize`, `ping`, `tools/list` and `tools/call`, plus client notifications.
  - It speaks protocol versions 2024-11-05 to 2025-11-25: a client's own version when listed,
    2025-06-18 otherwise.
  - The official SDK (`@modelcontextprotocol/sdk`, MIT) is a development dependency only. The
    tests use its client, which proves the server speaks the protocol, without bringing its
    HTTP frameworks into the server.
- **Streamable HTTP** at `/api/v1/mcp`:
  - POST takes one message and answers it in JSON (202 for notifications).
  - GET answers 405: there is no server-initiated stream.
  - DELETE ends the session.
  - `initialize` opens a session (`Mcp-Session-Id`), bound to the person, kept in memory by
    that process for a day. Another person's or an unknown id answers 404.
  - No credentials answers 401 with a bearer challenge.
  - The route takes `read` tokens, so read tools work with a read-only token.
- **Stdio**: `node cli.mjs mcp` bridges JSON-RPC lines on stdin to the HTTP endpoint
  (`TASKMOOR_URL`, `TASKMOOR_TOKEN`) and writes each answer on stdout. It needs no database,
  and there is one implementation behind both transports.
- **Tools run the REST API as the caller.** Each tool calls stable operations in-process with
  the request's own bearer token or session. The token's scope, the person's permissions, field
  rules, history and events apply as for any API call, so a tool cannot exceed its token: a
  read token's `create_ticket` is the REST refusal (403), returned as a tool error. Rich text
  is Markdown.
- **Tools and profiles:**
  - Read-only: `search_tickets`, `get_ticket`, `list_tracks`, `list_boards`, `list_sprints`.
  - Planner: also `create_ticket`, `update_ticket`, `add_comment`, `link_tickets`.
  - Full: also `transition_ticket`, by transition or target status name, with a close reason
    when asked.
  - A tool outside the profile is neither listed nor callable.
  - A refusal comes back as `isError: true` text, so the model can try another way.
- **Settings** live in `instance_setting` `mcp`: on or off, allowed client names (none means
  any, matched case-insensitively against `clientInfo.name` at `initialize`), and the profile
  (planner by default). Site administrators change them with `PUT /api/v1/admin/mcp`
  (`mcp.settings_updated`, audited) or on the `#/admin/mcp` page, which also shows how to
  connect.
- **Audit**: each `tools/call` emits `mcp.tool_called` (actor = the person; client name and
  version, tool, outcome), and the audit log records it.

## Options considered

| Option | For | Against |
|---|---|---|
| Own protocol code, official client in tests (chosen) | Small; no new runtime dependencies; compliance proven by the reference client | Protocol changes are ours to follow |
| The official server SDK | Complete protocol | Brings Express and Hono into the server; its transport owns the HTTP layer |
| Tools writing to the database directly | Faster | A second set of permission and history rules; scope could be bypassed |
| Sessions in the database | Survive restarts and span instances | A write per session; clients re-initialize anyway |

## Consequences

- OAuth 2.1 for MCP clients waits for the cross-origin auth (M1-107, done: ADR-080 lists what
  MCP clients still need: client registration, consent, scopes and discovery); personal and
  service-account tokens work now.
- Sessions are per process: behind several API instances a client needs sticky routing or
  re-initializes on 404, which the protocol expects.
- Knowledge-article tools come with the knowledge base (M3, KB-003).
