# ADR-028: AI provider gateway

- Status: Accepted (skeleton built; features follow in M1)
- Date: 2026-10-12
- Backlog: M0-023

## Context

Every self-hosted instance must get the AI features by entering its own provider credentials.
Organisations buy Claude through different channels (the Anthropic API, Amazon Bedrock, Google
Cloud Vertex AI, Microsoft Foundry), and air-gapped sites run local models. Product code must
not know which one is in use, and credentials must never reach the browser or the logs.

## Decision

`@tracksmith/ai` exposes one `AiGateway` with `generate({ feature, system, messages, schema? })`.
Product code names a feature; the gateway applies that feature's model, effort and output
limit, asks for structured output when a Zod schema is given, validates the answer and reports
refusals as data (`refused: true`), not exceptions.

### Providers

| Provider | Client | Model ID spelling |
|---|---|---|
| Anthropic API | `@anthropic-ai/sdk` | `claude-opus-5-5` |
| Amazon Bedrock | `@anthropic-ai/bedrock-sdk` (SigV4 with the admin's keys) | `anthropic.claude-opus-5-5`, or an inference-profile prefix such as `global.anthropic.` |
| Google Cloud Vertex AI | `@anthropic-ai/vertex-sdk` (access token or application default credentials) | `claude-opus-5-5` |
| Microsoft Foundry | `@anthropic-ai/foundry-sdk` (resource name plus key) | `claude-opus-5-5` |
| OpenAI-compatible | plain `fetch` to `/chat/completions` (Ollama, vLLM, LM Studio) | whatever the server serves |

The four Claude clients share one adapter because they share the Messages API; only client
construction and model-ID spelling differ.

### Models and effort

- Default model for every feature: `claude-opus-5-5`. An administrator may pick
  `claude-sonnet-5-5`, `claude-haiku-5-5` or `claude-fable-5-1` per feature, and may turn a
  feature off. Exact IDs only, no date suffixes.
- Effort is explicit per feature (`AI_FEATURES` in `features.ts`) and adjustable by the admin.
  Thinking is adaptive on every request; `budget_tokens`, sampling parameters and forced
  `tool_choice` are never sent, because the current models reject them.
- Structured answers use `output_config.format` with a strict JSON schema derived from the Zod
  schema; the gateway still validates the text with Zod before trusting it.
- The system prompt of a feature is stable, so it is marked cacheable; usage reports cache
  reads and writes so the admin page can show real cost.

### Credentials

Configuration holds only `{ secretId }` references. A `SecretStore` reveals values at client
construction; the gateway scrubs every revealed value from provider error messages. M1 adds the
envelope-encrypted store (master key from the environment, ciphertext in Postgres). Nothing
about the provider reaches the frontend bundle; the Builder (ADR-031) bakes no AI settings.

### Testing

Each adapter has contract tests that inject a recording `fetch` and assert the request on the
wire: URL, auth header, model spelling and body shape. They need no key and no network, so they
run in `pnpm verify` and CI. Real-provider evals (quality, prompt-injection corpus) are nightly
jobs from M1 and need the user's key with a spend cap.

## Options considered

| Option | For | Against |
|---|---|---|
| Official SDK per platform behind one adapter (chosen) | Correct auth and request shaping maintained upstream | Four dependencies |
| One hand-written HTTP client for all platforms | One dependency | Re-implementing SigV4, Vertex auth and version headers |
| Only the Anthropic API | Simplest | Excludes customers who must buy through a cloud marketplace |

## Consequences

Later features plug in by adding an entry to `AI_FEATURES` and calling the gateway. Still to
come: streaming for long answers, tool use for agents (M2), Message Batches for nightly jobs
(Anthropic API only), `inference_geo` for data residency, usage accounting with spend caps, and
embeddings through a bundled local model with pgvector, since the Claude API has no embeddings
endpoint. Server-side refusal fallbacks exist only on the first-party API; the product shows a
plain message on refusal and does not retry on another model.
