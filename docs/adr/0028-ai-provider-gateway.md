# ADR-028: AI provider gateway

- Status: Accepted (gateway core and request policy built in M1; settings, key storage and spend
  limits follow in M1-075 to M1-077)
- Date: 2026-10-12, updated 2026-10-28
- Backlog: M0-023, M1-073, M1-074

## Context

Every self-hosted instance must get the AI features by entering its own provider credentials.
Organisations buy Claude through different channels (the Anthropic API, Amazon Bedrock, Google
Cloud Vertex AI, Microsoft Foundry), and air-gapped sites run local models. Product code must
not know which one is in use, and credentials must never reach the browser or the logs.

## Decision

`@taskmoor/ai` exposes one `AiGateway` with `generate({ feature, system, messages, schema?,
tools? })` and `stream(...)`. Product code names a feature; the gateway applies that feature's
model, effort and output limit, asks for structured output when a Zod schema is given, validates
the answer and reports refusals as data (`refused: true`), not exceptions.

### Providers

| Provider | Client | Model ID spelling |
|---|---|---|
| Anthropic API | `@anthropic-ai/sdk` | `claude-opus-5-5` |
| Amazon Bedrock | `AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk`: the Messages API endpoint (`bedrock-mantle.<region>.api.aws/anthropic`), SigV4 with the admin's keys, a Bedrock API key, or the server's AWS role | `anthropic.claude-opus-5-5` |
| Google Cloud Vertex AI | `@anthropic-ai/vertex-sdk` (access token or application default credentials) | `claude-opus-5-5` |
| Microsoft Foundry | `@anthropic-ai/foundry-sdk` (resource name plus key) | `claude-opus-5-5` |
| OpenAI-compatible | plain `fetch` to `/chat/completions` (Ollama, vLLM, LM Studio) | whatever the server serves |

The four Claude clients share one adapter because they share the Messages API; only client
construction and model-ID spelling differ.

### Models and effort

- Default model for every feature: `claude-opus-5-5`. An administrator may pick
  `claude-sonnet-5-5`, `claude-haiku-5-5` or `claude-fable-5-1` per feature, and may turn a
  feature off. Exact IDs only, no date suffixes.
- Effort is explicit per feature (`AI_FEATURES` in `features.ts`, the values of spec 02c
  section 1.2: summaries, query from text and duplicates `low`, assisted creation `medium`) and
  adjustable by the admin. Thinking is adaptive on every request; `budget_tokens`, sampling
  parameters and forced `tool_choice` are never sent, because the current models reject them.
  The output limit is 16,000 tokens per feature, because adaptive thinking counts against it.
- Structured answers use `output_config.format` with a strict JSON schema derived from the Zod
  schema; the gateway still validates the text with Zod before trusting it. Tools are strict and
  offered with automatic tool choice.
- The system prompt of a feature is stable, so it is marked cacheable; usage reports cache
  reads and writes so the admin page can show real cost.

### Credentials

Configuration holds only `{ secretId }` references. A `SecretStore` reveals values at client
construction; the gateway scrubs every revealed value from provider error messages. M1 adds the
envelope-encrypted store (master key from the environment, ciphertext in Postgres). Nothing
about the provider reaches the frontend bundle; the Builder (ADR-031) bakes no AI settings.

### Testing

Each adapter has contract tests that replay recorded fixtures: the request on the wire (URL,
auth header, model spelling, exact body) is compared with the recording, and the recorded answer
is fed back. They need no key and no network, so they run in `pnpm verify` and CI. A live smoke
test runs when `TASKMOOR_AI_TEST_KEY` is set. Real-provider evals (quality, prompt-injection
corpus) are nightly jobs from M1 and need the user's key with a spend cap.

## Options considered

| Option | For | Against |
|---|---|---|
| Official SDK per platform behind one adapter (chosen) | Correct auth and request shaping maintained upstream | Four dependencies |
| One hand-written HTTP client for all platforms | One dependency | Re-implementing SigV4, Vertex auth and version headers |
| Only the Anthropic API | Simplest | Excludes customers who must buy through a cloud marketplace |
| Bedrock through `InvokeModel` (`AnthropicBedrock`) | Inference-profile IDs | Legacy path with its own request shape; the Messages API endpoint (Mantle) is the current one |
| Retries inside the SDK (`maxRetries`) | No code | Untyped, unlogged, unaware of streams and of a circuit breaker |

## Implementation (M1-073, M1-074)

`packages/ai/src`:

- **One provider interface** (`types.ts`, `ProviderAdapter`): `generate`, `stream` (text deltas
  through a callback), `countTokens`, `listModels`, optional `batches`, `capabilities(model)` and
  `classifyError`. `createProviderAdapter(config, secrets)` (`factory.ts`) builds the adapter for
  a configured provider. A new provider implements the interface; feature code does not change.
- **Capabilities** per provider and model (streaming, structured output, tool calls, strict
  tools, effort, prompt caching, token counting, model listing, batches, refusal fallback).
  Each feature lists what it needs; `gateway.availability(feature)` says whether to show it and
  what is missing, and `generate` refuses a schema or tools the model cannot take
  (`AiUnsupportedError`) before anything is sent.
- **Claude request** (`adapters/claude-request.ts`): `buildClaudeParams` builds one body for all
  four platforms: tools sorted by name, then the instructions and the scope context as two
  `system` blocks with a cache breakpoint each, volatile messages last; adaptive thinking; the
  feature's effort; strict structured output or strict tools with `tool_choice: auto`.
  `assertClaudeRequestPolicy` (`policy.ts`) checks every body before it leaves (also batch
  items and token counts): a forced tool choice, a thinking budget, disabled thinking, sampling
  parameters, a missing effort or a non-strict tool throw `AiPolicyError`.
- **Answers**: `stop_reason` is read before content. A refusal never yields text or tool calls,
  even partial ones; the stream emits a `refused` event so the UI discards what it showed.
  Assistant turns keep the provider's own content (`message.native`), so thinking blocks go back
  unchanged on the next turn.
- **Refusal fallbacks**: on the Anthropic API, requests for Opus 5.5, Opus 5, Sonnet 5.5 and Fable 5.1
  carry `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), so the API retries a
  refusal on the model it recommends for the category. Bedrock, Vertex AI and Foundry have no
  server-side fallback; when the admin sets `refusalFallbackModel`, the SDK's
  `betaRefusalFallbackMiddleware` retries on that model with the refusal's credit token (beta
  `fallback-credit-2026-07-01`). Haiku has no fallback. An answer from a fallback is marked
  `fellBack`, and usage sums every attempt (`usage.iterations`). When such a turn is sent back,
  the `fallback` seams and the declined model's thinking and tool calls are left out.
- **Retries** belong to the gateway; the SDK makes one attempt. Rate limits, overloads (529),
  5xx, timeouts and lost connections are retried twice by default with exponential backoff
  (500 ms doubling, at most 8 s) and jitter; `retry-after-ms` and `retry-after` (seconds or a
  date) are honoured up to 60 s, and a longer wait fails the call instead. `x-should-retry`
  overrides the guess. Each retry is logged (`logger.warn`, metadata only: provider, feature,
  attempt, delay, kind, status). A stream is retried only before its first text; a batch
  submission only after an explicit 429 or 529, so a lost answer cannot create a second batch.
- **Circuit breaker** per gateway: five calls in a row that end in an outage (overload, 5xx,
  timeout, connection) open it for 30 s; calls then fail at once (`AiCircuitOpenError`), so a
  core action that uses AI on the side completes without it. After the cool-down one trial call
  decides.
- **Errors** are typed (`AiProviderError.kind`: `rate_limited`, `overloaded`, `server`,
  `timeout`, `connection`, `authentication`, `permission`, `not_found`, `invalid_request`,
  `request_too_large`), read from the SDK's error classes, never from message text. Messages are
  scrubbed of every credential; the raw SDK error is not kept as `cause`, and the SDK's own
  logging is off (`logLevel: 'off'`).
- **Structured output**: `strictJsonSchema` runs the SDK's strict transform on Zod's JSON
  schema without its `$schema` marker (which would otherwise land in the description). An
  answer that is not JSON or fails the Zod schema gets one repair attempt (the answer and a note
  naming the problems are appended), then `AiOutputError`. An answer cut off at the output limit
  is never repaired. Tool inputs are validated with the tool's Zod schema before they are
  returned; calls to unknown tools fail.
- **Streaming**: `gateway.stream()` is an async iterable of `text` and `refused` events with a
  `result` promise and `abort()`; leaving the loop or aborting the caller's signal closes the
  connection, which stops generation and billing.
- **Batches** (Anthropic API only): `submitBatch` for one feature (item IDs of 1 to 64 letters,
  digits, `-` or `_`; at most 100,000 items), `batchStatus`, `cancelBatch` and `batchResults`
  work from the batch ID alone, so a job resumes after a restart. Results are matched by item
  ID and validated per item (`invalid_output` when the schema fails). Batch requests carry no
  server-side fallback, which the Batches API rejects.
- **Token counting** uses the generally available endpoint on every Claude platform; **model
  listing** the Models API (Anthropic API only).
- **OpenAI-compatible** (`adapters/openai-compatible.ts`): chat completions with
  `response_format: json_schema` (strict), strict function tools with `tool_choice: auto`,
  streaming with `include_usage`, `GET /models`. Tool support is read from Ollama's
  `/api/show` (`capabilities` contains `tools`); other servers keep the defaults (JSON schema
  yes, tools no) unless the configuration states them. Effort, prompt caching, token counting
  and batches are reported as unavailable.
- **Tests**: recorded fixtures in `adapters/__fixtures__/<platform>/*.json`, written from the
  documented API shapes (placeholders for every credential and ID). `replayFetch`
  (`testing.ts`) compares each request with the recording and reports every difference;
  `FakeAdapter` scripts answers for gateway tests and for packages that use the gateway. Policy
  tests include property tests (no generated request ever carries a forced tool choice; tool
  order never changes the prefix). `live.test.ts` covers the Anthropic API end to end, including
  a repeated call that must read the cache, and is skipped without `TASKMOOR_AI_TEST_KEY`.

Decisions made while building:

1. Bedrock goes through the Messages API endpoint (Mantle). Model IDs carry the `anthropic.`
   prefix only; the inference-profile prefixes of the legacy `InvokeModel` path (`global.`,
   `us.`) and the `modelPrefix` setting are gone. Bedrock may also use a Bedrock API key or the
   server's AWS role.
2. Refusal fallbacks are on by default where the API offers them; the earlier "the product
   does not retry on another model" is replaced. On the other platforms the fallback is opt-in
   through `refusalFallbackModel`, because the substitute must be a model the admin has enabled
   on that platform.
3. The gateway owns retries and the circuit breaker (SDK `maxRetries: 0`).
4. Feature efforts follow spec 02c section 1.2; output limits leave room for thinking.
5. Provider error details stay out of `cause`, so a logger that serialises causes cannot leak
   request data.

## Consequences

Later features plug in by adding an entry to `AI_FEATURES` and calling the gateway. Still to
come: key storage and the settings page (M1-075, M1-076), usage accounting with spend caps and
the audit log (M1-077), agent loops with budgets (AI-011), `inference_geo` for data residency
(AI-010), and embeddings through a bundled local model with pgvector (M1-078), since the Claude
API has no embeddings endpoint. Bulk jobs on providers without batches go through the job queue
(ADR-015) at a limited rate.
