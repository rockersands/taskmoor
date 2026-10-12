# ADR-001: Record architecture decisions as ADRs

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-004

## Context

Tracksmith is built across hundreds of Claude sessions that do not remember each other. A
decision that lives only in a conversation is lost, and later sessions may undo it.

## Decision

Every decision that constrains more than one module, or that a later session could reasonably
reverse, is recorded in `docs/adr/NNNN-title.md` using `template.md` (a short MADR variant).
Numbers follow the ADR table in the [build plan](../plan/build-plan.md#5-architecture-and-stack),
so references stay stable even though records are written in a different order.

- An ADR starts as Proposed and becomes Accepted when its evidence exists (a spike, a benchmark,
  or the user's confirmation for product and legal choices).
- Accepted ADRs are not rewritten. A changed decision gets a new ADR that supersedes the old one,
  and both the plan table and the index are updated.
- `docs/adr/README.md` lists every ADR with its status.

## Consequences

Sessions can check a decision before changing related code. The cost is a short document per
decision, which is small next to re-arguing it.
