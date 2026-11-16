# ADR-030: Test strategy and the verify gate

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-008, M0-009, M0-011, M0-014

## Context

No human re-tests changes by hand. Claude must be able to change complex code, run one command,
wait, and trust the answer. The answer must be short enough to read in full and precise enough to
act on.

## Decision

### One gate: `pnpm verify`

Runs Biome, `tsc -b` and the whole Vitest suite in parallel (Playwright too with `--e2e` or in CI)
and prints one line per step plus only the failures: test name, `file:line`, message, the
expected/received diff and the stack frames inside the repo. Full logs go to `.verify/`. Exit
code 0 means done.

### Layers

| Layer | Tool | Where | Notes |
|---|---|---|---|
| Unit | Vitest | `*.test.ts` next to the code | Pure logic, no I/O |
| Integration | Vitest + real Postgres | same | `useMigratedDatabase()` gives each file its own database cloned from a migrated template |
| Component | Vitest + Testing Library + jsdom | `apps/web/src` | Query by role and name; `setViewportWidth()` for compact layouts |
| Golden | Vitest file snapshots | `__golden__/` | `stableJson()` output; `pnpm verify --update` rewrites; CI never writes |
| Property | fast-check | any | `FC_RUNS` and `FC_SEED` control runs and replay |
| End-to-end | Playwright | `apps/web/e2e` | Production build; desktop (1440x900) and mobile (Pixel 7) projects |
| Contract, conformance, benchmarks, upgrade, install | later tasks | | See the plan, section 7 |

### Postgres without Docker

Tests run against real PostgreSQL, never a mock. Locally the testkit starts Postgres 16 from the
`embedded-postgres` npm binaries using `initdb` and `pg_ctl` directly, keeps the cluster in
`.cache/pg-test` between runs (warm start about a second) and runs with `fsync=off`. A second
concurrent run gets a throwaway cluster. With `TASKMOOR_TEST_DATABASE_URL` set (CI service
containers on Postgres 16 and 18) that server is used instead.

Each test file gets `CREATE DATABASE ... TEMPLATE tpl_<migration hash>`, so files are isolated and
can run in parallel; the template is rebuilt only when migrations change.

### Rules

- Tests come from the spec and cite requirement IDs in their names (`[CORE-028] ...`); a
  traceability check (M0-014) will fail on unknown IDs.
- No network calls in tests; AI providers are tested against recorded contracts.
- A flaky test is a failing test: fix it or delete it, never retry it into passing locally.

### Every supported browser (M1-132; NFR-007)

The routine gate runs Playwright on two projects: desktop Chromium (1440x900) and a phone
(Pixel 7). `pnpm verify --e2e --browsers` (or `TASKMOOR_E2E_BROWSERS=all`) adds four more:
desktop Firefox and desktop Safari (WebKit) at 1440x900, Safari on an iPhone and Chrome on an
Android phone, both at 360 px, the narrowest width the UI supports (ADR-033). Chrome and Edge
share the Chromium engine of the desktop project. The extra projects are not in the routine
gate because they triple its e2e time; run them before a release and after any change to
input handling, focus or clipboard code.

- **Once per backend.** First-run setup can happen once per database, so its spec runs only on
  desktop Chromium; every other spec runs on every project.
- **Engine differences the specs allow for.** WebKit, like Safari until "Press Tab to highlight
  each item" is on, skips links on Tab, so the keyboard-only journey skips WebKit. Security
  keys (WebAuthn's virtual authenticator) exist only in Chromium. Synthetic paste builds a
  plain `Event` with `clipboardData` defined, since Firefox does not let a script construct a
  `ClipboardEvent` with data.
- **What the extra browsers found.** Escape did not close the attachment preview in WebKit (the
  dialog now listens on the document), and the workflow map's Add button could be pressed
  before the default workflow loaded (now disabled until it has).

### Story tests on a cold dependency cache (T-208, 2026-11-06, revised 2026-11-08)

A fresh checkout's first full gate on the Windows PC lost 48 story tests on 2026-11-04 to
"optimized dependencies changed. reloading"; a rerun passed. Vite logs that in one place: when
its browser server meets a package mid-run that its first bundle lacks, bundles again and gets
a different result, it reloads every test page, and the stories in flight fail. On a cold cache
(a fresh clone or worktree, a new lockfile) the first bundle holds only what Vite's scan found
before the browser started. On the Mac the scan finds every package, so cold runs passed there;
a scan that misses a package, fails or is cut short under a full gate's load leaves the rest to
be met mid-run. With the scan switched off, a cold run on the Mac reloaded three times and
failed every story in flight, then hung.

The stories' config (`storiesProject()` in `apps/web/vitest.stories.config.ts`, which makes every
story project: both skins, `stories` and `stories-dark` (ADR-036), and their touch twins, below)
therefore lists every package a full run optimizes
in `optimizeDeps.include` (`STORY_DEPS`), so the first bundle does not depend on the scan. A
package the web app reaches only through another one is named with the one that brings it
(`@taskmoor/richtext > mdast-util-gfm-table`): Vite resolves each entry from `apps/web` and skips
one it cannot with only a warning. With the scan switched off and the list in place, a cold run
bundled nothing mid-run and passed, as did cold runs of one skin and of both together.
`vitest.stories.config.test.ts` bundles the light stories the way a cold start does, once from
the scan alone and once from the list alone, and fails on a listed package that was not bundled
or a scanned file the list does not cover.

Each story project also keeps its optimized dependencies in a folder of its own
(`apps/web/node_modules/.vite/stories-<skin>`, `stories-<skin>-touch` for the touch projects).
The Storybook plugin points every project made from one `.storybook` folder at a single folder,
and the two skins, which start together, both optimized into it: the later one moved the earlier
one's finished folder aside while its browser could be loading from it.

### Touch stories on a touch screen from the start (T-328, 2026-11-16)

A story that measures what a finger gets (44 px targets, ADR-033) needs `(pointer: coarse)` to
hold for the whole page, so every touch rule stays where its sheet has it (T-255). Its
`beforeEach` used to switch Chromium's touch emulation on through Vitest's `cdp()` and an
`afterAll` switched it off. In full story runs such a story sometimes timed out at 15 s and
passed alone: the switch was a round trip from the page to Vitest's main thread, a new DevTools
session for each file (never detached) and the Emulation command, with no time limit of its own
and all of it inside the story's 15 s. Under a full gate's load it sometimes outlasted them.

Touch is now the browser's, not the story's:

- A touch story carries a literal `tags: ['touch']` (Storybook reads tags from the source, so no
  spread or import) and keeps `beforeEach: onARealTouchScreen`.
- Two more projects, `stories-touch` and `stories-dark-touch`, run only those stories, on
  Playwright contexts with `hasTouch`: the same emulation, sent when the page is made, so the
  pointer is coarse from the first frame. `stories` and `stories-dark` leave them out by the tag.
  Each story still runs once per skin, and the four projects together run as many story tests as
  the two did.
- A touch project loads only the story files with a touch story (`touchStoryFiles()`) and runs
  them on one page (`browser.fileParallelism: false`). A page count of its own would need a
  `sequence.groupOrder` of its own, which Vitest runs after every other project. The list is
  made when the project starts; in watch mode the project also follows Vitest's file watcher
  (`followTouchStoryFiles()`), so a file that gains a touch story joins it at once instead of
  its story running nowhere until Vitest restarts.
- `onARealTouchScreen` only checks: in a story test whose browser has a mouse it fails, naming
  the missing tag. Storybook's own page falls back to `asOnATouchScreen`.
- `vitest.stories.config.test.ts` reads every story file with Storybook's CSF parser: every story
  tagged `touch` must be in a file the touch projects load, and every story that asks for a real
  touch screen must carry the tag. The design guard asks the same of the story that checks a
  dragged-whole element (T-290).

## Consequences

Running every suite on each change stays fast while the suite is small; `--changed` limits the
run to affected tests as the repo grows. Windows CI runs the embedded-Postgres path on pushes to
main so the Docker-free harness keeps working.
