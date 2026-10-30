---
title: "The MCP server"
audience: admins
sources: apps/server/src/mcp/protocol.ts, apps/server/src/mcp/settings.ts, apps/server/src/mcp/tools.ts, apps/server/src/mcp/stdio.ts, apps/server/src/routes/mcp.ts, apps/server/src/cli.ts, apps/server/src/tokens/scopes.ts, apps/server/src/audit/subscriber.ts, apps/web/src/admin/McpPage.tsx, apps/web/src/admin/SettingsPage.tsx, apps/web/src/i18n/messages.en.ts, Dockerfile, docs/api/README.md, docs/adr/0018-mcp-server.md, docs/adr/0068-mcp-server.md, docs/specs/02a-platform-api-and-integrations.md
accessed: 2026-10-30
attestation: own-words
---
# The MCP server

Taskmoor has a built-in server for the Model Context Protocol (MCP), the protocol that AI
agents and assistants use to call tools. An agent connected to it can search and read tickets
and, if you allow it, create, change, comment on, link and move them. It comes with every
install and needs nothing extra.

## How it works

- An agent connects with a person's or a service account's API token. Every tool runs the REST
  API as that token, so the token's scopes, the owner's permissions, field rules, ticket
  history and notifications apply exactly as for any other API call. An agent can never do
  more than the token could.
- Administrators choose one tool profile for the whole instance, and may restrict which MCP
  clients may connect.
- Every tool call is written to the audit log with the client, the person and the tool.

The protocol itself is described at https://modelcontextprotocol.io.

## Turning it on and choosing the tools

The server is on by default, with the **Planner** profile and any client allowed. Site
administrators change this on **Settings**, then **MCP server**:

- **Let agents connect** turns the server on or off. While it is off, every message is refused
  with "The MCP server is turned off."
- **Tools agents get** picks the profile (below).
- **Allowed clients** lists client names, one per line, as each client gives its name when it
  connects. Names match without regard to case. Leave the box empty to allow any client. The
  list is checked when a client opens a session, so a session opened before a change keeps
  working until it ends.

Select **Save MCP settings**. The change applies to the next request; there is nothing to
restart.

The list of allowed clients matches the name a client gives about itself. It keeps unexpected
tools out, but it is not a credential: the token is.

The same settings are at `GET` and `PUT /api/v1/admin/mcp`, with `enabled`, `profile`
(`read-only`, `planner` or `full`) and `allowedClients`. A token needs the `admin` scope there.

## The tools

| Tool | What it does | Profile |
|---|---|---|
| `search_tickets` | Finds tickets with [the query language](../use/search.md); up to 50 per call (20 unless asked), with a cursor for more | Read-only |
| `get_ticket` | Reads one ticket by key, with its description in Markdown, status, people and dates | Read-only |
| `list_tracks` | Lists the tracks the caller may browse, with their keys | Read-only |
| `list_boards` | Lists the boards the caller may see, optionally of one track | Read-only |
| `list_sprints` | Lists a Scrum board's sprints with their states and dates | Read-only |
| `create_ticket` | Creates a ticket in a track; the ticket type and priority are given by name, the description in Markdown | Planner |
| `update_ticket` | Changes a ticket's summary, description, priority, start and due dates or labels | Planner |
| `add_comment` | Adds a comment in Markdown | Planner |
| `link_tickets` | Links two tickets by link type name, such as Blocks or Relates | Planner |
| `transition_ticket` | Moves a ticket by the name of a transition or of the status it leads to, with a close reason by name when the transition asks for one | Full |

Each profile includes the tools of the ones above it:

- **Read-only:** search and read tickets; list tracks, boards and sprints.
- **Planner:** also create and change tickets, comment and link them. This is the default.
- **Full:** also move tickets through their workflows.

A tool outside the profile is neither listed nor callable. When the REST API refuses a call,
the tool answers with the reason as text, so the agent can try another way.

## Permissions and limits

- The MCP endpoint takes tokens with the `read` scope, so read tools work with a read-only
  token. The write tools need a token with `write`; with a `read` token they are refused and
  nothing changes.
- For an agent that should only read, give it a `read` token, or choose the **Read-only**
  profile for everyone.
- The owner's permissions decide what the agent sees and changes, ticket by ticket, including
  visibility levels.
- A connection is a session that the server keeps in memory for a day after its last use.
  Sessions belong to the person who opened them; another person's session id is refused.
- Sessions live in the process that opened them. With several API processes behind a load
  balancer, either route a client to the same process each time, or let the client open a new
  session when the server answers that its session is unknown, which MCP clients do.
- Each request carries one JSON-RPC message; batches are refused. The server answers in JSON
  and does not open a server-sent event stream.

Taskmoor does not yet support OAuth sign-in for MCP clients; use an API token. It also does not
limit how many tool calls an agent makes.

## Connecting a client

First make a token for the agent: a personal token on the Account page, or a service-account
token if the agent should act as itself rather than as a person. See
[API tokens and service accounts](api-tokens.md).

### Over HTTP

Clients that speak MCP's streamable HTTP transport connect to `/api/v1/mcp` on your server and
send the token as a bearer token:

```text
URL:     https://tracker.example.com/api/v1/mcp
Header:  Authorization: Bearer <token>
```

The client sends `initialize` first and receives an `Mcp-Session-Id` header, which it sends
with every following message. A `DELETE` to the same address ends the session, with a read-only
token too. Taskmoor speaks the protocol versions 2024-11-05, 2025-03-26, 2025-06-18 and
2025-11-25.

The **MCP server** settings page shows this address for your server under **Connecting an
agent**.

### Over stdio

Clients that start a command and talk to it on standard input and output use the bridge in
Taskmoor's operator CLI. It reads each JSON-RPC message from stdin, sends it to the server's
HTTP endpoint with the token, and writes the answer to stdout; logs go to stderr. It needs no
database, only the server's address and the token:

```bash
TASKMOOR_URL=https://tracker.example.com TASKMOOR_TOKEN=<token> node cli.mjs mcp
```

`cli.mjs` is in the server's image (in `/app`) and in the output of a production build. On a
machine with Docker, the image can run the bridge directly:

```bash
docker run --rm -i -e TASKMOOR_URL=https://tracker.example.com -e TASKMOOR_TOKEN=<token> \
  <taskmoor image> node cli.mjs mcp
```

Most clients take the command, its arguments and its environment variables in their own
settings file; the exact format depends on the client. Keep the token in the client's secret
store where it has one. See [The operator CLI](cli.md) for the CLI's other commands.

## The audit trail

- Each tool call records `mcp.tool_called` in the audit log, with the person, the client's name
  and version, the tool and whether it succeeded.
- What the tools change also appears where any change appears: ticket history, comments and
  notifications, under the token's owner.
- Changes to the settings record `mcp.settings_updated`.

Site administrators read these with `GET /api/v1/audit?action=mcp.`; see
[Monitoring and logs](monitoring.md) for the audit log as a whole.
