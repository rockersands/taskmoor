# ADR-002: Licence and contribution model

- Status: Proposed (waiting for the user's confirmation)
- Date: 2026-10-12
- Backlog: M0-004

## Context

The product promises every premium feature for free to self-hosters. Public-sector and
enterprise buyers need an OSI-approved licence. A permissive licence would let a closed SaaS
fork take the work without giving changes back.

## Decision (recommended)

- AGPL-3.0-only for the whole repository, one public codebase, no paid edition (the
  "always-free charter").
- Contributions under the Developer Certificate of Origin (`Signed-off-by` on every commit),
  checked in CI, instead of a CLA.

Until the user confirms, the repository carries no LICENSE file and stays private.

## Options considered

| Option | For | Against |
|---|---|---|
| AGPL-3.0 + DCO | OSI licence; network clause stops closed SaaS forks; low contributor friction | Some companies ban AGPL internally |
| GPL-3.0 | OSI licence | No network clause; a hosted fork need not share changes |
| Apache-2.0 / MIT | Widest adoption | Anyone can ship a closed hosted fork |
| FSL / BSL | Protects a commercial offer | Not OSI; conflicts with the always-free promise |
| CLA | Allows relicensing later | Friction; signals a future closed edition |

## Consequences

Adding the LICENSE file and the DCO check is a one-commit change once confirmed. Third-party
dependencies must be compatible with AGPL-3.0 (enforced by the licence allowlist, ADR-029).
