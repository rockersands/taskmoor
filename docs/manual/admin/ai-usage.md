---
title: "AI usage, spend limits and data controls"
audience: admins
sources: packages/ai/src/spend.ts, packages/ai/src/agent.ts, apps/server/src/ai/agent-runs.ts, docs/adr/0101-agent-runs-with-budgets.md, packages/ai/src/redact.ts, packages/ai/src/gateway.ts, apps/server/src/ai/usage.ts, apps/server/src/ai/service.ts, apps/server/src/ai/context.ts, apps/server/src/ai/statement.ts, apps/server/src/routes/ai-usage.ts, apps/web/src/admin/AiUsagePage.tsx, apps/web/src/admin/AiLimitsPage.tsx, apps/web/src/ai/AiNotice.tsx, apps/web/src/ai/DataStatement.tsx, apps/web/src/i18n/messages.en.ts, packages/db/src/migrations/0075_ai_spend.ts, docs/adr/0100-ai-spend-audit-redaction.md, docs/specs/02c-platform-api-and-integrations.md, docs/specs/05a-administration-security-and-self-hosting.md, docs/specs/05b-administration-security-and-self-hosting.md, apps/server/src/security/notices.ts, docs/adr/0109-security-notices-and-alerts.md
accessed: 2026-11-03
attestation: own-words
---
# AI usage, spend limits and data controls

Taskmoor's AI features call an AI provider your organisation pays directly. Taskmoor itself
meters nothing and charges nothing. This page explains how administrators see what AI costs,
stop it at a ceiling, keep sensitive values out of what is sent, and tell people what leaves the
site.

Open **Administration → AI usage** (`#/admin/ai-usage`) to see it, and **Administration → AI limits
and prices** (`#/admin/ai-limits`) to change limits and rates. Only site administrators see these
pages.

## What the page shows

- **What leaves this site**: the provider and region AI features send data to, what each
  feature that is turned on sends, what is never sent, the redaction in force and whether any
  content is kept. The statement is generated from the current settings, so it changes when a
  feature, model or provider changes.
- **Usage** for the last 7 days, the last 30 days or this month: calls, tokens, cost, calls a
  limit refused and calls that failed, then the same by day, by feature, by person and by model.
  Days are UTC days. Calls the system made for nobody appear as "The system".
- **Spend limits** with what each has used in its current period and when it starts again.
- **Latest AI calls**: the newest entries of the AI audit log.

## Costs and the price table

Each call's cost is worked out when it is made, from the token counts the provider returns and
the price table. A later price change does not rewrite the past.

- Taskmoor starts with the first-party list prices for the Claude models on the Anthropic API and
  on Microsoft Foundry, which bills at the same rates. They are defaults to check against your own
  bill, marked `verify: true` in the API until an administrator sets a rate.
- Amazon Bedrock and Google Cloud Vertex AI price separately. Their calls are counted as
  **unpriced** (cost 0) until you enter your rates; the page says how many calls had no price.
  Token limits apply to them either way.
- Cache writes and cache reads have their own rates; batch requests cost half; a model with a
  dearer rate above a prompt size (Haiku above 100,000 tokens) has that rate too.

**AI limits and prices** holds the price table, in US dollars per million tokens. Each row says
**List price: check your bill** or **Your rate**. **Change** sets your rate for a model, with its input,
output and cache rates, and a dearer rate above a prompt size if the model has one. **Back to the list
price** drops your rate. **Add a rate** covers a model with no list price: name its **Provider** and
**Model** as the AI page does. Each change is in the audit log. Through the API: `GET` and
`PUT /api/v1/admin/ai/prices`, and `DELETE /api/v1/admin/ai/prices?provider=&model=`.

## Spend limits

A spend limit is a hard stop. Once the use of its period reaches the amount, AI calls it covers
are refused before anything is sent, and the feature says "The AI limit is reached" with the time
AI is available again.

| Setting | Values |
|---|---|
| Who it counts | everyone together (`workspace`), one feature (`feature`), one person, or each person on their own (`user` with no person named) |
| Period | a UTC day, an ISO week from Monday, or a calendar month |
| Measure | tokens (input, output, cache reads and writes together) or cost in US dollars |
| Alerts | percentages of the amount, 80% and 100% unless you choose others |

- On **AI limits and prices**, **Add a limit** asks **Who it counts**, the **Period**, the **Measure**, the
  amount and the percentages to **Alert at**. **Change** and **Delete** act on a limit in the list, which
  shows what it has used and when it starts again.
- Through the API: `POST /api/v1/admin/ai/limits`, `PATCH` and `DELETE /api/v1/admin/ai/limits/:id`. For
  example, a daily limit of 200,000 tokens for each person is
  `{"scope": "user", "period": "day", "metric": "tokens", "amount": 200000}`.
- Each threshold raises one alert per period (and per person for a personal limit). The alert is
  an `ai_limit.threshold_reached` record in the audit log, so it also reaches syslog and webhooks
  when you forward those, and every site administrator gets it in their inbox and by email.
- A call already running when a limit is reached still finishes, so the use can end a little
  above the amount.
- Calls the system makes for nobody are not counted against personal limits.

## The AI audit log

Every AI call writes one entry, whatever happened: answered, declined by the provider, failed,
cancelled, or refused by a limit. An entry holds who, the feature, the provider, the model asked
for and the model that answered, input, output and cache tokens, cost, outcome and how long it
took. The list is at `GET /api/v1/admin/ai/calls` (filters `from`, `to`, `userId`, `feature`,
`outcome`), and the page shows the newest.

By default no prompt or answer text is stored anywhere. To review what AI was sent and answered,
set **content logging** for up to 90 days (`PUT /api/v1/admin/ai/policy` with
`{"contentDays": 7}`): from then on the entries keep the redacted request and the answer until
their days run out, then the content is deleted. Setting it back to 0 stops keeping content.

Not yet: the tokens a cancelled stream used are not reported by the provider in time, so a
cancelled call is logged with no tokens.

## Keeping sensitive values out

Before anything is sent, Taskmoor replaces sensitive values with a placeholder such as
`[redacted: card number]`:

- **Patterns**: payment card numbers (only those with a valid check digit), IBANs (only with a
  valid checksum), US social security numbers, and email addresses. The first three are on by
  default.
- **Terms**: words or phrases you list, such as a project codename, in any case.
- **Fields**: fields you mark sensitive (`description`, `environment` or a custom field such as
  `cf[12]`) are never sent; their values are also replaced wherever they appear in other text,
  for values of four characters or more. Fields that a ticket's field rules hide are treated the
  same way.

Set them with `PUT /api/v1/admin/ai/policy`, for example
`{"patterns": ["card-number", "iban", "us-ssn"], "terms": ["Project Heron"], "redactedFields": ["cf[12]"]}`.
The audit log records each change, with the terms counted rather than written out. Your own
regular expressions are not accepted: a careless pattern could stall every AI call.

AI features also send only what the person asking may see: a ticket they cannot open is never
part of a prompt. Attachments, passwords, tokens and keys are never sent.

Not yet: redaction by data classification waits for classification levels (a later release).

## The notice before first use

Before a person first uses an AI feature, Taskmoor shows them what leaves the site and where
it goes, and the feature appears once they choose **I understand**. Their answer is recorded
once (`ai_notice.acknowledged` in the audit log).

## Agent runs and their budgets

Some AI work takes several steps: the model calls tools (searching tickets, reading one), reads
what they return and decides the next step. Each such run has its own limits on steps, tokens,
cost and time, besides the spend limits above.

- A run never goes past its limits. Before each step Taskmoor counts what it is about to send
  and caps the length of the answer so that even the most expensive outcome stays within the
  limits. When too little room is left for a useful step, the run stops instead.
- A run stops at its time limit: a step or tool still running is cancelled.
- A run that stops at a limit says "budget reached", names the limit, and hands back what it
  completed so far. Each run is one entry in the audit log (`ai_run.finished`) with how it ended,
  what it used and which tools it called; each of its steps is an entry in the AI audit log.
- With Claude on the Anthropic API, the model is also told the run's token budget, so it plans
  its work to fit.
- A run's cost limit needs a price for its model; without one the run is not started.

Not yet: no feature in this release starts agent runs; the AI features that will use them show
their results where they are used.
