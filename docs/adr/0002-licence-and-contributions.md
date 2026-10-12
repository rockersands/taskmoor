# ADR-002: Licence and contribution model

- Status: Accepted (confirmed by the user on 2026-10-12)
- Date: 2026-10-12
- Backlog: M0-004

## Context

The product promises every premium feature for free to self-hosters. Public-sector and
enterprise buyers need an OSI-approved licence. A permissive licence would let a closed SaaS
fork take the work without giving changes back.

## Decision

- AGPL-3.0-only for the whole repository, one public codebase, no paid edition (the
  "always-free charter").
- Contributions under the Developer Certificate of Origin (`Signed-off-by` on every commit),
  checked in CI, instead of a CLA.

The repository carries the AGPL-3.0 text in `LICENSE` and `"license": "AGPL-3.0-only"` in every
package manifest. It stays private until the public name is cleared (M0-007).

### Enforcing the DCO on the free GitHub plan

Private repositories on GitHub's free plan have no branch protection or rulesets, so nothing on
GitHub can block a merge. The DCO is enforced in three places instead:

- `.githooks/prepare-commit-msg` adds the sign-off to every commit;
- `.githooks/pre-push` runs `pnpm dco` and refuses to push unsigned commits;
- the CI `verify` job runs `pnpm dco` on the pushed or proposed commits and fails the build.

If the account moves to a paid plan, or the repository becomes public, make the `verify` job a
required status check on `main`.

## Options considered

| Option | For | Against |
|---|---|---|
| AGPL-3.0 + DCO | OSI licence; network clause stops closed SaaS forks; low contributor friction | Some companies ban AGPL internally |
| GPL-3.0 | OSI licence | No network clause; a hosted fork need not share changes |
| Apache-2.0 / MIT | Widest adoption | Anyone can ship a closed hosted fork |
| FSL / BSL | Protects a commercial offer | Not OSI; conflicts with the always-free promise |
| CLA | Allows relicensing later | Friction; signals a future closed edition |

## Consequences

Third-party dependencies must be compatible with AGPL-3.0 (enforced by the licence allowlist,
ADR-029). Anyone hosting a modified Taskmoor for others must offer them its source.
