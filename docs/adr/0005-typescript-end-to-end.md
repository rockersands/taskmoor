# ADR-005: TypeScript end to end

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

The product is a modular monolith (ADR-004) built by Claude sessions that must stay consistent
across thousands of tasks. The sync design (ADR-013) applies the same mutation on the client,
optimistically, and on the server, authoritatively; two languages would mean two copies of
every mutation. Self-hosters want one image and few moving parts (section 3 of the build plan).
The user confirmed the stack choice in `docs/plan/decisions.csv` ("Core stack").

## Decision

- **One language.** TypeScript everywhere: the server (Node.js LTS, Fastify), the worker and
  realtime roles, the web client (React), the Builder, the CLI and the extension SDK.
- **Node.js LTS only.** The image ships the current LTS (22 today); a new LTS is adopted in the
  first minor release after it reaches active LTS. No native addons unless prebuilt binaries
  exist for linux amd64 and arm64, and never in the request path.
- **Shared packages hold the logic**, not the apps: validation (Zod), the query language,
  rich-text conversion, workflow evaluation and sync mutations live in `packages/*` and are
  imported by both `apps/server` and `apps/web`.
- **CPU-heavy work** (imports, exports, report rendering, embeddings) runs in the worker role
  and, inside it, in worker threads, so the API event loop stays responsive. Spikes measure the
  hot spots (query compile, XML streaming) before any native alternative is considered.
- **Strictness** is the tool: `strict`, `exactOptionalPropertyTypes`, no `any` in `packages/*`,
  Biome rules at error level, and property tests for pure logic (ADR-030).

## Options considered

| Option | For | Against |
|---|---|---|
| TypeScript end to end (chosen) | Shared mutation and validation code; one toolchain; largest pool of libraries for the integrations list | Single-threaded request handling; CPU-bound work needs workers |
| Go server, React client | Small static binary, strong concurrency | Every mutation and validation rule written twice; two toolchains for every session |
| JVM (Kotlin) | Jira's own ecosystem of libraries | Memory footprint against the 1.5 GB idle target; two languages |
| Elixir, React client | Realtime strengths | Two languages; small hiring and library pool for the integration surface |

## Consequences

Performance-sensitive paths need measurement, not assumption: each spike records p95 against
the budgets, and the nightly benchmark (M0-033) keeps them honest. A single-binary backend
(OPS-023) is produced with Node's single-executable support in M2, so the language choice does
not block the no-Docker install.
