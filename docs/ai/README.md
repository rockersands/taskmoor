# Live AI checks

Taskmoor's AI code is tested against a fake provider and recorded answers. A few checks need a
real model: M1-073's live smoke test, M1-074's cache read, the prompt-injection corpus against a
live model, and the measured thresholds of M1-079's evals. `pnpm ai:live` runs all of them from
one command (T-333, ADR-108). A person runs it once, in their own terminal, with their own key.
Claude never runs it and never asks anyone for a key.

## Before you run it

- An Anthropic API key with a spend limit set in the Anthropic Console. Before anything is
  spent, the command checks the key with a free call, prints what it will run with a rough cost
  (about $7 to $50 at the list price of `claude-opus-5-5` when this page was written), and asks
  whether to go on.
- This repository with its dependencies installed (`corepack pnpm install`). The evals start the
  embedded PostgreSQL in `.cache/pg-test`, as the tests do; no Docker is needed.
- Time: about 20 minutes to 2 hours. The model calls run one after another.

## Run it (PowerShell)

```powershell
corepack pnpm ai:live
```

When it asks for the key, paste it (Ctrl+V or a right click) and press Enter. Nothing appears
while you paste: the key never reaches the screen, and because it is not part of a command it
never lands in PowerShell's history file either. Read the plan and the cost, then answer `y`.

Never put the key on the command line: not as an argument, and not as
`$env:TASKMOOR_AI_KEY = '...'` typed at the prompt, which PowerShell keeps in its history file
like any other command. When `TASKMOOR_AI_KEY` is already set in this terminal, for example by a
password manager's command-line tool for this one session, the command uses it and does not ask.
Don't keep the key in a permanent user variable.

## Run it (Git Bash)

Git Bash inside Windows Terminal works as above: `corepack pnpm ai:live`, then paste the key
when asked. Git Bash's own window (MinTTY) hands a program like this one a pipe instead of a
terminal, so nothing typed there could be hidden: the command does not ask, says so, and stops
with exit code 2. Run it from PowerShell or Windows Terminal instead, or give the key to this
shell without typing it into a command:

```bash
read -rs TASKMOOR_AI_KEY && export TASKMOOR_AI_KEY   # paste the key, press Enter: nothing shows
corepack pnpm ai:live
unset TASKMOOR_AI_KEY
```

Never type `export TASKMOOR_AI_KEY=...` or `TASKMOOR_AI_KEY=... corepack pnpm ai:live`: bash
keeps both in `~/.bash_history`.

## What it does with the key

- It checks the key first with the model list, which costs nothing. A key the API refuses stops
  the command with exit code 2 before anything is spent.
- It keeps the key in memory and hands it to each step only through that step's environment.
- Every line it prints, logs or writes is scrubbed: the key becomes `[key]`, and a line holding a
  piece of it is left out.
- The report, `docs/ai/live-checks.md`, and the run's summary in `.verify/ai-live.json` hold
  dates, model ids, thresholds, measured values, case ids and, for a failure, only the kind of
  error and its HTTP status: no key, no request header, no prompt, no answer and no error text.
  A provider's error message can name your organization, and a failed check can quote the
  model's answer; both stay in the steps' logs, `.verify/ai-live/*.log`, which git ignores, as it
  ignores the reason `.verify/ai-live.json` gives when the command could not run (in the
  provider's words when it refused the key). Don't commit or share those files.
- Only this command runs the live tests. A key in the environment, even in
  `TASKMOOR_AI_TEST_KEY`, does not make `pnpm verify` call the API: the live test files run only
  when the command starts them.

## What it runs

Each step runs whatever the one before did.

| Step | What runs | Closes |
| --- | --- | --- |
| 1 | `packages/ai/src/live.test.ts`: an answer, a stream, strict structured output, a strict tool with automatic choice, a token count, the model list; a repeat call that must read the cache | M1-073, M1-074 |
| 2 | `packages/ai/src/injection/live.test.ts`: every case of the injection corpus through an agent run with the live model; each must hold as the offline test defines holding | M1-079, and the M1 gate's injection check |
| 3 | `pnpm eval all --candidate apps/server/src/ai/evals/candidates/live.ts`: natural language to query (85% or more), summaries with the judge (every case, and the judge must first agree with every graded example), duplicates (recall@3 of 80% or more), the corpus through every feature (every case, each feature answered by the model) | M1-079 |

A judge call that fails costs that one verdict, not the step: the case counts as not passed, and
the other measurements stand. When the judge disagrees with a graded example, the summaries are
"not measured" until someone reviews the disagreement and corrects the prompt or the label
(`apps/server/src/ai/evals/judge-prompt.md`, "Calibrating the judge").

## Results

- Exit code 0 when every check passes, 1 when one fails, 2 when it could not run (no key, a
  refused key, no confirmation, Ctrl+C at any point; before the steps, nothing has been spent).
- `docs/ai/live-checks.md`: the date, the model, a row per check with its threshold, measured
  value and result, and which of M1-073, M1-074 and M1-079 the run closes. Commit it after the
  run, or leave it for the coordinator.
- `.verify/ai-live.json`: the same for tools, or why the command could not run;
  `.verify/ai-live/*.log`: each step's output with the full error messages, scrubbed of the key.
- The last lines say what the coordinator records in `docs/plan/progress.csv`.

## Options

- `--yes`: no question before spending, for a rerun already decided on.
- `--base-url <url>`: another address for the API, such as a proxy. The command's own tests point
  it at the fake provider.
- `--json <file>` and `--report <file>`: write the summary elsewhere.
