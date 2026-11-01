# ADR-108: The AI features of v1: summaries, query from text, drafts, breakdown and duplicates

- Status: Accepted
- Date: 2026-11-01
- Backlog: M1-079

## Context

M1-073 to M1-077 built the gateway, the provider settings, the spend meter and the AI audit log;
M1-118 the injection defences; M1-131 agent runs; M1-078 the bundled embedding model; M1-133 the
eval sets. M1-079 turns them into the four features people use (spec 02c): summaries of a ticket
and of its thread (AI-013), natural language to query (AI-014), drafts and breakdowns
(AI-015) and duplicate suggestions at create time (AI-016). NFR-011 asks that nothing changes
without a key except that the controls are hidden; NFR-012 that AI never sits on the path of a
non-AI action. No AI key exists in this environment, so everything is built and tested against
the fake provider and recorded answers, and the live measurement waits for a key.

## Decision

**One choke point, as the person.** Every feature calls `AiService.call(scope, fn)` with the
ticket's track (none for a query), so the workspace, track, strict-mode and feature switches and
the provider's capabilities apply before anything is sent, and each call is metered, redacted
and audited by the gateway as before (ADR-100). What a prompt holds is read as the person asking:
the ticket through `AiContext.ticket` (the ticket route as them), comments through
`AiContext.comments` (the set-based form of the comment rule, `commentReadableSql`: a comment
restricted to a role or group they are not in is never read), and recent changes through the
history route, without fields the AI policy marks sensitive or the field rules hide.

**Fenced and screened.** Each kind of untrusted text sits in its own element (`ticket`,
`comment`, `change`, `pasted`, `child`, `new`, `question`), and no piece may open or close an
element of any kind the prompt uses (`ai/features/fence.ts`), not only its own: a comment cannot
pose as the ticket. Every answer goes through `screenAnswer` before it is returned: images that
would load from another site are taken out, and links to other sites are listed so the interface
names their hosts. No feature offers the model a tool, so a tool call in an answer has nothing to
run; in a structured answer it makes the answer invalid (502 `ai_invalid_answer`), and an invalid
answer is never applied.

**Routes** (`routes/ai-features.ts`; read-only token class, contract exemptions with reasons, no
domain event: the AI audit log books each call):

| Route | Feature | Answer |
|---|---|---|
| `POST /api/v1/tickets/:id/ai/summary` `{ scope: ticket \| thread }` | AI-013 | Server-sent events: `text` pieces, then `done` with the text, the cited comments (`commentId`, `author`), links to other sites and how many comments were left out; or `refused`, or `error` |
| `POST /api/v1/ai/query` `{ text }` | AI-014 | `{ query, explanation, valid, repaired, problem? }` |
| `POST /api/v1/ai/drafts` `{ text, track }` | AI-015 | `{ track, drafts: [{ summary, description, ticketType, priority, labels }] }` |
| `POST /api/v1/tickets/:id/ai/breakdown` `{ guidance? }` | AI-015 | `{ parent, track, childTypes, children: [{ summary, description, ticketType }] }`, or 409 `no_child_types` |
| `POST /api/v1/tickets/similar` `{ ..., reasons: true }` | AI-016 | The embedding answer, re-ordered with `likely` and `reason` per ticket and `reranked` |

- **Summaries** stream. Nothing is written to the response until the gateway has the first
  event, so a refusal before it (a spend limit, AI switched off) is an ordinary JSON error with
  its status. Closing the request aborts the gateway's stream, which aborts the provider's
  (AI-007 (1): billing stops). The model cites comments as `[c<id>]` with the comment's own id;
  `citationsOf` keeps only marks of comments that were in the prompt and removes the rest. A
  thread too long for the prompt keeps its first comment and as many of the latest as fit in
  120,000 characters, and says how many it left out; 200 comments fit.
- **Query from text** sends the language (system prompt: grammar, fields and functions generated
  from `@taskmoor/query`'s own tables, in our words; the same for everyone, so it is cached) and
  the person's context: name, now, time zone, week start, and the names they may use (tracks they
  see with their releases and areas, statuses, priorities, types, close reasons, people, groups,
  labels, custom fields: `features/vocabulary.ts`), the shape the evals' candidate context has.
  The answer is structured output. The server parses, resolves, binds and compiles it as the
  person with `prepareSearch` and never runs it: the person sees it, may edit it and presses Run,
  and the search route checks it again. A query that fails gets one repair turn with the parser's
  or resolver's message; one that still fails is returned with `valid: false` and the problem.
- **Drafts and breakdowns** are proposals. The server maps the type and priority names the model
  chose onto the track's own (`choose`, case-insensitive) and drops anything else: unknown labels,
  types that may not sit under the parent (a breakdown's child types are the track's types one
  level below the ticket's, by `parentLevelAllowed`; another becomes the first allowed). Creating
  happens in the web app, after the person confirms, through `POST /api/v1/tickets` with their
  own rights; nothing in the AI routes writes a ticket (AI-015 (2)). Images in pasted text are
  not sent: the gateway's content parts carry text only, so AI-015's "or images" waits for image
  parts in the provider interface.
- **Duplicates** keep the embedding route (M1-078) and add `reasons: true`. The embedding lookup
  always runs first and needs no key. With a model for the track, the first eight candidates
  (summary and 300 characters of description, the description left out when the AI policy marks
  it) are re-ranked by structured output within what is left of 2 s from the request
  (`DUPLICATE_BUDGET_MS`, the call aborted at the deadline); on timeout, a refusal or any error the
  embedding order stands with `reranked: false`. Reasons are screened too.

**The web app.** Each control sits inside `<AiFeature>` for its feature and track, so nothing
shows where the server would refuse (NFR-011): Summarise ticket and Summarise comments with
Cancel and numbered citation links on the ticket page (`SummaryPanel`), Break down in the ticket
toolbar (`BreakdownAction`: proposals to edit and deselect, then "Create N tickets"), Ask in
plain language on the search page (`AskQuery`: an editable query and its explanation; Run is
offered for a valid query, or once an invalid one is edited), and Draft from text in the create
form (`DraftFromText`: choosing a draft fills the form; Create still creates). The first use of
each shows the AI notice (`useFirstUse` wraps `AiNotice`), and nothing is sent before it is read.
Refusals use `aiRefusalMessage`; a provider's refusal shows "AI could not help with this request"
and none of its text. Duplicate suggestions (`DuplicateSuggestions`) sit under the summary in the
create form and are not an AI control: they come from embeddings with no key, and ask for
`reasons` only where the duplicates feature is available and the person has read the notice, the
reasons marked as written by AI.

**NFR-012.** Every AI call is on explicit request or bounded: summaries, queries, drafts and
breakdowns run only when the person asks, in requests of their own; the re-ranking has a 2 s
deadline and falls back; no ticket read or write waits for AI.

**Evals** (ADR-107's runner):
- `candidates/features.ts` makes a candidate from the product itself: an app on the eval
  database whose provider is the candidate's adapter, asked through its routes as each case's
  person (`EvalWorld.asOn`), at the dataset's fixed now (`ai.now`).
- `candidates/live.ts` uses the Anthropic API with a key from `TASKMOOR_AI_EVAL_KEY` (or
  `TASKMOOR_AI_TEST_KEY`) and grades the judged summary criteria with the same model
  (`judge.ts`, `judge-prompt.md` calibrated on the graded examples first); without a key it says
  it cannot run and the CLI stops with exit code 2, making up no score.
- `candidates/replay.ts` replays recorded answers (the corpus's references and graded summaries,
  ids mapped to the seeded comments) to prove the wiring end to end.
- `injection-eval.ts` plants each case of M1-118's corpus in a ticket and asks every feature
  about it; `THRESHOLDS.injection` is 100% of cases holding.

## Results (fake provider, 2026-11-01)

`pnpm eval all --candidate apps/server/src/ai/evals/candidates/replay.ts`:

- query: 125/125 exact-result match, 100.0% (en 77/77, es 16/16, de 16/16, ja 16/16);
- summary: 12/12 pass the automatic criteria; the judged criteria wait for a model;
- duplicates: recall@3 100.0% over 46 queries (pool 76), MRR 0.946, near miss above the
  duplicate 10.9%, the bundled model with the re-rank wiring (the replay keeps the order);
- injection: 40/40 cases hold through every feature.

These prove the plumbing, not a model's quality. The thresholds of M1-079 (query 85%, every
summary passing both graders, duplicates recall@3 80%, injection 100%) are measured with
`candidates/live.ts` once the user sets a key.

## Consequences

- M1-079's measured thresholds wait for a key; everything else is built and tested.
- The eval tooling directory may use test helpers (`packages/devtools/src/boundaries.ts`): the
  injection corpus and the fake capabilities.
- `FakeProviderServer` can script answers per request (`answer`) and streams them as server-sent
  events, so end-to-end tests run every feature with no network (`e2e/ai-features-fake.spec.ts`).
- Images in drafts (AI-015 "or images") need image content parts in the gateway first.
- Triage suggestions (AI-017) and natural-language automation rules (AI-018) are M2.
