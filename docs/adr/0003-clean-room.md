# ADR-003: Clean-room rules

- Status: Accepted (counsel review requested, task M0-005)
- Date: 2026-10-12
- Backlog: M0-004, M0-005, M0-006

## Context

Tracksmith matches the behaviour of a commercial product. Copyright protects code, text and
artwork, and Atlassian's terms restrict how its products and documents may be used. Interfaces
and behaviour described in our own words are the safe path.

## Decision

1. Specs in `docs/specs` describe behaviour in our own words and link the public pages they were
   based on. Code is written from the specs, never from Atlassian code, decompiled artefacts or
   copied documentation text.
2. No Atlassian product, account or trial is used to build or test Tracksmith. Test fixtures and
   importer samples are synthetic, built from public format descriptions.
3. No Atlassian names, logos, icons, colours or screenshots in the product. The name never
   contains "Jira"; compatibility is described as "Jira-compatible" (nominative use).
4. CI enforces what it can: spec provenance front matter (M0-006), a licence allowlist and
   secret and asset scans (M0-012).
5. Any suspected contamination is reported in `HANDOFF.md`, the affected code is quarantined
   and rewritten from the spec by a session that has not seen the contaminating material.

## Consequences

Some behaviour must be inferred and later checked against design-partner data (specs mark these
lines "verify"). The protocol in `docs/legal/clean-room.md` (M0-005) expands these rules.
