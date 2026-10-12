# ADR-018: Built-in MCP server over the native API

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

AI agents and assistants are becoming ordinary API clients; Atlassian's Rovo MCP server passed a
million monthly users and OpenProject charges for its MCP. The spec (API-012) asks for a free,
built-in MCP server with streamable HTTP and stdio transports, tool profiles and auditing.

## Decision

- **One server, two transports.** `packages/mcp` implements the Model Context Protocol with the
  official TypeScript SDK: streamable HTTP served by the backend under `/mcp` (OAuth 2.1 with
  PKCE or a personal token, API-002), and a `tracksmith mcp` stdio command in the CLI for local
  clients, which talks to the same backend with a token.
- **Tools are generated from the OpenAPI contract** (ADR-016), so every tool is a public
  endpoint with the caller's permissions, and nothing bypasses authorization. The tool list is
  curated into profiles: read-only (search, read, list), planner (plus create, update, comment,
  transition, link) and full (plus administration). Admins allowlist client ids and pick the
  profile per client or token.
- **Resources** expose items, spaces, boards, sprints and knowledge articles as readable
  documents; prompts ship for triage and summarisation and can be edited by admins.
- **Every call is audited** (who, client, tool, arguments digest, result status, latency) in
  the AI audit log (IAM-021), and rate-limited per token like any API client.
- **No model inside.** The server never calls a model; it is a client surface. Model use lives
  in the AI gateway (ADR-028).

## Options considered

| Option | For | Against |
|---|---|---|
| Built-in server generated from the contract (chosen) | Always in step with the API; permission model reused; free for every install | Tool descriptions need curation for agent quality |
| Community or separate project | Core stays smaller | Lags releases; profiles and audit would be missing |
| Generic "run any API call" tool | Tiny surface | Poor agent results; no profiles |

## Consequences

The contract snapshot test also protects the tool list; an API change that breaks a tool shows
up in CI. Tool quality is measured with an eval set from M1 (ADR-028).
