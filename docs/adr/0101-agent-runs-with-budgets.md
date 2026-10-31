# ADR-101: Agent runs with budgets that are enforced before they can be passed

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-131

## Context

AI-011 asks for multi-step agent loops with per-run limits on tokens, cost, steps and wall time,
a task budget for models that take one, and a graceful stop with a summary: a run that reaches
its cost limit stops, records "budget reached" and posts what it completed, and no run passes
its step count. The AI features of M1-079 (breakdown, assisted creation) and later agents
(AI-019, AI-025) need one loop, not one per feature.

A limit checked after each call is passed by the call that crosses it. A cost limit of $1 that
lets a 16,000-token answer through at $0.98 used is not a limit. The loop has to know the worst
case of the next call before it makes it.

## Decision

`runAgent(gateway, options)` in `@taskmoor/ai` (`agent.ts`), with a `ToolRegistry` of
`AgentTool`s (name, description, Zod input, `run`). The gateway offers the tools with automatic
choice and validates every tool input (ADR-028); the loop runs the tools and returns their
results, errors included (`isError`), to the model; a call to a tool outside the registry gets
an error result, never a run.

**Limits, per run:** `maxSteps` (model calls) and `maxWallMs` always; `maxTokens` (every token
billed), `maxInputTokens`, `maxOutputTokens` and `maxCostNanos` when set. Before each step:
- the step count is checked;
- the prompt's input tokens are counted with the provider's counter (Claude everywhere; without
  a counter, an upper estimate of one token per two characters);
- the step's `max_tokens` is set to the smallest room any limit leaves, with input priced at the
  dearest input rate (cache write, cache read or plain input) and output at the output rate.
  Thinking counts against `max_tokens`, so the cap holds it too;
- with less room than `minStepOutputTokens` (1,024), no call is made.

So the provider's own enforcement of `max_tokens` keeps every token and cost limit, and a
property test over random scripts (answers of any length and latency, tool calls, cache reads)
shows no run passes any limit, and that the run's sums equal what the provider billed.

**Time:** one deadline per run from an injectable clock. At the deadline the run's abort signal
fires: the model call is cancelled (the gateway's `AiAbortedError`) and a tool still running is
not waited for (its promise races the deadline; tools get the signal to stop work). Tests use
`VirtualClock` (`@taskmoor/ai/testing`), whose time moves only when a fake lets it pass.

**Stopping:** a limit ends the run with `status: 'budget_reached'` and `limit` (`steps`,
`tokens`, `input_tokens`, `output_tokens`, `cost`, `time`, or `spend_limit` when a spend limit of
ADR-100 refused the next call). An answer cut off by a budget-reduced `max_tokens` is a budget
stop, not a failure. Other ends: `completed`, `refused`, `failed`, `cancelled`. No wrap-up call
is made after a limit (it would pass the limit); the report says what was done instead:
`completed` (the `done` lines of successful tool calls), the last answer text, the steps with
their usage and cost, the totals and the elapsed time.

**Task budget:** models that pace themselves against a budget (`taskBudget` capability: Claude
Opus 5.5, Opus 5, Sonnet 5.5 and Haiku 5.5 on the Anthropic API, beta
`task-budgets-2026-03-13`) get `output_config.task_budget` with the run's token limit
(`maxTokens`, else `maxOutputTokens`) as `total`, the same on every step, with `remaining` left
to the server. Below the API's minimum of 20,000 tokens, or on other platforms and models, none
is sent; the loop's limits hold either way. Token counting drops it.

**Server:** `app.ai.agents.run(...)` (`apps/server/src/ai/agent-runs.ts`) runs the loop on the
workspace's gateway: each step is redacted, limited and booked as one AI audit row with the
run's ID (ADR-100); the cost limit is priced from the workspace's price table (a cost limit on an
unpriced model is refused); tool results can mark sensitive values for redaction in later steps.
Each run ends with one audited `ai_run.finished` event (status, limit, steps, tokens, cost, time,
tool names with counts, the limits; no content), then its report goes to the feature's `post`.

## Consequences

- Counting tokens before each step costs one more provider request per step (free on Claude).
- A run can end with budget left that a smaller step could have used: the floor of 1,024 output
  tokens per step trades that for steps that can do something.
- Where the feature posts the report (a comment, the UI) is the feature's choice (M1-079).
