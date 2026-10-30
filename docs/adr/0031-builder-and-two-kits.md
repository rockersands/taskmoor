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

## Implementation (M1-109: the core library)

`packages/builder-core` (`@taskmoor/builder-core`) runs on Web Crypto alone, with no Node
module, so the web Builder and the CLI share every byte of it.
- **Inputs** (`inputs.ts`): the form of spec 05b section 1.2. Validation answers a code per
  field with an English message:
  - https everywhere except `localhost`, `127.0.0.1`, `::1`, `*.localhost` and `*.test`;
  - a backend URL without a path;
  - a frontend URL ending in `/`, whose path becomes the base path.

  Clean URLs are the default (M1-134). The SMTP password and an AI key are `UserSecrets`,
  kept apart from the inputs.
- **Secrets** (`secrets.ts`), each at least 128 bits:
  - a UUID v4 instance id and an Ed25519 key from a 32-byte seed;
  - a 32-character alphanumeric database password;
  - the pepper, token-signing key, master key and setup token, each 32 random bytes.

  `seededRandom` (SHA-256 in counter mode) makes a run reproducible for tests and rebuilds;
  the platform generator is the default.
- **Manifest** (`manifest.ts`): Ed25519 over `taskmoor-manifest-v1` and the manifest's
  canonical JSON (keys sorted at every depth). `verifyManifest` also checks the key against
  its fingerprint.
- **Project file** (`project.ts`): the inputs, with secrets only when a passphrase is given.
  The passphrase key comes from PBKDF2-SHA-256 at 600,000 rounds and encrypts with
  AES-256-GCM. The keys are written in a fixed order.
- **Kits** (`kits.ts`): the shared core of both kits.
  - The backend gets a `.env` with the secrets and the variables the server reads (`PUBLIC_URL`,
    `TASKMOOR_SETUP_TOKEN`, `TASKMOOR_PASSWORD_PEPPER`, `TASKMOOR_WEB_ROUTING`, `TASKMOOR_SMTP_*`,
    `POSTGRES_PASSWORD`). It also gets `TASKMOOR_INSTANCE_ID`, `TASKMOOR_INSTANCE_KEY`, and
    names later tickets read (`TASKMOOR_ALLOWED_ORIGINS`, `TASKMOOR_TOKEN_SIGNING_KEY`,
    `TASKMOOR_MASTER_KEY`, `TASKMOOR_AI_*`).
  - The frontend gets `taskmoor-config.json` with the runtime config of ADR-066.
  - Both carry the same signed `connection-manifest.json`.
  - `checkKits` is OPS-014's consistency check: signature, the same manifest on both sides,
    address, instance, version, key against fingerprint, allowed origin, frontend target and
    routing, and no secret of the build anywhere in the frontend kit. `buildKits` refuses
    kits that fail it.
  - M1-110 and M1-111 add the Compose, Caddy, installer and static-app files around these.
- **Zip** (`zip.ts`): stored entries, sorted, dated 1980-01-01 and marked UTF-8. One file set
  gives one archive, and a standard `unzip -t` accepts it.
- **The server's half**: `TASKMOOR_INSTANCE_ID` and `TASKMOOR_INSTANCE_KEY` (both or neither)
  seed the identity of ADR-070 the first time it is needed. An identity already stored, say
  from a restore, is kept. `meta.builder.test.ts` installs from a generated kit, and the meta
  endpoint's answer passes the frontend's `verifyInstance` with the kit's pinned identity.

## Implementation (M1-111: the frontend kit)

- **Pinning.** The runtime config of ADR-066 gained `instanceId` and `instanceKey`, which go
  together or not at all.
  - `buildKits` writes the manifest's id and public key into the frontend config, and
    `checkKits` requires them to match.
  - In the app, `VersionGate` asks `/api/meta` to sign a fresh nonce and checks the answer
    with `verifyInstance`. A backend that is not the pinned instance gets "This app belongs to
    another server" in place of the app, so nobody signs in to the wrong server (API-017 (2)).
  - Unreachable backends are not blocked: the page's own requests show the failure.
  - A frontend the backend serves itself has no pin.
- **Assembly** (`builder-core/src/frontend.ts`, browser-safe):
  - `assembleFrontendKit` fills the slot and adds `integrity="sha384-…"` to every script and
    stylesheet.
  - For clean URLs it adds `.htaccess`, `_redirects` and `nginx.conf` below the base path.
  - The single-file form inlines the scripts and stylesheet into index.html (`</script>` and
    `</style>` escaped) and uses hash routing, since one file cannot answer deep links. It
    gives up a strict Content-Security-Policy, which the zip form keeps.
  - `frontendKit` does the same from a Builder run's kits and ships the manifest beside it.
- **CLI** (`pnpm builder --project <file>`, `packages/devtools/src/builder.ts`): writes the
  backend kit's core and the frontend kit as a zip and as one file. With `--seed`, the bytes
  match any other run of the same project file and build. A passphrase comes from an
  environment variable named on the command line, never from the command line itself. The
  web Builder page that shares this core is still to come.
- **Checks:**
  - The web-build test project assembles both forms from a real build and runs the
    repository's secret scanner over every file.
  - `e2e/kit-server.ts` serves three kits from this run's build as a plain static host
    would, with `/api` and WebSockets passed to the backend. `kits.spec.ts` checks:
    - the zip kit: a deep link and its reload, with integrity on the assets;
    - the single file: nothing fetched from its host but the page;
    - a kit pinned to another instance: refused.
  - Uploads to real Apache, S3 with a CDN, Netlify and Cloudflare Pages hosts (OPS-013 (1))
    have not been tried from here.

