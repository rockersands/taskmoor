---
title: "AI settings"
audience: admins
sources: apps/server/src/routes/ai.ts, apps/server/src/ai/credentials.ts, apps/server/src/ai/environment.ts, apps/server/src/ai/keyring.ts, apps/server/src/ai/service.ts, apps/server/src/ai/settings.ts, packages/iam/src/envelope.ts, packages/ai/src/config.ts, deploy/compose/install.sh, packages/builder-core/src/backend.ts, docs/adr/0028-ai-provider-gateway.md, docs/adr/0098-ai-key-storage.md, docs/specs/02c-platform-api-and-integrations.md, docs/specs/05a-administration-security-and-self-hosting.md
accessed: 2026-10-31
attestation: own-words
---
# AI settings

Taskmoor's AI features run on an AI provider that you choose and pay for directly: the
Anthropic API, Amazon Bedrock, Google Vertex AI, Microsoft Foundry, or a server of your own that
speaks the OpenAI chat API (Ollama, vLLM and similar). Taskmoor adds no metering of its own.
This page covers the provider and its key; nothing is sent to a provider until one is set up.

## Setting the provider and key

- **From the Builder's backend kit or the environment.** Give `TASKMOOR_AI_PROVIDER` and
  `TASKMOOR_AI_KEY` (and the region, project or address your provider needs: see
  [configuration](configuration.md#ai-providers)). On the first start the server stores them,
  the key encrypted, and switches AI on. The install script then removes the key from `.env`.
  Later starts ignore these variables.
- **Through the API.** A site administrator, or a token with the admin scope, sets a key with
  `PUT /api/v1/admin/ai/credentials/apiKey` and the body `{"value": "<the key>"}`, and removes it
  with `DELETE` on the same address. `GET /api/v1/admin/ai` shows the settings and, for each
  stored key, its last four characters, where it came from and who set it when.

Keys are **write-only**. Once stored, no page, answer, event, audit record or log line shows
more of a key than its last four characters (none at all for one shorter than 12 characters).
To check which key is in use, compare those four characters with your provider's console.

The places a key can go are named after the provider settings that take them: `apiKey` (the
Anthropic API, a Bedrock API key, Foundry, an OpenAI-compatible server), `accessKeyId`,
`secretAccessKey` and `sessionToken` (Bedrock with AWS access keys) and `accessToken` (Vertex
AI). Bedrock and Vertex AI can also use the server's own cloud credentials and need no key.

## Replacing a key

Put the new key the same way. New AI calls use it at once, in every server process; calls
already running finish with the key they started with, so nobody sees an error. Revoke the old
key at your provider a minute later, when those calls are done.

## How keys are kept

Each key is encrypted with a key of its own, and that key is in turn encrypted (wrapped) with
the instance's **master key**, which never enters the database. A copy of the database or a
backup therefore holds no readable AI key.

- The master key is `TASKMOOR_MASTER_KEY`, which the Builder's backend kit writes for you.
- Without it, the password pepper (`TASKMOOR_PASSWORD_PEPPER` or the keyring in
  `TASKMOOR_DATA`) wraps the keys instead. Backups carry that keyring.
- Without either, AI keys cannot be stored: the API answers `409 key_storage_unavailable` and
  a key given in the environment is left alone (the log says so).

`GET /api/v1/admin/ai` reports which one is in use as `keyStorage`: `master_key`, `pepper` or
`none`.

**Changing the master key.** Set the new key in `TASKMOOR_MASTER_KEY` and the old one in
`TASKMOOR_MASTER_KEY_PREVIOUS`, then restart. The server re-wraps every stored AI key with the
new master key and logs how many it moved. After that start, remove
`TASKMOOR_MASTER_KEY_PREVIOUS`. If the log says some keys are wrapped by a key the server does
not have, the old key is missing from the list.

**Losing the master key** loses the stored AI keys, nothing else: set a new master key and
enter the provider keys again.

## What is not there yet

- **A key service.** Wrapping keys with a cloud KMS or HashiCorp Vault instead of the master
  key is designed for, but no setting turns it on yet.
- **`install.ps1`** does not remove `TASKMOOR_AI_KEY` from `.env` after the first start: delete
  the line yourself.
