# Releases, channels and support

How Taskmoor is versioned, published and supported (OPS-007, ADR-022). This page is the policy;
the manual's upgrade page (`docs/manual`) is how an administrator applies it.

## Versions

Taskmoor uses semantic versions, `MAJOR.MINOR.PATCH`:

| Part | Changes when | Example |
|---|---|---|
| Major | A milestone ships (M1 is 1.0, M2 is 2.0) or a change needs an administrator's decision | 1.0.0 to 2.0.0 |
| Minor | New features, new migrations, API additions | 1.0.0 to 1.1.0 |
| Patch | Fixes only; no new feature; a migration only when a fix needs one | 1.1.0 to 1.1.1 |

The native API is versioned on its own (`/api/v1`); a backend serves the current API version
and the one before it, so a frontend kit one version behind keeps working (ADR-032). The Jira-
compatible API follows the shape it is compatible with and changes only additively.

## Channels

| Channel | What | Image tags | Support |
|---|---|---|---|
| **Stable** | Every minor and patch release | `1.2.3`, `1.2`, `1` and `latest` | Until the next minor; security fixes go into the next patch |
| **Long-term support (LTS)** | One release a year, named in its release notes | `1.0.4`, `1.0`, `lts` | Security fixes for **24 months** from its release, as patches on its own line (1.0.x) |
| **Preview** | Builds of `main` before a release | `preview-<date>-<commit>` | None: for trying out, never for production data |

An LTS line takes security fixes and fixes for data loss; it takes no features. Upgrading from
an LTS release to the current one is supported in one step even when it is more than three
releases back (`packages/db/src/releases.ts`: the last three releases, and the latest LTS).

## What a release contains

Every release, on every channel but preview:

- the image `ghcr.io/rockersands/taskmoor:<version>` (public; amd64 and arm64), and the
  all-in-one image;
- the air-gap bundle (`tools/airgap/bundle.sh`): images, the Compose kit, the Helm chart, the
  frontend build and the CycloneDX SBOM, with `SHA256SUMS` signed by the release key;
- the Builder page (`apps/web/dist-builder/index.html`), the frontend artefact and the server
  bundle, all stamped with the version (ADR-066);
- release notes: what changed, migrations and their expected time, anything an administrator
  must decide, and the security fixes with their advisories.

## Signing

Releases are signed with the release key (ECDSA P-256, cosign blob format). The public key is
`tools/airgap/taskmoor-release.pub` in this repository and on the release page; compare the two
before trusting a bundle. The private key is kept offline by the maintainer, never in the
repository or in CI; it signs on the maintainer's machine.

`bash verify.sh` in a bundle checks the signature and every checksum, and stops on any
mismatch.

## Supported upgrades

- From any of the last three releases to the current one in one step, and from the latest LTS
  release (ADR-022). `cli.mjs check-upgrade` says whether a database's start is supported before
  anything changes.
- PostgreSQL 16 and later. A PostgreSQL major version reaching its own end of life is dropped
  only in a major Taskmoor release, announced one minor release ahead.
- Frontend kits: the backend serves its own API version and the one before, and tells an older
  frontend that it must update (`/api/meta`, ADR-032).

## Security fixes

Report vulnerabilities as `SECURITY.md` says. A fix ships as a patch release on the stable line
and on every LTS line still in support, with an advisory naming the versions affected and fixed.
