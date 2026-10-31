# ADR-099: The AI settings page: provider, write-only keys, live test connection, per-feature model and effort, and switches enforced at one choke point

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-076

## Context

AI-001 asks for an admin page to choose a provider, paste a key or enter platform settings, run
"test connection" (credentials checked and the models listed live from the provider, an invalid
key failing with the provider's message), choose a model per feature, and switch AI on or off
per workspace and per track. AI-006 makes `claude-opus-5-5` the default for every feature, with
the effort of spec 02c section 1.2, and lets administrators change model and effort per feature,
the change taking effect on the next call. IAM-019 (2): in strict mode AI controls stay hidden
until a track is explicitly opted in. The done-when: an end-to-end test shows test connection
listing the fixture models; the default is `claude-opus-5-5`; switches and strict mode hide
controls and block calls.

ADR-098 (M1-075) stores the settings per workspace in `ai_setting` and the keys sealed in
`ai_credential`, and routes every call through `AiService.use`. No AI feature has a control in
the app yet (M1-079 builds them).

## Decision

### Settings (`apps/server/src/ai/settings.ts`, no migration)

`ai_setting.value` gains `strict`, `features` (per feature id: `enabled`, `model` from
`CLAUDE_MODELS`, `effort` from `EFFORTS`; the gateway's `featureSettingsSchema`) and `tracks`
(track id to `true` or `false`). A track switch is explicit or absent: `false` turns AI off in
the track; `true` opts it in under strict mode; absent follows the workspace, which strict mode
turns into off. `scopeBlock(settings, trackId)` decides: `disabled` (workspace off), `track_off`,
`strict` (not opted in, or no track at all), else null. Changes run under the row's lock
(`updateAiSettings`), so a track switch and a page save never undo each other, and every one
moves the version, so the next call in every process builds its client with them.

### One choke point (`AiService.call`)

`call({ workspaceId, trackId, feature }, fn)` refuses before anything is sent, with
`AiUnavailableError(reason)`: `disabled`, `track_off`, `strict`, `feature_off`, `unsupported`
(the model lacks what the feature needs), or the provider's own state (`not_configured`,
`invalid`, `key_unreadable`). The gateway is built with the stored per-feature settings, so a
model or effort change applies at the next call. `features(workspaceId, trackId)` gives the same
answer per feature without calling the provider; `GET /api/v1/ai/features?trackId=` serves it to
anyone signed in (read scope).

### Hiding controls (`apps/web/src/ai/AiFeature.tsx`)

`<AiFeature feature trackId>` renders its children only when that answer says `available`, and
nothing while it loads or when the server cannot be asked. Every AI control the app gets goes
inside one; the server refuses the call anyway. On the settings page itself, the per-feature and
per-track controls are hidden while AI is off for the workspace.

### Routes (`apps/server/src/routes/ai.ts`)

- `GET /api/v1/admin/ai` adds what the page needs: each provider's key slots and required ones,
  the features with their default effort and output, the models and efforts, the default
  model, and every live track with its explicit switch and whether AI may run there (`on`).
- `PUT /api/v1/admin/ai`: `enabled`, `strict`, `provider` (settings only: a key in them is
  refused, keys go through the write-only credential routes; incomplete settings are refused by
  field with Zod's paths and messages, never values), `features`. Event `ai.settings_updated`
  with the changes.
- `PUT /api/v1/admin/ai/tracks/:id` `{ enabled: true | false | null }`. Event
  `ai.track_switched` (track key and value).
- `POST /api/v1/admin/ai/test`: the saved settings, or provider settings and keys sent with the
  request and not saved, so a key can be tried before it is stored. With a model listing (the
  Anthropic API, OpenAI-compatible servers) it answers the models the provider lists right now;
  without one (Bedrock, Vertex AI, Foundry) a token count proves the key and address, and
  `models` is null. A failure answers `ok: false` with the error's kind and the provider's
  message, every key scrubbed out of it (the gateway scrubs the adapter's secrets, the route
  every key it used). It stores nothing and emits no event (exempt in the contract test). It
  waits at most 20 s.
- All under `/api/v1/admin`, so tokens need the admin scope; both new events are audited.

### The page (`apps/web/src/admin/AiSettingsPage.tsx`, `#/admin/ai`, linked from Settings)

The workspace switch, strict mode with what it does, the provider and its settings (the
address for the Anthropic API, region, project, resource, server address and model as each
provider needs), the keys of the provider's slots (password fields, never filled from the server;
the hint says "Stored, ending in …", where it came from, or "Not set"; save and remove per
slot), "Test connection" with the typed keys and the current provider settings, the list of
models or the provider's message, each feature's switch, model (Claude providers; the default is
marked) and effort (its default marked), and the tracks with their switches, saved at once.

### Tests

- `apps/server/src/routes/ai.test.ts`: test connection through the gateway's real Anthropic
  adapter against `FakeProviderServer` (`@taskmoor/ai/testing`, a local port answering from the
  recorded `models.json` and `summary.json`, and the authentication error quoting the key it was
  sent), both with keys sent along and with stored ones; a wrong key's message arrives as
  `invalid x-api-key [redacted]`; keys in provider settings and incomplete settings refused;
  defaults (`claude-opus-5-5`, low effort) and a change to Haiku on the next call; feature, track
  and workspace switches and strict mode, each both in `GET /api/v1/ai/features` and as a refused
  call that sends nothing.
- `apps/web/src/admin/AiSettingsPage.test.tsx`, `apps/web/src/ai/AiFeature.test.tsx`, stories
  with axe for both.
- `apps/web/e2e/ai-settings.spec.ts`: the journey on the attachments backend, whose two
  processes share a master key; api-server.ts runs the fake provider on 8796 and accepts a key
  playwright.config.ts makes per run (`TASKMOOR_E2E_AI_KEY`).

## Options considered

| Option | For | Against |
|---|---|---|
| Switches in `ai_setting` JSON, checked in `AiService.call` (chosen) | One place decides for the page, the API and the calls; no migration | Track switches of deleted tracks linger in the JSON (harmless) |
| A `track.feature_ai` column beside the other track features | Track administrators would see it with the others | Touches every track route and view; strict mode needs a third state anyway |
| Test connection only with saved settings | Simpler | An administrator would have to store a key to learn that it is wrong |
| Models listed from our own list | Works on every platform | AI-001 (2) asks for the provider's live list |

## Consequences

- M1-079 puts each AI control inside `AiFeature` and calls through `AiService.call` with the
  track; nothing else decides whether AI runs.
- M1-077 adds spend limits and the AI audit at the same choke point.
- Bedrock, Vertex AI and Foundry show "the connection works" without models, since their
  platforms offer no listing through the SDK; the model choice stays the Claude list.
- IAM-019's other parts (email content, exports) are not in this change.
