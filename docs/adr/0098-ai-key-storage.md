# ADR-098: AI provider keys under envelope encryption, write-only, moved in from the environment, rotated without failed calls

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-075

## Context

IAM-020 asks for AI provider keys to be encrypted at rest with envelope encryption under the
instance master key (optionally a KMS or Vault), write-only in the UI with only the last four
characters shown, never sent to the browser or written to logs, and rotated without downtime.
A key the Builder's backend kit puts in `.env` (`TASKMOOR_AI_PROVIDER`, `TASKMOOR_AI_KEY`)
moves into encrypted storage on first boot, and the installer then removes it from the file.
AI-001 (3) asks that such a start enables AI with no UI step. The done-when: the key is absent
from logs, API responses and the web bundle (tests), and a rotation under load causes 0 failed
calls.

Until now the gateway (ADR-028) took credentials from a `SecretStore` with an in-memory fake
only, and the server read neither `TASKMOOR_MASTER_KEY` nor `TASKMOOR_AI_*`. TOTP seeds, LDAP
bind passwords and the Cloud importer's token are sealed with the pepper ring
(`sealSecret`, AES-256-GCM under a key derived from the pepper), which is single-layer: changing
the pepper means re-encrypting every secret.

## Decision

### Envelope encryption (`packages/iam/src/envelope.ts`)

- Each secret gets its own random 32-byte data key; the secret is encrypted with it
  (AES-256-GCM, `v1.<iv>.<ciphertext>.<tag>` in base64url) and bound by additional data to where
  it is stored (`taskmoor ai credential:<workspace>:<slot>`), so a row copied to another slot or
  workspace does not open.
- The data key is wrapped by a **key-encryption key** (`KeyEncryptionKey`: `id`, `wrap`,
  `unwrap`). The row stores the wrapped data key and the wrapping key's id, never the key.
- `LocalKek.fromSecret(masterKey)`: HKDF-SHA-256 of the master key. Its id is `master:` and a
  12-character fingerprint of a second HKDF output, so the id reveals nothing about the key.
  `LocalKek.fromPepper(pepper)` (`pepper:<pepper id>`) is the same derivation from the active
  password pepper.
- `ExternalKek` wraps an `ExternalKeyService` (`kind: 'kms' | 'vault'`, `keyRef`,
  `encrypt(bytes) → string`, `decrypt(string) → bytes`). A cloud KMS (AWS KMS `Encrypt` and
  `Decrypt` with the key's ARN, Google Cloud KMS, Azure Key Vault wrap and unwrap) and Vault's
  transit engine (`POST transit/encrypt/<name>` and `transit/decrypt/<name>` with base64
  plaintext) each map to those two calls. The service only ever sees data keys. M1 ships the
  interface and `FakeKeyService` (`@taskmoor/iam/testing`); a real one plugs in by implementing
  the interface and passing it to `aiKeyRing({ external })` in `main.ts`. No environment variable
  selects one yet.
- `KeyRing`: the active key wraps new data keys; older keys (and any pepper the pepper ring can
  find, such as one a restore added) still unwrap. `rewrapEnvelope` re-wraps a data key under the
  active key without touching the ciphertext.

### Which key wraps (`apps/server/src/ai/keyring.ts`)

A plugged-in key service first, then `TASKMOOR_MASTER_KEY` (the Builder kit writes 32 random
bytes in base64url; any secret of 32 characters or more is accepted), then the install's active
password pepper, which a Compose install without a master key has in `TASKMOOR_DATA` and which
backups carry. With none of them, credentials cannot be stored: the API answers 409
`key_storage_unavailable` and an environment key stays out (the log says why).

Changing the master key: set the new one in `TASKMOOR_MASTER_KEY` and the old one in
`TASKMOOR_MASTER_KEY_PREVIOUS` (comma-separated). At start the API role re-wraps every data key
the active key did not wrap (`rewrapCredentials`, only rows nobody replaced meanwhile), logs how
many, and logs a count of rows wrapped by a key it does not have. After that start the previous
key can go.

### Storage (migration 0074)

- `ai_setting`: one row per workspace with the settings as JSON (here: `enabled` and the
  provider's non-secret settings; M1-076 adds the rest), a `version` that every settings or
  credential change moves, and `environment_imported_at`.
- `ai_credential`: per workspace and slot (`apiKey`, `accessKeyId`, `secretAccessKey`,
  `sessionToken`, `accessToken`, the `ProviderConfig` field names), the ciphertext, the wrapped
  data key, the wrapping key's id, `last4` (empty when the secret is shorter than 12
  characters), `source` (`admin` or `environment`), who changed it and when.
- The stored provider settings never hold a secret reference. When a client is built, each
  slot that holds a credential and that the provider takes becomes `{ secretId: <slot> }`
  (`withCredentialRefs`), and the result is checked with the gateway's own `providerConfigSchema`.

### Write-only API (`apps/server/src/routes/ai.ts`)

- `GET /api/v1/admin/ai`: settings, credential summaries (slot, last four, source, who and
  when) and `keyStorage` (`kms`, `vault`, `master_key`, `pepper` or `none`).
- `PUT /api/v1/admin/ai/credentials/:slot` `{ value }`: set or replace. Surrounding white space
  is dropped; inside, only printable characters without spaces. A refusal never echoes the
  value. Event `ai.credential_set` (`slot`, `last4`, `replaced`, `source`).
- `DELETE /api/v1/admin/ai/credentials/:slot`: event `ai.credential_deleted`.
- Site administrators only; the routes are under `/api/v1/admin`, so tokens need the admin
  scope. Both events are audited. No route returns a credential.

### The environment on first start (`apps/server/src/ai/environment.ts`)

The API role, after migrating, takes `TASKMOOR_AI_PROVIDER`, `TASKMOOR_AI_KEY` and, for the
platforms that need them, `TASKMOOR_AI_REGION`, `_PROJECT`, `_RESOURCE`, `_BASE_URL` and
`_MODEL`. Under an advisory lock (several API processes may start at once) and only if the
workspace has no AI settings, credentials or earlier import: the key is sealed into its
provider's slot (`accessToken` for Vertex AI, `apiKey` otherwise) with `source: environment`
and an `ai.credential_set` event without an actor, the provider settings are stored, and AI is
switched on when they are complete (otherwise it stays off and the log lists the missing paths).
Every later start logs that the environment is ignored. Log lines name variables and providers,
never a value or the last four characters. Both installers (`deploy/compose/install.sh` and the
kit's `install.sh`) remove the `TASKMOOR_AI_KEY` line from `.env` once the backend is ready and
its log says the database holds the settings. `install.ps1` does not do this yet.

### Rotation without failed calls (`apps/server/src/ai/service.ts`)

`AiService.use(workspaceId, fn)` reads the workspace's settings row (one primary-key lookup)
and runs `fn` with the gateway built for that version. Calls for one version share one build; a
call that read an older version gets the newer client. A replaced client is retired, not
closed: calls already running keep it, retries included, until they finish. `drained(ws,
version)` builds the current client and resolves when no call holds an older one, which is when
the old key may be revoked at the provider. Building reads the credentials, opens them into an
in-memory store for the adapter factory and keeps nothing else; the adapter's `secretValues`
let the gateway scrub them from provider errors (ADR-028).

### Tests

- `packages/iam/src/envelope.test.ts`: fresh data key per seal, binding to the slot, tampering,
  unknown keys, fingerprints, master key rotation by re-wrapping, a fake KMS and a fake Vault that
  only see 32-byte data keys, a property test.
- `apps/server/src/ai/keys.test.ts` (keys made at run time, never printed but as last four):
  the environment import (two processes at once, then ignored), the write-only API, rotation
  under load (16 concurrent callers through the gateway with a fake provider that checks the key
  per request; the old key is revoked once `drained` resolves; two runs: 456 and 381 calls, 0
  failed, both keys used), and the leak check: every key the tests used is absent from the
  server's trace-level log, every API answer and header, the domain events and the audit log,
  including a provider error that quotes the key.
- `apps/web/build/artefact.test.ts`: a real Vite build with `TASKMOOR_AI_KEY`,
  `VITE_TASKMOOR_AI_KEY`, `TASKMOOR_MASTER_KEY` and `VITE_TASKMOOR_MASTER_KEY` set to fresh
  values ships none of them.

## Options considered

| Option | For | Against |
|---|---|---|
| Envelope encryption with a data key per secret (chosen) | Changing the master key re-wraps 32-byte keys only; a KMS or Vault sees data keys, never provider keys; IAM-020 asks for it | Two layers to explain |
| `sealSecret` with the pepper, as TOTP seeds | Exists | One layer: a key change re-encrypts every secret; no KMS path |
| Keep the key in the environment | Nothing to build | Fails IAM-020: the key sits in `.env` and in every process's environment |
| Refuse to store keys without a master key | Simpler rule | Compose installs without the Builder would have no way to use AI; the pepper is already outside the database and backed up |
| Re-read credentials on every call | Always current | A database read and a decryption per call; the version row does the same job |

## Consequences

- AI can be switched on by the kit alone; the key leaves `.env` on the first install.
- Losing the master key loses the stored AI keys (not the instance): enter them again. Backups
  hold ciphertext only, so a restore needs the same master key, or the pepper keyring the backup
  carries when no master key was set.
- A real KMS or Vault needs a small adapter and a way to configure it; the interface is fixed.
- The gateway's circuit breaker is per client, so a key change resets it.
- M1-076 builds the settings page on these routes; M1-077 (spend limits, AI audit) uses
  `AiService.use` as the one place calls pass.
