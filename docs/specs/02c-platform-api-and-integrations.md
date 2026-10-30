---
spec: 02c
title: "Platform, API and integrations: AI gateway and AI features"
sources: docs/research/sources.md
accessed: 2026-10-11
attestation: own-words
---
# 02c Platform, API and integrations: AI gateway and AI features

This file specifies the AI layer of Taskmoor. Every self-hosted install can switch AI on by pasting a cloud AI key (or pointing at a local model), with no vendor metering by Taskmoor: the customer pays its AI provider directly and sets its own spend limits. Claude models are the default, reached through Anthropic's official SDK either directly or through the customer's existing Amazon Bedrock, Google Vertex AI or Microsoft Foundry account; OpenAI-compatible and local endpoints cover air-gapped sites. The file defines the provider settings, one internal gateway that all AI features call, default models and effort per feature, and the features themselves by milestone. Security, privacy and cost controls for AI are in file 05a (IAM-020 to IAM-023), file 05b (OPS-020) and NFR-011 and NFR-012.

## How to read

- **ID**: `MODULE-NNN`, stable and never reused. This file holds AI.
- **MS**: M1 = release 1.0, Jira Software parity and Data Center exit core; M2 = enterprise, automation and service-desk core; M3 = ITSM, operations and CMDB; M4 = discovery, portfolio, quality and ecosystem.
- **Pri**: M = Must, S = Should, C = Could.
- **Source**: parity target. "exceeds Jira" marks a deliberate improvement; "verify" marks facts to confirm before relying on them. Anthropic API details below (model IDs, parameters, platform clients) come from Anthropic's SDK reference as of October 2026, not from the Jira research; confirm feature availability per platform at build time.
- **Terms**: ticket (Jira: issue); query = the query language of file 01b (native, with a Jira-compatible dialect); agent = an AI principal that can be assigned or mentioned; file 00 lists the full vocabulary.

## 1. Reference: providers, models and gateway

### 1.1 Provider matrix

| Provider | Client | Credentials and settings | Model ids | MS |
|---|---|---|---|---|
| Anthropic Claude API | Official Anthropic SDK, first-party client | API key | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` | M1 |
| Amazon Bedrock | Official SDK Bedrock client (Messages API endpoint) | AWS access key or role, region (required) | Same ids with an `anthropic.` prefix, for example `anthropic.claude-opus-5-5` | M1 |
| Google Vertex AI | Official SDK Vertex client | Service account or application default credentials, project id, region (`global` recommended) | Bare ids, for example `claude-opus-5-5` | M1 |
| Microsoft Foundry | Official SDK Foundry client | Foundry resource name and key, or Entra ID | Model or deployment name as configured (verify naming) | M1 |
| OpenAI-compatible endpoint | HTTP client for chat-completions-compatible servers (Ollama, vLLM and similar) | Base URL, optional key | Read from the endpoint's model list | M1 |
| Other hosted providers | Adapter per provider behind the same interface | Provider-specific | Read from the provider's model list | M2 |

Rules: Claude models are always called through the official Anthropic SDK (first-party or platform client), never through an OpenAI-compatible shim. Feature availability differs by platform (for example batch processing, server-side refusal fallback, inference region selection and model listing); the gateway records capabilities per configured provider and model and degrades features accordingly.

### 1.2 Default model and effort per feature

| Feature | Default model | Effort | Output mode | MS |
|---|---|---|---|---|
| Ticket and comment-thread summaries | `claude-opus-5-5` | low | Streamed text | M1 |
| Natural language to query | `claude-opus-5-5` | low | Structured (query, explanation) | M1 |
| AI-assisted creation and breakdown | `claude-opus-5-5` | medium | Structured (list of drafted tickets) | M1 |
| Duplicate suggestions at create time | `claude-opus-5-5` | low | Structured (candidate ids, reasons) | M1 |
| Triage suggestions | `claude-opus-5-5` | low | Structured (values with reasoning) | M2 |
| Automation rule from natural language | `claude-opus-5-5` | medium | Structured (rule JSON) | M2 |
| Agents as delegates; coding-agent hand-off | `claude-opus-5-5` | high | Tool calls, streamed progress | M2 |
| Dashboard chart from natural language | `claude-opus-5-5` | medium | Structured (chart spec) | M2 |
| Semantic search re-ranking | `claude-opus-5-5` | low | Structured (ranking) | M2 |
| Writing and formula assistance | `claude-opus-5-5` | medium | Streamed text or structured formula | M2 |
| Virtual service agent | `claude-opus-5-5` | high | Tool calls, streamed | M3 |
| Incident summaries; alert grouping | `claude-opus-5-5` | low | Streamed text; structured groups | M3 |
| Postmortem drafts | `claude-opus-5-5` | medium | Streamed text | M3 |
| Custom agents and scheduled agent jobs | `claude-opus-5-5` | high | Tool calls | M3 |
| Discovery evidence clustering | `claude-opus-5-5` | low | Structured, batch | M4 |
| Customer-service reply drafts | `claude-opus-5-5` | medium | Streamed text | M4 |

Admins may switch any feature to `claude-sonnet-5-5` or `claude-haiku-5-5`, or to a model of another configured provider, and may change effort per feature. Model ids are used exactly as written, with no date suffixes. Request rules for current Claude models: always send the effort explicitly (Opus 5.5 defaults to medium); use adaptive thinking and never send a "thinking disabled" setting or a fixed thinking budget (rejected on these models); never force a specific tool choice (rejected on Opus 5.5 and Sonnet 5.5): use automatic tool choice with strict tool schemas, or structured outputs; read `stop_reason` before reading content.

### 1.3 Default price table for cost tracking (admin-editable)

Anthropic first-party list prices per million tokens, October 2026: `claude-opus-5-5` $4 input, $20 output, $0.20 cache read; `claude-sonnet-5-5` $2 input, $10 output, $0.20 cache read; `claude-haiku-5-5` $0.10 input, $0.50 output for prompts up to 100K tokens ($0.50 and $2.50 beyond). Batch requests cost half. Bedrock and Vertex AI price separately; admins enter their own rates. Treat all figures as defaults to verify at release.

### 1.4 Gateway pipeline

1. Feature request arrives with the requesting user, track and feature id.
2. Checks: AI enabled for workspace, track and feature; user may see every piece of content to be sent; spend limit not reached (OPS-020).
3. Redaction rules applied (IAM-022).
4. Prompt assembled with a stable prefix (tool definitions, system instructions, track context) and volatile parts last, so prompt caching works; untrusted content (ticket text, emails, web pages) is wrapped and labelled as data (IAM-023).
5. Provider call: streaming for long outputs, structured outputs where a machine reads the result, tool calls validated against their schemas.
6. Result validated; on failure one repair attempt, then a clear error.
7. Audit record written with metadata only (IAM-021) and cost booked against user and workspace.

## 2. AI requirements

| ID | Requirement | Acceptance criteria | MS | Pri | Source |
|---|---|---|---|---|---|
| AI-001 | **AI provider settings.** Taskmoor shall provide an admin page to choose a provider, paste an API key or enter platform credentials, run "test connection" (validates credentials and lists available models live from the provider's model listing), select a model per feature, and switch AI on or off per workspace and per track; the same settings are accepted from environment variables for headless installs. | (1) An invalid key fails the test with the provider's error message. (2) A valid key lists models fetched live, not from a hard-coded list. (3) Starting the server with the provider and key set in environment variables (as written by the Builder's backend kit, OPS-015) enables AI with no UI step, and the key then moves into encrypted storage (IAM-020). | M1 | M | User requirement; exceeds Jira (no BYO key) |
| AI-002 | **Provider interface.** Taskmoor shall route every AI call through one internal provider interface covering text generation, streaming, structured output, tool calls, token counting, model listing and batch submission, with a capability record per provider and model. | (1) Adding a provider requires implementing only the interface; no feature code changes. (2) A feature whose capability is missing on the selected model is hidden with an explanation. | M1 | M | User requirement |
| AI-003 | **Anthropic provider.** Taskmoor shall call Claude through the official Anthropic SDK, directly with an API key or through the customer's Amazon Bedrock, Google Vertex AI or Microsoft Foundry account (section 1.1). | (1) The same summary feature works against each of the four access paths in integration tests. (2) Bedrock requests use region-scoped `anthropic.`-prefixed ids; Vertex requests use project, region and bare ids. | M1 | M | User requirement |
| AI-004 | **OpenAI-compatible and local endpoints.** Taskmoor shall support OpenAI-compatible endpoints such as Ollama and vLLM for air-gapped installs, detecting tool-call and JSON-schema support and degrading features that need them. | (1) With only a local Ollama endpoint configured and no internet, summaries work. (2) Models without tool calling never receive agent features. | M1 | M | User requirement; Plane (BYO model) |
| AI-005 | **Other hosted providers.** Taskmoor shall add adapters for other hosted model providers through the provider interface. | (1) Each adapter passes the shared provider conformance test suite. | M2 | S | User requirement |
| AI-006 | **Default models and effort.** Taskmoor shall default every AI feature to `claude-opus-5-5` with the effort of section 1.2, let admins choose `claude-sonnet-5-5` or `claude-haiku-5-5` and the effort per feature, use exact model ids without date suffixes, and follow the request rules of section 1.2. | (1) A fresh install with an Anthropic key uses `claude-opus-5-5` for every feature. (2) Requests always carry an explicit effort and never carry disabled thinking, a fixed thinking budget or a forced tool choice. (3) A per-feature change to Haiku takes effect on the next call. | M1 | M | User requirement |
| AI-007 | **Streaming, structured outputs and tool calls.** The Taskmoor AI gateway shall stream long outputs to the browser with cancel, use structured outputs for machine-read results, and validate every tool call input and structured result against its JSON schema before use. | (1) The first streamed token of a summary reaches the UI before the full response completes, and cancel stops provider billing for the rest. (2) An invalid structured result triggers one repair attempt, then a user-visible error; invalid data is never applied. | M1 | M | User requirement |
| AI-008 | **Prompt caching and batch.** The Taskmoor AI gateway shall order prompts for cache reuse, mark cache breakpoints, record cache-read tokens, and send bulk and backfill jobs (re-summaries, imported-backlog triage, embeddings refresh, evidence clustering) through the provider's batch API where available, otherwise through a rate-limited queue. | (1) A second request with the same prefix within the cache lifetime reports cache-read tokens above zero. (2) A batch job of 10,000 items completes, matches results by request id and resumes after a restart. | M1 | M | User requirement |
| AI-009 | **Retries, refusals and fallback.** The Taskmoor AI gateway shall retry 429, 5xx and connection errors with exponential backoff and jitter honouring Retry-After, handle a refusal stop reason with a clear message and an optional fallback model (server-side fallback where the platform offers it, otherwise a client-side retry on the configured fallback model), and use a circuit breaker per provider. | (1) Two 529 responses followed by success yield one result and two logged retries. (2) A refusal shows "AI could not help with this request" and never shows partial content as an answer. (3) When the provider is down, the core action (for example creating a ticket) still succeeds without AI. | M1 | M | User requirement |
| AI-010 | **Inference region.** Taskmoor shall let admins set where inference runs (Claude API inference geography where supported, Bedrock or Vertex region, Foundry resource region) and show it in the data statement. | (1) With region "EU" set on a platform that cannot honour it, calls fail closed with an explanation rather than running elsewhere. | M2 | S | User requirement |
| AI-011 | **Agent runs with budgets.** The Taskmoor AI gateway shall run multi-step agent loops with per-run limits on tokens, cost, steps and wall-clock time, pass a task budget to models that support one, and stop gracefully with a summary when a limit is reached. | (1) A run hitting its cost limit stops, records "budget reached" and posts what it completed. (2) No agent run exceeds its configured step count. | M1 | M | User requirement |
| AI-012 | **Embeddings with a bundled local model.** Taskmoor shall compute embeddings for tickets, comments and knowledge articles with a bundled local embedding model by default (optionally an external embedding endpoint), stored in PostgreSQL with a vector index and filtered by permissions at query time. | (1) With no cloud key and no internet, embeddings are computed and similar-ticket lookups work. (2) Similar-ticket results never include tickets the user cannot browse. | M1 | M | User requirement |
| AI-013 | **Summaries.** Taskmoor shall summarise a ticket (purpose, status, contributors, next steps, blockers, recent changes) and a comment thread on request, streamed, citing the comments used. | (1) A summary of a ticket with 200 comments appears with references to specific comments. (2) The summary uses only content the requesting user can see. | M1 | M | Jira (Rovo); YouTrack |
| AI-014 | **Natural language to query.** Taskmoor shall turn a question in any supported UI language into a query, show the generated query editable before it runs, explain it, and validate it with the parser. | (1) "my open bugs updated this week" yields a query the user can edit and run. (2) A generated query that fails parsing is never executed. (3) Works for German and Japanese prompts (exceeds Jira, English only). | M1 | M | Jira (Rovo); exceeds Jira |
| AI-015 | **AI-assisted creation and breakdown.** Taskmoor shall draft tickets from pasted text or images and break a ticket into child tickets with summaries and descriptions, shown for review before anything is created. | (1) Breaking an Outcome proposes children the user can edit, deselect and then create in one action. (2) Nothing is created without confirmation. | M1 | M | Jira (Rovo) |
| AI-016 | **Duplicate suggestions at create time.** Taskmoor shall show likely duplicates while a ticket is being created, using embedding similarity and, when a model is configured, model re-ranking with reasons. | (1) Typing a summary close to an existing ticket shows it within 2 s. (2) With no cloud key, candidates still appear from embeddings alone. | M1 | M | Linear; Plane |
| AI-017 | **Triage suggestions.** Taskmoor shall suggest track or team, assignee, labels, priority and related tickets for new or intake tickets, with visible reasoning and a per-property setting of show, hide or auto-apply. | (1) With priority set to auto-apply and labels to show, priority is set and labels await acceptance. (2) Each suggestion shows its reasoning. | M2 | M | Linear Triage Intelligence |
| AI-018 | **Automation rules from natural language.** Taskmoor shall draft an automation rule (file 02b) from a description and show it in the builder for review before saving. | (1) "close subtickets when the parent is closed" yields a valid rule that passes a dry run. | M2 | M | Jira (Rovo Studio) |
| AI-019 | **Agents as delegates.** Taskmoor shall model agents as principals that can be assigned or mentioned while a human stays the owner, record agent sessions with an activity stream (thoughts, actions, results, errors), mark agent-written text, and hand tickets to external coding agents (for example Claude Code, Codex, Copilot, Cursor) through connectors, webhooks or MCP, receiving progress and pull-request links back. | (1) Delegating a ticket to a coding agent posts progress to the ticket and links the resulting pull request. (2) Agent-written text is visibly attributed. (3) Agents do not count as users. | M2 | M | Jira Agents; Linear agents; GitHub |
| AI-020 | **Dashboard charts from natural language.** Taskmoor shall build a dashboard or insight chart from a description, showing the underlying query and chart settings for editing. | (1) "bugs created per week by priority, last quarter" yields an editable stacked chart. | M2 | M | Jira Space insights |
| AI-021 | **Semantic search.** Taskmoor shall offer meaning-based search across tickets, comments and knowledge articles, combined with query filters, using the local embeddings and optional model re-ranking. | (1) Searching "login fails after password reset" finds a ticket titled "Cannot sign in following credential change". | M2 | M | User requirement |
| AI-022 | **Writing and formula assistance.** Taskmoor shall rewrite selected text (shorten, expand, tone, grammar), explain terms, and generate or fix formula-field expressions. | (1) "Fix formula" turns an invalid expression into a valid one or explains why it cannot. | M2 | S | Jira (Rovo); JPD |
| AI-023 | **Virtual service agent.** Taskmoor shall answer customers on the help portal and by email from the knowledge base and request history, create or update requests through tools, and hand off to a human agent with the full transcript. | (1) A question answered by a published article is resolved with a cited link. (2) An unanswerable question creates a request containing the transcript. | M3 | M | JSM virtual service agent; exceeds Jira (no conversation caps) |
| AI-024 | **Operations AI.** Taskmoor shall summarise incidents and their timelines, draft post-incident reviews from timeline and chat, and group related alerts. | (1) A postmortem draft contains timeline, impact and contributing factors for review. (2) Alert grouping merges alerts with the same cause into one incident candidate. | M3 | M | JSM Premium AIOps |
| AI-025 | **Custom agents and scheduled agent jobs.** Taskmoor shall let admins define agents (instructions, knowledge sources, tools, permissions) and run natural-language jobs on schedules or events. | (1) A weekly job posts a summary of a track's changes to a channel. (2) An agent cannot use tools outside its allowlist. | M3 | S | Rovo Studio; Linear Loops |
| AI-026 | **Discovery and customer-service AI.** Taskmoor shall cluster discovery evidence into themes linked to ideas, and draft customer-service replies for agent approval. | (1) Clustering 5,000 pieces of evidence runs as a batch job and links each cluster to candidate ideas. (2) Drafted replies are never sent without agent approval unless a rule allows it. | M4 | M | JPD; JSM customer service |
