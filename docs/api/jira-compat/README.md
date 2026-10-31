# The Jira-compatible API

What Taskmoor serves for scripts and tools written for Jira (ADR-016, ADR-085), and how far it
has come. Both files here are generated; do not edit them.

- `openapi.json`: Taskmoor's own description of the compatible API, made from
  `packages/api-jira-compat/src/operations.ts`. Each operation names the public pages it was
  written from (`x-sources`) and what they left open (`x-verify`). It copies nothing from
  Atlassian's documentation.
- `matrix.md`: each operation's state (complete, partial, failing, missing, untested) from a
  run of the conformance suite against this repository's server
  (`apps/server/src/compat/conformance.test.ts`).

Run the suite against a running Taskmoor with
`TASKMOOR_TOKEN=<token> pnpm conformance compat --url=https://tracker.example.com --project=KEY`.
It refuses Atlassian hosts: the clean room (ADR-003) forbids testing against their products.
