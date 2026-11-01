---
title: "AI settings"
audience: admins
sources: apps/web/src/admin/AiSettingsPage.tsx, apps/web/src/ai/AiFeature.tsx, apps/server/src/routes/ai-features.ts, docs/adr/0108-ai-v1-features.md, packages/ai/src/features.ts, docs/adr/0099-ai-settings-page.md, apps/server/src/routes/ai.ts, apps/server/src/ai/credentials.ts, apps/server/src/ai/environment.ts, apps/server/src/ai/keyring.ts, apps/server/src/ai/service.ts, apps/server/src/ai/settings.ts, packages/iam/src/envelope.ts, packages/ai/src/config.ts, deploy/compose/install.sh, packages/builder-core/src/backend.ts, docs/adr/0028-ai-provider-gateway.md, docs/adr/0098-ai-key-storage.md, docs/specs/02c-platform-api-and-integrations.md, docs/specs/05a-administration-security-and-self-hosting.md, docs/adr/0106-local-embeddings-and-vector-search.md
accessed: 2026-11-01
attestation: own-words
---
# AI settings

Taskmoor's AI features run on an AI provider that you choose and pay for directly: the
Anthropic API, Amazon Bedrock, Google Vertex AI, Microsoft Foundry, or a server of your own that
speaks the OpenAI chat API (Ollama, vLLM and similar). Taskmoor adds no metering of its own.
Nothing is sent to a provider until AI is switched on and a provider is set up.

Site administrators find the settings under **Settings > AI**.

## Setting the provider and key

- **On the AI page.** Choose the provider and fill in what it needs: nothing more for the
  Anthropic API (an address only if you reach it through a proxy of your own), the region for
  Bedrock, the region and project for Vertex AI, the resource name for Foundry, and the server's
  address and model for an OpenAI-compatible server. Save, then paste the key and choose
  **Save API key**. The key field is always empty: under it the page says "Stored, ending in"
  and the last four characters, or "Not set".
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

## Testing the connection

**Test connection** asks the provider for the models it offers right now, with the settings on
the page and any key typed into the key field but not saved yet, so you can try a key before you
store it. It lists the models, or shows the provider's own error message (a wrong key, a wrong
address), with any key taken out of it. Bedrock, Vertex AI and Foundry do not list their models
this way: for them the test counts the tokens of a short text and says the connection works. The
same test is `POST /api/v1/admin/ai/test`.

## Features, models and effort

With AI on, the page lists each feature: summaries of tickets and threads, search in plain
language, drafting tickets from a description, and likely duplicates while creating a ticket.
For each you can switch it off, choose the model and choose the effort.

- Every feature uses `claude-opus-5-5` unless you choose `claude-sonnet-5-5`,
  `claude-haiku-5-5` or `claude-fable-5-1`. An OpenAI-compatible server uses its own model for
  everything, so the page offers no model choice then.
- The effort is how much the model thinks before it answers: low for summaries, search and
  duplicates, medium for drafting, unless you change it.
- A change applies to the next AI call, in every server process.

## Where AI is on

- **The workspace switch**, "Use AI in this workspace", turns everything on or off. Off, no
  AI control shows anywhere and the server refuses every AI call. The page then hides the
  feature and track settings too.
- **Track switches** turn AI off in one track (or back on). They take effect at once.
- **Strict mode** is for regulated data: AI stays off, and its controls hidden, everywhere except
  the tracks you switch on in the list. Outside any track (for example search across tracks) it
  stays off as well.

People see an AI control only where the feature is available to them, and the server checks the
same rules again on every call, so a control that is hidden is also refused. The app asks
`GET /api/v1/ai/features?trackId=` which features are available in a track; anyone signed in
can ask it.

The same settings are under `PUT /api/v1/admin/ai` (workspace switch, strict mode, provider
settings and features, never a key) and `PUT /api/v1/admin/ai/tracks/{id}` with `{"enabled":
true}`, `false` or `null` (back to the default). Every change is in the audit log.

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

## What people get

With a provider set up and AI on, people see the features where they apply: summaries on the
ticket page, **Ask in plain language** on the search page, **Draft from text** in the create
dialog, **Break down** on a ticket, and AI reasons beside the duplicate suggestions of the
create dialog. [Using AI features](../use/ai.md) describes them. The settings above decide where
each one shows: a feature switched off, a track switched off or kept out by strict mode hides
its control, and the server refuses the call anyway.

- Every feature reads as the person using it: only tickets, comments and fields they may see go
  to the provider, and fields marked sensitive are replaced first.
- Nothing is changed by AI on its own. Drafts and breakdowns are proposals; tickets are created
  only when the person confirms, with their own rights.
- Every call is counted against the spend limits and recorded in the AI audit log
  ([AI usage](ai-usage.md)).
- Duplicate suggestions come from the bundled embedding model and work with no provider; the
  AI only re-orders them, within 2 seconds, and is skipped when it is slower.

The routes are `POST /api/v1/tickets/{id}/ai/summary` (streamed), `POST /api/v1/ai/query`,
`POST /api/v1/ai/drafts`, `POST /api/v1/tickets/{id}/ai/breakdown` and
`POST /api/v1/tickets/similar` with `"reasons": true`. A read token reaches them, since none
of them changes anything.

## What is not there yet

- **Images in drafts.** Drafting reads pasted text only; images wait for a later release.

- **A key service.** Wrapping keys with a cloud KMS or HashiCorp Vault instead of the master
  key is designed for, but no setting turns it on yet.
- **`install.ps1`** does not remove `TASKMOOR_AI_KEY` from `.env` after the first start: delete
  the line yourself.
