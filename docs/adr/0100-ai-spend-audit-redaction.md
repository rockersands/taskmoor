# ADR-100: AI spend limits, the AI audit log and redaction, in the gateway's call path

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-077

## Context

Taskmoor meters nothing: each install pays its AI provider directly (spec 02c). Administrators
still need to know what AI costs and to stop it at a ceiling (OPS-020), to see every call without
the prompts being kept (IAM-021), to keep sensitive values out of what is sent (IAM-022 (1)) and
to know what leaves the instance (IAM-022 (2)). The gateway of ADR-028 is the one door every
call goes through, so that is where these controls belong: a feature that forgets them cannot
exist. The spec's pipeline (02c section 1.4) orders them: limits before the call, redaction before
sending, an audit record after.

## Decision

**In `@taskmoor/ai` (provider-neutral, no database):**
- `AiGatewayOptions.meter` (`AiMeter`: `admit`, `record`) and `redaction` (rules per call).
  Every `generate` and `stream` is admitted, run and booked by one wrapper, so each call writes
  exactly one audit row whatever its outcome: answered, declined by the provider, failed,
  cancelled, or refused by a limit before anything was sent. A repair attempt for an invalid
  structured answer (AI-007) belongs to its call: both answers' tokens are booked on one row,
  including when the repair fails too (`AiOutputError.usage`). A booking failure is logged, never
  turned into a failed call: the answer was already billed.
- `GenerateRequest.tag` (`userId`, `trackId`, `runId`) says who a call is for; it never reaches
  the provider. `sensitive` carries values of fields marked sensitive that the prompt was built
  from.
- `Redactor` replaces, in the system text, the context, user turns, tool results and tool-call
  inputs: built-in patterns (payment card numbers with a valid Luhn digit, IBANs with a valid
  checksum, US social security numbers, email addresses), administrator terms, and the sensitive
  values (4 characters or more; shorter ones are replaced in their own field only, or they would
  hit ordinary words). Each becomes `[redacted: <what>]`. Provider turns (`native`) go back
  untouched: Claude checks its thinking blocks, and they only hold what the model wrote from
  already redacted text. Administrators get no free-form regular expressions: a pattern runs over
  every prompt, and backtracking could take the server down.
- `spend.ts`: prices in billionths of a dollar per token ("nanos"; $/MTok × 1,000), so sums are
  exact integers; `callCost` with a long-prompt rate (Haiku above 100K) and the batch half price;
  `LIST_PRICES` for the Anthropic API and Foundry (same rates); periods in UTC (day, ISO week from
  Monday, calendar month); `limitApplies`, `reachedLimit`; `MemoryMeter` in `testing.ts`.

**In the server (`apps/server/src/ai`, migration 0075):**
- `DbMeter.admit` reads the counters of the limits that apply (`ai_spend_counter`, by primary
  key: period, period start, `workspace`, `feature:<id>` or `user:<id>`) and refuses at the limit
  with `AiSpendLimitError` (429 `ai_limit_reached` with the scope, period and when it resets).
  `record` writes, in one transaction, the `ai_call` row, the day's sums (`ai_usage_day`, the
  dashboard's source, so its totals match the log), the nine counters, and each alert threshold
  crossed once per limit, period and person (`ai_limit_alert`, event
  `ai_limit.threshold_reached`, audited). Limits are hard stops: a call in flight when the limit is
  reached still finishes, so a limit can be passed by the calls already running.
- Limits: the workspace, a feature, one person or each person; per day, week or month; in tokens
  (input, output, cache reads and writes together) or cost. Alerts default to 80% and 100%.
- Prices: `ai_price` holds administrators' rates; models without one use the list prices, shown
  with `verify: true` ("list price to verify"); no date is written into code or data. Bedrock and
  Vertex AI price separately, so their calls are booked unpriced (cost 0, `priced: false`, counted
  on the dashboard) until an administrator enters a rate; token limits still apply to them.
- Content: off by default. `ai_policy.content_days` (up to 90) keeps what was sent (after
  redaction) and the answer on the row until `content_expires_at`; the six-hourly prune clears it.
- Redaction: `ai_policy` holds the patterns (card numbers, IBANs and US SSNs on by default),
  terms (shown in events as a count only) and fields marked sensitive (`description`, `cf[12]`).
  `AiContext.ticket` reads a ticket through the ticket route as the person asking (a ticket they
  cannot see is never sent), replaces marked fields and fields the ticket's field rules hide with
  placeholders, returns their values as `sensitive`, and wraps the ticket as data (IAM-023).
- `AiService` builds one gateway per provider adapter with the meter and the redaction wired in,
  from an `AiProviderSource` that key storage (M1-075) supplies; without one, AI is not
  configured. Feature code (M1-079) calls `app.ai.service.gateway(workspaceId)`, tags calls with
  the person, and answers failures with `aiErrorBody`.
- The data statement (`GET /api/v1/admin/ai/statement`, and `GET /api/v1/ai/notice` for every
  person, without the redaction details) is generated from the feature registry, the provider's
  settings and the policy; `FEATURE_DATA` is typed by the registry, so a new feature cannot ship
  without saying what it sends. A person acknowledges it once (`ai_notice.acknowledged`).

## Consequences

- One audit row per call makes the log the bill's mirror; the dashboard reads daily sums written
  with it, so it stays fast and exact. Counters make the limit check two index lookups.
- Calls through `countTokens` are redacted but not booked (token counting is free); batch results
  are booked when read with `feature` set, at the batch rate, so a batch's results are read once.
- A cancelled stream is booked as `aborted` with no tokens: the adapters do not report the
  partial usage the provider bills. A known gap.
- Admin email for alerts waits for an administrator notification channel; the alert is an audited
  event (and reaches syslog and webhooks), and the dashboard lists the alerts.
- Redaction by data classification (IAM-016) waits for classifications (M2).
