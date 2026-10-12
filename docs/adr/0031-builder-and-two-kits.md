# ADR-031: The Builder, two kits and a signed connection manifest

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

The user's requirement: a frontend that can be uploaded to any static host and a backend that
installs in minutes, with nothing wired by hand and no secret ever in the frontend (OPS-013 to
OPS-017, IAM-026, NFR-013). The two halves must find each other and refuse to pair with the
wrong instance.

## Decision

- **One core, two faces.** `packages/builder-core` generates both kits from one input set;
  `apps/builder` is a static page that runs entirely in the browser (secrets from WebCrypto,
  zips built locally, zero network requests, verified by a test that captures traffic) and the
  CLI exposes the same core for automation. Both produce byte-identical kits from the same
  project file and seed.
- **Inputs:** backend URL, frontend URL, instance name, branding, default language, routing
  mode (clean URLs with generated `.htaccess`, `_redirects` and nginx fallbacks, or hash
  routing), optional SMTP, optional AI provider and key, deployment target (Compose on a VPS by
  default; Helm values; single binary in M2).
- **Backend kit:** `docker-compose.yml` pinned to the exact image version, Postgres and Caddy
  for automatic HTTPS; `.env` with fresh secrets (database password, token-signing keys, the
  master key for stored AI keys, a one-time setup token), `PUBLIC_URL`, `ALLOWED_ORIGINS`,
  OAuth redirect URIs and `INSTANCE_ID`; `install.sh` and `install.ps1` that check
  prerequisites, start the stack, wait for health and print the setup link; a README listing
  the DNS records.
- **Frontend kit:** a zip (default) or a single `index.html` of the static app for the same
  version, with public configuration inlined (API and WebSocket URLs, instance id, key
  fingerprint, branding, routing mode) and SRI hashes. A build-time scanner fails the kit if any
  secret of that build, known key format or high-entropy string appears in it.
- **Connection manifest:** both kits carry the instance id and the instance public key; the
  frontend asks the backend's public meta endpoint (API-017) to sign a nonce and refuses to run
  against a backend whose id or signature does not match (IAM-025).
- **Project file:** inputs without secrets (or with secrets encrypted by a passphrase), used to
  regenerate kits on upgrade or rebrand.

## Options considered

| Option | For | Against |
|---|---|---|
| Static Builder plus CLI on one core (chosen) | Secrets never leave the user's machine; automation gets the same output; offline | A third app to keep in step with releases (it is versioned with them) |
| Backend setup wizard only | One place | The frontend kit still needs generating before the backend exists; no offline path |
| Hand-written configuration | Nothing to build | Exactly the hand wiring that produces broken installs |

## Consequences

The nightly zero-configuration job (NFR-013) builds both kits, installs the backend kit on a
fresh VM, uploads the frontend kit to a plain static server on another origin and runs the e2e
suite. The admin area can add origins and regenerate frontend kits later (OPS-017).
