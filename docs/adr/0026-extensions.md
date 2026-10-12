# ADR-026: Extensions as WASM in Extism, UI slots in sandboxed iframes

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

Jira's value is partly its marketplace; Forge gives apps hosted functions and Custom UI with a
module catalogue. Self-hosted extensions must not take the server down or read data outside
their scopes. The spec asks for a sandboxed server runtime (EXT-001), every extension point of
its section 3 (EXT-002), iframe UI extensions with a TypeScript SDK (EXT-003), scripting for
admins (EXT-004), signed packages with scopes (EXT-005), storage (EXT-006) and observability
(EXT-007).

## Decision

- **Server extensions are WebAssembly modules run by Extism** (`@extism/extism`,
  BSD-3-Clause) in the worker role, with host functions scoped by the capabilities the package
  declares: ticket and track API as the extension's identity, key-value and SQL storage in the
  extension's own schema, outbound HTTP to an allowlist, logging. CPU time, memory and
  wall-clock limits apply per invocation; a failing extension is disabled after repeated
  faults, never crashes the host.
- **Extension points** are typed events and hooks in `packages/extensions`: field types with
  query operators, workflow checks, guards and effects, query functions,
  automation actions, REST endpoints under `/api/ext/<id>`, scheduled jobs, UI slots.
- **UI extensions are iframes** with a strict CSP, a `postMessage` bridge that exposes only
  permitted API calls, design tokens for theming and `@taskmoor/extension-sdk`.
- **Admin scripting** (EXT-004) is TypeScript compiled by the server to WASM through the same
  runtime (QuickJS in WASM), so scripts and packaged extensions share one sandbox and one set of
  limits.
- **Packages** are signed archives with a manifest (scopes, egress domains, points); admins
  approve scopes on install; offline install from a file; per-track enablement; uninstall with
  data removal drops the schema.
- **Observability** per extension: invocations, errors with stack traces, latency, resource
  use, log lines (EXT-007).

## Options considered

| Option | For | Against |
|---|---|---|
| WASM in Extism plus iframes (chosen) | Strong isolation; language-agnostic (Rust, Go, TS via QuickJS); deterministic limits | Host functions must be designed per capability; WASM build toolchain for authors |
| In-process JavaScript (`isolated-vm`, `vm2`) | Easy authoring | Escapes have a history; memory and CPU limits are weaker; native addon |
| Separate processes or containers | Full isolation | Heavy per extension; not available on all hosts |
| Hosted functions (Forge model) | No operator burden | Requires a cloud we do not run |

## Consequences

The extension API is a public contract versioned with the API (ADR-016). A registry (EXT-009)
is an M4 item; until then packages install from files and URLs.
