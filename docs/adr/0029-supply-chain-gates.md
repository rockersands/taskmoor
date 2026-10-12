# ADR-029: Supply-chain gates

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-012

## Context

Taskmoor will be distributed under a copyleft licence (ADR-002) and run inside other
organisations' networks. A dependency under an incompatible licence, a committed credential or a
known-vulnerable package would each be costly to discover late.

## Decision

Checks that run in `pnpm verify` (so locally and in CI), each with a fixture that must fail:

- **Licence allowlist** (`packages/devtools/src/licences.ts`): every installed package must
  declare an SPDX licence that evaluates to allowed. The list holds permissive licences, MPL-2.0,
  LGPL and GPL-3.0/AGPL-3.0, all compatible with AGPL-3.0. A missing licence fails.
- **Secret scan** (`packages/devtools/src/secrets.ts`): files git would commit are checked for
  cloud, VCS, AI-provider, chat and payment keys, private keys and passwords in URLs. A reviewed
  public value can carry `secret-scan: allow` on its line.

Checks that run in CI only:

- **SBOM**: a CycloneDX JSON SBOM built by Syft is kept as a build artifact on every run.
- **Vulnerabilities**: Trivy fails the build on fixable high or critical vulnerabilities.
- **Updates**: Dependabot opens weekly grouped pull requests for npm packages and GitHub
  Actions. It needs no third-party app, unlike Renovate, which the plan named first.

Static analysis with CodeQL is added once the repository is public; on private repositories it
needs GitHub Advanced Security.

## Consequences

Adding a dependency with an unusual licence needs a decision recorded here first. Third-party
GitHub Actions (outside the `actions/` organisation) are pinned by commit SHA with the version in
a comment; Dependabot keeps the pins current.
