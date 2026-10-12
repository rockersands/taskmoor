# ADR-004: Monorepo layout and toolchain

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-008

## Context

One backend image and one static frontend are built from many modules. Sessions need fast
feedback and a layout they can find their way around without prior context. The development
machine runs Windows without Docker.

## Decision

- **Workspace:** pnpm workspaces (`apps/*`, `packages/*`), packages named `@tracksmith/*`,
  consumed from source (`exports` point at `src/*.ts`), so nothing is built before tests run.
- **Types:** TypeScript 6.0, strict, `module: preserve` with bundler resolution, one
  `tsconfig.json` per package and project references from the root; `tsc -b` is incremental.
- **Lint and format:** Biome 2 (one fast tool) instead of ESLint plus Prettier. Module boundary
  rules come from dependency-cruiser (M0-010).
- **Tests:** one root Vitest 4 config that lists every package as a project, so one run covers
  the repo and shares one test database server (ADR-030).
- **Turborepo:** deferred. With source-consumed packages there is nothing to cache yet; it comes
  in with the image and frontend build pipelines when caching saves real time.
- **Runtime libraries:** Fastify 5 (API), Kysely 0.28 with node-postgres (SQL), Zod 4
  (validation), React 19 and Vite 7 (frontend), Playwright (browser tests).

## Versions held back on purpose

| Tool | Using | Newest | Why |
|---|---|---|---|
| TypeScript | 6.0 | 7.0 (native compiler) | Tooling that uses the compiler API is not ready for 7 yet |
| Vitest | 4.1 | 5.0 | 5 is new; move once the reporter and project APIs are confirmed |
| Vite | 7.3 | 8.x | Matches the React plugin line in use; upgrade with Vitest 5 |
| embedded-postgres | 16.x | 18.x | Tests run on the oldest supported Postgres; CI also runs 18 |

Upgrades are tracked as backlog tasks and must pass `pnpm verify --ci`.

## Consequences

Adding a package means adding it to `tsconfig.json` references; the root Vitest config finds it
by folder. Packages are not published, so no build step or versioning is needed until the image
build (M0-025).
